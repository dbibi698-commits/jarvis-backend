// JARVIS backend — v1
// Zero dependencies: only Node.js built-ins (node:http, node:fs, node:path, node:crypto).
// Run:  node server.js        (PORT and ADMIN_KEY come from env)
// Deploy: Render Blueprint (render.yaml) — no build step.
//
// What it does (owner control panel for the JARVIS Android app):
//   - Devices heartbeat in with a random per-device install_id; the server
//     records first_seen / last_seen / device / app version / last action.
//   - Devices send events (what the user asked Jarvis to do).
//   - The owner can Ban / Suspend / Shutdown / Restore any install from
//     the /admin dashboard, permanently or for N days.
//   - The app is local-first: if this backend is unreachable, Jarvis keeps
//     working normally on-device. A heartbeat answer of "banned" /
//     "suspended" / "shutdown" is the only thing that stops it.
//
// Storage: data/users.json (plain JSON). Render's free disk is ephemeral —
// data resets on redeploy / restart. Acceptable for v1; a real database
// (Render Postgres / Supabase) is the upgrade path.
//
// Auth: heartbeat + event have NO auth by design — install_id is a random
// per-device UUID and the data is not sensitive. Admin routes are protected
// by ADMIN_KEY (env). Default key "jarvis-admin-123" exists only for local
// testing — the dashboard shows a loud warning while it is in use.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = parseInt(process.env.PORT || "3000", 10);
const ADMIN_KEY = process.env.ADMIN_KEY || "jarvis-admin-123";
const DEFAULT_KEY = "jarvis-admin-123";
const USING_DEFAULT_KEY = ADMIN_KEY === DEFAULT_KEY;

const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");

// ---------------------------------------------------------------- storage

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch {
    return {}; // missing or corrupt file -> start empty
  }
}

function saveUsers(users) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Atomic write: temp file + rename, so a crash never leaves a half file.
  const tmp = USERS_FILE + "." + crypto.randomBytes(6).toString("hex") + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2));
  fs.renameSync(tmp, USERS_FILE);
}

// ---------------------------------------------------------------- status

// Effective status, computed at read time: an expired suspension/shutdown
// automatically becomes "ok" again — no cron job needed.
function effectiveStatus(user) {
  if ((user.status === "suspended" || user.status === "shutdown") && user.until) {
    if (new Date(user.until).getTime() <= Date.now()) return "ok";
  }
  return user.status || "ok";
}

function statusMessage(user) {
  const st = effectiveStatus(user);
  if (st === "banned") return "This install has been banned by the owner.";
  if (st === "suspended") return "Jarvis is suspended until " + (user.until || "further notice") + ".";
  if (st === "shutdown") return "Jarvis has been shut down by the owner" + (user.until ? " until " + user.until : " permanently") + ".";
  return "Jarvis is running normally.";
}

function publicUser(user) {
  return {
    install_id: user.install_id,
    device_model: user.device_model || "",
    app_version: user.app_version || "",
    first_seen: user.first_seen,
    last_seen: user.last_seen,
    status: effectiveStatus(user),
    until: user.until || null,
    last_action: user.last_action || "",
    events: user.events || [],
  };
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
      if (raw.length > 1_000_000) req.destroy(); // 1 MB cap
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

function dashboardHtml(users, key) {
  const list = Object.values(users);
  const now = Date.now();
  const total = list.length;
  const active24h = list.filter((u) => u.last_seen && now - new Date(u.last_seen).getTime() < 24 * 3600 * 1000).length;
  const banned = list.filter((u) => effectiveStatus(u) === "banned").length;
  const paused = list.filter((u) => effectiveStatus(u) === "suspended" || effectiveStatus(u) === "shutdown").length;

  const rows = list
    .sort((a, b) => new Date(b.last_seen || 0) - new Date(a.last_seen || 0))
    .map((u) => {
      const st = effectiveStatus(u);
      const badge =
        st === "ok" ? '<span class="ok">OK</span>'
        : st === "banned" ? '<span class="bad">BANNED</span>'
        : st === "suspended" ? '<span class="warn">SUSPENDED</span>'
        : '<span class="warn">SHUTDOWN</span>';
      const until = u.until && st !== "ok" ? "<br><small>until " + escapeHtml(fmtTime(u.until)) + "</small>" : "";
      const evs = (u.events || []).slice(-3).map((e) => escapeHtml(e.event)).join(", ");
      return `<tr>
<td title="${escapeHtml(u.install_id)}">${escapeHtml(shortId(u.install_id))}</td>
<td>${escapeHtml(u.device_model || "—")}</td>
<td>${escapeHtml(u.app_version || "—")}</td>
<td>${escapeHtml(fmtTime(u.first_seen))}</td>
<td>${escapeHtml(fmtTime(u.last_seen))}</td>
<td>${badge}${until}</td>
<td>${escapeHtml(u.last_action || "—")}${evs ? "<br><small>" + evs + "</small>" : ""}</td>
<td class="actions">
<button onclick="act('${escapeHtml(u.install_id)}','ban')">Ban</button>
<button onclick="act('${escapeHtml(u.install_id)}','suspend',7)">Suspend 7d</button>
<button onclick="act('${escapeHtml(u.install_id)}','shutdown',30)">Shutdown 30d</button>
<button onclick="act('${escapeHtml(u.install_id)}','shutdown',0)">Shutdown permanent</button>
<button onclick="act('${escapeHtml(u.install_id)}','restore')">Restore</button>
</td></tr>`;
    })
    .join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>JARVIS Admin — ${total} installs</title><style>
body{font-family:system-ui,sans-serif;background:#0b0f16;color:#e6f1ff;margin:0;padding:16px}
h1{color:#22d3ee;margin:0 0 4px}.sub{color:#9fb3d1;margin:0 0 16px}
.warnbar{background:#7c2d12;border:1px solid #f97316;color:#ffedd5;padding:12px;border-radius:8px;margin-bottom:16px}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px}
.card{background:#111827;border:1px solid #1f2937;border-radius:10px;padding:14px 18px;min-width:140px}
.card b{font-size:26px;display:block}.card span{color:#9fb3d1;font-size:13px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{border-bottom:1px solid #1f2937;padding:8px;text-align:left;vertical-align:top}
th{color:#9fb3d1}td small{color:#9fb3d1}
.ok{color:#4ade80}.bad{color:#f87171;font-weight:700}.warn{color:#fbbf24;font-weight:700}
.actions button{display:block;width:100%;margin:2px 0;padding:5px 8px;border-radius:6px;border:1px solid #334155;background:#1f2937;color:#e6f1ff;cursor:pointer;font-size:12px}
.actions button:hover{background:#374151}
</style></head><body>
<h1>JARVIS Admin</h1>
<p class="sub">Installs, activity and remote control. Data is stored in data/users.json on this server.</p>
${USING_DEFAULT_KEY ? '<div class="warnbar"><b>WARNING:</b> You are using the default admin key (jarvis-admin-123). Anyone who knows it can control every install. Set a strong ADMIN_KEY environment variable on Render and redeploy.</div>' : ""}
<div class="cards">
<div class="card"><b>${total}</b><span>Total installs</span></div>
<div class="card"><b>${active24h}</b><span>Active (last 24h)</span></div>
<div class="card"><b>${banned}</b><span>Banned</span></div>
<div class="card"><b>${paused}</b><span>Suspended / Shutdown</span></div>
</div>
<table><tr><th>Install</th><th>Device</th><th>App</th><th>First seen</th><th>Last seen</th><th>Status</th><th>Last action</th><th>Actions</th></tr>
${rows || '<tr><td colspan="8">No installs yet — devices appear here after their first heartbeat.</td></tr>'}
</table>
<script>
const KEY = ${JSON.stringify(key)};
async function act(id, action, days) {
  if (action === 'ban' && !confirm('Ban this install permanently?')) return;
  if (action === 'shutdown' && days === 0 && !confirm('Shut down Jarvis for this install permanently?')) return;
  const r = await fetch('/api/admin/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: KEY, install_id: id, action: action, days: days }) });
  if (!r.ok) { alert('Failed: ' + r.status); return; }
  location.reload();
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

    // ---- POST /api/heartbeat
    if (req.method === "POST" && pathname === "/api/heartbeat") {
      const body = await readJsonBody(req);
      const installId = String(body.install_id || "").trim();
      if (!installId) return sendJson(res, 400, { error: "install_id required" });
      const users = loadUsers();
      const now = new Date().toISOString();
      let user = users[installId];
      if (!user) {
        user = {
          install_id: installId,
          device_model: body.device_model || "",
          app_version: body.app_version || "",
          first_seen: now,
          last_seen: now,
          status: "ok",
          until: null,
          last_action: body.last_action || "",
          events: [],
        };
        users[installId] = user;
      } else {
        user.last_seen = now;
        if (body.device_model) user.device_model = body.device_model;
        if (body.app_version) user.app_version = body.app_version;
        if (body.last_action !== undefined) user.last_action = body.last_action;
      }
      saveUsers(users);
      return sendJson(res, 200, {
        status: effectiveStatus(user),
        until: user.until || null,
        message: statusMessage(user),
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
          install_id: installId,
          device_model: "",
          app_version: "",
          first_seen: now,
          last_seen: now,
          status: "ok",
          until: null,
          last_action: "",
          events: [],
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

    // ---- GET /api/admin/users
    if (req.method === "GET" && pathname === "/api/admin/users") {
      if (url.searchParams.get("key") !== ADMIN_KEY) {
        return sendJson(res, 401, { error: "unauthorized" });
      }
      const users = loadUsers();
      return sendJson(res, 200, Object.values(users).map(publicUser));
    }

    // ---- POST /api/admin/action
    if (req.method === "POST" && pathname === "/api/admin/action") {
      const body = await readJsonBody(req);
      if (body.key !== ADMIN_KEY) return sendJson(res, 401, { error: "unauthorized" });
      const installId = String(body.install_id || "").trim();
      const action = String(body.action || "");
      const users = loadUsers();
      const user = users[installId];
      if (!user) return sendJson(res, 404, { error: "unknown install_id" });
      const days = body.days === undefined || body.days === null ? null : Number(body.days);
      const now = Date.now();
      if (action === "ban") {
        user.status = "banned";
        user.until = null;
      } else if (action === "suspend") {
        const d = days && days > 0 ? days : 7;
        user.status = "suspended";
        user.until = new Date(now + d * 24 * 3600 * 1000).toISOString();
      } else if (action === "shutdown") {
        user.status = "shutdown";
        // days > 0: temporary; days 0 or omitted: permanent
        user.until = days && days > 0 ? new Date(now + days * 24 * 3600 * 1000).toISOString() : null;
      } else if (action === "restore") {
        user.status = "ok";
        user.until = null;
      } else {
        return sendJson(res, 400, { error: "unknown action (ban|suspend|shutdown|restore)" });
      }
      saveUsers(users);
      return sendJson(res, 200, publicUser(user));
    }

    // ---- GET /admin (dashboard)
    if (req.method === "GET" && pathname === "/admin") {
      const key = url.searchParams.get("key") || "";
      if (key !== ADMIN_KEY) return sendHtml(res, 200, keyFormHtml());
      return sendHtml(res, 200, dashboardHtml(loadUsers(), key));
    }

    // ---- GET / (short intro)
    if (req.method === "GET" && pathname === "/") {
      return sendHtml(res, 200, `<!DOCTYPE html><html><head><meta charset="utf-8"><title>JARVIS backend</title></head>
<body style="font-family:system-ui,sans-serif;background:#0b0f16;color:#e6f1ff;padding:24px">
<h1 style="color:#22d3ee">JARVIS backend</h1>
<p>API is running. Endpoints: <code>GET /health</code>, <code>POST /api/heartbeat</code>, <code>POST /api/event</code>, <code>GET /api/admin/users?key=…</code>, <code>POST /api/admin/action</code>, <code>GET /admin?key=…</code></p>
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
  console.log("JARVIS backend listening on port " + PORT);
  if (USING_DEFAULT_KEY) {
    console.log("WARNING: using default ADMIN_KEY (jarvis-admin-123) — set ADMIN_KEY env var!");
  }
});

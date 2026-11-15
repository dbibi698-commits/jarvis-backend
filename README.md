# JARVIS backend — v2

Owner control backend for the JARVIS Android app. Zero npm dependencies —
only Node.js built-ins (`node:http`, `node:fs`, `node:path`, `node:crypto`),
so it runs with a plain `node server.js` and deploys to Render with no build step.

**Live:** https://jarvis-backend-8ray.onrender.com
**Admin dashboard:** https://jarvis-backend-8ray.onrender.com/admin?key=<ADMIN_KEY>
**Repo:** https://github.com/dbibi698-commits/jarvis-backend

## What it does

- **Install tracking** — every Jarvis install heartbeats in with a random
  per-device `install_id` + a `device_id` (SHA-256 hash of the phone's
  Android ID — the raw ID is never sent). The server records first seen /
  last seen / device model / app version / last action.
- **One-click ban** — from the `/admin` dashboard the owner can **Ban**
  (permanent), **Suspend** (temporary, default 7 days), **Shutdown**
  (temporary, default 30 days, or permanent), or **Restore** any install —
  and **Ban Device** (blocks every install on that phone).
  A suspended/shutdown install automatically becomes "ok" again when its
  `until` time passes — no cron job needed.
- **Remote control** — the owner can turn Jarvis features on/off for all
  installs, add extra instructions (persona_extra), post an announcement,
  and publish a new app version + APK URL. Every install picks it up on its
  next heartbeat (within ~15 min) and offers the update (one tap to install).
- **Monitoring (consent only)** — if the app user turns ON "Owner
  monitoring" in Jarvis Settings, the app also sends recent activity, which
  permissions it granted, recent chat history, and — only when the owner
  requests it — one screenshot / one camera photo / small text files from
  Jarvis's own workspace. Nothing is collected from a user who did not opt in.
- **Local-first** — the app keeps working fine when this backend is
  unreachable. Only a heartbeat answer of `banned` / `suspended` /
  `shutdown` stops Jarvis on that device.

## Policy — plain and simple

**What the admin CAN see / do:** which installs exist (device, app
version, first/last seen, last action); Ban / Suspend / Shutdown one user
or one whole device in one click; turn features on/off for everyone; add
instructions; post an announcement; publish an app update.

**What the admin sees ONLY when the app user turned ON "Owner monitoring":**
recent activity, which permissions the user granted, recent chat history,
one screenshot (only when requested), one camera photo (only when
requested), small text files from Jarvis's own workspace (only with file
permission).

**What the admin NEVER sees / does:** no passwords, no OTPs, no live
camera video, no live screen stream, no location tracking, no data from
other apps, no silent installs (every update needs one tap on Install), no
phone unlocking. If monitoring is OFF, the admin sees only the install's
device, version and last action — nothing else.

## Run locally

```bash
node server.js            # listens on PORT (default 3000)
ADMIN_KEY=my-secret node server.js
```

Check it: `curl http://localhost:3000/health` → `{"ok":true}`

## Deploy on Render (free)

1. Push this folder to a GitHub repo.
2. Render dashboard → **New → Blueprint** → pick the repo.
   `render.yaml` creates a web service named `jarvis-backend` with
   `startCommand: node server.js` and generates a random `ADMIN_KEY`.
   (Or create the service via the Render API — see the connector doc.)
3. After deploy, open the service URL — e.g.
   `https://jarvis-backend-xxxx.onrender.com/admin?key=<ADMIN_KEY>`
   (find the generated key in Render → service → Environment).
4. The Jarvis app (v1.4.0+) has the backend URL baked in as the default —
   no manual setup needed in the app.

Free-plan note: Render spins the service down after ~15 min idle, so the
first heartbeat after a pause can take ~30–60 s. The app does not depend on
it, so nothing breaks.

## API contract

| Route | Method | Body / query | Response |
|---|---|---|---|
| `/health` | GET | — | `{"ok":true}` |
| `/api/config` | GET | — | public remote config |
| `/api/heartbeat` | POST | `{"install_id","device_id","device_model","app_version","last_action","monitoring","permissions","recent_activity"}` | `{"status","until","message","config","screenshot_requested","camera_requested"}` |
| `/api/event` | POST | `{"install_id","event","detail"}` | `{"ok":true}` |
| `/api/history` | POST | `{"install_id","messages":[{"role","text","at"}]}` | `{"ok":true,"stored":n}` |
| `/api/screenshot` | POST | `{"install_id","image":base64-jpeg}` | `{"ok":true}` |
| `/api/camera-photo` | POST | `{"install_id","image":base64-jpeg}` | `{"ok":true}` |
| `/api/files` | POST | `{"install_id","files":[{"name","content"}]}` | `{"ok":true,"stored":[...]}` |
| `/api/admin/users` | GET | `?key=ADMIN_KEY` | array of users (401 without the key) |
| `/api/admin/config` | GET | `?key=ADMIN_KEY` | full config |
| `/api/admin/config` | POST | `{"key","features","persona_extra","announcement","latest_version","latest_version_code","apk_url"}` | public config |
| `/api/admin/action` | POST | `{"key":ADMIN_KEY,"install_id","action":"ban"\|"suspend"\|"shutdown"\|"restore"\|"ban_device"\|"unban_device"\|"request_screenshot"\|"request_camera","days":number?}` | the updated user / `{ok:true}` |
| `/api/admin/screenshot/<install_id>` | GET | `?key=ADMIN_KEY` | JPEG |
| `/api/admin/camera-photo/<install_id>` | GET | `?key=ADMIN_KEY` | JPEG |
| `/api/admin/file/<install_id>/<name>` | GET | `?key=ADMIN_KEY` | file download |
| `/admin` | GET | `?key=ADMIN_KEY` | HTML dashboard (or a key-entry form) |

User object:
`{"install_id","device_id","device_model","app_version","first_seen","last_seen","status","until","device_status","last_action","monitoring","permissions","recent_activity","events","history_count","last_screenshot_at","last_camera_at","files"}`

Action meanings:
- `ban` — permanent ban (`until: null`).
- `suspend` — temporary, `days` (default 7).
- `shutdown` — temporary if `days > 0` (default 30 via the dashboard
  button), permanent if `days` is `0` or omitted.
- `restore` — status back to `ok`, `until: null`.
- `ban_device` / `unban_device` — ban (or unban) the whole device by
  `device_id` (resolved from `install_id`).
- `request_screenshot` / `request_camera` — the app sends one screenshot /
  one camera photo on its next heartbeat (monitoring ON only).

## Admin key

`ADMIN_KEY` comes from the environment. If it is not set, the server uses
the default `jarvis-admin-123` for local testing — the dashboard shows a
visible warning while the default is in use. On Render, `render.yaml`
generates a random key automatically. Never share the key.

## Limitations

- **Storage is JSON files** (`data/users.json`, `data/devices.json`,
  `data/config.json`, atomic write via temp file + rename). Render's free
  disk is **ephemeral**: data resets on redeploy / restart. Acceptable for
  v2. The upgrade path is a real database (Render Postgres or Supabase).
- **Heartbeat / event / history / screenshot / camera / files / config-read
  have no auth by design** — `install_id` is a random per-device UUID and
  the monitoring data only exists when the user opted in. Admin routes are
  protected by `ADMIN_KEY`.
- **No push**: the app polls via heartbeat; a ban/suspend/config change
  takes effect on the device's next heartbeat (within ~15 min by default).
- Events are capped at the last 20 per install, history at 50, activity at
  20, files at 10 files × 100 KB, to keep storage small.
- **Updates are never silent**: Android requires one tap on Install for any
  sideloaded APK update. The app downloads the APK and shows a
  "tap to install" notification — that is the closest Android allows.
- **Camera/screenshot are single still images on request**, not live video
  or a live screen stream. Live streaming would need a media server and
  constant battery/data use; it is deliberately not built.

# JARVIS backend

Owner control backend for the JARVIS Android app. Zero npm dependencies —
only Node.js built-ins (`node:http`, `node:fs`, `node:path`, `node:crypto`),
so it runs with a plain `node server.js` and deploys to Render with no build step.

## What it does

- **Install tracking** — every Jarvis install heartbeats in with a random
  per-device `install_id`. The server records first seen / last seen /
  device model / app version / last action.
- **Activity** — the app posts events (what the user asked Jarvis to do);
  the last 20 per install are kept.
- **Remote control** — from the `/admin` dashboard the owner can **Ban**
  (permanent), **Suspend** (temporary, default 7 days), **Shutdown**
  (temporary, default 30 days, or permanent), or **Restore** any install.
  A suspended/shutdown install automatically becomes "ok" again when its
  `until` time passes — no cron job needed.
- **Local-first** — the app keeps working fine when this backend is
  unreachable. Only a heartbeat answer of `banned` / `suspended` /
  `shutdown` stops Jarvis on that device.

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
3. After deploy, open the service URL — e.g.
   `https://jarvis-backend-xxxx.onrender.com/admin?key=<ADMIN_KEY>`
   (find the generated key in Render → service → Environment).
4. Put that URL into the Jarvis app (Settings → Backend URL) so the app
   starts heartbeating.

Free-plan note: Render spins the service down after ~15 min idle, so the
first heartbeat after a pause can take ~30–60 s. The app does not depend on
it, so nothing breaks.

## API contract

| Route | Method | Body / query | Response |
|---|---|---|---|
| `/health` | GET | — | `{"ok":true}` |
| `/api/heartbeat` | POST | `{"install_id","device_model","app_version","last_action"}` | `{"status":"ok"\|"banned"\|"suspended"\|"shutdown","until":ISO-or-null,"message":string}` |
| `/api/event` | POST | `{"install_id","event","detail"}` | `{"ok":true}` |
| `/api/admin/users` | GET | `?key=ADMIN_KEY` | array of users (401 without the key) |
| `/api/admin/action` | POST | `{"key":ADMIN_KEY,"install_id","action":"ban"\|"suspend"\|"shutdown"\|"restore","days":number?}` | the updated user (401 wrong key, 404 unknown install) |
| `/admin` | GET | `?key=ADMIN_KEY` | HTML dashboard (or a key-entry form) |

User object:
`{"install_id","device_model","app_version","first_seen","last_seen","status","until","last_action","events":[{"at","event","detail"}]}`

Action meanings:
- `ban` — permanent ban (`until: null`).
- `suspend` — temporary, `days` (default 7).
- `shutdown` — temporary if `days > 0` (default 30 via the dashboard
  button), permanent if `days` is `0` or omitted.
- `restore` — status back to `ok`, `until: null`.

## Admin key

`ADMIN_KEY` comes from the environment. If it is not set, the server uses
the default `jarvis-admin-123` for local testing — the dashboard shows a
visible warning while the default is in use. On Render, `render.yaml`
generates a random key automatically. Never share the key.

## Limitations

- **Storage is a JSON file** (`data/users.json`, atomic write via temp
  file + rename). Render's free disk is **ephemeral**: data resets on
  redeploy / restart. Acceptable for v1. The upgrade path is a real
  database (Render Postgres or Supabase).
- **Heartbeat / event have no auth by design** — `install_id` is a random
  per-device UUID and the data is not sensitive. Admin routes are
  protected by `ADMIN_KEY`.
- **No push**: the app polls via heartbeat; a ban/suspend takes effect on
  the device's next heartbeat (within ~15 min by default).
- Events are capped at the last 20 per install to keep the file small.

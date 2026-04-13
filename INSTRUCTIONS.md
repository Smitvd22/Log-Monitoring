# Log Monitor — Quick Run & UI Test Instructions

This file lists exact commands to run and what to verify for each dashboard button and UI panel.

---

## Workspace
Root of project: d:\U23AI118\SEM 6\CC-LAB\log-monitor

Backend folder: `backend`

Logs: `backend/logs` (files: `app.log`, `anomalies.log`, `alerts.log`)

Scripts: `backend/scripts` (`button_test.js`, `ui_check_full.js`, `ui_headless_check.js`)

---

## 1 — Setup & start (PowerShell commands)

- Install backend deps
```powershell
cd "d:\U23AI118\SEM 6\CC-LAB\log-monitor\backend"
npm install
```

- Start backend (foreground)
```powershell
cd "d:\U23AI118\SEM 6\CC-LAB\log-monitor\backend"
npm start
```

- Start backend dev (auto-reload)
```powershell
npm run dev
```

- Start supporting processes (open separate terminals)
```powershell
# log generator
node src/logGenerator.js

# alert system
node src/alertSystem.js
```

---

## 2 — Quick API checks (PowerShell / curl)

- Health
```powershell
curl http://localhost:3000/health
curl http://localhost:3000/api/health/deep
```

- Stats & logs
```powershell
curl http://localhost:3000/api/stats
curl http://localhost:3000/api/logs?limit=10
curl http://localhost:3000/api/top-errors
```

- Anomalies, heatmap, traces, alerts
```powershell
curl http://localhost:3000/api/anomalies
curl http://localhost:3000/api/heatmap
curl http://localhost:3000/api/alerts
# trace requires a traceId from /api/logs
curl http://localhost:3000/api/trace/<traceId>
```

---

## 3 — Useful scripts (run from `backend`)

- Button automation (inject/cascade/clear)
```powershell
node scripts/button_test.js
```

- Full UI check (fetches anomalies/heatmap/traces)
```powershell
node scripts/ui_check_full.js
```

- Headless UI (Playwright screenshots)
```powershell
npm i -D playwright
npx playwright install chromium
node scripts/ui_headless_check.js
```

Screenshots and results are written to `backend/logs` by the headless script.

---

## 4 — Test mode (safe testing helpers)

These endpoints exist to help testing and are guarded by runtime `testMode`.

- View test mode
```powershell
curl http://localhost:3000/api/debug/testmode
```

- Enable test mode (runtime)
```powershell
curl -X POST http://localhost:3000/api/debug/testmode -H "Content-Type: application/json" -d "{\"enabled\":true}"
```

- Emit synthetic logs (populate buffers)
```powershell
curl -X POST http://localhost:3000/api/debug/emit_logs -H "Content-Type: application/json" -d "{\"count\":100,\"level\":\"ERROR\"}"
```

- Create forced anomaly (immediate)
```powershell
curl -X POST http://localhost:3000/api/debug/force_anomaly -H "Content-Type: application/json" -d "{\"service\":\"test-service\",\"severity\":\"CRITICAL\",\"description\":\"forced test\"}"
```

- Seed baseline for z-score detector
```powershell
curl -X POST http://localhost:3000/api/debug/seed_anomaly -H "Content-Type: application/json" -d "{\"history\":[1,1,2,1,2,1,1,2,1,2,1,1,2,1,1,1,2,1,1,1],\"current\":30}"
```

Note: for safety, `testMode` defaults to off unless set via env `TEST_MODE=true` at startup or enabled runtime via the endpoint above.

---

## 5 — Dashboard buttons: what they do and what to check

Buttons are in the dashboard at `http://localhost:3000/`.

- Pause / Resume
  - Action: toggles client-side live feed rendering (pauses new rows being shown and local interval).
  - Endpoint: none (client-only).
  - What to check:
    - Button text toggles between `⏸ Pause` and `▶ Resume`.
    - When paused: new logs should still be accepted by the server but the UI should not prepend them (open DevTools → console/network to observe no new WS updates applied).
    - Server unaffected: `/api/stats` continues updating.

- Inject Anomaly
  - Action: client posts 8 ERROR logs to `/api/log` in quick succession.
  - Endpoint: `POST /api/log` (multiple requests)
  - What to check:
    - `/api/stats` error count increases after running.
    - `/api/logs` shows recent ERROR entries (use `?limit=20`).
    - `/api/anomalies` may remain empty unless anomaly baseline exists — use test mode seed or force anomaly if required.
    - Log file `backend/logs/app.log` contains the injected messages.

- Cascade
  - Action: posts ERROR logs for several services (api-gateway, order-service, payment-service, auth-service, log-monitor-app).
  - Endpoint: `POST /api/log` repeated for each service.
  - What to check:
    - `/api/stats` bufferSize and ERROR counts increase.
    - `/api/top-errors` will list the repeated messages.
    - UI `Level distribution` / `Top errors` should update (refresh UI or press Inject then fetch state).

- Clear
  - Action: deletes log buffer via `DELETE /api/logs`.
  - Endpoint: `DELETE /api/logs`
  - What to check:
    - `/api/stats` should show `total` ≈ 0 (or small after immediate system logs).
    - `/api/logs` returns empty list.
    - `backend/logs/app.log` is truncated (file may be empty or small).
    - UI stream should be empty (Log table shows "No logs").

---

## 6 — Panels and where to check server-side

- Overview
  - Checks: Top errors (`/api/top-errors`), sources (`/api/stats` -> `sourceCounts`), timeline (`/api/timeline`).

- Live Stream
  - Checks: `/ws/logs` WebSocket; network tab in browser shows WS frames; server broadcasts logs via `broadcastWS()`.

- Anomalies
  - Checks: `/api/anomalies` and file `backend/logs/anomalies.log`.
  - Note: z-score anomaly detection needs historical baseline (20-minute window). Use `seed_anomaly` for immediate tests or `emit_logs` repeatedly to build baseline.

- Heatmap
  - Checks: `/api/heatmap` returns a 7×24 matrix (days × hours). Populate by emitting ERROR logs with different timestamps or wait for real traffic.

- Traces
  - Checks: `traceId` present in logs from `/api/logs`; call `/api/trace/:id` to list spans.

- Alerts
  - Checks: `/api/alerts` (maps to anomaly buffer) and `backend/logs/alerts.log` (if alertSystem writes to file).

---

## 7 — Troubleshooting tips

- If `Cannot GET /` -> ensure `backend` server is running and `dashboard` folder exists; `backend/src/app.js` serves static files from `../dashboard`.
- If anomalies stay at 0:
  - Option A: enable `testMode` and `POST /api/debug/force_anomaly`.
  - Option B: seed baseline using `/api/debug/seed_anomaly` then inject many ERROR logs.
- If headless Playwright fails to run, run `npx playwright install chromium` once and ensure network access.
- To inspect live WS frames: open DevTools → Network → filter `ws` and watch `/ws/logs` frames.

---

## 8 — Files to inspect in repo

- `backend/src/app.js` — main server (routes, anomaly detection, WS, syslog).
- `backend/src/alertSystem.js` — alerting behavior.
- `backend/src/logGenerator.js` — test log generator.
- `dashboard/index.html` — static UI served by the backend.
- `backend/scripts/*` — automation scripts used during verification.

---

If you want, I can run any of the listed commands for you now — tell me which step to run next.

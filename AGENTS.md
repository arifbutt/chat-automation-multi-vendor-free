# AGENTS.md

## What this is

Local browser orchestration framework. Talks to free-tier web AI (Google AI, Gemini, ChatGPT, Claude, Brave Leo) via raw Chrome DevTools Protocol (CDP) WebSocket — no Playwright, no API keys. Chrome must be installed on the host machine.

## Commands

- `npm start` — Launches Express server + Chrome. Chrome opens a visible window.
- `npm test` — Sends a test prompt to `localhost:3000/ask`. **Server must be running first.**
- `npm test "your custom prompt"` — Pass a custom prompt as CLI arg.
- `npm run discover` — Probe all AI services and output DOM structure reports.
- `npm run discover:chatgpt` — Probe a specific service.
- `npm run discover -- --output report.json` — Save discovery report to file.

No lint, typecheck, or test framework. No CI.

## Architecture

```
index.js              → Express API (POST /ask, GET /health)
discover.js           → Standalone reconnaissance CLI (DOM scanning)
src/browser.js        → Chrome spawn, CDP connect, tab session management
src/supervisor.js     → Target polling (2s), prompt queue, reconnection, auto-reconstruct
src/dom.js            → Input/button detection via ARIA roles + spatial analysis (no class selectors)
src/typing.js         → Character-by-character CDP dispatch with stochastic delays
src/monitor.js        → 400ms polling for success/error/security-challenge signatures
src/maintenance.js    → Keep-alive heartbeat every 12min, idle jitter cooldowns
src/state.js          → In-memory state cache (IDLE/TYPING/GENERATING/ERROR_RECOVERY)
src/services/         → Service adapters (base.js interface, registry.js, google-ai.js + 4 stubs)
```

## Critical gotchas

- **Typing uses 3 CDP events, not 2**: `keyDown` (no text) → `char` (with text) → `keyUp`. Using `text` on `keyDown` causes double character insertion.
- **CDP session attachment is required**: `CDP({ port:9222 })` connects to the **browser-level** WebSocket. To run `Runtime.evaluate` on a specific tab, you must call `Target.attachToTarget({ targetId, flatten: true })` to get a `sessionId`, then pass `{ sessionId }` as the second argument to all CDP calls. Without this, DOM queries return `null`.
- **Chrome 136+ requires `--user-data-dir` alongside `--remote-debugging-port`** or the debugging port is ignored. Both are already set in `src/browser.js`.
- **`user_data/` is a real Chrome profile** with authenticated sessions. Do not delete or reset it.
- **Express 5** is used (not 4). Error handling works differently — async errors in route handlers propagate differently than Express 4.
- **`HEADLESS=false`** in `.env` — Chrome opens a visible window. This is intentional (background tabs get throttled).
- **Tab reuse on startup**: The system checks for existing tabs matching the service URL before creating new ones. This prevents duplicate tabs from Chrome's session restore.

## Flags that do NOT exist (do not add back)

The original spec listed these as Chrome flags. They are fabricated — not real Chromium flags:
- `--dont-minify-renderers` — never existed in Chromium source
- `--disable-features=CalculatePageVisibilityToProcessPriority` — wrong name. Real feature: `CalculateNativeWinOcclusion` (which IS used in `src/browser.js`)

## Multi-service support

Adapters in `src/services/` follow the `base.js` abstract interface. To add a new service:
1. Create `src/services/my-service.js` extending `BaseService`
2. Implement all abstract methods (findInput, findSendButton, detectSuccess, detectError, detectSecurityChallenge, extractResponse)
3. Register in `src/services/registry.js`
4. Use `POST /ask` with `{ "prompt": "...", "service": "my-service" }`

Registered services: `google-ai`, `gemini`, `chatgpt`, `claude`, `brave-leo`

## Reconnaissance script (discover.js)

Standalone CLI that visits AI services, scans DOM, and outputs structured JSON reports.

```bash
node discover.js --all                    # Probe all services
node discover.js --service chatgpt        # Probe one service
node discover.js --url https://example.com # Probe custom URL
node discover.js --output report.json     # Save to file
```

The report includes: input selectors, send button selectors, response container selectors, button inventory, iframe inventory, and security challenge detection. Use these reports to populate or update service adapter selectors.

## Key technical details

- **CDP client**: `chrome-remote-interface` npm package. Uses `cdp.Domain.method(params, sessionId)` style.
- **Session routing**: All CDP calls (`Runtime.evaluate`, `Input.dispatchKeyEvent`, `Page.*`, `DOM.*`) must pass `{ sessionId }` as second argument when operating on a specific tab.
- **Google AI URL**: `https://www.google.com/search?udm=50` — the `udm=50` param activates AI Mode.
- **DOM evaluation helper**: `dom.js` exports `evaluate(cdp, expression, sessionId)` which wraps `Runtime.evaluate`. Use this instead of raw CDP calls.
- **Monitor timeout**: Response polling times out after 90s (`MAX_WAIT_MS` in `src/monitor.js`).
- **Supervisor queue**: `enqueuePrompt(text)` returns a Promise. Calling it while processing queues the prompt. The resolved value is `{ result: string }`.
- **Reconnection**: If CDP disconnects, the supervisor auto-reconnects with exponential backoff. If max attempts reached, Chrome is relaunched.

## Environment

- `PORT` (default 3000) — Express server port
- `HEADLESS` (default false) — Chrome visibility (keep false for reliability)

## Test workflow

1. `npm start` (wait for "Initialization complete" log)
2. `npm test` or `curl -X POST http://localhost:3000/ask -H "Content-Type: application/json" -d '{"prompt":"test"}'`
3. `GET /health` returns current state, CDP connection status, and uptime

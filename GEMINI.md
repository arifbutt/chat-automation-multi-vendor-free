# High-Resilience Local Browser Orchestration Framework

## Overview

A local, client-side automation architecture that orchestrates free-tier web AI services through a native browser layer using raw Chrome DevTools Protocol (CDP). Designed to behave as a local configuration layer governing a legitimate, human-authenticated browser process.

## Architecture

### 7-Layer System

| Layer | Module | Purpose |
|-------|--------|---------|
| 1 | `src/browser.js` | Chrome process spawn with hardening flags, CDP connection |
| 2 | `src/supervisor.js` | Lifecycle supervisor, target polling, auto-reconstruction |
| 3 | `src/dom.js` | Layout-agnostic DOM resolution (ARIA, spatial, SVG) |
| 4 | `src/typing.js` | Human-emulated stochastic keystroke dispatch |
| 5 | `src/monitor.js` | Multi-condition monitoring, response parsing |
| 6 | `src/services/` | Service adapters (Google AI, extensible) |
| 7 | `src/maintenance.js` | Anti-timeout, keep-alive, tab focus |

### Service Adapters

- `src/services/base.js` — Abstract interface
- `src/services/google-ai.js` — Google AI implementation

### Supporting Modules

- `src/state.js` — In-memory state cache
- `src/utils.js` — Stochastic timing, logging, helpers

## Stack

- **Runtime**: Node.js (v18+)
- **CDP Client**: `chrome-remote-interface`
- **API**: Express.js
- **Browser**: Chrome (stable, installed on host)

## Installation

```bash
npm install
```

## Usage

1. Start the server:
   ```bash
   npm start
   ```

2. Send a prompt:
   ```bash
   curl -X POST http://localhost:3000/ask -H "Content-Type: application/json" -d '{"prompt": "What is the capital of France?"}'
   ```

3. Check health:
   ```bash
   curl http://localhost:3000/health
   ```

## Key Design Principles

- **Human Emulation Mimicry**: Stochastic typing delays, natural pauses
- **Layout Agnostic**: No class-name dependencies, uses ARIA roles and spatial analysis
- **Self-Healing**: Auto-reconstruction on tab/process crashes
- **Zero Cloud Overhead**: Runs entirely locally via CDP WebSocket

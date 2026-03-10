# FlareSign Keep-Alive Bot

A **zero-Mineflayer** Minecraft server keep-alive bot built on raw TCP with a custom Minecraft protocol implementation.

Supports **1.21.0 → 1.21.11** (protocol versions 767–774) with automatic fallback, newest-first.

---

## Features

- 🔌 **Custom protocol** — pure Node.js TCP, no Mineflayer
- 🔄 **Auto-reconnect** — reconnects on disconnect or error
- 🔀 **Protocol auto-fallback** — tries 774 → 773 → ... → 767 if kicked (all 1.21.x)
- 🚶 **Human-like movement** — random walk, idle, head-look, smooth turns
- ⚙️ **Env-based config** — set server + bot name via `.env` or environment
- 📊 **Live stats** — real-time position, keep-alive count, uptime in terminal

---

## Requirements

- Node.js ≥ 18
- Offline-mode Minecraft server (`online-mode=false` in `server.properties`)

> **Note:** Online-mode servers require Microsoft/Mojang auth tokens (not implemented).  
> This bot is designed for private offline-mode servers or LAN servers.

---

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure
cp .env.example .env
# Edit .env and set MC_HOST (and optionally MC_PORT, BOT_NAME)

# 3. Run
npm start
```

Or with inline env vars:
```bash
MC_HOST=my.server.com BOT_NAME=CoolBot node index.js
```

---

## Environment Variables

| Variable   | Required | Default     | Description                        |
|------------|----------|-------------|------------------------------------|
| `MC_HOST`  | ✅ Yes   | —           | Server hostname or IP              |
| `MC_PORT`  | No       | `25565`     | Server port                        |
| `BOT_NAME` | No       | `FlareBot`  | In-game bot username               |
| `DEBUG`    | No       | `false`     | Log every packet (verbose mode)    |

---

## How it works

### Connection flow
```
TCP connect
  → Handshake (0x00) [HANDSHAKING]
  → Login Start (0x00) [LOGIN]
  ← Login Success (0x02)
  → Login Acknowledged (0x03)
  [CONFIGURATION]
  ← Known Packs (0x0E) → reply with 0 packs
  ← Registry Data (0x07) → ignored
  ← Finish Configuration (0x03)
  → Client Information (0x00)
  → Finish Configuration (0x03)
  [PLAY]
  ← Play Login (0x2B) → send Client Information
  ← Synchronize Player Position (0x40) → Confirm Teleport (0x00)
  ↔ Keep Alive (every ~20s, automatic)
  → Set Player Position And Rotation (0x1B) every tick
```

### Movement engine
Every Minecraft tick (50ms) the bot picks one of four behaviour states:
- **Idle** (30%) — micro head drift, standing still
- **Walking** (35%) — moves in a random direction with slight speed variation
- **Turning** (20%) — smooth yaw rotation to a random heading
- **Looking** (15%) — smooth pitch change (looking up/down)

State durations are randomised so the movement pattern never repeats.

---

## Compression

Servers with `network-compression-threshold` enabled will send `Set Compression` during login. The bot currently does **not** implement zlib compression (most small/private servers leave this at the default or disable it). If your server requires compression, you'll see a warning and the bot will fail to parse packets after the threshold is set. Open an issue to request compression support.

---


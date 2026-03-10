'use strict';

const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { PacketReader, PacketWriter, framePacket } = require('./buffer');
const PacketSplitter = require('./splitter');
const HumanMovement = require('./movement');

/**
 * Supported protocol versions (newest → oldest fallback order):
 *   774 → 1.21.11
 *   773 → 1.21.9, 1.21.10
 *   772 → 1.21.7, 1.21.8
 *   771 → 1.21.6
 *   770 → 1.21.5
 *   769 → 1.21.4
 *   768 → 1.21.2, 1.21.3
 *   767 → 1.21.0, 1.21.1
 */
const PROTOCOL_VERSION = 774;
const STATES = { HANDSHAKING: 0, STATUS: 1, LOGIN: 2, CONFIGURATION: 3, PLAY: 4 };

// How long to wait after "Connection throttled" before retrying (ms)
const THROTTLE_RETRY_MS = 8000;
// Normal reconnect delay once the protocol is locked
const RECONNECT_MS = 5000;

class MinecraftBot extends EventEmitter {
  constructor(opts) {
    super();
    this.host     = opts.host;
    this.port     = opts.port || 25565;
    this.username = opts.username || 'FlareBot';
    this.debug    = opts.debug || false;

    this._state      = STATES.HANDSHAKING;
    this._socket     = null;
    this._splitter   = new PacketSplitter();
    this._movement   = new HumanMovement(this);
    this._connected  = false;
    this._loginAttempts = 0;
    this._keepAlivesSent = 0;
    this._keepAlivesRecv = 0;

    // Protocol negotiation
    this._protocolFallbacks = [774, 773, 772, 771, 770, 769, 768, 767];
    this._protocolIdx       = 0;
    this.protocol           = PROTOCOL_VERSION;
    this._protocolLocked    = false; // once true, never change protocol again

    // Single reconnect timer — only one reconnect can ever be pending
    this._reconnectTimer = null;
    // Set to true by packet handlers that want to drive the next connect()
    // themselves, preventing socket 'close' from also scheduling one.
    this._reconnectHandled = false;
  }

  // ─── Logging ───────────────────────────────────────────────────────────────

  log(msg)  {
    const ts = new Date().toISOString().replace('T',' ').slice(0,19);
    console.log(`\x1b[36m[${ts}]\x1b[0m ${msg}`);
  }
  warn(msg) {
    const ts = new Date().toISOString().replace('T',' ').slice(0,19);
    console.log(`\x1b[33m[${ts}] WARN\x1b[0m ${msg}`);
  }
  error(msg){
    const ts = new Date().toISOString().replace('T',' ').slice(0,19);
    console.log(`\x1b[31m[${ts}] ERROR\x1b[0m ${msg}`);
  }

  // ─── Connection management ─────────────────────────────────────────────────

  connect() {
    // Clear any pending reconnect before opening a new socket
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    this._loginAttempts++;
    this._reconnectHandled = false;
    this._state    = STATES.HANDSHAKING;
    this._splitter = new PacketSplitter();
    this._movement.stop();

    this.log(
      `Connecting to ${this.host}:${this.port} as \x1b[32m${this.username}\x1b[0m` +
      ` (protocol ${this.protocol}${this._protocolLocked ? ' \x1b[32m[locked]\x1b[0m' : ''}, attempt #${this._loginAttempts})`
    );

    const socket = net.createConnection({ host: this.host, port: this.port });
    this._socket = socket;

    socket.on('connect', () => {
      this._connected = true;
      this.log('TCP connected → sending handshake');
      this._sendHandshake();
      this._sendLoginStart();
    });

    socket.on('data', chunk => this._splitter.push(chunk));

    this._splitter.on('packet', raw => {
      try { this._handleRaw(raw); }
      catch (e) { this.warn(`Packet handling error: ${e.message}\n${e.stack}`); }
    });

    socket.on('error', err => {
      this.error(`Socket error: ${err.message}`);
    });

    socket.on('close', () => {
      this._connected = false;
      this._movement.stop();
      // Only schedule a reconnect here if the packet handler didn't already do it
      if (!this._reconnectHandled) {
        this.log(`Disconnected. Reconnecting in ${RECONNECT_MS / 1000}s…`);
        this._scheduleReconnect(RECONNECT_MS);
      }
    });
  }

  _scheduleReconnect(delayMs) {
    if (this._reconnectTimer) return; // already pending
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  /** Destroy socket and schedule next connect, preventing the close handler from also doing it */
  _reconnectAfter(delayMs, logMsg) {
    this._reconnectHandled = true; // tell close handler to stand down
    if (logMsg) this.log(logMsg);
    this._socket.destroy();
    this._scheduleReconnect(delayMs);
  }

  // ─── Packet sending ────────────────────────────────────────────────────────

  _send(packetId, writer) {
    if (!this._socket || !this._connected) return;
    const frame = framePacket(packetId, writer.toBuffer());
    if (this.debug) this.log(`  → 0x${packetId.toString(16).padStart(2,'0')} (${frame.length}b)`);
    this._socket.write(frame);
  }

  _sendHandshake() {
    const w = new PacketWriter();
    w.writeVarInt(this.protocol);
    w.writeString(this.host);
    w.writeUShort(this.port);
    w.writeVarInt(2); // next state: login
    this._send(0x00, w);
    this._state = STATES.LOGIN;
  }

  _sendLoginStart() {
    const w = new PacketWriter();
    w.writeString(this.username);
    w.writeUUID('00000000-0000-0000-0000-000000000000');
    this._send(0x00, w);
  }

  sendPosition(x, y, z, yaw, pitch, onGround) {
    if (this._state !== STATES.PLAY) return;
    const w = new PacketWriter();
    w.writeDouble(x).writeDouble(y).writeDouble(z);
    w.writeFloat(yaw).writeFloat(pitch);
    w.writeByte(onGround ? 1 : 0);
    this._send(0x1B, w);
  }

  // ─── Packet dispatch ───────────────────────────────────────────────────────

  _handleRaw(raw) {
    const reader = new PacketReader(raw);
    const id = reader.readVarInt();
    if (this.debug) this.log(`  ← 0x${id.toString(16).padStart(2,'0')} [${Object.keys(STATES)[this._state]}]`);
    switch (this._state) {
      case STATES.LOGIN:         return this._handleLogin(id, reader);
      case STATES.CONFIGURATION: return this._handleConfig(id, reader);
      case STATES.PLAY:          return this._handlePlay(id, reader);
    }
  }

  // ── LOGIN ──────────────────────────────────────────────────────────────────

  _handleLogin(id, r) {
    switch (id) {
      case 0x00: return this._onLoginDisconnect(r);
      case 0x01: return this._onEncryptionRequest(r);
      case 0x02: return this._onLoginSuccess(r);
      case 0x03: return this._onSetCompression(r);
      case 0x04: return this._onLoginPluginRequest(r);
    }
  }

  _onLoginDisconnect(r) {
    const reason = r.readString();
    this.error(`Login disconnected: ${reason}`);

    // ── Throttle: server is rate-limiting us ──────────────────────────────
    // This is NOT a version mismatch. Lock the current protocol (if we already
    // found the right one) and wait before retrying — don't blast through the
    // fallback list.
    if (/throttl/i.test(reason)) {
      if (!this._protocolLocked && this._protocolIdx > 0) {
        // We already successfully identified the version last attempt.
        // The correct protocol is the current one — lock it.
        this._protocolLocked = true;
        this.warn(`Throttled. Protocol ${this.protocol} locked in. Waiting ${THROTTLE_RETRY_MS/1000}s…`);
      } else if (this._protocolLocked) {
        this.warn(`Throttled (protocol ${this.protocol} locked). Waiting ${THROTTLE_RETRY_MS/1000}s…`);
      } else {
        // Throttled before we even negotiated a version — just wait and retry same protocol
        this.warn(`Throttled before version negotiation. Waiting ${THROTTLE_RETRY_MS/1000}s…`);
      }
      this._reconnectAfter(THROTTLE_RETRY_MS);
      return;
    }

    // ── Version mismatch: parse the MC version from the kick message ──────
    // Handles both:
    //   "Outdated client! Please use 1.21.8"
    //   "Outdated server! I'm still on 1.21.4"
    const versionMatch = reason.match(/1\.21\.(\d+)/);
    if (versionMatch) {
      const mcMinor = parseInt(versionMatch[1], 10);
      const target  = this._mcVersionToProtocol(mcMinor);
      if (target) {
        this.warn(`Server is on 1.21.${mcMinor} → jumping to protocol ${target}`);
        this.protocol      = target;
        this._protocolIdx  = this._protocolFallbacks.indexOf(target);
        if (this._protocolIdx === -1) this._protocolIdx = 0;
        this._reconnectAfter(1500);
        return;
      }
    }

    // ── Generic version mismatch / unknown kick: step down one protocol ───
    this._stepProtocolDown();
  }

  /** Map a 1.21.x minor version number to its protocol number */
  _mcVersionToProtocol(minor) {
    const map = { 0:767, 1:767, 2:768, 3:768, 4:769, 5:770, 6:771, 7:772, 8:772, 9:773, 10:773, 11:774 };
    return map[minor] ?? null;
  }

  /** Step down one protocol in the fallback list, or give up and reset */
  _stepProtocolDown() {
    if (this._protocolLocked) {
      // Protocol is locked — just reconnect with the same one
      this._reconnectAfter(RECONNECT_MS, `Reconnecting with locked protocol ${this.protocol}…`);
      return;
    }

    this._protocolIdx++;
    if (this._protocolIdx < this._protocolFallbacks.length) {
      this.protocol = this._protocolFallbacks[this._protocolIdx];
      this.warn(`Trying protocol version ${this.protocol}…`);
      this._reconnectAfter(1500);
    } else {
      this.error('All protocol versions exhausted. Waiting 15s before retrying from top…');
      this._protocolIdx = 0;
      this.protocol = this._protocolFallbacks[0];
      this._reconnectAfter(15000);
    }
  }

  _onEncryptionRequest(r) {
    r.readString();           // serverId
    r.readBytes(r.readVarInt()); // pubKey
    r.readBytes(r.readVarInt()); // verifyToken
    this.warn('Server requires online-mode encryption — this bot only supports offline-mode servers.');
    this._reconnectAfter(30000, 'Pausing 30s (online-mode server)…');
  }

  _onLoginSuccess(r) {
    const uuid     = r.readUUID();
    const username = r.readString();
    const propCount = r.readVarInt();
    for (let i = 0; i < propCount; i++) {
      r.readString(); r.readString();
      if (r.readBoolean()) r.readString();
    }

    // ✅ Login succeeded — lock the protocol forever
    if (!this._protocolLocked) {
      this._protocolLocked = true;
      this.log(`\x1b[32mLogin success!\x1b[0m UUID=${uuid} Name=${username} — protocol ${this.protocol} \x1b[32mlocked\x1b[0m`);
    } else {
      this.log(`\x1b[32mLogin success!\x1b[0m UUID=${uuid} Name=${username}`);
    }
    this._loginAttempts = 0;

    this._send(0x03, new PacketWriter()); // Login Acknowledged
    this._state = STATES.CONFIGURATION;
    this.log('State → CONFIGURATION');
  }

  _onSetCompression(r) {
    const threshold = r.readVarInt();
    if (this.debug) this.log(`Set compression threshold: ${threshold} (not implemented)`);
  }

  _onLoginPluginRequest(r) {
    const messageId = r.readVarInt();
    r.readString(); // channel
    const w = new PacketWriter();
    w.writeVarInt(messageId);
    w.writeBoolean(false);
    this._send(0x02, w);
  }

  // ── CONFIGURATION ──────────────────────────────────────────────────────────

  _handleConfig(id, r) {
    switch (id) {
      case 0x00: return this._onConfigCookieRequest(r);
      case 0x01: return this._onConfigPluginMessage(r);
      case 0x02: return this._onConfigDisconnect(r);
      case 0x03: return this._onConfigFinish(r);
      case 0x04: return this._onConfigKeepAlive(r);
      case 0x05: return this._onConfigPing(r);
      case 0x07: return; // Registry data — ignore
      case 0x0E: return this._onKnownPacks(r);
      // silently ignore everything else
    }
  }

  _onConfigCookieRequest(r) {
    const key = r.readString();
    const w = new PacketWriter();
    w.writeString(key).writeBoolean(false);
    this._send(0x01, w);
  }

  _onConfigPluginMessage(r) {
    const channel = r.readString();
    if (this.debug) this.log(`  Config plugin message: ${channel}`);
    if (channel === 'minecraft:brand') {
      const w = new PacketWriter();
      w.writeString('minecraft:brand');
      w.writeBytes(Buffer.from('\x06Flare'));
      this._send(0x00, w);
    }
  }

  _onConfigDisconnect(r) {
    this.error(`Configuration disconnect: ${r.readString()}`);
    this._reconnectAfter(RECONNECT_MS);
  }

  _onConfigFinish(r) {
    this.log('Config finish → sending client info + finish');
    this._sendClientInformation(true);
    this._send(0x03, new PacketWriter()); // Finish Configuration
    this._state = STATES.PLAY;
    this.log('State → PLAY');
    this.emit('spawn');
  }

  _onConfigKeepAlive(r) {
    const id = r.readLong();
    const w = new PacketWriter();
    w.writeLong(id);
    this._send(0x04, w);
    this._keepAlivesSent++;
  }

  _onConfigPing(r) {
    const id = r.readInt();
    const w = new PacketWriter();
    w.writeInt(id);
    this._send(0x05, w);
  }

  _onKnownPacks(r) {
    const w = new PacketWriter();
    w.writeVarInt(0); // 0 known packs
    this._send(0x07, w);
  }

  _sendClientInformation(inConfig = false) {
    const w = new PacketWriter();
    w.writeString('en_us');
    w.writeByte(8);           // view distance
    w.writeVarInt(0);         // chat mode: enabled
    w.writeBoolean(true);     // chat colors
    w.writeByte(0x7F);        // all skin parts
    w.writeVarInt(1);         // main hand: right
    w.writeBoolean(false);    // text filtering
    w.writeBoolean(true);     // server listings
    this._send(inConfig ? 0x00 : 0x0A, w);
  }

  // ── PLAY ───────────────────────────────────────────────────────────────────

  _handlePlay(id, r) {
    switch (id) {
      case 0x00: return; // Bundle delimiter
      case 0x1D: return this._onPlayDisconnect(r);
      case 0x26: return this._onPlayKeepAlive(r);
      case 0x2B: return this._onPlayLogin(r);
      case 0x38: return this._onPlayPing(r);
      case 0x40: return this._onSynchronizePosition(r);
    }
  }

  _onPlayDisconnect(r) {
    this.error(`Play disconnect: ${r.readString()}`);
    this._reconnectAfter(RECONNECT_MS);
  }

  _onPlayKeepAlive(r) {
    const id = r.readLong();
    const w = new PacketWriter();
    w.writeLong(id);
    this._send(0x18, w);
    this._keepAlivesSent++;
    this._keepAlivesRecv++;
    if (this.debug) this.log(`  KeepAlive ↔ ${id}`);
  }

  _onPlayLogin(r) {
    const entityId = r.readInt();
    r.readBoolean(); // hardcore
    const dimCount = r.readVarInt();
    for (let i = 0; i < dimCount; i++) r.readString();
    const maxPlayers = r.readVarInt();
    this.log(`\x1b[32mPlay login!\x1b[0m EntityID=${entityId} MaxPlayers=${maxPlayers}`);
    this._sendClientInformation(false);
  }

  _onPlayPing(r) {
    const id = r.readInt();
    const w = new PacketWriter();
    w.writeInt(id);
    this._send(0x36, w);
  }

  _onSynchronizePosition(r) {
    const x    = r.readDouble();
    const y    = r.readDouble();
    const z    = r.readDouble();
    const yaw  = r.readFloat();
    const pitch= r.readFloat();
    r.readByte(); // flags
    const teleportId = r.readVarInt();

    this.log(`Teleport → (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}) yaw=${yaw.toFixed(1)}`);

    const w = new PacketWriter();
    w.writeVarInt(teleportId);
    this._send(0x00, w); // Confirm Teleport

    this._movement.setSpawn(x, y, z);
    this._movement.yaw   = yaw;
    this._movement.pitch = pitch;
    if (!this._movement._tickInterval) this._movement.start();
  }
}

module.exports = MinecraftBot;

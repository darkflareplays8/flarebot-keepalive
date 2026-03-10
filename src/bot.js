'use strict';

const net    = require('net');
const zlib   = require('zlib');
const { EventEmitter } = require('events');
const { PacketReader, PacketWriter, framePacket } = require('./buffer');
const PacketSplitter = require('./splitter');
const HumanMovement  = require('./movement');

/**
 * Protocol version map (1.21.0 – 1.21.11):
 *   774 → 1.21.11   773 → 1.21.9/10   772 → 1.21.7/8   771 → 1.21.6
 *   770 → 1.21.5    769 → 1.21.4      768 → 1.21.2/3   767 → 1.21.0/1
 */
const PROTOCOL_VERSION  = 774;
const STATES = { HANDSHAKING:0, STATUS:1, LOGIN:2, CONFIGURATION:3, PLAY:4 };

const THROTTLE_RETRY_MS = 12000; // wait after throttle kick
const RECONNECT_MS      = 5000;  // normal reconnect delay

class MinecraftBot extends EventEmitter {
  constructor(opts) {
    super();
    this.host     = opts.host;
    this.port     = opts.port || 25565;
    this.username = opts.username || 'FlareBot';
    this.debug    = opts.debug || false;

    this._state   = STATES.HANDSHAKING;
    this._socket  = null;
    this._splitter = new PacketSplitter();
    this._movement = new HumanMovement(this);
    this._connected = false;
    this._loginAttempts  = 0;
    this._keepAlivesSent = 0;
    this._keepAlivesRecv = 0;

    // Compression state (set by Set Compression packet)
    this._compressionThreshold = -1; // -1 = disabled

    // Protocol negotiation
    this._protocolFallbacks = [774, 773, 772, 771, 770, 769, 768, 767];
    this._protocolIdx       = 0;
    this.protocol           = PROTOCOL_VERSION;
    this._protocolLocked    = false;

    this._reconnectTimer   = null;
    this._reconnectHandled = false;
  }

  // ─── Logging ───────────────────────────────────────────────────────────────

  log(msg)  { console.log(`\x1b[36m[${this._ts()}]\x1b[0m ${msg}`); }
  warn(msg) { console.log(`\x1b[33m[${this._ts()}] WARN\x1b[0m ${msg}`); }
  error(msg){ console.log(`\x1b[31m[${this._ts()}] ERROR\x1b[0m ${msg}`); }
  _ts()     { return new Date().toISOString().replace('T',' ').slice(0,19); }

  // ─── Connection management ─────────────────────────────────────────────────

  connect() {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }

    this._loginAttempts++;
    this._reconnectHandled    = false;
    this._compressionThreshold = -1;  // reset per-connection
    this._state   = STATES.HANDSHAKING;
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

    // Splitter gives us length-stripped raw frames.
    // If compression is active, each frame is: [dataLen VarInt][payload]
    // where dataLen=0 means uncompressed, dataLen>0 means zlib payload.
    this._splitter.on('packet', raw => {
      try { this._handleFrame(raw); }
      catch (e) { this.warn(`Packet error: ${e.message}`); if (this.debug) console.error(e.stack); }
    });

    socket.on('error', err => this.error(`Socket error: ${err.message}`));

    socket.on('close', () => {
      this._connected = false;
      this._movement.stop();
      if (!this._reconnectHandled) {
        this.log(`Disconnected. Reconnecting in ${RECONNECT_MS/1000}s…`);
        this._scheduleReconnect(RECONNECT_MS);
      }
    });
  }

  _scheduleReconnect(ms) {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => { this._reconnectTimer = null; this.connect(); }, ms);
  }

  _reconnectAfter(ms, msg) {
    this._reconnectHandled = true;
    if (msg) this.log(msg);
    this._socket.destroy();
    this._scheduleReconnect(ms);
  }

  // ─── Compression-aware frame handler ──────────────────────────────────────

  _handleFrame(raw) {
    let payload;

    if (this._compressionThreshold >= 0) {
      // Compressed mode: [dataLen VarInt][data]
      const r = new PacketReader(raw);
      const dataLen = r.readVarInt();
      const data    = r.readBytes(r.remaining);

      if (dataLen === 0) {
        // Uncompressed (packet was below threshold)
        payload = data;
      } else {
        // Compressed — synchronous inflate
        try {
          payload = zlib.inflateSync(data);
        } catch (e) {
          this.warn(`zlib inflate failed: ${e.message}`);
          return;
        }
      }
    } else {
      // No compression — raw is just [packetId VarInt][payload]
      payload = raw;
    }

    const r = new PacketReader(payload);
    const id = r.readVarInt();
    if (this.debug) this.log(`  ← 0x${id.toString(16).padStart(2,'0')} [${Object.keys(STATES)[this._state]}]${this._compressionThreshold>=0?' (compressed)':''}`);

    switch (this._state) {
      case STATES.LOGIN:         return this._handleLogin(id, r);
      case STATES.CONFIGURATION: return this._handleConfig(id, r);
      case STATES.PLAY:          return this._handlePlay(id, r);
    }
  }

  // ─── Packet sending ────────────────────────────────────────────────────────

  _send(packetId, writer) {
    if (!this._socket || !this._connected) return;

    const payload = writer.toBuffer();
    let frame;

    if (this._compressionThreshold >= 0) {
      // Build compression-mode packet: [packetId][payload] optionally compressed
      const inner = Buffer.concat([this._varIntBuf(packetId), payload]);
      if (inner.length >= this._compressionThreshold) {
        const compressed = zlib.deflateSync(inner);
        const lenBuf = this._varIntBuf(inner.length); // dataLen = uncompressed size
        const outer  = Buffer.concat([lenBuf, compressed]);
        frame = Buffer.concat([this._varIntBuf(outer.length), outer]);
      } else {
        // Below threshold: dataLen = 0
        const outer = Buffer.concat([Buffer.from([0x00]), inner]);
        frame = Buffer.concat([this._varIntBuf(outer.length), outer]);
      }
    } else {
      frame = framePacket(packetId, payload);
    }

    if (this.debug) this.log(`  → 0x${packetId.toString(16).padStart(2,'0')} (${frame.length}b)`);
    this._socket.write(frame);
  }

  _varIntBuf(val) {
    const w = new PacketWriter();
    w.writeVarInt(val);
    return w.toBuffer();
  }

  _sendHandshake() {
    const w = new PacketWriter();
    w.writeVarInt(this.protocol);
    w.writeString(this.host);
    w.writeUShort(this.port);
    w.writeVarInt(2);
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

  // ─── Disconnect reason parser ─────────────────────────────────────────────
  // MC 1.20.3+ sends disconnect reason as an NBT Text Component, not a plain
  // JSON string. We handle both formats and extract plain text from either.

  _parseDisconnectReason(r) {
    // Try to read as a standard MC String (VarInt length prefix + UTF8)
    // In pre-1.20.3: it's a JSON string like {"text":"..."}
    // In 1.20.3+: it's an NBT-encoded Text Component
    //
    // We attempt JSON parse first. If that fails we do a best-effort
    // extraction of any readable text from the buffer.
    const raw = r.readString();

    // Attempt JSON
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'string') return parsed;
      if (parsed && typeof parsed.text === 'string') return parsed.text;
      if (parsed && Array.isArray(parsed.extra)) {
        return (parsed.text || '') + parsed.extra.map(e => e.text || '').join('');
      }
      return raw;
    } catch (_) {}

    // Return raw string as-is (may be NBT bytes rendered as string, or just text)
    return raw;
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
    const reason = this._parseDisconnectReason(r);
    this.error(`Login disconnected: ${reason}`);

    // Throttle — DO NOT change protocol, just wait
    if (/throttl/i.test(reason) || reason === '/' || reason.length <= 2) {
      // '/' or short garbage = likely throttle with compressed/NBT packet we
      // couldn't fully parse, or Aternos's minimal throttle response.
      const isThrottle = /throttl/i.test(reason) || reason.length <= 2;
      if (isThrottle) {
        this._protocolLocked = true; // lock whatever we have
        this.warn(`Throttled (protocol ${this.protocol} locked). Waiting ${THROTTLE_RETRY_MS/1000}s…`);
        this._reconnectAfter(THROTTLE_RETRY_MS);
        return;
      }
    }

    // Version mismatch — jump straight to the right protocol
    const m = reason.match(/1\.21\.(\d+)/);
    if (m) {
      const target = this._mcVersionToProtocol(parseInt(m[1], 10));
      if (target) {
        this.warn(`Server is on 1.21.${m[1]} → jumping to protocol ${target}`);
        this.protocol     = target;
        this._protocolIdx = this._protocolFallbacks.indexOf(target);
        if (this._protocolIdx < 0) this._protocolIdx = 0;
        this._reconnectAfter(1500);
        return;
      }
    }

    // Unknown kick — if locked just reconnect, else step down
    this._stepProtocolDown();
  }

  _mcVersionToProtocol(minor) {
    const map = { 0:767,1:767,2:768,3:768,4:769,5:770,6:771,7:772,8:772,9:773,10:773,11:774 };
    return map[minor] ?? null;
  }

  _stepProtocolDown() {
    if (this._protocolLocked) {
      this._reconnectAfter(RECONNECT_MS, `Reconnecting (protocol ${this.protocol} locked)…`);
      return;
    }
    this._protocolIdx++;
    if (this._protocolIdx < this._protocolFallbacks.length) {
      this.protocol = this._protocolFallbacks[this._protocolIdx];
      this.warn(`Trying protocol ${this.protocol}…`);
      this._reconnectAfter(1500);
    } else {
      this.error('All protocols exhausted. Waiting 15s…');
      this._protocolIdx = 0;
      this.protocol = this._protocolFallbacks[0];
      this._reconnectAfter(15000);
    }
  }

  _onSetCompression(r) {
    const threshold = r.readVarInt();
    this._compressionThreshold = threshold;
    this.log(`Compression enabled (threshold: ${threshold} bytes)`);
  }

  _onEncryptionRequest(r) {
    r.readString(); r.readBytes(r.readVarInt()); r.readBytes(r.readVarInt());
    this.warn('Server requires online-mode — bot only supports offline-mode servers.');
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

  _onLoginPluginRequest(r) {
    const messageId = r.readVarInt(); r.readString();
    const w = new PacketWriter();
    w.writeVarInt(messageId).writeBoolean(false);
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
    if (this.debug) this.log(`  Plugin message: ${channel}`);
    if (channel === 'minecraft:brand') {
      const w = new PacketWriter();
      w.writeString('minecraft:brand').writeBytes(Buffer.from('\x06Flare'));
      this._send(0x00, w);
    }
  }

  _onConfigDisconnect(r) {
    this.error(`Config disconnect: ${this._parseDisconnectReason(r)}`);
    this._reconnectAfter(RECONNECT_MS);
  }

  _onConfigFinish(r) {
    this.log('Config finish → PLAY');
    this._sendClientInformation(true);
    this._send(0x03, new PacketWriter());
    this._state = STATES.PLAY;
    this.emit('spawn');
  }

  _onConfigKeepAlive(r) {
    const id = r.readLong();
    const w = new PacketWriter(); w.writeLong(id);
    this._send(0x04, w); this._keepAlivesSent++;
  }

  _onConfigPing(r) {
    const id = r.readInt();
    const w = new PacketWriter(); w.writeInt(id);
    this._send(0x05, w);
  }

  _onKnownPacks(r) {
    const w = new PacketWriter(); w.writeVarInt(0);
    this._send(0x07, w);
  }

  _sendClientInformation(inConfig = false) {
    const w = new PacketWriter();
    w.writeString('en_us').writeByte(8).writeVarInt(0)
     .writeBoolean(true).writeByte(0x7F).writeVarInt(1)
     .writeBoolean(false).writeBoolean(true);
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
    this.error(`Play disconnect: ${this._parseDisconnectReason(r)}`);
    this._reconnectAfter(RECONNECT_MS);
  }

  _onPlayKeepAlive(r) {
    const id = r.readLong();
    const w = new PacketWriter(); w.writeLong(id);
    this._send(0x18, w);
    this._keepAlivesSent++; this._keepAlivesRecv++;
    if (this.debug) this.log(`  KeepAlive ↔ ${id}`);
  }

  _onPlayLogin(r) {
    const entityId = r.readInt(); r.readBoolean();
    const dimCount = r.readVarInt();
    for (let i = 0; i < dimCount; i++) r.readString();
    const maxPlayers = r.readVarInt();
    this.log(`\x1b[32mPlay login!\x1b[0m EntityID=${entityId} MaxPlayers=${maxPlayers}`);
    this._sendClientInformation(false);
  }

  _onPlayPing(r) {
    const id = r.readInt();
    const w = new PacketWriter(); w.writeInt(id);
    this._send(0x36, w);
  }

  _onSynchronizePosition(r) {
    const x = r.readDouble(), y = r.readDouble(), z = r.readDouble();
    const yaw = r.readFloat(), pitch = r.readFloat();
    r.readByte();
    const teleportId = r.readVarInt();
    this.log(`Teleport → (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}) yaw=${yaw.toFixed(1)}`);
    const w = new PacketWriter(); w.writeVarInt(teleportId);
    this._send(0x00, w);
    this._movement.setSpawn(x, y, z);
    this._movement.yaw = yaw; this._movement.pitch = pitch;
    if (!this._movement._tickInterval) this._movement.start();
  }
}

module.exports = MinecraftBot;

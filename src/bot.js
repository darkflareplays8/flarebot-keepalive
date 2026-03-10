'use strict';

const net  = require('net');
const zlib = require('zlib');
const { EventEmitter } = require('events');
const { PacketReader, PacketWriter, framePacket } = require('./buffer');
const PacketSplitter = require('./splitter');
const HumanMovement  = require('./movement');

/**
 * Protocol version map (1.21.0 – 1.21.11):
 *   774→1.21.11  773→1.21.9/10  772→1.21.7/8  771→1.21.6
 *   770→1.21.5   769→1.21.4     768→1.21.2/3  767→1.21.0/1
 */
const PROTOCOL_VERSION = 774;
const STATES = { HANDSHAKING:0, STATUS:1, LOGIN:2, CONFIGURATION:3, PLAY:4 };
const THROTTLE_RETRY_MS = 12000;
const RECONNECT_MS      = 5000;

// ─── NBT Text Component parser ─────────────────────────────────────────────────
// MC 1.20.3+ sends disconnect reasons as NBT, not JSON strings.
// We just need to extract the plain text — no need for a full NBT impl.
function extractNbtText(buf) {
  // NBT tag types
  const TAG_BYTE=1, TAG_SHORT=2, TAG_INT=3, TAG_LONG=4, TAG_FLOAT=5,
        TAG_DOUBLE=6, TAG_BYTE_ARRAY=7, TAG_STRING=8, TAG_LIST=9,
        TAG_COMPOUND=10, TAG_INT_ARRAY=11, TAG_LONG_ARRAY=12;

  let off = 0;
  const strings = [];

  function readType()   { return buf[off++]; }
  function readByte()   { return buf[off++]; }
  function readShort()  { const v = buf.readInt16BE(off); off+=2; return v; }
  function readUShort() { const v = buf.readUInt16BE(off); off+=2; return v; }
  function readInt()    { const v = buf.readInt32BE(off); off+=4; return v; }
  function readLong()   { off+=8; }
  function readFloat()  { off+=4; }
  function readDouble() { off+=8; }
  function readString() {
    const len = readUShort();
    const s = buf.slice(off, off+len).toString('utf8');
    off += len;
    return s;
  }

  function skipPayload(type) {
    switch(type) {
      case TAG_BYTE:       readByte(); break;
      case TAG_SHORT:      readShort(); break;
      case TAG_INT:        readInt(); break;
      case TAG_LONG:       readLong(); break;
      case TAG_FLOAT:      readFloat(); break;
      case TAG_DOUBLE:     readDouble(); break;
      case TAG_BYTE_ARRAY: { const n=readInt(); off+=n; break; }
      case TAG_STRING:     { const s=readString(); strings.push(s); break; }
      case TAG_LIST:       {
        const elType = readByte();
        const count  = readInt();
        for(let i=0;i<count;i++) skipPayload(elType);
        break;
      }
      case TAG_COMPOUND:   {
        while(off < buf.length) {
          const t = readType();
          if(t === 0) break; // TAG_End
          readString(); // tag name
          skipPayload(t);
        }
        break;
      }
      case TAG_INT_ARRAY:  { const n=readInt(); off+=n*4; break; }
      case TAG_LONG_ARRAY: { const n=readInt(); off+=n*8; break; }
    }
  }

  try {
    const rootType = readType();
    if (rootType === TAG_STRING) {
      // Bare string component (most common for disconnect)
      return readString();
    }
    // Compound or other — walk it and collect all string values
    // For compound: there's no name on the root in the "nameless" NBT format used in packets
    if (rootType === TAG_COMPOUND) {
      while (off < buf.length) {
        const t = readType();
        if (t === 0) break;
        const name = readString();
        if (t === TAG_STRING) {
          const val = readString();
          if (name === 'text' || name === 'translate') return val;
          strings.push(val);
        } else {
          skipPayload(t);
        }
      }
      if (strings.length) return strings[0];
    }
    // Fallback: scan for any readable ASCII strings in the buffer
    return extractReadableAscii(buf);
  } catch(_) {
    return extractReadableAscii(buf);
  }
}

function extractReadableAscii(buf) {
  // Pull out runs of printable ASCII >= 4 chars
  let run = '';
  const runs = [];
  for (const b of buf) {
    if (b >= 0x20 && b < 0x7F) {
      run += String.fromCharCode(b);
    } else {
      if (run.length >= 4) runs.push(run);
      run = '';
    }
  }
  if (run.length >= 4) runs.push(run);
  return runs.join(' ') || buf.toString('hex');
}

// ─── Main Bot Class ────────────────────────────────────────────────────────────

class MinecraftBot extends EventEmitter {
  constructor(opts) {
    super();
    this.host     = opts.host;
    this.port     = opts.port || 25565;
    this.username = opts.username || 'FlareBot';
    this.debug    = opts.debug || false;

    this._state              = STATES.HANDSHAKING;
    this._activeSocket       = null;  // THE one socket we care about
    this._movement           = new HumanMovement(this);
    this._connected          = false;
    this._loginAttempts      = 0;
    this._keepAlivesSent     = 0;
    this._keepAlivesRecv     = 0;
    this._compressionThreshold = -1;

    this._protocolFallbacks  = [774, 773, 772, 771, 770, 769, 768, 767];
    this._protocolIdx        = 0;
    this.protocol            = PROTOCOL_VERSION;
    this._protocolLocked     = false;

    this._reconnectTimer     = null;
  }

  log(msg)  { console.log(`\x1b[36m[${this._ts()}]\x1b[0m ${msg}`); }
  warn(msg) { console.log(`\x1b[33m[${this._ts()}] WARN\x1b[0m ${msg}`); }
  error(msg){ console.log(`\x1b[31m[${this._ts()}] ERROR\x1b[0m ${msg}`); }
  _ts()     { return new Date().toISOString().replace('T',' ').slice(0,19); }

  // ─── Connection ────────────────────────────────────────────────────────────

  connect() {
    // ① Cancel any pending reconnect timer
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    // ② Hard-kill any existing socket — this is the ONLY place a new socket is made
    if (this._activeSocket && !this._activeSocket.destroyed) {
      this._activeSocket.removeAllListeners();
      this._activeSocket.destroy();
    }
    this._activeSocket = null;
    this._connected    = false;

    this._loginAttempts++;
    this._compressionThreshold = -1;
    this._state    = STATES.HANDSHAKING;
    this._movement.stop();

    this.log(
      `Connecting to ${this.host}:${this.port} as \x1b[32m${this.username}\x1b[0m` +
      ` (protocol ${this.protocol}${this._protocolLocked ? ' \x1b[32m[locked]\x1b[0m':''}, attempt #${this._loginAttempts})`
    );

    const splitter = new PacketSplitter();
    const socket   = net.createConnection({ host: this.host, port: this.port });
    this._activeSocket = socket;

    socket.on('connect', () => {
      if (socket !== this._activeSocket) return;
      this._connected = true;
      this.log('TCP connected → sending handshake');
      this._sendHandshake();
      this._sendLoginStart();
    });

    socket.on('data', chunk => {
      if (socket !== this._activeSocket) return;
      splitter.push(chunk);
    });

    splitter.on('packet', raw => {
      if (socket !== this._activeSocket) return;
      try { this._handleFrame(raw); }
      catch (e) { this.warn(`Packet error: ${e.message}`); if (this.debug) console.error(e.stack); }
    });

    socket.on('error', err => {
      if (socket !== this._activeSocket) return;
      this.error(`Socket error: ${err.message}`);
    });

    socket.on('close', () => {
      if (socket !== this._activeSocket) return;
      this._connected = false;
      this._movement.stop();
      this.log(`Disconnected. Reconnecting in ${RECONNECT_MS/1000}s…`);
      this._scheduleReconnect(RECONNECT_MS);
    });
  }

  _scheduleReconnect(ms) {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => { this._reconnectTimer = null; this.connect(); }, ms);
  }

  /** Kill socket + schedule reconnect. Safe to call from packet handlers. */
  _reconnectAfter(ms, msg) {
    if (msg) this.log(msg);
    // Detach the active socket so its close event doesn't also schedule a reconnect
    const sock = this._activeSocket;
    this._activeSocket = null;
    this._connected    = false;
    if (sock && !sock.destroyed) { sock.removeAllListeners(); sock.destroy(); }
    this._scheduleReconnect(ms);
  }

  // ─── Frame dispatch (compression-aware) ───────────────────────────────────

  _handleFrame(raw) {
    let payload;
    if (this._compressionThreshold >= 0) {
      const r = new PacketReader(raw);
      const dataLen = r.readVarInt();
      const data    = r.readBytes(r.remaining);
      if (dataLen === 0) {
        payload = data;
      } else {
        try { payload = zlib.inflateSync(data); }
        catch (e) { this.warn(`zlib inflate: ${e.message}`); return; }
      }
    } else {
      payload = raw;
    }

    const r  = new PacketReader(payload);
    const id = r.readVarInt();
    if (this.debug) {
      this.log(`  ← 0x${id.toString(16).padStart(2,'0')} [${Object.keys(STATES)[this._state]}]${this._compressionThreshold>=0?' z':''}`);
    }
    switch (this._state) {
      case STATES.LOGIN:         return this._handleLogin(id, r);
      case STATES.CONFIGURATION: return this._handleConfig(id, r);
      case STATES.PLAY:          return this._handlePlay(id, r);
    }
  }

  // ─── Sending ───────────────────────────────────────────────────────────────

  _send(packetId, writer) {
    if (!this._activeSocket || this._activeSocket.destroyed || !this._connected) return;
    const payload = writer.toBuffer();
    let frame;
    if (this._compressionThreshold >= 0) {
      const inner = Buffer.concat([this._varIntBuf(packetId), payload]);
      if (inner.length >= this._compressionThreshold) {
        const compressed = zlib.deflateSync(inner);
        const outer = Buffer.concat([this._varIntBuf(inner.length), compressed]);
        frame = Buffer.concat([this._varIntBuf(outer.length), outer]);
      } else {
        const outer = Buffer.concat([Buffer.from([0x00]), inner]);
        frame = Buffer.concat([this._varIntBuf(outer.length), outer]);
      }
    } else {
      frame = framePacket(packetId, payload);
    }
    if (this.debug) this.log(`  → 0x${packetId.toString(16).padStart(2,'0')} (${frame.length}b)`);
    this._activeSocket.write(frame);
  }

  _varIntBuf(v) { const w = new PacketWriter(); w.writeVarInt(v); return w.toBuffer(); }

  _sendHandshake() {
    const w = new PacketWriter();
    w.writeVarInt(this.protocol).writeString(this.host).writeUShort(this.port).writeVarInt(2);
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
    w.writeFloat(yaw).writeFloat(pitch).writeByte(onGround ? 1 : 0);
    this._send(0x1B, w);
  }

  // ─── Disconnect reason: handles JSON string and NBT text component ─────────

  _readDisconnectReason(r) {
    // In MC < 1.20.3: reason is a MC String (varint-prefixed UTF8 JSON)
    // In MC >= 1.20.3: reason is an NBT Text Component (raw NBT bytes, no length prefix at the packet level —
    //   but it IS still read as a MC String in the Login Disconnect packet per wiki.vg 1.20.3+ spec)
    // So readString() gets us bytes that might be JSON or might be raw NBT.
    const raw = r.readString();

    // Try JSON first (covers older servers and some messages)
    try {
      const j = JSON.parse(raw);
      if (typeof j === 'string') return j;
      if (j && typeof j.text === 'string') return j.text;
      // Flatten extras
      let text = j.text || '';
      if (Array.isArray(j.extra)) text += j.extra.map(e => (typeof e === 'string' ? e : e.text||'')).join('');
      if (text) return text;
    } catch (_) {}

    // If it starts with a known NBT tag byte, treat as NBT
    if (raw.length > 0) {
      const firstByte = raw.charCodeAt(0);
      if (firstByte >= 1 && firstByte <= 12) {
        // Looks like NBT — re-read the raw bytes and parse
        const buf = Buffer.from(raw, 'binary');
        return extractNbtText(buf);
      }
    }

    return raw || '(empty)';
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
    const reason = this._readDisconnectReason(r);
    this.error(`Login disconnected: ${reason}`);

    // Throttle — stop changing protocol, just wait
    if (/throttl/i.test(reason)) {
      this._protocolLocked = true;
      this.warn(`Throttled. Protocol ${this.protocol} locked. Waiting ${THROTTLE_RETRY_MS/1000}s…`);
      this._reconnectAfter(THROTTLE_RETRY_MS);
      return;
    }

    // Version mismatch — jump directly to correct protocol
    const m = reason.match(/1\.21\.(\d+)/);
    if (m) {
      const target = this._mcVersionToProtocol(parseInt(m[1], 10));
      if (target) {
        this.warn(`Server is on 1.21.${m[1]} → jumping to protocol ${target}`);
        this.protocol     = target;
        this._protocolIdx = Math.max(0, this._protocolFallbacks.indexOf(target));
        this._reconnectAfter(1500);
        return;
      }
    }

    this._stepProtocolDown();
  }

  _mcVersionToProtocol(minor) {
    const map = {0:767,1:767,2:768,3:768,4:769,5:770,6:771,7:772,8:772,9:773,10:773,11:774};
    return map[minor] ?? null;
  }

  _stepProtocolDown() {
    if (this._protocolLocked) {
      this._reconnectAfter(RECONNECT_MS);
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
    this._reconnectAfter(30000, 'Pausing 30s (online-mode)…');
  }

  _onLoginSuccess(r) {
    const uuid      = r.readUUID();
    const username  = r.readString();
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
      // Ignore everything else silently
    }
  }

  _onConfigCookieRequest(r) {
    const key = r.readString();
    const w = new PacketWriter(); w.writeString(key).writeBoolean(false);
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
    const reason = this._readDisconnectReason(r);
    this.error(`Config disconnect: ${reason}`);

    // "You are already connected" — we have a stale connection, wait longer
    if (/already connected/i.test(reason)) {
      this.warn('Stale connection detected — waiting 10s for server to expire old session…');
      this._reconnectAfter(10000);
      return;
    }
    this._reconnectAfter(RECONNECT_MS);
  }

  _onConfigFinish(r) {
    this.log('Config finish → PLAY');
    this._sendClientInformation(true);
    this._send(0x03, new PacketWriter()); // Finish Configuration
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
    const reason = this._readDisconnectReason(r);
    this.error(`Play disconnect: ${reason}`);
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

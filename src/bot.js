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
const PROTOCOL_VERSION = 774; // Start at newest, fall back automatically on rejection

const STATES = { HANDSHAKING: 0, STATUS: 1, LOGIN: 2, CONFIGURATION: 3, PLAY: 4 };

class MinecraftBot extends EventEmitter {
  constructor(opts) {
    super();
    this.host        = opts.host;
    this.port        = opts.port || 25565;
    this.username    = opts.username || 'FlareBot';
    this.protocol    = opts.protocol || PROTOCOL_VERSION;
    this.debug       = opts.debug || false;

    this._state      = STATES.HANDSHAKING;
    this._socket     = null;
    this._splitter   = new PacketSplitter();
    this._movement   = new HumanMovement(this);
    this._connected  = false;
    this._reconnectDelay = 5000;
    this._reconnectTimer = null;
    this._keepAlivesSent = 0;
    this._keepAlivesRecv = 0;
    this._loginAttempts  = 0;

    // Try newest protocol first, fall back on rejection (covers all 1.21.0–1.21.11)
    this._protocolFallbacks = [774, 773, 772, 771, 770, 769, 768, 767];
    this._protocolIdx       = 0;
  }

  log(msg) {
    const ts = new Date().toISOString().replace('T',' ').slice(0,19);
    console.log(`\x1b[36m[${ts}]\x1b[0m ${msg}`);
  }

  warn(msg) {
    const ts = new Date().toISOString().replace('T',' ').slice(0,19);
    console.log(`\x1b[33m[${ts}] WARN\x1b[0m ${msg}`);
  }

  error(msg) {
    const ts = new Date().toISOString().replace('T',' ').slice(0,19);
    console.log(`\x1b[31m[${ts}] ERROR\x1b[0m ${msg}`);
  }

  connect() {
    this._loginAttempts++;
    this.log(`Connecting to ${this.host}:${this.port} as \x1b[32m${this.username}\x1b[0m (protocol ${this.protocol}, attempt #${this._loginAttempts})`);

    this._state    = STATES.HANDSHAKING;
    this._splitter = new PacketSplitter();
    this._movement.stop();

    const socket = net.createConnection({ host: this.host, port: this.port });
    this._socket = socket;

    socket.on('connect', () => {
      this._connected = true;
      this.log(`TCP connected → sending handshake`);
      this._sendHandshake();
      this._sendLoginStart();
    });

    socket.on('data', chunk => {
      this._splitter.push(chunk);
    });

    this._splitter.on('packet', raw => {
      try { this._handleRaw(raw); }
      catch (e) { this.warn(`Packet handling error: ${e.message}`); }
    });

    socket.on('error', err => {
      this.error(`Socket error: ${err.message}`);
    });

    socket.on('close', () => {
      this._connected = false;
      this._movement.stop();
      this.log(`Disconnected. Reconnecting in ${this._reconnectDelay / 1000}s…`);
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, this._reconnectDelay);
  }

  // ─── Packet sending ────────────────────────────────────────────────────────

  _send(packetId, writer) {
    if (!this._socket || !this._connected) return;
    const buf = writer.toBuffer();
    const frame = framePacket(packetId, buf);
    if (this.debug) this.log(`  → 0x${packetId.toString(16).padStart(2,'0')} (${frame.length} bytes)`);
    this._socket.write(frame);
  }

  _sendHandshake() {
    const w = new PacketWriter();
    w.writeVarInt(this.protocol); // protocol version
    w.writeString(this.host);
    w.writeUShort(this.port);
    w.writeVarInt(2); // next state: login
    this._send(0x00, w);
    this._state = STATES.LOGIN;
  }

  _sendLoginStart() {
    const w = new PacketWriter();
    w.writeString(this.username);
    // UUID: all zeros for offline mode
    w.writeUUID('00000000-0000-0000-0000-000000000000');
    this._send(0x00, w);
  }

  sendPosition(x, y, z, yaw, pitch, onGround) {
    if (this._state !== STATES.PLAY) return;
    const w = new PacketWriter();
    w.writeDouble(x);
    w.writeDouble(y);
    w.writeDouble(z);
    w.writeFloat(yaw);
    w.writeFloat(pitch);
    w.writeByte(onGround ? 1 : 0);
    // 0x1B = Set Player Position And Rotation (play, serverbound, 1.21.x)
    this._send(0x1B, w);
  }

  // ─── Packet receiving ──────────────────────────────────────────────────────

  _handleRaw(raw) {
    const reader = new PacketReader(raw);
    const packetId = reader.readVarInt();
    if (this.debug) this.log(`  ← 0x${packetId.toString(16).padStart(2,'0')} in state ${Object.keys(STATES)[this._state]}`);

    switch (this._state) {
      case STATES.LOGIN:         return this._handleLogin(packetId, reader);
      case STATES.CONFIGURATION: return this._handleConfig(packetId, reader);
      case STATES.PLAY:          return this._handlePlay(packetId, reader);
    }
  }

  // ── LOGIN state ────────────────────────────────────────────────────────────

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

    // MC sends kick messages like:
    //   'Outdated client! Please use 1.21.8'
    //   'Outdated server! I'm still on 1.21.4'
    // Parse the version and jump straight to the correct protocol instead of
    // blindly stepping down one-by-one.
    const versionMatch = reason.match(/1\.21\.(\d+)/);
    if (versionMatch) {
      const mcMinor = parseInt(versionMatch[1], 10);
      const target  = this._mcVersionToProtocol(mcMinor);
      if (target && target !== this.protocol) {
        this.warn(`Server is on 1.21.${mcMinor} → jumping straight to protocol ${target}`);
        this._socket.destroy();
        this.protocol     = target;
        this._protocolIdx = this._protocolFallbacks.indexOf(target);
        if (this._protocolIdx === -1) this._protocolIdx = 0;
        setTimeout(() => this.connect(), 1000);
        return;
      }
    }

    this._tryNextProtocol();
  }

  /** Map a 1.21.x minor version to its protocol number */
  _mcVersionToProtocol(minor) {
    const map = { 0:767, 1:767, 2:768, 3:768, 4:769, 5:770, 6:771, 7:772, 8:772, 9:773, 10:773, 11:774 };
    return map[minor] ?? null;
  }

  _onEncryptionRequest(r) {
    // We're in offline mode — if the server requires online-mode encryption,
    // we can only warn the user. We don't have a Mojang token.
    const serverId   = r.readString();
    const pubKeyLen  = r.readVarInt();
    const pubKey     = r.readBytes(pubKeyLen);
    const verifyLen  = r.readVarInt();
    const verifyToken= r.readBytes(verifyLen);

    this.warn('Server requires online-mode (encryption). This bot only supports offline-mode servers.');
    this.warn('For online-mode, you would need a Microsoft/Mojang auth token. Disconnecting.');
    this._socket.destroy();
  }

  _onLoginSuccess(r) {
    const uuid     = r.readUUID();
    const username = r.readString();
    // Property count (for online mode skins etc.)
    const propCount = r.readVarInt();
    for (let i = 0; i < propCount; i++) {
      r.readString(); // name
      r.readString(); // value
      const signed = r.readBoolean();
      if (signed) r.readString(); // signature
    }

    this.log(`\x1b[32mLogin success!\x1b[0m UUID=${uuid} Name=${username}`);
    this._loginAttempts = 0;

    // Send Login Acknowledged → transition to CONFIGURATION
    this._send(0x03, new PacketWriter());
    this._state = STATES.CONFIGURATION;
    this.log('State → CONFIGURATION');
  }

  _onSetCompression(r) {
    const threshold = r.readVarInt();
    this.log(`Set compression threshold: ${threshold} (ignoring — we don't compress)`);
    // NOTE: For a production bot you'd need to implement zlib compression here.
    // Most servers have this, but small private servers may disable it.
    // TODO: implement zlib compression/decompression for online servers.
  }

  _onLoginPluginRequest(r) {
    const messageId = r.readVarInt();
    const channel   = r.readString();
    // Respond with unsuccessful (0x02 Login Plugin Response)
    const w = new PacketWriter();
    w.writeVarInt(messageId);
    w.writeBoolean(false); // not handled
    this._send(0x02, w);
  }

  // ── CONFIGURATION state ────────────────────────────────────────────────────

  _handleConfig(id, r) {
    switch (id) {
      case 0x00: return this._onConfigCookieRequest(r);
      case 0x01: return this._onConfigPluginMessage(r);
      case 0x02: return this._onConfigDisconnect(r);
      case 0x03: return this._onConfigFinish(r);
      case 0x04: return this._onConfigKeepAlive(r);
      case 0x05: return this._onConfigPing(r);
      case 0x07: return this._onRegistryData(r);
      case 0x0E: return this._onKnownPacks(r);
      default:   // silently ignore unknown config packets
    }
  }

  _onConfigCookieRequest(r) {
    const key = r.readString();
    // Respond: Cookie Response (0x01)
    const w = new PacketWriter();
    w.writeString(key);
    w.writeBoolean(false); // no payload
    this._send(0x01, w);
  }

  _onConfigPluginMessage(r) {
    const channel = r.readString();
    if (this.debug) this.log(`  Config plugin message: ${channel}`);
    // We respond to brand channel with our own brand
    if (channel === 'minecraft:brand') {
      const w = new PacketWriter();
      w.writeString('minecraft:brand');
      const brand = Buffer.from('\x06Flare\x00');
      w.writeBytes(brand);
      this._send(0x00, w);
    }
  }

  _onConfigDisconnect(r) {
    this.error(`Configuration disconnect: ${r.readString()}`);
    this._socket.destroy();
  }

  _onConfigFinish(r) {
    this.log('Config finish received → sending client info + finish');
    // Send Client Information (0x00) 
    this._sendClientInformation(true);
    // Send Finish Configuration (0x03)
    this._send(0x03, new PacketWriter());
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

  _onRegistryData(r) {
    // We just consume and ignore registry data (codec)
    // A full implementation would parse NBT here
    if (this.debug) this.log('  Registry data received (ignored)');
  }

  _onKnownPacks(r) {
    // Server asks what resource packs we know
    // We respond with Known Packs (serverbound) saying we know none
    const w = new PacketWriter();
    w.writeVarInt(0); // 0 known packs
    this._send(0x07, w);
  }

  // Shared client information packet (used in both config and play state)
  _sendClientInformation(inConfig = false) {
    const w = new PacketWriter();
    w.writeString('en_us');   // locale
    w.writeByte(8);           // view distance
    w.writeVarInt(0);         // chat mode: enabled
    w.writeBoolean(true);     // chat colors
    w.writeByte(0x7F);        // displayed skin parts (all)
    w.writeVarInt(1);         // main hand: right
    w.writeBoolean(false);    // enable text filtering
    w.writeBoolean(true);     // allow server listings
    const packetId = inConfig ? 0x00 : 0x0A;
    this._send(packetId, w);
  }

  // ── PLAY state ─────────────────────────────────────────────────────────────

  _handlePlay(id, r) {
    switch (id) {
      case 0x00: return; // Bundle delimiter - ignore
      case 0x1D: return this._onPlayDisconnect(r);
      case 0x26: return this._onPlayKeepAlive(r);
      case 0x2B: return this._onPlayLogin(r);
      case 0x38: return this._onPlayPing(r);
      case 0x40: return this._onSynchronizePosition(r);
      default:   // Many packets we don't need to handle
    }
  }

  _onPlayDisconnect(r) {
    this.error(`Play disconnect: ${r.readString()}`);
    this._socket.destroy();
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
    const entityId  = r.readInt();
    const isHC      = r.readBoolean();
    const dimCount  = r.readVarInt();
    for (let i = 0; i < dimCount; i++) r.readString();
    const maxPlayers = r.readVarInt();
    const viewDist   = r.readVarInt();
    const simDist    = r.readVarInt();
    const reducedDebug = r.readBoolean();
    const respawnScreen= r.readBoolean();
    const limitedCraft = r.readBoolean();

    this.log(`\x1b[32mPlay login!\x1b[0m EntityID=${entityId} MaxPlayers=${maxPlayers}`);

    // After login, send client info
    this._sendClientInformation(false);
  }

  _onPlayPing(r) {
    const id = r.readInt();
    const w = new PacketWriter();
    w.writeInt(id);
    this._send(0x36, w); // Pong (Play)
  }

  _onSynchronizePosition(r) {
    const x     = r.readDouble();
    const y     = r.readDouble();
    const z     = r.readDouble();
    const yaw   = r.readFloat();
    const pitch = r.readFloat();
    const flags = r.readByte();
    const teleportId = r.readVarInt();

    this.log(`Teleport → (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}) yaw=${yaw.toFixed(1)}`);

    // Confirm teleport
    const w = new PacketWriter();
    w.writeVarInt(teleportId);
    this._send(0x00, w);

    // Update movement engine with our new position
    this._movement.setSpawn(x, y, z);
    this._movement.yaw   = yaw;
    this._movement.pitch = pitch;
    if (!this._movement._tickInterval) {
      this._movement.start();
    }
  }

  _tryNextProtocol() {
    this._socket.destroy();
    this._protocolIdx++;
    if (this._protocolIdx < this._protocolFallbacks.length) {
      const next = this._protocolFallbacks[this._protocolIdx];
      this.warn(`Trying protocol version ${next}…`);
      this.protocol = next;
      setTimeout(() => this.connect(), 1500);
    } else {
      this.error('All protocol versions failed. Retrying from top in 10s…');
      this._protocolIdx = 0;
      this.protocol = this._protocolFallbacks[0];
      setTimeout(() => this.connect(), 10000);
    }
  }
}

module.exports = MinecraftBot;

'use strict';
const { EventEmitter } = require('events');

/**
 * Buffers raw TCP data and emits complete Minecraft packets.
 * MC packets: [VarInt length][VarInt packetId][payload...]
 */
class PacketSplitter extends EventEmitter {
  constructor() {
    super();
    this._buf = Buffer.alloc(0);
  }

  push(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    this._parse();
  }

  _parse() {
    while (true) {
      // Try to read a VarInt length prefix
      let length = 0, shift = 0, i = 0;
      let hasLength = false;
      for (; i < this._buf.length && i < 5; i++) {
        const b = this._buf[i];
        length |= (b & 0x7F) << shift;
        shift += 7;
        if (!(b & 0x80)) { i++; hasLength = true; break; }
      }
      if (!hasLength) return; // Not enough bytes for length yet
      if (this._buf.length < i + length) return; // Incomplete packet

      const packet = this._buf.slice(i, i + length);
      this._buf = this._buf.slice(i + length);
      this.emit('packet', packet);
    }
  }
}

module.exports = PacketSplitter;

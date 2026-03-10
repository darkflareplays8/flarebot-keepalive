'use strict';

class PacketReader {
  constructor(buf) {
    this.buf = buf;
    this.offset = 0;
  }

  get remaining() { return this.buf.length - this.offset; }

  readByte() { return this.buf[this.offset++]; }

  readBytes(n) {
    const slice = this.buf.slice(this.offset, this.offset + n);
    this.offset += n;
    return slice;
  }

  readVarInt() {
    let result = 0, shift = 0, b;
    do {
      b = this.readByte();
      result |= (b & 0x7F) << shift;
      shift += 7;
      if (shift > 35) throw new Error('VarInt too big');
    } while (b & 0x80);
    return result;
  }

  readVarLong() {
    let result = BigInt(0), shift = BigInt(0), b;
    do {
      b = this.readByte();
      result |= BigInt(b & 0x7F) << shift;
      shift += BigInt(7);
    } while (b & 0x80);
    return result;
  }

  readString() {
    const len = this.readVarInt();
    return this.readBytes(len).toString('utf8');
  }

  readUShort() { const v = this.buf.readUInt16BE(this.offset); this.offset += 2; return v; }
  readShort()  { const v = this.buf.readInt16BE(this.offset);  this.offset += 2; return v; }
  readInt()    { const v = this.buf.readInt32BE(this.offset);  this.offset += 4; return v; }
  readUInt()   { const v = this.buf.readUInt32BE(this.offset); this.offset += 4; return v; }
  readLong()   { const v = this.buf.readBigInt64BE(this.offset); this.offset += 8; return v; }
  readFloat()  { const v = this.buf.readFloatBE(this.offset);  this.offset += 4; return v; }
  readDouble() { const v = this.buf.readDoubleBE(this.offset); this.offset += 8; return v; }
  readBoolean(){ return this.readByte() !== 0; }

  readUUID() {
    const high = this.buf.readBigUInt64BE(this.offset);
    const low  = this.buf.readBigUInt64BE(this.offset + 8);
    this.offset += 16;
    const hex = high.toString(16).padStart(16,'0') + low.toString(16).padStart(16,'0');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }
}

class PacketWriter {
  constructor() { this.chunks = []; }

  toBuffer() { return Buffer.concat(this.chunks); }

  writeByte(v) {
    const b = Buffer.allocUnsafe(1); b[0] = v & 0xFF;
    this.chunks.push(b); return this;
  }

  writeBytes(buf) { this.chunks.push(Buffer.from(buf)); return this; }

  writeVarInt(v) {
    v = v >>> 0;
    const bytes = [];
    do {
      let byte = v & 0x7F;
      v >>>= 7;
      if (v !== 0) byte |= 0x80;
      bytes.push(byte);
    } while (v !== 0);
    this.chunks.push(Buffer.from(bytes)); return this;
  }

  writeVarLong(v) {
    v = BigInt(v);
    const bytes = [];
    do {
      let byte = Number(v & BigInt(0x7F));
      v >>= BigInt(7);
      if (v !== BigInt(0)) byte |= 0x80;
      bytes.push(byte);
    } while (v !== BigInt(0));
    this.chunks.push(Buffer.from(bytes)); return this;
  }

  writeString(str) {
    const encoded = Buffer.from(str, 'utf8');
    this.writeVarInt(encoded.length);
    this.chunks.push(encoded); return this;
  }

  writeUShort(v) { const b = Buffer.allocUnsafe(2); b.writeUInt16BE(v); this.chunks.push(b); return this; }
  writeShort(v)  { const b = Buffer.allocUnsafe(2); b.writeInt16BE(v);  this.chunks.push(b); return this; }
  writeInt(v)    { const b = Buffer.allocUnsafe(4); b.writeInt32BE(v);  this.chunks.push(b); return this; }
  writeUInt(v)   { const b = Buffer.allocUnsafe(4); b.writeUInt32BE(v); this.chunks.push(b); return this; }
  writeLong(v)   { const b = Buffer.allocUnsafe(8); b.writeBigInt64BE(BigInt(v)); this.chunks.push(b); return this; }
  writeFloat(v)  { const b = Buffer.allocUnsafe(4); b.writeFloatBE(v);  this.chunks.push(b); return this; }
  writeDouble(v) { const b = Buffer.allocUnsafe(8); b.writeDoubleBE(v); this.chunks.push(b); return this; }
  writeBoolean(v){ return this.writeByte(v ? 1 : 0); }

  writeUUID(uuidStr) {
    const hex = uuidStr.replace(/-/g, '');
    const high = BigInt('0x' + hex.slice(0, 16));
    const low  = BigInt('0x' + hex.slice(16));
    const b = Buffer.allocUnsafe(16);
    b.writeBigUInt64BE(high, 0);
    b.writeBigUInt64BE(low,  8);
    this.chunks.push(b); return this;
  }
}

/** Wrap a raw packet payload with length-prefixed VarInt framing */
function framePacket(packetIdInt, payloadBuf) {
  const idWriter = new PacketWriter();
  idWriter.writeVarInt(packetIdInt);
  const idBuf = idWriter.toBuffer();
  const full = Buffer.concat([idBuf, payloadBuf]);
  const lenWriter = new PacketWriter();
  lenWriter.writeVarInt(full.length);
  return Buffer.concat([lenWriter.toBuffer(), full]);
}

module.exports = { PacketReader, PacketWriter, framePacket };

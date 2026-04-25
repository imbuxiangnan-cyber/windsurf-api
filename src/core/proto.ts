/**
 * Protobuf wire format codec — zero-dependency, schema-less.
 */

export function encodeVarint(value: number | bigint): Buffer {
  const bytes: number[] = [];
  let v = typeof value === 'bigint' ? value : BigInt(value);
  if (v < 0n) v = v & 0xFFFFFFFFFFFFFFFFn;
  do {
    let byte = Number(v & 0x7Fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (v > 0n);
  return Buffer.from(bytes);
}

function makeTag(field: number, wireType: number): Buffer {
  return encodeVarint((field << 3) | wireType);
}

export function writeVarintField(field: number, value: number): Buffer {
  return Buffer.concat([makeTag(field, 0), encodeVarint(value)]);
}

export function writeStringField(field: number, str: string): Buffer {
  if (!str && str !== '') return Buffer.alloc(0);
  const data = Buffer.from(str, 'utf-8');
  return Buffer.concat([makeTag(field, 2), encodeVarint(data.length), data]);
}

export function writeMessageField(field: number, msgBuf: Buffer): Buffer {
  if (!msgBuf || msgBuf.length === 0) return Buffer.alloc(0);
  return Buffer.concat([makeTag(field, 2), encodeVarint(msgBuf.length), msgBuf]);
}

export function writeBoolField(field: number, value: boolean): Buffer {
  if (!value) return Buffer.alloc(0);
  return writeVarintField(field, 1);
}

export interface ParsedField {
  field: number;
  wireType: number;
  value: number | Buffer;
}

export function decodeVarint(buf: Buffer, offset = 0): { value: number; length: number } {
  let result = 0, shift = 0, pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= (byte & 0x7F) << shift;
    if (!(byte & 0x80)) break;
    shift += 7;
    if (shift >= 64) throw new Error('Varint overflow');
  }
  return { value: result >>> 0, length: pos - offset };
}

export function parseFields(buf: Buffer): ParsedField[] {
  const fields: ParsedField[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const tag = decodeVarint(buf, pos);
    pos += tag.length;
    const fieldNum = tag.value >>> 3;
    const wireType = tag.value & 0x07;
    let value: number | Buffer;
    switch (wireType) {
      case 0: {
        const v = decodeVarint(buf, pos);
        pos += v.length;
        value = v.value;
        break;
      }
      case 1: {
        value = buf.subarray(pos, pos + 8);
        pos += 8;
        break;
      }
      case 2: {
        const len = decodeVarint(buf, pos);
        pos += len.length;
        value = buf.subarray(pos, pos + len.value);
        pos += len.value;
        break;
      }
      case 5: {
        value = buf.subarray(pos, pos + 4);
        pos += 4;
        break;
      }
      default:
        throw new Error(`Unknown wire type ${wireType} at offset ${pos}`);
    }
    fields.push({ field: fieldNum, wireType, value });
  }
  return fields;
}

export function getField(fields: ParsedField[], num: number, wireType?: number): ParsedField | null {
  return fields.find(f => f.field === num && (wireType === undefined || f.wireType === wireType)) || null;
}

export function getAllFields(fields: ParsedField[], num: number): ParsedField[] {
  return fields.filter(f => f.field === num);
}

'use strict';

// Minimal image dimension reader for the loader's media upload path. It avoids
// an external node_modules dependency inside QQ's app_launcher directory.

function imageSize(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return (
    png(buffer) ||
    gif(buffer) ||
    jpeg(buffer) ||
    bmp(buffer) ||
    webp(buffer) || {
      width: 0,
      height: 0,
      type: undefined,
    }
  );
}

function png(buffer) {
  if (buffer.length < 24) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
      type: 'png',
    };
  }
  return null;
}

function gif(buffer) {
  if (buffer.length < 10) return null;
  const signature = buffer.toString('ascii', 0, 6);
  if (signature === 'GIF87a' || signature === 'GIF89a') {
    return {
      width: buffer.readUInt16LE(6),
      height: buffer.readUInt16LE(8),
      type: 'gif',
    };
  }
  return null;
}

function bmp(buffer) {
  if (buffer.length < 26) return null;
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return {
      width: Math.abs(buffer.readInt32LE(18)),
      height: Math.abs(buffer.readInt32LE(22)),
      type: 'bmp',
    };
  }
  return null;
}

function jpeg(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (offset + 4 > buffer.length) break;
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) break;
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      if (offset + 9 > buffer.length) break;
      return {
        width: buffer.readUInt16BE(offset + 7),
        height: buffer.readUInt16BE(offset + 5),
        type: 'jpg',
      };
    }
    offset += 2 + length;
  }
  return null;
}

function webp(buffer) {
  if (buffer.length < 30) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buffer.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
      type: 'webp',
    };
  }
  if (chunk === 'VP8 ') {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
      type: 'webp',
    };
  }
  if (chunk === 'VP8L') {
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
      type: 'webp',
    };
  }
  return null;
}

module.exports = { imageSize };

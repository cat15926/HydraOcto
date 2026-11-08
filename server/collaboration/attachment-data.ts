import { crc32 } from 'node:zlib';
import type { ImageMediaType } from '../../shared/collaboration.js';
import { AppError } from '../store.js';

export const imageByteLimit = 5 * 1024 * 1024;
export const imageUploadJsonLimit = Math.ceil(imageByteLimit / 3) * 4 + 4096;
const textTypes = ['text/plain', 'text/markdown', 'text/csv', 'text/javascript', 'text/typescript', 'text/html', 'text/css', 'application/json', 'application/xml', 'text/xml', ''];

function validImageSize(width: number, height: number) {
  return width > 0 && height > 0 && width * height <= 40_000_000;
}

// Verify the actual container and bound the decoded pixel count before forwarding to a decoder.
function matchesImage(data: Buffer, type: ImageMediaType): boolean {
  if (type === 'image/png') {
    if (data.length < 57 || !data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
        data.readUInt32BE(8) !== 13 || data.toString('latin1', 12, 16) !== 'IHDR' ||
        !validImageSize(data.readUInt32BE(16), data.readUInt32BE(20))) return false;
    let hasData = false;
    for (let offset = 8; offset + 12 <= data.length;) {
      const length = data.readUInt32BE(offset);
      const end = offset + 8 + length;
      if (end + 4 > data.length || crc32(data.subarray(offset + 4, end)) !== data.readUInt32BE(end)) return false;
      const chunk = data.toString('latin1', offset + 4, offset + 8);
      if (chunk === 'IDAT' && length > 0) hasData = true;
      if (chunk === 'IEND') return hasData && length === 0 && end + 4 === data.length;
      offset = end + 4;
    }
    return false;
  }
  if (type === 'image/webp') {
    if (data.length < 30 || data.toString('latin1', 0, 4) !== 'RIFF' || data.toString('latin1', 8, 12) !== 'WEBP' ||
        data.readUInt32LE(4) !== data.length - 8 || data.readUInt32LE(16) > data.length - 20) return false;
    switch (data.toString('latin1', 12, 16)) {
      case 'VP8 ': return data.subarray(23, 26).equals(Buffer.from('9d012a', 'hex')) &&
        validImageSize(data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff);
      case 'VP8L': return data[20] === 0x2f && validImageSize((data.readUInt16LE(21) & 0x3fff) + 1, ((data.readUIntLE(22, 3) >> 6) & 0x3fff) + 1);
      case 'VP8X': return data.readUInt32LE(16) === 10 && validImageSize(data.readUIntLE(24, 3) + 1, data.readUIntLE(27, 3) + 1);
      default: return false;
    }
  }
  if (data.length < 14 || data.readUInt16BE(0) !== 0xffd8 || data.readUInt16BE(data.length - 2) !== 0xffd9) return false;
  let frameFound = false;
  for (let offset = 2; offset + 4 < data.length;) {
    if (data[offset++] !== 0xff) return false;
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (marker === undefined || offset + 2 > data.length || marker === 0xd9) return false;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) return false;
    if (marker === 0xda) return frameFound && length >= 6 && offset + length < data.length - 2;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8 || !validImageSize(data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 3))) return false;
      frameFound = true;
    }
    offset += length;
  }
  return false;
}

export function decodeUpload(mediaType: unknown, base64: unknown) {
  const type = mediaType ?? '';
  const image = type === 'image/png' || type === 'image/jpeg' || type === 'image/webp';
  if (!image && !textTypes.includes(String(type))) throw new AppError(415, '支持 UTF-8 文本、PNG、JPEG 和 WebP 图片。');
  if (typeof base64 !== 'string') throw new AppError(400, '附件编码无效。');
  const limit = image ? imageByteLimit : 32768;
  const sizeError = image ? '图片最多 5 MiB。' : '每个附件需要 1–32 KiB。';
  if (!base64.length || base64.length > Math.ceil(limit / 3) * 4) throw new AppError(413, sizeError);
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > limit) throw new AppError(413, sizeError);
  if (bytes.toString('base64') !== base64) throw new AppError(400, '附件编码无效。');
  if (image) {
    if (!matchesImage(bytes, type)) throw new AppError(415, '图片格式无效或超过 4,000 万像素。');
    return { bytes, mediaType: type as ImageMediaType, stored: base64 };
  }
  let content: string;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new AppError(415, '附件需要有效 UTF-8 编码。'); }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content) || /^%PDF-/.test(content)) throw new AppError(415, '附件包含二进制内容。');
  // Preserve an optional BOM in existing text attachments and their digests.
  return { bytes, mediaType: 'text/plain' as const, stored: bytes.toString('utf8') };
}

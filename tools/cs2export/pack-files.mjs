// Content-hashed pack payloads and mip pages shared by both texture tiers.
import { writeFileSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { transposeBlocks } from '../../frontend/src/world/block-layout.mjs';

const laneBytes = (format) =>
  ({ DXT1: 8, DXT5: 16, ATI1N: 8, ATI2N: 16, BC6H: 16, BC7: 16 })[format] ??
  (/^ASTC\d+x\d+$/.test(format ?? '') ? 16 : 0);

export function packFiles(out, files = {}) {
  function store(bytes, category, format) {
    const decodedSize = bytes.length;
    let packing;
    if (bytes.length >= 1024) {
      const stride = laneBytes(format);
      const original = bytes;
      for (const lanes of stride ? [1, stride] : [1]) {
        const packed = deflateSync(
          lanes === 1 ? original : transposeBlocks(original, lanes, false),
          {
            level: 6,
          },
        );
        if (packed.length + 64 < bytes.length) {
          bytes = packed;
          packing = lanes;
        }
      }
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex'),
      file = sha256 + '.bin';
    if (!files[file]) {
      const fs = statfsSync(out);
      if (fs.bavail * fs.bsize - bytes.length < 4 * 1024 ** 3) throw Error('Disk reserve reached');
      writeFileSync(join(out, file), bytes, { flag: 'wx' });
      files[file] = {
        size: bytes.length,
        sha256,
        category,
        ...(packing ? { packing, decodedSize } : {}),
      };
    }
    return file;
  }
  // Pages group compatible blocks by refinement level. The bootstrap never shares a
  // file with large mips. Each mip remains one contiguous run of GPU-ready layers.
  const pages = new Map();
  function addMip(category, format, level, bytes, first) {
    const wave = first || Math.max(level.w, level.h) <= 16 ? 0 : Math.max(level.w, level.h);
    const key = [category, format, wave].join('/');
    const list = pages.get(key) ?? [];
    let page = list.at(-1);
    if (!page || page.size + bytes.length > 2 * 1024 ** 2) {
      page = { category, format, size: 0, parts: [], levels: [] };
      list.push(page);
      pages.set(key, list);
    }
    const descriptor = { ...level, offset: page.size, size: bytes.length };
    page.parts.push(bytes);
    page.levels.push(descriptor);
    page.size += bytes.length;
    return descriptor;
  }
  function flush() {
    for (const list of pages.values())
      for (const page of list) {
        const file = store(Buffer.concat(page.parts), page.category, page.format);
        for (const mip of page.levels) mip.file = file;
      }
    pages.clear();
  }
  return { files, store, addMip, flush };
}

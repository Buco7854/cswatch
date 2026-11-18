/** Compact only S2V's explicitly completed satellite PNGs in this run's fresh export directory. */
import { constants } from 'node:fs';
import { lstat, open, readdir, rename, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { localDirectory } from './toolchain-security.mjs';
import { checkFreeReserve } from './asset-storage.mjs';

export const sourceImageLimits = Object.freeze({
  bytes: 64 * 1024 ** 2,
  pixels: 64 * 1024 ** 2,
  edge: 16384,
  maxEdge: 2048,
  images: 20000,
  inputBytes: 8 * 1024 ** 3,
  outputBytes: 4 * 1024 ** 3,
  reportBytes: 4 * 1024 ** 2,
});
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const identity = (stat) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
const rootIdentity = (stat) => `${stat.dev}:${stat.ino}`;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export function completePng(bytes) {
  if (
    bytes.length < 57 ||
    bytes.length > sourceImageLimits.bytes ||
    !bytes.subarray(0, 8).equals(pngSignature)
  )
    throw Error('Completed source image is not a bounded PNG.');
  let offset = 8,
    chunks = 0,
    data = false;
  while (offset + 12 <= bytes.length && ++chunks <= 4096) {
    const size = bytes.readUInt32BE(offset),
      end = offset + size + 12;
    if (end > bytes.length) break;
    const kind = bytes.toString('ascii', offset + 4, offset + 8);
    if (
      !/^[a-zA-Z]{4}$/.test(kind) ||
      crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)
    )
      break;
    if (chunks === 1) {
      if (kind !== 'IHDR' || size !== 13) break;
      const width = bytes.readUInt32BE(offset + 8),
        height = bytes.readUInt32BE(offset + 12);
      if (
        !width ||
        !height ||
        width > sourceImageLimits.edge ||
        height > sourceImageLimits.edge ||
        width * height > sourceImageLimits.pixels
      )
        throw Error('Completed PNG dimensions exceed the source image bound.');
    } else if (kind === 'IHDR' || ['acTL', 'fcTL', 'fdAT'].includes(kind)) break;
    if (kind === 'IDAT' && size > 0) data = true;
    if (kind === 'IEND') {
      if (data && size === 0 && end === bytes.length) return;
      break;
    }
    offset = end;
  }
  throw Error('Completed PNG is truncated or has invalid chunks/CRC.');
}
function completedFilename(line) {
  if (typeof line !== 'string') throw Error('Expected one source export log line.');
  const match = /^--- \[(\d{1,6})\/(\d{1,6})\] Exported texture: (.*)$/.exec(line);
  if (!match) {
    if (/^--- \[.*\] Exported texture:/.test(line))
      throw Error('Invalid completed source image event.');
    return;
  }
  const count = Number(match[1]),
    total = Number(match[2]),
    name = match[3];
  if (
    count < 1 ||
    total < count ||
    total > sourceImageLimits.images ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_. -]{0,199}$/.test(name) ||
    name === '.' ||
    name === '..' ||
    /[. ]$/.test(name)
  )
    throw Error('Invalid completed source image filename/count.');
  const dot = name.lastIndexOf('.');
  return { name, file: (dot > 0 ? name.slice(0, dot) : name) + '.png' };
}
async function readBounded(handle, size) {
  if (!Number.isSafeInteger(size) || size < 57 || size > sourceImageLimits.bytes)
    throw Error('Source PNG byte limit exceeded.');
  const bytes = Buffer.alloc(size);
  for (let offset = 0; offset < size;) {
    const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
    if (!bytesRead) throw Error('Completed PNG changed or ended during read.');
    offset += bytesRead;
  }
  return bytes;
}
async function digest(handle, size) {
  const hash = createHash('sha256'),
    buffer = Buffer.alloc(65536);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, size - offset),
      offset,
    );
    if (!bytesRead) throw Error('Source image changed before replacement.');
    offset += bytesRead;
    hash.update(buffer.subarray(0, bytesRead));
  }
  return hash.digest('hex');
}

/** Call before starting S2V. An existing/nonempty operator export is never eligible. */
export async function createSourceImageCompactor({ root, signal, checkStorage } = {}) {
  if (typeof root !== 'string' || !root)
    throw Error("Provide this run's fresh private export root.");
  root = resolve(root);
  await localDirectory(root);
  const folder = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const initialRoot = await folder.stat({ bigint: true });
  try {
    if ((await readdir(root)).length)
      throw Error('Source image compaction requires a fresh empty export root.');
  } catch (error) {
    await folder.close();
    throw error;
  }
  const directory = `/proc/self/fd/${folder.fd}`;
  const images = [],
    seen = new Map(),
    scheduled = new Map();
  let inputBytes = 0,
    outputBytes = 0,
    readBytes = 0,
    reportBytes = 1024,
    fatal,
    finished;
  let queue = Promise.resolve();
  const alive = () => {
    if (signal?.aborted) throw Error('Source image compaction was cancelled.');
  };
  const rootCurrent = async () => {
    const current = await lstat(root, { bigint: true });
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      rootIdentity(current) !== rootIdentity(initialRoot)
    )
      throw Error('Source export directory changed.');
  };
  const compact = async ({ name, file }) => {
    alive();
    await rootCurrent();
    if (seen.has(file)) throw Error('Duplicate completed source image event.');
    if (seen.size >= sourceImageLimits.images)
      throw Error('Completed source image count exceeded.');
    const path = `${directory}/${file}`;
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let temporary;
    try {
      const original = await handle.stat({ bigint: true });
      if (
        !original.isFile() ||
        original.nlink !== 1n ||
        original.size < 57n ||
        original.size > BigInt(sourceImageLimits.bytes)
      )
        throw Error('Completed source image is not a bounded single-link regular PNG.');
      const size = Number(original.size);
      if (readBytes + 2 * size > sourceImageLimits.inputBytes)
        throw Error('Cumulative source image read limit exceeded.');
      const bytes = await readBounded(handle, size);
      inputBytes += size;
      readBytes += size;
      completePng(bytes);
      const inputHash = sha(bytes);
      const options = {
        limitInputPixels: sourceImageLimits.pixels,
        failOn: 'error',
        sequentialRead: true,
      };
      const metadata = await sharp(bytes, options).metadata();
      if (
        metadata.format !== 'png' ||
        !metadata.width ||
        !metadata.height ||
        metadata.pages > 1 ||
        metadata.width > sourceImageLimits.edge ||
        metadata.height > sourceImageLimits.edge ||
        metadata.width * metadata.height > sourceImageLimits.pixels
      )
        throw Error('Completed PNG metadata exceeds the source image bound.');
      let output = bytes;
      if (Math.max(metadata.width, metadata.height) > sourceImageLimits.maxEdge) {
        let image = sharp(bytes, options).resize({
          width: sourceImageLimits.maxEdge,
          height: sourceImageLimits.maxEdge,
          fit: 'inside',
          withoutEnlargement: true,
        });
        if (metadata.depth === 'ushort') image = image.toColourspace('rgb16');
        output = await image.png({ compressionLevel: 9, palette: false }).toBuffer();
      } else {
        // Metadata alone does not establish a valid complete pixel stream. Keep the original bytes after decoding.
        await sharp(bytes, options).raw().toBuffer();
      }
      alive();
      completePng(output);
      const result = await sharp(output, options).metadata();
      if (
        !result.width ||
        !result.height ||
        result.width > sourceImageLimits.maxEdge ||
        result.height > sourceImageLimits.maxEdge ||
        result.width > metadata.width ||
        result.height > metadata.height ||
        Boolean(result.hasAlpha) !== Boolean(metadata.hasAlpha)
      )
        throw Error('Compacted image changed alpha or exceeded its output dimensions.');
      if (outputBytes + output.length > sourceImageLimits.outputBytes)
        throw Error('Cumulative compacted image output limit exceeded.');
      const row = {
        file,
        input: { sha256: inputHash, width: metadata.width, height: metadata.height, bytes: size },
        output: {
          sha256: sha(output),
          width: result.width,
          height: result.height,
          bytes: output.length,
        },
      };
      const rowBytes = Buffer.byteLength(JSON.stringify(row)) + 1;
      if (reportBytes + rowBytes > sourceImageLimits.reportBytes)
        throw Error('Source image provenance exceeds 4 MiB.');
      const unchanged = output === bytes;
      if (!unchanged) {
        if (checkStorage) await checkStorage(output.length);
        else await checkFreeReserve(root, root, output.length);
        alive();
        temporary = `${directory}/.cswatch-compact-${randomBytes(12).toString('hex')}.png`;
        const target = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await target.writeFile(output);
          await target.sync();
        } finally {
          await target.close();
        }
      }
      // Both content and the currently named inode must still identify the completed export.
      const current = await lstat(path, { bigint: true });
      if (
        identity(original) !== identity(await handle.stat({ bigint: true })) ||
        identity(original) !== identity(current) ||
        !current.isFile() ||
        current.nlink !== 1n
      )
        throw Error('Source image changed before atomic replacement.');
      const currentHash = await digest(handle, size);
      readBytes += size;
      if (
        currentHash !== inputHash ||
        identity(original) !== identity(await handle.stat({ bigint: true })) ||
        identity(original) !== identity(await lstat(path, { bigint: true }))
      )
        throw Error('Source image changed before atomic replacement.');
      alive();
      await rootCurrent();
      if (temporary) {
        await rename(temporary, path);
        temporary = undefined;
      }
      outputBytes += output.length;
      reportBytes += rowBytes;
      seen.set(file, name);
      images.push(row);
    } finally {
      if (temporary) await unlink(temporary).catch(() => {});
      await handle.close();
    }
  };
  return {
    consume(line) {
      if (finished) return Promise.reject(Error('Source image compactor is already finished.'));
      let event;
      try {
        event = completedFilename(line);
      } catch (error) {
        fatal ||= error;
        return Promise.reject(error);
      }
      if (!event) return queue;
      const previous = scheduled.get(event.file);
      if (previous) {
        const error = Error('Duplicate or colliding completed source image event.');
        fatal ||= error;
        return Promise.reject(error);
      }
      if (scheduled.size >= sourceImageLimits.images) {
        const error = Error('Completed source image count exceeded.');
        fatal ||= error;
        return Promise.reject(error);
      }
      const pending = queue.then(() => {
        if (fatal) throw fatal;
        return compact(event);
      });
      queue = pending.catch((error) => {
        fatal ||= error;
      });
      scheduled.set(event.file, { name: event.name, promise: pending });
      return pending;
    },
    finish() {
      if (!finished)
        finished = queue.then(async () => {
          try {
            if (fatal) throw fatal;
            alive();
            return {
              schemaVersion: 1,
              maxEdge: sourceImageLimits.maxEdge,
              images,
              inputBytes,
              outputBytes,
              readBytes,
            };
          } finally {
            await folder.close();
          }
        });
      return finished;
    },
  };
}

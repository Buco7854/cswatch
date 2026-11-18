import type { FastifyInstance } from 'fastify';
import type { FileHandle } from 'node:fs/promises';
import type { ReadStream } from 'node:fs';
import {
  bytesFrom,
  fileDigest,
  fileVersion,
  regularFile,
  withDirectory,
} from './map-asset-files.js';
import { HttpError } from './security.js';

export const mapModelBytes = 2 * 1024 ** 3;
type ModelFile = { file: FileHandle; size: number; version: string };

/** Discovery and delivery share the same no-follow, single-link, bounded GLB boundary. */
export async function openMapModel(
  root: string,
  parts: string[],
  filename: string,
): Promise<ModelFile | undefined> {
  return withDirectory(root, ['maps', ...parts], async (directory) => {
    const file = await regularFile(directory, filename, 24, mapModelBytes);
    if (!file) return;
    let keep = false;
    try {
      const size = (await file.stat()).size,
        version = await fileVersion(file);
      const header = await bytesFrom(file, 20, 20);
      if (
        header.toString('ascii', 0, 4) !== 'glTF' ||
        header.readUInt32LE(4) !== 2 ||
        header.readUInt32LE(8) !== size ||
        header.readUInt32LE(12) < 4 ||
        header.readUInt32LE(12) % 4 ||
        header.readUInt32LE(12) > size - 20 ||
        header.readUInt32LE(16) !== 0x4e4f534a ||
        version !== (await fileVersion(file))
      )
        return;
      keep = true;
      return { file, size, version };
    } finally {
      if (!keep) await file.close();
    }
  });
}

const reserved = new Set(['agents', 'equipment', 'equipment-models', 'overviews', 'environments']);
function modelPath(value: string) {
  const agent = /^agents\/(ct|t)\.glb$/.exec(value);
  if (agent) return { parts: ['agents'], filename: `${agent[1]}.glb` };
  const map = /^([a-zA-Z0-9_-]{1,80})\/(desktop|mobile)\/scene\.glb$/.exec(value);
  if (map && !reserved.has(map[1].toLowerCase()))
    return { parts: [map[1], map[2]], filename: 'scene.glb' };
}
function singleRange(
  value: string | undefined,
  size: number,
): { start: number; end: number } | false | undefined {
  if (!value) return;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  // Multiple/unknown range formats may be ignored under HTTP; never construct multipart responses.
  if (!match || (!match[1] && !match[2])) return;
  let start: number, end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start >= size ||
      end < start
    )
      return false;
    end = Math.min(size - 1, end);
  }
  return { start, end };
}

/** Fixed model paths only. A broad static server must never follow operator links into private data. */
export async function mapModelFileRoutes(
  app: FastifyInstance,
  root: string,
  { digest: proveContent = fileDigest }: { digest?: typeof fileDigest } = {},
) {
  app.route<{ Params: { '*': string } }>({
    method: ['GET', 'HEAD'],
    url: '/map-assets/*',
    handler: async (request, reply) => {
      const path = modelPath(request.params['*']);
      if (!path) throw new HttpError(404, 'Map model not found.');
      const cancellation = new AbortController();
      let model: ModelFile | undefined;
      let stream: ReadStream | undefined;
      let streamOwnsFile = false;
      const abort = () => {
        cancellation.abort();
        stream?.destroy();
      };
      const closed = () => {
        if (!reply.raw.writableFinished) abort();
      };
      const cleanup = () => {
        request.raw.off('aborted', abort);
        reply.raw.off('close', closed);
      };
      const connected = () => {
        if (request.raw.aborted || reply.raw.destroyed) abort();
        cancellation.signal.throwIfAborted();
      };
      request.raw.once('aborted', abort);
      reply.raw.once('close', closed);
      try {
        connected();
        model = await openMapModel(root, path.parts, path.filename);
        if (!model) throw new HttpError(404, 'Map model not found.');
        connected();
        // Fresh content proof also prevents same-size/same-timestamp rewrites from satisfying an old ETag.
        let digest: string;
        try {
          digest = await proveContent(model.file, mapModelBytes, cancellation.signal);
        } catch {
          throw new HttpError(404, 'Map model not found.');
        }
        const etag = `"${digest}"`;
        connected();
        if (model.version !== (await fileVersion(model.file)))
          throw new HttpError(404, 'Map model not found.');
        reply
          .header('Cache-Control', 'private, no-store')
          .header('ETag', etag)
          .header('Accept-Ranges', 'bytes')
          .type('model/gltf-binary');
        const condition = request.headers['if-none-match'];
        if (
          typeof condition === 'string' &&
          condition
            .split(',')
            .some((entry) => entry.trim() === '*' || entry.trim().replace(/^W\//, '') === etag)
        )
          return reply.code(304).send();
        const ifRange = request.headers['if-range'];
        const range =
          ifRange && ifRange !== etag ? undefined : singleRange(request.headers.range, model.size);
        if (range === false)
          return reply.code(416).header('Content-Range', `bytes */${model.size}`).send();
        const start = range?.start ?? 0,
          end = range?.end ?? model.size - 1;
        if (range) reply.code(206).header('Content-Range', `bytes ${start}-${end}/${model.size}`);
        reply.header('Content-Length', end - start + 1);
        if (request.method === 'HEAD') return reply.send();
        connected();
        stream = model.file.createReadStream({ start, end, autoClose: true });
        streamOwnsFile = true;
        stream.once('close', cleanup);
        try {
          connected();
          return reply.send(stream);
        } catch (error) {
          stream.destroy();
          throw error;
        }
      } finally {
        if (!streamOwnsFile) {
          cleanup();
          await model?.file.close();
        }
      }
    },
  });
}

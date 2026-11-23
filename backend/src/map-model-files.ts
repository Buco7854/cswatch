import { join } from 'node:path';
import { pipeline } from 'node:stream';
import { createGzip, type Gzip } from 'node:zlib';
import { presentationParts } from './presentation-assets.js';
import type { FastifyInstance } from 'fastify';
import type { FileHandle } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import type { ReadStream } from 'node:fs';
import {
  bytesFrom,
  fileDigest,
  fileVersion,
  regularFile,
  withDirectory,
} from './map-asset-files.js';
import { HttpError } from './security.js';
import { manualMapLocation, type MapAssetLocation } from './map-asset-location.js';
import type { FastifyRequest } from 'fastify';

export const mapModelBytes = 2 * 1024 ** 3;
const compactMapBytes = JSON.parse(
  readFileSync(
    new URL(
      import.meta.url.endsWith('.ts') ? '../../shared/compact-map.json' : './compact-map.json',
      import.meta.url,
    ),
    'utf8',
  ),
).bytes as number;
const modelLimit = (parts: string[]) => (parts[1] === 'compact' ? compactMapBytes : mapModelBytes);
type ModelFile = { file: FileHandle; size: number; version: string };

/** Discovery and delivery share the same no-follow, single-link, bounded GLB boundary. */
export async function openMapModel(
  root: string,
  parts: string[],
  filename: string,
  baseParts: string[] = ['maps'],
): Promise<ModelFile | undefined> {
  return withDirectory(root, [...baseParts, ...parts], async (directory) => {
    const file = await regularFile(directory, filename, 24, modelLimit(parts));
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

const reserved = new Set([
  'agents',
  'equipment',
  'equipment-models',
  'viewmodels',
  'overviews',
  'environments',
  'previews',
  'packs',
]);
function modelPath(value: string) {
  const agent = /^agents\/(ct|t)\.glb$/.exec(value);
  if (agent) return { parts: ['agents'], filename: `${agent[1]}.glb` };
  const map = /^([a-zA-Z0-9_-]{1,80})\/(desktop|mobile|compact)\/scene\.glb$/.exec(value);
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

// Share one compressor between manual and immutable routes. Other simultaneous loads
// can stream identity without waiting for another client's network connection.
let gzipBusy = false;
function modelEncoding(header: string | undefined, canCompress: boolean) {
  if (!header) return 'identity';
  const weights = new Map<string, number>();
  for (const item of header.split(',')) {
    const match = /^\s*(gzip|identity|\*)\s*(?:;\s*q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?\s*$/i.exec(
      item,
    );
    if (match) weights.set(match[1].toLowerCase(), Number(match[2] ?? 1));
  }
  const gzip = weights.get('gzip') ?? weights.get('*') ?? 0;
  const explicitIdentity = weights.get('identity');
  if (canCompress && gzip > 0 && gzip >= (explicitIdentity ?? 0)) return 'gzip';
  if ((explicitIdentity ?? (weights.get('*') === 0 ? 0 : 1)) > 0) return 'identity';
  throw new HttpError(406, 'No acceptable map model encoding.');
}

/** Fixed model paths only. A broad static server must never follow operator links into private data. */
export async function mapModelFileRoutes(
  app: FastifyInstance,
  root: string,
  {
    digest: proveContent = fileDigest,
    url = '/map-assets/*',
    resolveLocation = async () => manualMapLocation(root),
    authorize,
  }: {
    digest?: typeof fileDigest;
    url?: string;
    resolveLocation?: (request: FastifyRequest) => Promise<MapAssetLocation>;
    authorize?: (request: FastifyRequest) => void;
  } = {},
) {
  app.route<{ Params: { '*': string } }>({
    method: ['GET', 'HEAD'],
    url,
    handler: async (request, reply) => {
      const location = await resolveLocation(request);
      const path = modelPath(request.params['*']);
      if (!path) throw new HttpError(404, 'Map model not found.');
      const cancellation = new AbortController();
      let model: ModelFile | undefined;
      let stream: ReadStream | undefined;
      let encoder: Gzip | undefined;
      let streamOwnsFile = false;
      const abort = () => {
        cancellation.abort();
        encoder?.destroy();
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
        const parts =
          path.parts[0] === 'agents' && location.key === 'manual'
            ? await presentationParts(join(location.root, ...location.parts), 'agents')
            : path.parts;
        model = await openMapModel(location.root, parts, path.filename, location.parts);
        if (!model) throw new HttpError(404, 'Map model not found.');
        connected();
        // Fresh content proof also prevents same-size/same-timestamp rewrites from satisfying an old ETag.
        let digest: string;
        try {
          digest = await proveContent(model.file, modelLimit(path.parts), cancellation.signal);
        } catch {
          throw new HttpError(404, 'Map model not found.');
        }
        connected();
        if (model.version !== (await fileVersion(model.file)))
          throw new HttpError(404, 'Map model not found.');
        authorize?.(request);
        const encoding = modelEncoding(
          request.headers['accept-encoding'],
          path.filename === 'scene.glb' &&
            !request.headers.range &&
            model.size >= 1024 ** 2 &&
            model.size <= 128 * 1024 ** 2 &&
            !gzipBusy,
        );
        // Encoder versions may produce different gzip bytes for the same file.
        const etag = encoding === 'gzip' ? `W/"${digest}-gzip"` : `"${digest}"`;
        reply
          .header('Cache-Control', 'private, no-store')
          .header('ETag', etag)
          .header('Vary', 'Accept-Encoding')
          .header('Accept-Ranges', encoding === 'gzip' ? 'none' : 'bytes')
          .type('model/gltf-binary');
        const condition = request.headers['if-none-match'];
        if (
          typeof condition === 'string' &&
          condition
            .split(',')
            .some(
              (entry) =>
                entry.trim() === '*' ||
                entry.trim().replace(/^W\//, '') === etag.replace(/^W\//, ''),
            )
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
        if (encoding === 'gzip')
          reply.header('Content-Encoding', 'gzip').header('X-File-Size', model.size);
        else reply.header('Content-Length', end - start + 1);
        if (request.method === 'HEAD') return reply.send();
        connected();
        stream = model.file.createReadStream({ start, end, autoClose: true });
        streamOwnsFile = true;
        try {
          connected();
          if (encoding === 'gzip') {
            encoder = createGzip({ level: 1 });
            gzipBusy = true;
            encoder.once('close', () => {
              gzipBusy = false;
              cleanup();
            });
            // Closing the response or rejecting the payload also releases the source FD.
            pipeline(stream, encoder, () => {});
            return reply.send(encoder);
          }
          stream.once('close', cleanup);
          return reply.send(stream);
        } catch (error) {
          cleanup();
          encoder?.destroy();
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

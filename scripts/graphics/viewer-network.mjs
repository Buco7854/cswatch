import assert from 'node:assert/strict';
import { digest } from './capture-report.mjs';

const visual = /\.glb$|\/environment\/|\/grade\./;
const proofHeader = 'x-cswatch-capture-sha256';

// Environment and equipment routes serve bounded Buffers without digest ETags.
// Bind those exact bytes before they leave the disposable QA server. Chromium
// may evict a large completed response body before Playwright can retrieve it.
export function bindViewerResponseBytes(app) {
  const hashes = new WeakMap();
  app.addHook('onSend', async (request, reply, payload) => {
    if (
      request.method === 'GET' &&
      reply.statusCode === 200 &&
      Buffer.isBuffer(payload) &&
      visual.test(request.url.split('?', 1)[0])
    ) {
      let hash = hashes.get(payload);
      if (!hash) {
        hash = digest(payload);
        hashes.set(payload, hash);
      }
      reply.header(proofHeader, hash);
    }
    return payload;
  });
}

export function observeViewerNetwork(page, origin, prefix, chunkIndex) {
  const resources = new Map(),
    scripts = new Map(),
    responses = new Map();
  const requests = new WeakSet(),
    pending = new Set();
  let error;
  const manifest = prefix + '/playback',
    chunk = manifest + '/chunks/' + chunkIndex,
    discovery = prefix + '/map-assets';
  // Ignore requests belonging to the previous page. Auto may also abort a
  // provisional transfer when its GPU probe picks the final model.
  page.on('request', (request) => {
    if (request.method() === 'GET' && new URL(request.url()).origin === origin)
      requests.add(request);
  });
  page.on('requestfinished', (request) => {
    if (!requests.has(request)) return;
    const path = new URL(request.url()).pathname;
    const script = path.startsWith('/assets/') && path.endsWith('.js');
    if (!script && !visual.test(path) && path !== manifest && path !== chunk && path !== discovery)
      return;
    const job = (async () => {
      const response = await request.response();
      if (response?.status() !== 200) return;
      if (script) scripts.set(path, digest(await response.body()));
      else if (path === discovery) responses.set(path, await response.json());
      else if (path === manifest || path === chunk)
        responses.set(path, digest(await response.body()));
      else {
        const headers = response.headers();
        const etag = /^(?:W\/)?"([a-f0-9]{64})(?:-gzip)?"$/.exec(headers.etag ?? '')?.[1];
        const hash = etag ?? headers[proofHeader];
        assert(/^[a-f0-9]{64}$/.test(hash ?? ''), 'Missing visual response digest');
        if (resources.has(path))
          assert.equal(resources.get(path), hash, 'Asset changed during capture');
        resources.set(path, hash);
      }
    })().catch((cause) => {
      error ??= new Error('Could not bind completed response ' + path, { cause });
    });
    pending.add(job);
    void job.finally(() => pending.delete(job));
  });
  return {
    resources,
    scripts,
    responses,
    async settle() {
      while (pending.size) await Promise.all([...pending]);
      if (error) throw error;
    },
  };
}

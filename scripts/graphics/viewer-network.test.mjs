import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import fastify from '../../backend/node_modules/fastify/fastify.js';
import { digest } from './capture-report.mjs';
import { bindViewerResponseBytes, observeViewerNetwork } from './viewer-network.mjs';

test('bind completed visual GETs even after the browser evicts the body', async () => {
  const app = fastify();
  try {
    const bytes = Buffer.from('synthetic model content');
    app.get('/equipment.glb', (_, reply) => reply.type('application/octet-stream').send(bytes));
    bindViewerResponseBytes(app);
    const response = await app.inject({ method: 'GET', url: '/equipment.glb' });
    assert.deepEqual(response.rawPayload, bytes);
    const page = new EventEmitter();
    const origin = 'http://127.0.0.1:4672';
    const network = observeViewerNetwork(page, origin, '/demo', 2);
    const request = (path, headers, method = 'GET') => ({
      method: () => method,
      url: () => origin + path,
      response: async () => ({
        status: () => 200,
        headers: () => headers,
        body: () => {
          throw Error('No data found for resource with given identifier');
        },
      }),
    });
    const active = request('/equipment.glb', response.headers),
      old = request('/library-preview.glb', {}),
      aborted = request('/map/mobile/scene.glb', {}),
      head = request('/map/desktop/scene.glb', {}, 'HEAD'),
      streamed = request('/map/compact/scene.glb', { etag: 'W/"' + digest(bytes) + '-gzip"' });
    page.emit('requestfinished', old);
    for (const entry of [active, aborted, head, streamed]) page.emit('request', entry);
    page.emit('requestfailed', aborted);
    for (const entry of [active, head, streamed]) page.emit('requestfinished', entry);
    await network.settle();
    assert.deepEqual(
      [...network.resources],
      [
        ['/equipment.glb', digest(bytes)],
        ['/map/compact/scene.glb', digest(bytes)],
      ],
    );
    const unbound = request('/required.glb', {});
    page.emit('request', unbound);
    page.emit('requestfinished', unbound);
    await assert.rejects(network.settle, /Could not bind completed response \/required.glb/);
  } finally {
    await app.close();
  }
});

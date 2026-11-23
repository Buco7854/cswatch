import { test } from 'node:test';
import assert from 'node:assert/strict';
import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import { requestLogger } from '../src/request-logger.js';

test('HTTP trace logs keep only bounded error diagnostics and strip request secrets', async (t) => {
  const lines: string[] = [];
  const app = Fastify({
    logger: { ...requestLogger(), level: 'trace', stream: { write: (line) => lines.push(line) } },
  });
  t.after(() => app.close());

  const marker = 'private-placeholder';
  const headers = { cookie: marker, authorization: marker, 'x-recovery-attempt': marker };
  const error = Object.assign(new Error(marker, { cause: new Error(marker) }), {
    name: marker,
    code: 'HPE_HEADER_OVERFLOW',
    statusCode: 431,
    rawPacket: Buffer.from(marker),
    headers,
    request: { headers, body: marker },
  });
  app.log.trace({ err: error }, 'client header_overflow');
  app.log.trace({ err: error });
  app.log.trace(error);
  app.log.error({ err: error }, error.message);
  app.log.trace({
    err: Object.assign(new Error(marker), { code: marker, statusCode: 599.5 }),
    req: { method: 'GET', url: `/api/health?state=${marker}`, headers, body: marker },
  });

  const records = lines.map((line) => JSON.parse(line));
  assert.deepEqual(
    records.map(({ msg, err }) => ({ msg, err })),
    [
      { msg: 'client header_overflow', err: { code: 'HPE_HEADER_OVERFLOW', statusCode: 431 } },
      ...Array.from({ length: 3 }, () => ({
        msg: 'Error',
        err: { code: 'HPE_HEADER_OVERFLOW', statusCode: 431 },
      })),
      { msg: 'Error', err: {} },
    ],
  );
  assert.deepEqual(records[4].req, { method: 'GET', url: '/api/health' });
  assert.doesNotMatch(lines.join(''), /private-placeholder|rawPacket|cause|stack|headers|body/);
});

test('multipart trace logs omit all request headers and retain parser diagnostics', async (t) => {
  const lines: string[] = [];
  const app = Fastify({
    logger: { ...requestLogger(), level: 'trace', stream: { write: (line) => lines.push(line) } },
  });
  t.after(() => app.close());

  const limits = { files: 1, fields: 0, parts: 1, fileSize: 1024 };
  await app.register(multipart, { limits, throwFileSizeLimit: true });
  app.post('/api/demos', async (request) => {
    const file = await request.file({ limits: { fileSize: 512 } });
    assert.ok(file);
    return { size: (await file.toBuffer()).length };
  });

  const marker = 'multipart-private-placeholder';
  const response = await app.inject({
    method: 'POST',
    url: '/api/demos',
    headers: {
      'content-type': `multipart/form-data; boundary=${marker}`,
      cookie: `session=${marker}`,
      authorization: `Bearer ${marker}`,
      'x-csrf-token': marker,
      'x-guest-context': marker,
      'x-custom-header': marker,
    },
    payload: [
      `--${marker}`,
      'Content-Disposition: form-data; name="file"; filename="sample.dem"',
      'Content-Type: application/octet-stream',
      '',
      'sample',
      `--${marker}--`,
      '',
    ].join('\r\n'),
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { size: 6 });
  assert.ok(!lines.some((line) => line.includes(marker)), 'request headers reached the logs');

  const records = lines.map((line) => JSON.parse(line));
  const options = records.find(({ msg }) => msg === 'Providing options to busboy');
  assert.deepEqual(options?.busboyOptions, {
    limits: { ...limits, fileSize: 512 },
    throwFileSizeLimit: true,
  });
  assert.ok(records.some(({ msg, res }) => msg === 'request completed' && res.statusCode === 200));
});

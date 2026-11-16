import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, RequestOptions } from 'node:http';
import { createHash } from 'node:crypto';
import {
  downloadRemoteDemo,
  isPublicDownloadAddress,
  resolveRemoteAddress,
  validateRemoteUrl,
} from '../src/remote-download.js';

const url = 'https://demos.example.com/match.dem';
const hosts = ['demos.example.com'];
const publicAddress = [{ address: '8.8.8.8', family: 4 }];

test('remote resources require exact HTTPS allowlist entries', () => {
  assert.equal(validateRemoteUrl(url, hosts).hostname, 'demos.example.com');
  for (const value of [
    'http://demos.example.com/match.dem',
    'https://demos.example.com:8443/match.dem',
    'https://demos.example.com.evil.test/match.dem',
    'https://evil.demos.example.com/match.dem',
    'https://user:secret@demos.example.com/match.dem',
    'https://demos.example.com/match.dem#anything',
    'https://127.0.0.1/match.dem',
    'https://[::1]/match.dem',
  ])
    assert.throws(() => validateRemoteUrl(value, hosts));
  assert.throws(() => validateRemoteUrl(url, ['*.example.com']));
});

test('remote DNS rejects private, mapped, special-use and mixed answer sets', async () => {
  const blocked = [
    '0.0.0.1',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.0.0.1',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:8.8.8.8',
    'fd00::1',
    'fe80::1',
    '2001:db8::1',
    '2002:7f00:1::',
    '3fff::1',
  ];
  for (const address of blocked) assert.equal(isPublicDownloadAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888'])
    assert.equal(isPublicDownloadAddress(address), true, address);
  await assert.rejects(() => resolveRemoteAddress(new URL(url), async () => []));
  await assert.rejects(() =>
    resolveRemoteAddress(new URL(url), async () => [
      ...publicAddress,
      { address: '127.0.0.1', family: 4 },
    ]),
  );
  await assert.rejects(() =>
    resolveRemoteAddress(new URL(url), async () => [{ address: '8.8.8.8', family: 6 }]),
  );
});

type Dependencies = NonNullable<Parameters<typeof downloadRemoteDemo>[3]>;
function fixture(
  chunks: Buffer[],
  statusCode = 200,
  headers: Record<string, string> = {},
  inspect?: (options: RequestOptions) => void,
): Dependencies {
  return {
    lookup: async () => publicAddress,
    request: (_url, options, callback) => {
      inspect?.(options);
      const request = new EventEmitter();
      Object.assign(request, {
        destroy: () => request,
        end: () => {
          queueMicrotask(() => {
            const response = Readable.from(chunks) as unknown as IncomingMessage;
            response.statusCode = statusCode;
            response.headers = headers;
            callback(response);
          });
          return request;
        },
      });
      return request as ReturnType<NonNullable<Dependencies['request']>>;
    },
  };
}

test('downloads pin the checked DNS address and verify byte count and integrity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cswatch-download-'));
  const payload = Buffer.from('PBDEMS2\0test demo');
  const destination = join(dir, 'input.dem');
  try {
    let checks = 0;
    const result = await downloadRemoteDemo(
      url,
      destination,
      {
        allowedHosts: hosts,
        maxBytes: 100,
        signal: AbortSignal.timeout(1000),
        sha256: createHash('sha256').update(payload).digest('hex'),
      },
      fixture([payload], 200, { 'content-length': String(payload.length) }, (options) => {
        assert.equal(options.agent, false);
        assert.equal(options.family, 4);
        assert.deepEqual(options.headers, {
          'Accept-Encoding': 'identity',
          'User-Agent': 'cswatch/1 demo-import',
        });
        (options.lookup as any)('demos.example.com', {}, (error: Error, address: string) => {
          assert.equal(error, null);
          assert.equal(address, '8.8.8.8');
          checks++;
        });
      }),
    );
    assert.equal(checks, 1);
    assert.equal(result.bytes, payload.length);
    assert.deepEqual(readFileSync(destination), payload);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('download bounds reject redirects, encoding, oversized and incomplete responses', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cswatch-download-bounds-'));
  const destination = join(dir, 'input.dem');
  const options = { allowedHosts: hosts, maxBytes: 8, signal: AbortSignal.timeout(5000) };
  try {
    for (const dependencies of [
      fixture([], 302, { location: 'https://localhost/private' }),
      fixture([], 200, { 'content-encoding': 'gzip' }),
      fixture([], 200, { 'content-length': '9' }),
    ]) {
      await assert.rejects(() => downloadRemoteDemo(url, destination, options, dependencies));
      assert.equal(existsSync(destination), false);
    }
    await assert.rejects(() =>
      downloadRemoteDemo(url, destination, options, fixture([Buffer.alloc(9)])),
    );
    rmSync(destination, { force: true });
    await assert.rejects(() =>
      downloadRemoteDemo(
        url,
        destination,
        options,
        fixture([Buffer.alloc(1)], 200, { 'content-length': '2' }),
      ),
    );
    rmSync(destination, { force: true });
    await assert.rejects(() =>
      downloadRemoteDemo(
        url,
        destination,
        { ...options, sha256: '0'.repeat(64) },
        fixture([Buffer.from('x')]),
      ),
    );
    rmSync(destination, { force: true });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() =>
      downloadRemoteDemo(
        url,
        destination,
        { ...options, signal: controller.signal },
        fixture([Buffer.from('x')]),
      ),
    );
    assert.equal(existsSync(destination), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aborting a download also bounds a stalled DNS resolver', async () => {
  const controller = new AbortController();
  let requested = false;
  const promise = downloadRemoteDemo(
    url,
    '/unused',
    {
      allowedHosts: hosts,
      maxBytes: 100,
      signal: controller.signal,
    },
    {
      lookup: () => new Promise(() => {}),
      request: () => {
        requested = true;
        throw new Error('Must not connect.');
      },
    },
  );
  controller.abort(new Error('Cancelled test download.'));
  await assert.rejects(promise, /Cancelled test download/);
  assert.equal(requested, false);
});

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
  downloadSteamReplay,
  validateSteamReplayUrl,
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
  inspect?: (options: RequestOptions, url: URL) => void,
  peer = publicAddress[0].address,
): Dependencies {
  return {
    lookup: async () => publicAddress,
    request: (url, options, callback) => {
      inspect?.(options, url);
      const request = new EventEmitter();
      Object.assign(request, {
        destroy: () => request,
        end: () => {
          queueMicrotask(() => {
            const response = Readable.from(chunks) as unknown as IncomingMessage;
            Object.assign(response, { socket: { remoteAddress: peer } });
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

test('Steam accepts only the exact numbered Valve replay object for the saved reservation and token', () => {
  const expected = { outcome_id: '987654321', token: 17 };
  const url = 'http://replay123.valve.net/730/000000000000987654321_0000065553.dem.bz2';
  for (const scheme of ['http', 'https']) {
    const input = url.replace('http:', scheme + ':');
    assert.equal(validateSteamReplayUrl(input, expected).href, input);
  }
  for (const value of [
    url.replace('http:', 'ftp:'),
    url.replace('123.', '1234.'),
    url.replace('123.', 'abc.'),
    url.replace('valve.net', 'valve.net.evil.test'),
    url.replace('replay123', 'other.replay123'),
    url.replace('valve.net', 'valve.net:80'),
    url.replace('//', '//name@'),
    url.replace('730/', '730/a/../'),
    url.replace('730/', '%37730/'),
    url.replace('987654321', '987654320'),
    url.replace('0000065553', '0000065554'),
    url.replace('0000065553', '4294967313'),
    url.replace('.bz2', '.gz'),
    url + '?',
    url + '#',
    url + '\n',
  ])
    assert.throws(() => validateSteamReplayUrl(value, expected), /confirm the replay/, value);
  assert.throws(() => validateRemoteUrl(url, ['replay123.valve.net']), /unsupported download host/);
});

test('Steam replay transfers pin a public peer, report cooldowns, and never follow redirects or retry TLS failures', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cswatch-steam-download-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'input.bz2');
  const url = 'http://replay9.valve.net/730/000000000000000000077_0000000001.dem.bz2';
  const reports: [number, string | null | undefined][] = [];
  const options = {
    expected: { outcome_id: '77', token: 1 },
    maxBytes: 8,
    signal: AbortSignal.timeout(3000),
    onResponse(status: number, retryAfter?: string | null) {
      reports.push([status, retryAfter]);
    },
  };
  const seen: string[] = [];
  const response = (chunks: Buffer[], status = 200, headers = {}, peer = '8.8.8.8') =>
    fixture(
      chunks,
      status,
      headers,
      (options, url) => {
        seen.push(url.href);
        assert.deepEqual(options.headers, {
          'Accept-Encoding': 'identity',
          'User-Agent': 'cswatch/1 demo-import',
        });
      },
      peer,
    );
  for (const peer of ['127.0.0.1', '1.1.1.1', '::ffff:8.8.8.8']) {
    await assert.rejects(
      downloadSteamReplay(url, path, options, response([], 200, {}, peer)),
      /restricted network/,
    );
    assert.equal(existsSync(path), false);
  }
  assert.deepEqual(reports, []);
  const invalid = [
    [302, { location: 'https://elsewhere.example/file' }],
    [410, {}],
    [429, { 'retry-after': '120' }],
  ] as const;
  for (const [status, headers] of invalid) {
    await assert.rejects(downloadSteamReplay(url, path, options, response([], status, headers)));
  }
  assert.deepEqual(reports, [
    [302, undefined],
    [410, undefined],
    [429, '120'],
  ]);
  const tls = url.replace('http:', 'https:');
  await assert.rejects(
    downloadSteamReplay(tls, path, options, {
      lookup: async () => publicAddress,
      request(value) {
        seen.push(value.href);
        throw new Error('synthetic TLS verification failure');
      },
    }),
    /TLS verification/,
  );
  assert.deepEqual(seen, [url, url, url, url, url, url, tls]);
  await assert.rejects(
    downloadSteamReplay(url, path, options, response([], 200, { 'content-length': '9' })),
    /exceeds/,
  );
  assert.equal(existsSync(path), false);
  const bytes = Buffer.from('BZh9data');
  assert.deepEqual(await downloadSteamReplay(url, path, options, response([bytes])), { bytes: 8 });
  assert.deepEqual(readFileSync(path), bytes);
});

test('remote failure reporting counts DNS, transport and short streams while local denials and cancellations preserve the provider budget', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cswatch-download-report-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let failures = 0;
  const options = {
    allowedHosts: hosts,
    signal: AbortSignal.timeout(3000),
    maxBytes: 8,
    onNetworkFailure: () => {
      failures++;
    },
  };
  const download = (name: string, deps: Dependencies) =>
    downloadRemoteDemo(url, join(dir, name), options, deps);
  const problem = (code: string) => Object.assign(new Error('fixture'), { code });
  await assert.rejects(
    download('dns', {
      lookup: async () => {
        throw problem('EAI_AGAIN');
      },
    }),
    /resolved/,
  );
  await assert.rejects(
    download('socket', {
      lookup: async () => publicAddress,
      request: () => {
        throw problem('ECONNRESET');
      },
    }),
  );
  await assert.rejects(
    download('short', fixture([Buffer.from('x')], 200, { 'content-length': '2' })),
    /incomplete/,
  );
  assert.equal(failures, 3);
  await assert.rejects(
    download('peer', { lookup: async () => [{ address: '127.0.0.1', family: 4 }] }),
  );
  await assert.rejects(download('limit', fixture([Buffer.alloc(9)])), /exceeds/);
  await assert.rejects(download('absent/path', fixture([Buffer.from('x')])), { code: 'ENOENT' });
  const controller = new AbortController();
  const pending = downloadRemoteDemo(
    url,
    join(dir, 'cancel'),
    { ...options, signal: controller.signal },
    { lookup: () => new Promise(() => {}) },
  );
  controller.abort();
  await assert.rejects(pending);
  assert.equal(failures, 3);
});

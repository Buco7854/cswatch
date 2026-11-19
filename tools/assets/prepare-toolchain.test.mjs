import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { crc32 } from 'node:zlib';
import {
  assertPackageLock,
  prepareToolchain,
  toolchainDirectory,
  toolchainLock,
  verifyToolchain,
} from './prepare-toolchain.mjs';
import { toolchainPins } from './toolchain-pins.mjs';
import {
  archivePath,
  artifactUrl,
  downloadArtifact,
  extractArchive,
  inventoryTree,
  runTool,
} from './toolchain-security.mjs';

async function temporary(run) {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-toolchain-test-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const fixture = Buffer.from('original synthetic operator tool archive');
const fixtureArtifact = {
  ...toolchainPins.s2v,
  hash: createHash('sha256').update(fixture).digest('hex'),
  maxBytes: 256,
};

// Original stored ZIP entries, never upstream binaries or game artwork.
function zipFixture({ declaredSize, linked = false } = {}) {
  const names = [
    'Source2Viewer-CLI',
    'THIRD_PARTY_NOTICES.txt',
    'libSkiaSharp.so',
    'libspirv-cross.so',
  ];
  const local = [],
    central = [];
  let offset = 0;
  for (const name of names) {
    const path = Buffer.from(name),
      data = Buffer.from('synthetic');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(declaredSize ?? data.length, 22);
    header.writeUInt16LE(path.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(0x0314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc32(data), 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(declaredSize ?? data.length, 24);
    directory.writeUInt16LE(path.length, 28);
    directory.writeUInt32LE(((linked ? 0xa1c0 : 0x81c0) * 65536) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    local.push(header, path, data);
    central.push(directory, path);
    offset += header.length + path.length + data.length;
  }
  const end = Buffer.alloc(22),
    entries = Buffer.concat(central);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(entries.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, entries, end]);
}

test('official artifact redirects reject non-HTTPS, credentials, unrelated paths and origins', () => {
  assert.equal(artifactUrl(toolchainPins.s2v, toolchainPins.s2v.url).protocol, 'https:');
  assert.equal(
    artifactUrl(
      toolchainPins.s2v,
      'https://release-assets.githubusercontent.com/github-production-release-asset/123/file?signature=public',
    ).hostname,
    'release-assets.githubusercontent.com',
  );
  for (const url of [
    'http://github.com/ValveResourceFormat/ValveResourceFormat/releases/download/21.1/cli-linux-x64.zip',
    'https://example.com/archive.zip',
    'https://github.com/another/repository/archive.zip',
    'https://release-assets.githubusercontent.com/another-path/archive.zip',
    'https://user:password@github.com/ValveResourceFormat/ValveResourceFormat/releases/download/21.1/cli-linux-x64.zip',
    'https://github.com:444/ValveResourceFormat/ValveResourceFormat/releases/download/21.1/cli-linux-x64.zip',
    'file:///etc/passwd',
  ])
    assert.throws(() => artifactUrl(toolchainPins.s2v, url));
  assert.throws(() =>
    artifactUrl(toolchainPins.sdk, 'https://dotnetcli.blob.core.windows.net/another-sdk.tar.gz'),
  );
});

test('archive names reject parent traversal, absolute paths and control-character aliases', () => {
  assert.equal(archivePath('./sdk/10.0/file.dll'), 'sdk/10.0/file.dll');
  for (const value of [
    '../escape',
    '/absolute',
    'a/../../escape',
    'a\\b',
    'a\nb',
    'a//b',
    '././alias',
  ])
    assert.throws(() => archivePath(value));
});

test('restored package content must match the locked dependency set independently of archive hashes', () => {
  const libraries = Object.fromEntries(
    toolchainPins.packages.map((pin) => [
      `${pin.name}/${pin.version}`,
      { type: 'package', sha512: pin.contentHash },
    ]),
  );
  assertPackageLock(libraries);
  const first = Object.keys(libraries)[0];
  assert.throws(
    () => assertPackageLock({ ...libraries, [first]: { type: 'package', sha512: 'changed' } }),
    /content/,
  );
  assert.throws(
    () =>
      assertPackageLock({ ...libraries, 'unexpected/1.0.0': { type: 'package', sha512: 'other' } }),
    /locked packages/,
  );
});

test('bounded downloads follow only an approved redirect and verify bytes before returning', async (t) => {
  await temporary(async (root) => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      calls.push({ url: String(url), options });
      return calls.length === 1
        ? new Response(null, {
            status: 302,
            headers: {
              location:
                'https://release-assets.githubusercontent.com/github-production-release-asset/123/tool.zip',
            },
          })
        : new Response(fixture);
    });
    const target = join(root, 'archive.zip');
    assert.equal(await downloadArtifact(fixtureArtifact, target), fixture.length);
    assert.deepEqual(await readFile(target), fixture);
    assert.equal(calls.length, 2);
    assert.ok(
      calls.every(({ options }) => options.redirect === 'manual' && options.credentials === 'omit'),
    );
  });
});

test('downloads reject redirect escapes, oversized responses, bad hashes and cancellation', async (t) => {
  await temporary(async (root) => {
    const fetch = t.mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response(null, { status: 302, headers: { location: 'https://example.com/tool.zip' } }),
    );
    await assert.rejects(downloadArtifact(fixtureArtifact, join(root, 'redirect')), /official/);
    assert.equal(fetch.mock.callCount(), 1);
    fetch.mock.mockImplementation(
      async () => new Response(fixture, { headers: { 'content-length': '100000' } }),
    );
    await assert.rejects(downloadArtifact(fixtureArtifact, join(root, 'length')), /byte limit/);
    fetch.mock.mockImplementation(async () => new Response(Buffer.alloc(300)));
    await assert.rejects(downloadArtifact(fixtureArtifact, join(root, 'stream')), /byte limit/);
    fetch.mock.mockImplementation(async () => new Response('wrong archive'));
    await assert.rejects(downloadArtifact(fixtureArtifact, join(root, 'hash')), /checksum/);
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      prepareToolchain({ cache: join(root, 'cache'), signal: abort.signal }),
      /abort/i,
    );
  });
});

test('a checksum failure leaves no published tools, staging directory or lock', async (t) => {
  await temporary(async (root) => {
    const cache = join(root, 'cache');
    t.mock.method(globalThis, 'fetch', async () => new Response('not the pinned release'));
    await assert.rejects(prepareToolchain({ cache }), /checksum/);
    assert.deepEqual(await readdir(cache), []);
  });
});

test('cache ancestors and final targets cannot be symlinks, and incomplete caches are not repaired', async (t) => {
  await temporary(async (root) => {
    let network = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      network++;
      throw new Error('Unexpected network');
    });
    const outside = join(root, 'outside');
    await mkdir(outside, { mode: 0o700 });
    await writeFile(join(outside, 'keep.txt'), 'untouched');
    const alias = join(root, 'alias');
    await symlink(outside, alias);
    await assert.rejects(prepareToolchain({ cache: join(alias, 'cache') }), /real directories/);
    const cache = join(root, 'cache');
    await mkdir(cache, { mode: 0o700 });
    const final = join(cache, toolchainDirectory);
    await symlink(outside, final);
    await assert.rejects(prepareToolchain({ cache }), /real directories/);
    await rm(final);
    await mkdir(final, { mode: 0o700 });
    await writeFile(join(final, 'keep.txt'), 'incomplete');
    await assert.rejects(prepareToolchain({ cache }));
    assert.equal(await readFile(join(final, 'keep.txt'), 'utf8'), 'incomplete');
    assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'untouched');
    assert.equal(network, 0);
  });
});

test('cached tools verify their entire inventory and refuse changed or extra files', async () => {
  await temporary(async (root) => {
    const source = 'source/SteamFileDownloader-' + toolchainPins.source.version + '/bin/';
    for (const path of [
      's2v/Source2Viewer-CLI',
      's2v/libSkiaSharp.so',
      's2v/libspirv-cross.so',
      'runtime/dotnet',
      source + 'SteamFileDownloader',
      source + 'SteamFileDownloader.dll',
      'SteamFileDownloader',
    ]) {
      const file = join(root, path);
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, 'synthetic file only, never executed', { mode: 0o700 });
    }
    const provenance = {
      format: 1,
      platform: 'linux',
      arch: 'x64',
      lock: toolchainLock,
      pins: toolchainPins,
      files: await inventoryTree(root),
    };
    await writeFile(join(root, 'provenance.json'), JSON.stringify(provenance), { mode: 0o600 });
    assert.equal((await verifyToolchain(root)).downloader, join(root, 'SteamFileDownloader'));
    await writeFile(join(root, 'SteamFileDownloader'), 'changed');
    await assert.rejects(verifyToolchain(root), /corrupt/);
    await symlink('/tmp', join(root, 'unexpected-link'));
    await assert.rejects(verifyToolchain(root), /symbolic links/);
  });
});

test('tar extraction rejects linked entries and declared expansion before extraction', async () => {
  await temporary(async (root) => {
    const input = join(root, 'input');
    await mkdir(input, { mode: 0o700 });
    await writeFile(join(input, 'safe.txt'), 'small synthetic file');
    const archive = join(root, 'safe.tar.gz');
    await runTool('tar', ['--create', '--gzip', '--file', archive, '--directory', input, '.']);
    await extractArchive({ format: 'tar', maxExpanded: 1024 }, archive, join(root, 'valid'));
    assert.equal(await readFile(join(root, 'valid/safe.txt'), 'utf8'), 'small synthetic file');
    await assert.rejects(
      extractArchive({ format: 'tar', maxExpanded: 1 }, archive, join(root, 'large')),
      /expands/,
    );
    await symlink('/etc/passwd', join(input, 'unsafe'));
    await runTool('tar', ['--create', '--gzip', '--file', archive, '--directory', input, '.']);
    await assert.rejects(
      extractArchive({ format: 'tar', maxExpanded: 1024 }, archive, join(root, 'linked')),
      /unsupported entry/,
    );
  });
});

test('S2V ZIP extraction checks the fixed file set, entry types and declared expansion first', async () => {
  await temporary(async (root) => {
    const archive = join(root, 'fixture.zip');
    const artifact = { format: 'zip', maxExpanded: 1024 };
    await writeFile(archive, zipFixture());
    await extractArchive(artifact, archive, join(root, 'valid'));
    assert.equal(await readFile(join(root, 'valid/Source2Viewer-CLI'), 'utf8'), 'synthetic');
    await writeFile(archive, zipFixture({ declaredSize: 2000 }));
    await assert.rejects(extractArchive(artifact, archive, join(root, 'large')), /expands/);
    assert.deepEqual(await readdir(join(root, 'large')), []);
    await writeFile(archive, zipFixture({ linked: true }));
    await assert.rejects(
      extractArchive(artifact, archive, join(root, 'linked')),
      /fixed release files/,
    );
    assert.deepEqual(await readdir(join(root, 'linked')), []);
  });
});

test('subprocess output and lifetime are bounded without executing downloaded code', async () => {
  await assert.rejects(
    runTool(process.execPath, ['-e', "process.stdout.write('x'.repeat(10000))"], {
      maxOutput: 128,
    }),
    /output limit/,
  );
  await assert.rejects(
    runTool(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 30 }),
    /time limit/,
  );
});

test('trusted tool failures preserve a bounded exit status for safe inventory diagnostics', async () => {
  await assert.rejects(
    runTool(process.execPath, ['-e', 'process.exit(13)']),
    (error) => error.exitCode === 13,
  );
});

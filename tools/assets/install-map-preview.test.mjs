import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { buildNetworkDeny } from './build-network-deny.mjs';
import {
  installMapPreview,
  normalizeOfficialPreview,
  officialPreview,
} from './install-map-preview.mjs';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'official-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = join(root, 'cache'),
    output = join(root, 'assets');
  await mkdir(cache);
  await mkdir(output);
  const networkDeny = buildNetworkDeny(join(root, 'boundary')),
    s2v = join(root, 's2v'),
    downloader = join(root, 'downloader');
  await writeFile(s2v, 'original trusted tool fixture');
  await writeFile(downloader, 'original trusted tool fixture');
  const image = await sharp({
    create: { width: 32, height: 18, channels: 4, background: { r: 30, g: 60, b: 90, alpha: 1 } },
  })
    .png()
    .toBuffer();
  const indexBytes = Buffer.from('original bounded VPK directory'),
    sha1 = createHash('sha1').update(indexBytes).digest('hex');
  return { root, cache, output, networkDeny, s2v, downloader, image, indexBytes, sha1 };
}
function pipeline(f, settings = {}) {
  let downloads = 0,
    conversions = 0,
    listed = 0,
    published = 0,
    entryAvailable = Boolean(settings.cachedEntry);
  const raw = Buffer.from('Original native resource fixture');
  const adapters = {
    storage: async () => {},
    reserve: async () => {},
    index: async () => ({
      entries: new Map([
        [
          officialPreview.resource,
          { length: raw.length, preloadBytes: 0, resource: officialPreview.resource, crc32: 1 },
        ],
      ]),
      readEntry: async () => (entryAvailable ? (settings.badCrc ? undefined : raw) : undefined),
    }),
    run: async (command, args, context) => {
      if (command === f.downloader) {
        assert.equal(context.conversionWriteRoots, undefined);
        if (args[0] === 'ls') {
          listed++;
          return {
            stdout: `2347770\t${settings.manifest ?? '123'}\t${f.sha1}\t${f.indexBytes.length}\tgame/csgo/pak01_dir.vpk\n`,
            stderr: '',
            code: 0,
          };
        }
        downloads++;
        const selection = JSON.parse(await readFile(join(context.cwd, 'files.json'), 'utf8'));
        if (selection[2347770].includes(`game/csgo/pak01_dir.vpk:${officialPreview.resource}`))
          entryAvailable = true;
        assert.ok(
          selection[2347770].every(
            (value) =>
              value === 'game/csgo/pak01_dir.vpk' ||
              value === `game/csgo/pak01_dir.vpk:${officialPreview.resource}`,
          ),
        );
        const directory = join(f.cache, 'steam/game/csgo');
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'pak01_dir.vpk'), f.indexBytes);
        return { stdout: '', stderr: '', code: 0 };
      }
      assert.equal(command, f.networkDeny);
      assert.equal(args[0], '--write-root');
      const root = args[1];
      assert.ok(root.endsWith('/conversion'));
      assert.deepEqual(context.conversionWriteRoots, [root]);
      assert.ok(context.home.startsWith(root + '/'));
      assert.ok(context.temporary.startsWith(root + '/'));
      assert.equal(args[2], '--');
      if (args[3] === f.s2v) {
        const input = args[args.indexOf('-i') + 1];
        assert.ok(input.startsWith(root + '/'));
        assert.deepEqual(await readFile(input), raw);
        await writeFile(join(args[args.indexOf('--output') + 1], 'source.png'), f.image);
      } else {
        assert.equal(args[3], process.execPath);
        assert.equal(args[4], '--max-old-space-size=256');
        assert.ok(args.includes('--prepare-image'));
        await writeFile(
          args[args.indexOf('--output') + 1],
          settings.corrupt ? Buffer.from('not an image') : f.image,
        );
      }
      conversions++;
      return { stdout: '', stderr: '', code: 0 };
    },
  };
  const options = {
    cache: f.cache,
    output: f.output,
    manifest: '123',
    networkDeny: f.networkDeny,
    s2v: f.s2v,
    downloader: f.downloader,
    beforePublish: async () => {
      published++;
      if (settings.rejectBudget)
        throw Object.assign(Error('Prepared budget exhausted'), { code: 'ASSET_STORAGE_LIMIT' });
    },
  };
  return { adapters, options, counts: () => ({ downloads, conversions, listed, published }) };
}
test('fixed official screenshot acquisition checks pinned index/CRC, isolates both converters and atomically publishes bounded original pixels', async (t) => {
  const f = await fixture(t),
    p = pipeline(f),
    result = await installMapPreview(p.options, p.adapters);
  assert.equal(result.status, 'prepared');
  assert.deepEqual(p.counts(), { downloads: 2, conversions: 2, listed: 1, published: 1 });
  const folder = join(f.output, 'previews/de_mirage'),
    metadata = JSON.parse(await readFile(join(folder, 'preview.json'), 'utf8')),
    bytes = await readFile(join(folder, 'preview.png'));
  assert.deepEqual(bytes, f.image);
  assert.equal(metadata.imageSha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(metadata.assetVersion, 'steam-2347770-123');
  const report = JSON.parse(await readFile(join(folder, 'provenance.json'), 'utf8'));
  assert.equal(report.source.resource, officialPreview.resource);
  assert.equal(report.source.manifest, '123');
  assert.equal((await sharp(bytes).metadata()).width, 32);
});
test('verified cached source bytes skip downloader allocation while a same-size index rewrite requires fresh acquisition', async (t) => {
  for (const corrupt of [false, true]) {
    const f = await fixture(t),
      directory = join(f.cache, 'steam/game/csgo');
    await mkdir(directory, { recursive: true });
    const index = Buffer.from(f.indexBytes);
    if (corrupt) index[0] ^= 1;
    await writeFile(join(directory, 'pak01_dir.vpk'), index);
    const p = pipeline(f, { cachedEntry: true }),
      allocations = [],
      reserves = [];
    p.adapters.storage = async (_cache, _output, bytes = 0) => allocations.push(bytes);
    p.adapters.reserve = async (_cache, _output, bytes = 0) => reserves.push(bytes);
    const result = await installMapPreview(p.options, p.adapters);
    assert.equal(result.status, 'prepared');
    assert.equal(p.counts().downloads, corrupt ? 1 : 0);
    assert.equal(
      allocations.some((bytes) => bytes >= 64 * 1024 ** 2),
      corrupt,
    );
    assert.ok(reserves.some((bytes) => bytes > 16 * 1024 ** 2));
    assert.deepEqual(await readFile(join(directory, 'pak01_dir.vpk')), f.indexBytes);
  }
});
test('any fixed operator preview is preserved without tool bootstrap or Steam contact, and linked roots fail before side effects', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.output, 'previews/de_cache'), { recursive: true });
  await writeFile(join(f.output, 'previews/de_cache/operator.txt'), 'preserve');
  const result = await installMapPreview(
    { cache: f.cache, output: f.output, manifest: '123', networkDeny: f.networkDeny },
    {
      prepareToolchain: async () => {
        throw Error('No bootstrap allowed');
      },
      run: async () => {
        throw Error('No process allowed');
      },
    },
  );
  assert.deepEqual(result, { status: 'installed', map: 'de_cache' });
  assert.deepEqual(await readdir(join(f.output, 'previews')), ['de_cache']);
  const linked = join(f.root, 'linked');
  await symlink(f.cache, linked);
  await assert.rejects(
    () =>
      installMapPreview({
        cache: linked,
        output: f.output,
        manifest: '123',
        networkDeny: f.networkDeny,
      }),
    /real directories/,
  );
});
test('wrong source, failed CRC, corrupt output and exhausted prepared budget cannot publish a preview', async (t) => {
  for (const settings of [
    { manifest: '124' },
    { badCrc: true },
    { corrupt: true },
    { rejectBudget: true },
  ]) {
    const f = await fixture(t),
      p = pipeline(f, settings);
    await assert.rejects(
      () => installMapPreview(p.options, p.adapters),
      (error) =>
        settings.manifest || settings.badCrc
          ? error.code === 'SOURCE_MAP_MISMATCH'
          : settings.rejectBudget
            ? error.code === 'ASSET_STORAGE_LIMIT'
            : /PNG/.test(error.message),
    );
    const files = await readdir(f.output);
    assert.ok(
      files.length === 0 ||
        (files.length === 1 &&
          files[0] === 'previews' &&
          (await readdir(join(f.output, 'previews'))).length === 0),
    );
    assert.equal(
      (await readdir(f.cache)).some((name) => name.startsWith('preview-install-')),
      false,
    );
  }
});
test('the reusable Sharp-only normalization phase retains original pixels and refuses overwriting an existing output', async (t) => {
  const f = await fixture(t),
    input = join(f.root, 'input.png'),
    output = join(f.root, 'normalized.png');
  await writeFile(input, f.image);
  const result = await normalizeOfficialPreview({ input, output });
  assert.equal(result.width, 32);
  assert.equal(result.height, 18);
  assert.equal(
    result.sha256,
    createHash('sha256')
      .update(await readFile(output))
      .digest('hex'),
  );
  assert.deepEqual(await sharp(output).raw().toBuffer(), await sharp(input).raw().toBuffer());
  await assert.rejects(() => normalizeOfficialPreview({ input, output }), { code: 'EEXIST' });
});

test('Sharp preview normalization runs in the required stage-only child and cannot write outside that stage', async (t) => {
  const { runAssetProcess } = await import('./install-steam-assets.mjs'),
    { fileURLToPath } = await import('node:url');
  const f = await fixture(t),
    conversion = join(f.root, 'conversion'),
    home = join(conversion, 'home'),
    temporary = join(conversion, 'tmp');
  for (const path of [conversion, home, temporary]) await mkdir(path);
  const input = join(conversion, 'original.png'),
    output = join(conversion, 'normalized.png'),
    control = join(f.root, 'downloader-control.json'),
    outside = join(f.root, 'escaped-preview.png');
  await writeFile(input, f.image);
  await writeFile(control, 'preserve');
  const args = [
    '--write-root',
    conversion,
    '--',
    process.execPath,
    '--max-old-space-size=256',
    fileURLToPath(new URL('./install-map-preview.mjs', import.meta.url)),
    '--prepare-image',
    input,
    '--output',
  ];
  const result = await runAssetProcess(f.networkDeny, [...args, output], {
    cwd: f.root,
    home,
    temporary,
    log: join(f.root, 'normalized.log'),
    timeoutMs: 30000,
  });
  assert.equal(result.code, 0);
  const decoded = await sharp(await readFile(output))
    .raw()
    .toBuffer();
  assert.deepEqual([...decoded.subarray(0, 4)], [30, 60, 90, 255]);
  const denied = await runAssetProcess(f.networkDeny, [...args, outside], {
    cwd: f.root,
    home,
    temporary,
    log: join(f.root, 'denied.log'),
    timeoutMs: 30000,
    allowFailure: true,
  });
  assert.notEqual(denied.code, 0);
  assert.equal(await readFile(control, 'utf8'), 'preserve');
  await assert.rejects(() => readFile(outside), { code: 'ENOENT' });
});

test('linked nested Steam output directories or existing package targets fail before downloader writes', async (t) => {
  for (const nested of ['directory', 'index']) {
    const f = await fixture(t),
      outside = join(f.root, 'operator-data');
    await mkdir(outside);
    await writeFile(join(outside, 'original'), 'preserve');
    await mkdir(join(f.cache, 'steam'));
    await mkdir(join(f.cache, 'steam/game'));
    if (nested === 'directory') await symlink(outside, join(f.cache, 'steam/game/csgo'));
    else {
      await mkdir(join(f.cache, 'steam/game/csgo'));
      await symlink(join(outside, 'original'), join(f.cache, 'steam/game/csgo/pak01_dir.vpk'));
    }
    let called = false;
    await assert.rejects(() =>
      installMapPreview(
        {
          cache: f.cache,
          output: f.output,
          manifest: '123',
          networkDeny: f.networkDeny,
          s2v: f.s2v,
          downloader: f.downloader,
        },
        {
          run: async () => {
            called = true;
            throw Error('Must not execute');
          },
        },
      ),
    );
    assert.equal(called, false);
    assert.equal(await readFile(join(outside, 'original'), 'utf8'), 'preserve');
  }
});

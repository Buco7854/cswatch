import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { managedSoundDirectory } from '../../shared/gameplay-sound-bank.mjs';
import { installGameplaySounds } from './install-gameplay-sounds.mjs';
import { buildNetworkDeny } from './build-network-deny.mjs';
import { soundRegistryIds, gameplaySoundRegistry } from './prepare-gameplay-sounds.mjs';
function wav() {
  const data = Buffer.alloc(1644);
  data.write('RIFF');
  data.writeUInt32LE(1636, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(8000, 24);
  data.writeUInt32LE(16000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(1600, 40);
  return data;
}
test('sound installer validates roots/selection/confinement before bootstrap or downloader effects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sound-installer-roots-'));
  try {
    const cache = join(root, 'cache'),
      output = join(root, 'output');
    await mkdir(cache);
    await mkdir(output);
    const linked = join(cache, 'steam');
    await symlink(output, linked);
    let calls = 0;
    await assert.rejects(
      () =>
        installGameplaySounds(
          { cache, output, manifest: '123' },
          {
            prepareToolchain: async () => {
              calls++;
              throw Error('must notrun');
            },
          },
        ),
      /real directories/,
    );
    assert.equal(calls, 0);
    await assert.rejects(
      () => installGameplaySounds({ cache, output, manifest: '123', items: ['../../x'] }),
      /Unknown/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('selective sound acquisition pins/hash-checks sources and isolates conversion from downloader controls before no-replace publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sound-installer-'));
  try {
    const cache = join(root, 'cache'),
      output = join(root, 'output');
    await mkdir(cache);
    await mkdir(output);
    await mkdir(join(output, 'sounds'));
    await writeFile(join(output, 'sounds/operator-file'), 'operator');
    const generation = join(output, managedSoundDirectory);
    const networkDeny = buildNetworkDeny(join(root, 'boundary')),
      s2v = join(root, 's2v'),
      downloader = join(root, 'downloader');
    await writeFile(s2v, 'trusted original fixture');
    await writeFile(downloader, 'trusted original fixture');
    const indexBytes = Buffer.from('original VPK directory fixture'),
      sha1 = createHash('sha1').update(indexBytes).digest('hex'),
      items = ['ak47-fire', 'footstep'];
    let steam = 0,
      conversions = 0,
      publications = 0;
    const result = await installGameplaySounds(
      {
        cache,
        output,
        manifest: '123',
        networkDeny,
        s2v,
        downloader,
        managed: true,
        beforePublish: async () => {
          publications++;
          const stages = (await readdir(generation)).filter((name) => name.startsWith('.sounds-'));
          assert.equal(stages.length, 1);
          assert.equal(
            (await readFile(join(generation, stages[0], 'ak47-fire/sound.wav'))).length,
            wav().length,
          );
        },
      },
      {
        index: async () => ({
          entries: new Map(
            items.map((id) => [
              gameplaySoundRegistry.items[id].source,
              { resource: gameplaySoundRegistry.items[id].source, length: 4, preloadBytes: 0 },
            ]),
          ),
          readEntry: async () => Buffer.from('VSND'),
        }),
        run: async (command, args, options) => {
          if (command === downloader) {
            steam++;
            if (args[0] === 'ls')
              return {
                stdout: `2347770\t123\t${sha1}\t${indexBytes.length}\tgame/csgo/pak01_dir.vpk\n`,
                stderr: '',
                code: 0,
              };
            const selected = JSON.parse(await readFile(join(options.cwd, 'files.json'), 'utf8'));
            assert.ok(
              selected[2347770].every(
                (path) =>
                  path === 'game/csgo/pak01_dir.vpk' ||
                  /^game\/csgo\/pak01_dir\.vpk:sounds\//.test(path),
              ),
            );
            const path = join(cache, 'steam/game/csgo');
            await mkdir(path, { recursive: true });
            await writeFile(join(path, 'pak01_dir.vpk'), indexBytes);
            return { stdout: '', stderr: '', code: 0 };
          }
          assert.equal(command, networkDeny);
          assert.equal(args[0], '--write-root');
          const conversion = args[1];
          assert.ok(conversion.startsWith(options.cwd + '/conversion'));
          assert.deepEqual(options.conversionWriteRoots, [conversion]);
          assert.ok(options.home.startsWith(conversion + '/'));
          assert.ok(options.temporary.startsWith(conversion + '/'));
          const input = args[args.indexOf('-i') + 1],
            decoded = args[args.indexOf('--output') + 1];
          assert.ok(input.startsWith(conversion + '/'));
          await writeFile(join(decoded, basename(input, '.vsnd_c') + '.wav'), wav());
          conversions++;
          return { stdout: '', stderr: '', code: 0 };
        },
      },
    );
    assert.equal(await readFile(join(output, 'sounds/operator-file'), 'utf8'), 'operator');
    assert.equal(result.output, join(generation, 'sounds'));
    assert.deepEqual(
      await installGameplaySounds(
        { cache, output, manifest: '456', networkDeny, s2v, downloader, managed: true },
        { run: () => assert.fail('an installed generation needs no source request') },
      ),
      { status: 'installed' },
    );
    assert.equal(steam, 3);
    assert.equal(conversions, 2);
    assert.equal(publications, 1);
    assert.equal(result.report.prepared.length, 2);
    assert.equal(result.report.source.manifest, '123');
    assert.equal(result.report.source.resources.length, 2);
    assert.equal(
      JSON.parse(await readFile(join(generation, 'sounds/ak47-fire/manifest.json'), 'utf8'))
        .durationMs,
      100,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing fixed samples are reported individually and CRC failure remains a terminal source mismatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sound-source-evidence-'));
  try {
    const networkDeny = buildNetworkDeny(join(root, 'boundary')),
      s2v = join(root, 's2v'),
      downloader = join(root, 'downloader');
    await writeFile(s2v, 'original');
    await writeFile(downloader, 'original');
    const indexBytes = Buffer.from('original index'),
      sha1 = createHash('sha1').update(indexBytes).digest('hex');
    for (const invalid of [false, true]) {
      const cache = join(root, `cache-${invalid}`),
        output = join(root, `output-${invalid}`);
      await mkdir(cache);
      await mkdir(output);
      const resource = gameplaySoundRegistry.items['ak47-fire'].source;
      let conversionCalls = 0;
      const install = () =>
        installGameplaySounds(
          {
            cache,
            output,
            manifest: '123',
            networkDeny,
            s2v,
            downloader,
            items: ['ak47-fire', 'footstep'],
          },
          {
            index: async () => ({
              entries: new Map([[resource, { resource, length: 4, preloadBytes: 0 }]]),
              readEntry: async () => (invalid ? undefined : Buffer.from('VSND')),
            }),
            run: async (command, args, options) => {
              if (command === downloader) {
                if (args[0] === 'ls')
                  return {
                    stdout: `2347770\t123\t${sha1}\t${indexBytes.length}\tgame/csgo/pak01_dir.vpk\n`,
                    stderr: '',
                    code: 0,
                  };
                const path = join(cache, 'steam/game/csgo');
                await mkdir(path, { recursive: true });
                await writeFile(join(path, 'pak01_dir.vpk'), indexBytes);
                return { stdout: '', stderr: '', code: 0 };
              }
              conversionCalls++;
              await writeFile(join(args[args.indexOf('--output') + 1], 'ak47-fire.wav'), wav());
              return { stdout: '', stderr: '', code: 0 };
            },
          },
        );
      if (invalid) {
        await assert.rejects(install, (error) => error.code === 'SOURCE_MAP_MISMATCH');
        assert.equal(conversionCalls, 0);
      } else {
        const result = await install();
        assert.equal(result.report.prepared.length, 1);
        assert.deepEqual(result.report.unsupported, [
          { id: 'footstep', reason: 'native-format-unavailable' },
        ]);
        assert.equal(result.report.source.unsupportedResources.length, 1);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sound source manifest mismatch is terminal before downloading or converting a different source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sound-manifest-mismatch-'));
  try {
    const cache = join(root, 'cache'),
      output = join(root, 'output');
    await mkdir(cache);
    await mkdir(output);
    const networkDeny = buildNetworkDeny(join(root, 'boundary')),
      s2v = join(root, 's2v'),
      downloader = join(root, 'downloader');
    await writeFile(s2v, 'original');
    await writeFile(downloader, 'original');
    let calls = 0;
    await assert.rejects(
      () =>
        installGameplaySounds(
          { cache, output, manifest: '123', networkDeny, s2v, downloader, items: ['ak47-fire'] },
          {
            run: async (command, args) => {
              calls++;
              assert.equal(command, downloader);
              assert.equal(args[0], 'ls');
              return {
                stdout: `2347770\t124\t${'a'.repeat(40)}\t64\tgame/csgo/pak01_dir.vpk\n`,
                stderr: '',
                code: 0,
              };
            },
            index: async () => {
              throw Error('Mismatched source must not be inspected');
            },
          },
        ),
      (error) => error.code === 'SOURCE_MAP_MISMATCH',
    );
    assert.equal(calls, 1);
    assert.deepEqual(await readdir(output), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

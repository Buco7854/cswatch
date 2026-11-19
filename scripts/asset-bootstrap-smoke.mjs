/** Cold tool preparation inside the hardened assets image. Only pinned tools
 * are downloaded. Steam listing uses an explicitly original fixture. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

let phase = 'preconditions';
let failureSchema;
try {
  assert.equal(process.env.CSWATCH_ASSET_BOOTSTRAP_TEST, 'true');
  assert.equal(process.cwd(), '/app');
  assert.equal(Number(process.versions.node.split('.')[0]), 24);
  assert.equal(process.getuid(), 1000);
  assert.equal(process.getgid(), 1000);
  assert.equal(existsSync('/data'), false);
  for (const key of [
    'ADMIN_USERNAME',
    'ADMIN_PASSWORD',
    'STEAM_API_KEY',
    'FACEIT_API_KEY',
    'FACEIT_DOWNLOAD_TOKEN',
  ])
    assert.equal(process.env[key], undefined);
  const processStatus = await readFile('/proc/self/status', 'utf8');
  assert.match(processStatus, /^CapEff:\s+0+$/m);
  assert.match(processStatus, /^NoNewPrivs:\s+1$/m);

  const { prepareToolchain, toolchainDirectory } =
    await import('/app/tools/assets/prepare-toolchain.mjs');
  const { refreshOfficialMapInventory } =
    await import('/app/tools/assets/official-map-inventory.mjs');
  const { prepareMapJobs, readOfficialMapInventory, mapInventoryFailureSchema } =
    await import('/app/backend/dist/map-jobs.js');
  failureSchema = mapInventoryFailureSchema;
  const cache = '/map-cache';
  const jobs = '/map-jobs';
  const assets = '/map-assets';
  const toolCache = join(cache, 'tools');
  assert.equal(
    existsSync(toolCache),
    false,
    'Cold verification requires an empty disposable cache.',
  );
  await prepareMapJobs(jobs);
  let preparations = 0;
  let lastProgress;
  const inventory = () =>
    refreshOfficialMapInventory(
      { cache, jobs, assets },
      {
        prepareToolchain: async (options) => {
          preparations++;
          assert.equal(existsSync(join(toolCache, toolchainDirectory)), preparations > 1);
          return prepareToolchain({
            ...options,
            onProgress: (event) => {
              const stage = ['download', 'extract', 'build', 'cached', 'ready'].includes(
                event.stage,
              )
                ? event.stage
                : 'prepare';
              const artifact =
                typeof event.artifact === 'string' &&
                /^[A-Za-z0-9._+-]{1,100}$/.test(event.artifact)
                  ? event.artifact
                  : undefined;
              const signature = `${stage}:${artifact || ''}`;
              if (signature !== lastProgress) {
                lastProgress = signature;
                console.log(
                  JSON.stringify({
                    event: 'asset.bootstrap_stage',
                    stage,
                    ...(artifact ? { artifact } : {}),
                  }),
                );
              }
            },
          });
        },
        run: async (_command, args, context) => {
          assert.deepEqual(args, [
            'ls',
            '730',
            '2347770',
            '--anonymous',
            '--',
            'game/csgo/maps/*.vpk',
          ]);
          assert.equal(context.timeoutMs, 120000);
          context.signal.throwIfAborted();
          // Original metadata only. This does not establish official membership.
          return {
            code: 0,
            stdout: `2347770\t1\t${'a'.repeat(40)}\t100\tgame/csgo/maps/de_ci_bootstrap.vpk`,
            stderr: '',
          };
        },
      },
    );
  phase = 'cold_bootstrap';
  const first = await inventory();
  assert.deepEqual(await readOfficialMapInventory(jobs), first);
  const provenance = join(toolCache, toolchainDirectory, 'provenance.json');
  const digest = async () =>
    createHash('sha256')
      .update(await readFile(provenance))
      .digest('hex');
  const before = await digest();
  phase = 'verified_cache_reuse';
  await inventory();
  assert.equal(preparations, 2);
  assert.equal(await digest(), before, 'Verified cache reuse must preserve provenance.');
  console.log(
    JSON.stringify({
      ok: true,
      coldToolchain: true,
      cachedReuse: true,
      inventoryPublication: true,
      steamListing: 'original-fixture',
      officialGameDownloads: 0,
    }),
  );
} catch (error) {
  const checked = failureSchema?.safeParse({ ...error?.inventoryDiagnostic, at: 0, retryAt: 0 });
  const diagnostic = checked?.success
    ? {
        phase: checked.data.phase,
        code: checked.data.code,
        ...(checked.data.exitCode === undefined ? {} : { exitCode: checked.data.exitCode }),
      }
    : undefined;
  console.error(
    JSON.stringify({
      event: 'asset.bootstrap_verification_failed',
      phase,
      ...(diagnostic ? { inventory: diagnostic } : {}),
    }),
  );
  process.exitCode = 1;
}

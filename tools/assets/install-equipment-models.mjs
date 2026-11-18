#!/usr/bin/env node
/** Trusted operator-only acquisition of explicit native static equipment. Never an app route. */
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runAssetProcess } from './install-steam-assets.mjs';
import { equipmentModelRegistry, selectedEquipmentModels } from './equipment-model-registry.mjs';
import { inspectEquipmentSourceModel } from './equipment-source-model.mjs';
import { scanEquipmentDependencies, agentIdleResource } from './equipment-dependencies.mjs';
import { readVpkDirectory } from './source2-dependencies.mjs';
import { preflightMaterialShaders } from './shader-preflight.mjs';
import { checkedBatch, parseSteamListing, STEAM_APP, STEAM_DEPOT } from './steam-assets-plan.mjs';
import {
  checkFreeReserve,
  checkStorage,
  exists,
  fileHash,
  regular,
  readableDirectory,
} from './asset-storage.mjs';
import { prepareToolchain } from './prepare-toolchain.mjs';
import { localDirectory } from './toolchain-security.mjs';
import { agentSourceRegistry } from './prepare-agent-model.mjs';
const MiB = 1024 ** 2;
const agentScript = fileURLToPath(new URL('./prepare-agent-model.mjs', import.meta.url));
const prepareScript = fileURLToPath(new URL('./prepare-equipment-model.mjs', import.meta.url));
export async function installEquipmentModels(options, adapters = {}) {
  const agents =
    options.agents === undefined
      ? []
      : Array.isArray(options.agents)
        ? options.agents
        : typeof options.agents === 'string'
          ? options.agents.split(',')
          : [];
  if (
    agents.length > 2 ||
    new Set(agents).size !== agents.length ||
    agents.some((team) => !Object.hasOwn(agentSourceRegistry, team))
  )
    throw Error('Select agent teams ct,t explicitly.');
  const ids = options.items === undefined ? [] : selectedEquipmentModels(options.items);
  if (!ids.length && !agents.length)
    throw Error('Select explicit equipment items and/or agent teams.');
  if (
    !options.output ||
    !options.cache ||
    Boolean(options.s2v) !== Boolean(options.downloader) ||
    !/^[1-9]\d{0,19}$/.test(options.manifest ?? '') ||
    BigInt(options.manifest) > 18446744073709551615n
  )
    throw Error(
      'Provide explicit items/output/cache/pinned manifest and both tool overrides or neither.',
    );
  const output = resolve(options.output),
    cache = resolve(options.cache),
    target = join(output, 'equipment-models');
  if (output === cache || cache.startsWith(output + '/') || output.startsWith(cache + '/'))
    throw Error('Keep runtime assets and private source cache separate.');
  await readableDirectory(output);
  await localDirectory(output);
  await localDirectory(cache, true);
  const game = join(cache, 'steam');
  await localDirectory(game, true);
  if (await exists(target)) await localDirectory(target);
  const agentOutput = join(output, 'agents');
  if (await exists(agentOutput)) await localDirectory(agentOutput);
  for (const team of agents)
    for (const name of [`${team}.glb`, `${team}.manifest.json`, `${team}.provenance.json`])
      if (await exists(join(agentOutput, name)))
        throw Error('An agent is already installed; use a new output root.');
  for (const id of ids)
    if (await exists(join(target, id)))
      throw Error(
        'Equipment already installed; use a new output root rather than replacing live assets.',
      );
  const tools = options.s2v
    ? {
        s2v: resolve(options.s2v),
        downloader: resolve(options.downloader),
        provenance: { mode: 'operator-supplied executables' },
      }
    : await (adapters.prepareToolchain ?? prepareToolchain)({
        cache: join(cache, 'tools'),
        signal: options.signal,
        onProgress: options.onProgress,
      });
  for (const tool of [tools.s2v, tools.downloader]) {
    await regular(tool, 512 * MiB);
    await access(tool, constants.X_OK);
  }
  tools.provenance.executables = await Promise.all(
    [tools.s2v, tools.downloader].map(async (path) => ({
      file: path,
      sha256: await fileHash(path, 'sha256', 512 * MiB),
    })),
  );
  const root = await mkdtemp(join(cache, 'equipment-install-')),
    home = join(root, 'home'),
    temporary = join(root, 'tmp'),
    pins = join(root, 'manifests');
  for (const path of [home, temporary, pins, game])
    await mkdir(path, { recursive: true, mode: 0o700 });
  await writeFile(
    join(pins, `manifest_${STEAM_DEPOT}.txt`),
    `Content Manifest for Depot ${STEAM_DEPOT}\n\nManifest ID / date     : ${options.manifest} / explicit equipment selection\n`,
    { flag: 'wx', mode: 0o600 },
  );
  let sequence = 0;
  const selection = new Map(),
    downloads = [],
    installed = [],
    installedAgents = [];
  const progress = (stage, details = {}) => options.onProgress?.({ stage, ...details });
  const execute = (command, args, stage, extra = {}) => {
    progress(stage);
    return (adapters.run ?? runAssetProcess)(command, args, {
      cwd: root,
      home,
      temporary,
      signal: options.signal,
      log: join(root, `${String(++sequence).padStart(3, '0')}-${stage}.log`),
      storageGuard: () => checkFreeReserve(cache, output),
      ...extra,
    });
  };
  const download = async (records, label) => {
    records = checkedBatch(records);
    if (!records.length) return;
    for (const record of records)
      selection.set(record.selector, Math.max(selection.get(record.selector) ?? 0, record.bytes));
    if (selection.size > 8192 || [...selection.values()].reduce((s, n) => s + n, 0) > 2 * 1024 ** 3)
      throw Error('Equipment selective download budget exceeded 2 GiB or 8192 entries.');
    await checkStorage(cache, output, records.reduce((s, r) => s + r.bytes, 0) + 64 * MiB);
    await writeFile(
      join(root, 'files.json'),
      JSON.stringify({ [STEAM_DEPOT]: records.map((x) => x.selector) }),
      { mode: 0o600 },
    );
    await execute(
      tools.downloader,
      ['track', STEAM_APP, '--anonymous', '--output', game, '--manifests', pins, '--save-manifest'],
      label,
      { timeoutMs: 10 * 60 * 1000 },
    );
    downloads.push({
      label,
      entries: records.length,
      selectedBytes: records.reduce((s, r) => s + r.bytes, 0),
    });
  };
  try {
    const initial = ['csgo', 'core'].flatMap((group) =>
      ['gameinfo.gi', 'pak01_dir.vpk', 'shaders_vulkan_dir.vpk'].map(
        (name) => `game/${group}/${name}`,
      ),
    );
    initial.push('game/csgo/steam.inf');
    const listing = await execute(
      tools.downloader,
      ['ls', STEAM_APP, `${STEAM_DEPOT}:${options.manifest}`, '--anonymous', '--', ...initial],
      'pinned-index-preflight',
      { timeoutMs: 120000 },
    );
    const plan = parseSteamListing(listing.stdout, initial);
    if (plan.manifest !== options.manifest) throw Error('Equipment depot manifest mismatch.');
    await download(
      plan.files.map((file) => ({ selector: file.file, bytes: file.bytes })),
      'equipment-indexes',
    );
    for (const file of plan.files)
      if ((await fileHash(join(game, file.file), 'sha1', file.bytes)) !== file.sha1)
        throw Error('Equipment source index hash mismatch.');
    const index = adapters.index ?? readVpkDirectory,
      csgo = await index(join(game, 'game/csgo/pak01_dir.vpk'));
    const resources = [
      ...new Set([
        ...ids.map((id) => equipmentModelRegistry[id].resource),
        ...agents.map((team) => agentSourceRegistry[team]),
      ]),
    ];
    const closureSeeds = [...resources, ...(agents.length ? [agentIdleResource] : [])];
    await download(
      closureSeeds.map((resource) => {
        const entry = csgo.entries.get(resource);
        if (!entry) throw Error('Selected native model is missing from pinned index.');
        return {
          selector: `game/csgo/pak01_dir.vpk:${resource}`,
          bytes: entry.length + entry.preloadBytes,
        };
      }),
      'equipment-model-metadata',
    );
    const modelSelections = new Map();
    for (const [i, resource] of resources.entries()) {
      const bytes = await csgo.readEntry(resource);
      if (!bytes) throw Error('Selected native model failed CRC.');
      const path = join(root, `model-${i}.vmdl_c`);
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
      const data = await execute(tools.s2v, ['-i', path, '--block', 'DATA'], `model-${i}-data`),
        control = await execute(tools.s2v, ['-i', path, '--block', 'CTRL'], `model-${i}-ctrl`);
      modelSelections.set(resource, {
        ...inspectEquipmentSourceModel({ data: data.stdout, control: control.stdout }),
        sourceSha256: createHash('sha256').update(bytes).digest('hex'),
        sourceBytes: bytes.length,
      });
    }
    let closure;
    for (let wave = 0; wave <= 8; wave++) {
      progress('equipment-dependency-scan', { wave });
      closure = await (adapters.scan ?? scanEquipmentDependencies)({
        game,
        seeds: closureSeeds,
        index,
      });
      if (closure.unknown.length)
        throw Error('A required static equipment dependency is absent from the pinned depot.');
      const pending = Object.entries(closure.pending).flatMap(([group, rows]) =>
        rows.map((row) => ({
          selector: `game/${group}/pak01_dir.vpk:${row.resource}`,
          bytes: row.length + row.preloadBytes,
        })),
      );
      if (!pending.length) break;
      if (wave === 8) throw Error('Static equipment dependency closure did not converge.');
      await download(pending, `equipment-dependencies-${wave + 1}`);
    }
    const shaderIndexes = await Promise.all(
      ['csgo', 'core'].map(async (group) => [
        group,
        await index(join(game, `game/${group}/shaders_vulkan_dir.vpk`)),
      ]),
    );
    const shaders = await preflightMaterialShaders({
      closure,
      game,
      packageFile: 'game/csgo/pak01_dir.vpk',
      stage: root,
      label: 'equipment',
      s2v: tools.s2v,
      execute,
      download,
      shaderIndexes,
      index,
    });
    const assetVersion = `steam-${STEAM_DEPOT}-${options.manifest}`;
    for (const [i, id] of ids.entries()) {
      const resource = equipmentModelRegistry[id].resource,
        selected = modelSelections.get(resource),
        exportRoot = join(root, `export-${i}`);
      await mkdir(exportRoot);
      const input = join(exportRoot, 'model.gltf');
      const result = await execute(
        tools.s2v,
        [
          '-i',
          join(game, 'game/csgo/pak01_dir.vpk'),
          '--game',
          join(game, 'game/csgo'),
          '--vpk_filepath',
          resource,
          '--output',
          input,
          '--gltf_export_format',
          'gltf',
          '--gltf_textures_adapt',
          '--gltf_mesh_list',
          selected.meshes.join(','),
        ],
        `equipment-${i}-export`,
        { allowFailure: true },
      );
      if (
        result.code !== 0 ||
        !(await exists(input)) ||
        /(?:Failed to|Could not|Unable to|Exception|Error:)/i.test(result.stdout + result.stderr)
      )
        throw Error('Static equipment export failed; inspect the private stage log.');
      await execute(
        process.execPath,
        [
          prepareScript,
          '--input',
          input,
          '--output',
          target,
          '--id',
          id,
          '--asset-version',
          assetVersion,
          '--native-sha256',
          selected.sourceSha256,
          '--native-bytes',
          String(selected.sourceBytes),
          '--native-meshes',
          selected.meshes.join(','),
          '--manifest',
          options.manifest,
        ],
        `equipment-${i}-pack`,
      );
      installed.push(id);
      await rm(exportRoot, { recursive: true, force: true });
    }
    if (agents.length) {
      const idleRoot = join(root, 'native-single-idle');
      await mkdir(idleRoot);
      const idle = join(idleRoot, 'idle.gltf');
      const idleResult = await execute(
        tools.s2v,
        [
          '-i',
          join(game, 'game/csgo/pak01_dir.vpk'),
          '--game',
          join(game, 'game/csgo'),
          '--vpk_filepath',
          agentIdleResource,
          '--output',
          idle,
          '--gltf_export_format',
          'gltf',
        ],
        'agent-single-idle-export',
        { allowFailure: true },
      );
      if (
        idleResult.code !== 0 ||
        !(await exists(idle)) ||
        /(?:Failed to|Could not|Unable to|Exception|Error:)/i.test(
          idleResult.stdout + idleResult.stderr,
        )
      )
        throw Error('The selected native idle clip could not be exported without a full graph.');
      for (const team of agents) {
        const resource = agentSourceRegistry[team],
          selection = modelSelections.get(resource),
          exportRoot = join(root, `agent-${team}-export`);
        await mkdir(exportRoot);
        const input = join(exportRoot, 'agent.gltf');
        const result = await execute(
          tools.s2v,
          [
            '-i',
            join(game, 'game/csgo/pak01_dir.vpk'),
            '--game',
            join(game, 'game/csgo'),
            '--vpk_filepath',
            resource,
            '--output',
            input,
            '--gltf_export_format',
            'gltf',
            '--gltf_textures_adapt',
            '--gltf_mesh_list',
            selection.meshes.join(','),
          ],
          `agent-${team}-export`,
          { allowFailure: true },
        );
        if (
          result.code !== 0 ||
          !(await exists(input)) ||
          /(?:Failed to|Could not|Unable to|Exception|Error:)/i.test(result.stdout + result.stderr)
        )
          throw Error('The selected native agent could not be exported.');
        await execute(
          process.execPath,
          [
            agentScript,
            '--input',
            input,
            '--idle',
            idle,
            '--output',
            agentOutput,
            '--team',
            team,
            '--asset-version',
            assetVersion,
          ],
          `agent-${team}-pack`,
        );
        installedAgents.push(team);
        await rm(exportRoot, { recursive: true, force: true });
      }
      await rm(idleRoot, { recursive: true, force: true });
    }
    const report = {
      schemaVersion: 1,
      assetVersion,
      items: ids,
      agents,
      modelSelections: Object.fromEntries(modelSelections),
      closure,
      shaders,
      downloads,
      tools: tools.provenance,
      limitations: [
        'Static native model geometry only; no animation graphs, recoil or native attachment poses',
        'C4 planted state uses the static C4 model; no native digits or arming animation',
      ],
    };
    const reportBytes = JSON.stringify(report, null, 2) + '\n';
    if (Buffer.byteLength(reportBytes) > 1024 * 1024)
      throw Error('Equipment installation provenance exceeds 1 MiB.');
    await writeFile(join(root, 'installation.json'), reportBytes, {
      flag: 'wx',
      mode: 0o600,
    });
    return {
      output: target,
      installed,
      agents,
      assetVersion,
      report: join(root, 'installation.json'),
    };
  } catch (error) {
    // Individual completed IDs remain valid immutable assets; never remove a pre-existing pack.
    throw new Error(
      `Equipment installation stopped. Completed ${installed.length} equipment models and ${installedAgents.length} agents; private logs: ${root}`,
      { cause: error },
    );
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  const { values } = parseArgs({
    options: {
      items: { type: 'string' },
      agents: { type: 'string' },
      output: { type: 'string' },
      cache: { type: 'string' },
      manifest: { type: 'string' },
      s2v: { type: 'string' },
      downloader: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'Usage: node install-equipment-models.mjs --items ak47,smokegrenade or all [--agents ct,t] --manifest PINNED_UINT64 --output DATA_DIR/maps --cache PRIVATE_CACHE [--s2v ABS_PATH --downloader ABS_PATH]',
    );
    process.exit(0);
  }
  const result = await installEquipmentModels({
    ...values,
    signal: controller.signal,
    onProgress: (event) => console.log(JSON.stringify(event)),
  });
  console.log(JSON.stringify(result));
}

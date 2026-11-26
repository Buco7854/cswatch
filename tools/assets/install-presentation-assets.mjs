/** Fixed shared native presentation banks. Acquisition never runs in an HTTP handler. */
import { spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, readdir, rename, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { selectedSteamManifest } from './steam-assets-plan.mjs';
import { localDirectory } from './toolchain-security.mjs';
import {
  exists,
  checkStorage,
  checkFreeReserve,
  regular,
  readableDirectory,
} from './asset-storage.mjs';
import { installEquipmentModels } from './install-equipment-models.mjs';
import { installEquipmentIcons, equipmentIconSources } from './install-equipment-icons.mjs';
import { equipmentModelRegistry } from './equipment-model-registry.mjs';
import { viewmodelSources, presentationPriority } from './viewmodel-sources.mjs';
import {
  preparerRevision,
  presentationDirectory,
  viewmodelManifest,
} from '../../backend/dist/asset-preparer.js';
import { inspectEquipmentGltf } from './equipment-model-input.mjs';
import contract from '../../shared/agent-animation.json' with { type: 'json' };
import {
  directionalDeclarations,
  validDirectionalRoles,
} from '../../shared/agent-animation-contract.mjs';
import { agentActionDeclarations, agentActionContract } from '../../shared/agent-actions.mjs';
import { verifyPreparedGlb } from './prepared-glb.mjs';
import { validPng } from '../../backend/dist/png.js';
import {
  cleanPresentationStages,
  checkPresentationRetirement,
  registerPresentationStage,
  presentationStageIdentity,
} from './presentation-stages.mjs';
import {
  readPresentationStatus,
  writePresentationStatus,
  presentationKinds,
  presentationParts,
} from '../../backend/dist/presentation-assets.js';

const presentationPreparationLimits = Object.freeze({
  attempts: 3,
  deadlineMs: 45 * 60 * 1000,
  modelDeadlineMs: 15 * 60 * 1000,
  files: 512,
  bytes: 1024 ** 3,
});
export const presentationItems = (kind) => {
  const registry = kind === 'viewmodels' ? viewmodelSources : equipmentModelRegistry;
  return [...new Set([...presentationPriority, ...Object.keys(registry)])].filter((id) =>
    Object.hasOwn(registry, id),
  );
};
const now = () => Math.floor(Date.now() / 1000);
const markerName = '.cswatch-presentation.json';
function failureCode(error, signal) {
  if (signal?.aborted) return signal.reason?.name === 'TimeoutError' ? 'timeout' : 'interrupted';
  if (error?.code === 'STEAM_RATE_LIMIT') return 'steam_rate_limited';
  if (error?.code === 'SOURCE_MAP_MISMATCH') return 'source_mismatch';
  if (
    ['ENOSPC', 'EDQUOT', 'ASSET_STORAGE_LIMIT'].includes(error?.code) ||
    /512 MiB reserve|allocated-storage limit|storage limit reached/.test(error?.message || '')
  )
    return 'storage_limit';
  return 'preparation_failed';
}
async function validateBank(root, kind, manifest, write = false) {
  let files = 0,
    bytes = 0;
  async function walk(path) {
    await localDirectory(path);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (++files > presentationPreparationLimits.files)
        throw Error('Presentation file-count bound exceeded.');
      const child = join(path, entry.name),
        stat = await lstat(child);
      if (stat.isDirectory() && !stat.isSymbolicLink()) await walk(child);
      else {
        await regular(child, kind === 'equipment' ? 1024 ** 2 : 16 * 1024 ** 2);
        if (write) await chmod(child, 0o644);
        bytes += stat.size;
        if (bytes > presentationPreparationLimits.bytes)
          throw Error('Presentation byte bound exceeded.');
      }
    }
    if (write) await chmod(path, 0o755);
  }
  await walk(root);
  const verifyModel = async (modelPath, metadataPath, id) => {
    await regular(modelPath, 16 * 1024 ** 2, 24);
    await regular(metadataPath, 16384, 2);
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    // Validate dense/Meshopt allocation bounds before any decoder is called.
    const { json } = await inspectEquipmentGltf(modelPath);
    if (
      kind === 'agents' &&
      (!Array.isArray(metadata.animationRoles) ||
        !validDirectionalRoles(metadata.animationRoles) ||
        !directionalDeclarations(json.animations) ||
        json.animations.some(
          (animation) =>
            !Array.isArray(animation.channels) ||
            !animation.channels.length ||
            animation.channels.length > contract.limits.maxChannels,
        ))
    )
      throw Error('Prepared agent must contain the complete directional animation set.');
    const verified = await verifyPreparedGlb(modelPath);
    if (
      (kind === 'agents'
        ? metadata.schemaVersion !== contract.schemaVersion || metadata.team !== id
        : metadata.schemaVersion !== 2 || metadata.id !== id) ||
      metadata.assetVersion !== `steam-2347770-${manifest}` ||
      metadata.sha256 !== verified.sha256 ||
      metadata.bytes !== verified.bytes
    )
      throw Error('Native model content/provenance does not match its fixed identity.');
  };
  if (kind === 'agents') {
    for (const team of ['ct', 't'])
      await verifyModel(join(root, `${team}.glb`), join(root, `${team}.manifest.json`), team);
    // The shared action bank: skeleton and curves only, with the complete role set.
    const bank = join(root, 'actions.glb'),
      bankMetadata = join(root, 'actions.manifest.json');
    await regular(bank, 16 * 1024 ** 2, 24);
    await regular(bankMetadata, 65536, 2);
    const metadata = JSON.parse(await readFile(bankMetadata, 'utf8'));
    const { json } = await inspectEquipmentGltf(bank);
    const verified = await verifyPreparedGlb(bank, { animationOnly: true });
    if (
      !agentActionDeclarations(json.animations) ||
      metadata.schemaVersion !== agentActionContract.schemaVersion ||
      metadata.assetVersion !== `steam-2347770-${manifest}` ||
      metadata.sha256 !== verified.sha256 ||
      metadata.bytes !== verified.bytes
    )
      throw Error('Prepared action bank does not match its fixed identity.');
  } else if (kind === 'viewmodels' || kind === 'equipment-models') {
    let count = 0;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!Object.hasOwn(equipmentModelRegistry, entry.name))
        throw Error('Unknown prepared native model identity.');
      await validateItem(join(root, entry.name), kind, manifest, entry.name, verifyModel);
      count++;
    }
    if (!count) throw Error('No native equipment models were prepared.');
  } else {
    const proof = join(root, 'provenance.json');
    await regular(proof, 1024 ** 2, 2);
    const evidence = JSON.parse(await readFile(proof, 'utf8'));
    const keys = Object.keys(equipmentIconSources);
    if (
      !Array.isArray(evidence.registryItems) ||
      evidence.registryItems.length !== keys.length ||
      !keys.every((key) => evidence.registryItems.includes(key))
    )
      throw Error('Native artwork registry changed.');
    const expected = new Map(Object.entries(evidence.items ?? {}));
    let count = 0;
    for (const filename of await readdir(root))
      if (filename.endsWith('.png')) {
        const id = filename.slice(0, -4);
        if (!Object.hasOwn(equipmentIconSources, id))
          throw Error('Unknown native equipment artwork identity.');
        const image = await readFile(join(root, filename));
        if (
          !validPng(image, { bytes: 1024 ** 2, dimension: 256, pixels: 256 * 64 }) ||
          image.readUInt32BE(20) > 64 ||
          expected.get(id)?.pngSha256 !== createHash('sha256').update(image).digest('hex')
        )
          throw Error('Invalid bounded native equipment artwork.');
        count++;
      }
    if (!count || count !== expected.size) throw Error('Incomplete native equipment artwork.');
  }
  if (!files) throw Error('Empty native presentation bank.');
}

async function validateItem(root, kind, manifest, id, verifyModel) {
  const modelPath = join(root, 'model.glb'),
    metadataPath = join(root, 'manifest.json');
  if (kind !== 'viewmodels' && verifyModel) return verifyModel(modelPath, metadataPath, id);
  await localDirectory(root);
  await regular(metadataPath, 16384, 2);
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  const verified = await verifyPreparedGlb(modelPath);
  if (verified.bytes !== metadata.bytes || verified.sha256 !== metadata.sha256)
    throw Error('Prepared item differs from its manifest.');
  if (kind === 'equipment-models') {
    if (metadata.id !== id || metadata.assetVersion !== `steam-2347770-${manifest}`)
      throw Error('Prepared equipment differs from its selected source.');
    return;
  }
  const rig = viewmodelManifest.parse(metadata),
    { json } = await inspectEquipmentGltf(modelPath);
  const roles = Object.keys(rig.actions);
  if (
    rig.id !== id ||
    rig.manifest !== manifest ||
    roles.length !== Object.keys(viewmodelSources[id]).length - 3 ||
    !json.nodes.some((node) => node.name === 'root_motion') ||
    json.animations.length !== roles.length ||
    roles.some(
      (role) =>
        !Object.hasOwn(viewmodelSources[id], role) ||
        !json.animations.some(
          (animation) =>
            animation.name === id + '-' + role &&
            animation.channels.length > 0 &&
            animation.channels.length <= 384,
        ),
    )
  )
    throw Error('Prepared first-person model differs from its fixed identity.');
}

/** One idle category per call, with a persisted three-attempt generation budget. */
export async function installPresentationAssets(options, manifest, kind, adapters = {}) {
  selectedSteamManifest(manifest);
  if (
    !presentationKinds.includes(kind) ||
    !options.networkDeny ||
    typeof options.cacheRoot !== 'string'
  )
    throw Error('Fixed native presentation kind and confinement are required.');
  const assets = resolve(options.assets),
    output = join(assets, presentationDirectory),
    target = join(output, kind);
  const itemBank = kind === 'equipment-models' || kind === 'viewmodels';
  const ids = itemBank ? presentationItems(kind) : [];
  const operatorPresent =
    kind !== 'viewmodels' &&
    (await exists(join(assets, kind))) &&
    (await presentationParts(assets, kind))[0] === kind;
  const cacheRoot = resolve(options.cacheRoot);
  if (
    cacheRoot === '/' ||
    cacheRoot === output ||
    cacheRoot.startsWith(output + '/') ||
    output.startsWith(cacheRoot + '/')
  )
    throw Error('Keep native sources separate from served assets.');
  await localDirectory(cacheRoot);
  await localDirectory(assets);
  await readableDirectory(output);
  await localDirectory(options.jobs);
  const stageOptions = {
    jobs: options.jobs,
    assets: output,
    cache: cacheRoot,
  };
  if (await cleanPresentationStages(stageOptions))
    throw Error('Unsafe private presentation staging requires operator review.');
  await regular(options.networkDeny, 1024 * 1024);
  const probe = spawnSync(options.networkDeny, ['--check'], { stdio: 'ignore', timeout: 5000 });
  if (probe.error || probe.status !== 0)
    throw Error('Required native presentation confinement is unavailable.');
  const status = (await readPresentationStatus(options.jobs)) || {
    schemaVersion: preparerRevision,
    categories: {},
  };
  const previous = status.categories[kind];
  // A selected category is one immutable native-source generation, including
  // continuation after an inventory refresh or an acknowledged retry restart.
  manifest = previous?.manifest || manifest;
  let targetExists = await exists(target);
  let owned = false,
    installedManifest;
  const retire = async (path, item) => {
    const retired = join(
      dirname(path),
      `.retired-${item || kind}-${randomBytes(12).toString('hex')}`,
    );
    await checkPresentationRetirement(path, kind, item);
    await registerPresentationStage(stageOptions, retired, {
      manifest,
      kind,
      location: item ? 'models' : 'assets',
      retirement: path,
    });
    const outcome = spawnSync(options.networkDeny, ['--retire-presentation', path, retired], {
      stdio: 'ignore',
      timeout: 10000,
    });
    if (outcome.error || outcome.status !== 0)
      throw Error('Exclusive presentation retirement failed.');
    if (await cleanPresentationStages(stageOptions))
      throw Error('Presentation retirement requires operator review.');
  };
  let repairingBank = false;
  if (targetExists) {
    await localDirectory(target);
    const marker = join(target, markerName);
    if (await exists(marker)) {
      await regular(marker, 256);
      const text = await readFile(marker, 'utf8');
      const value = JSON.parse(text);
      selectedSteamManifest(value.manifest);
      if (
        text === JSON.stringify({ schemaVersion: preparerRevision, kind, manifest: value.manifest })
      )
        installedManifest = value.manifest;
    }
    owned = Boolean(installedManifest);
    if (installedManifest && previous && installedManifest !== previous.manifest) {
      // Keep both immutable sources intact and expose the contradiction as a
      // terminal failure, including after an acknowledged retry/restart.
      status.categories[kind] = {
        ...previous,
        status: 'failed',
        attempts: presentationPreparationLimits.attempts,
        updatedAt: now(),
        code: 'source_mismatch',
      };
      delete status.categories[kind].stage;
      delete status.categories[kind].retryAt;
      await writePresentationStatus(options.jobs, status);
      return { status: 'failed' };
    }
    manifest = installedManifest || manifest;
    if (!itemBank || !owned) {
      if (owned) {
        try {
          await validateBank(target, kind, manifest);
        } catch {
          repairingBank = true;
          await retire(target);
          owned = targetExists = false;
        }
      }
      if (targetExists) {
        const state = owned ? 'ready' : 'preserved';
        status.categories[kind] = {
          manifest: installedManifest || previous?.manifest || manifest,
          generation: previous?.generation || randomBytes(12).toString('hex'),
          status: state,
          ...(operatorPresent ? { operatorPresent: true } : {}),
          attempts: previous?.attempts || 0,
          updatedAt: now(),
          ...(previous?.counts ? { counts: previous.counts } : {}),
          ...(previous?.unsupported ? { unsupported: previous.unsupported } : {}),
        };
        await writePresentationStatus(options.jobs, status);
        return { status: state === 'ready' ? 'installed' : 'preserved' };
      }
    }
  }
  if (!targetExists && operatorPresent && !repairingBank) {
    status.categories[kind] = {
      manifest,
      generation: previous?.generation || randomBytes(12).toString('hex'),
      status: 'preserved',
      operatorPresent: true,
      attempts: 0,
      updatedAt: now(),
    };
    await writePresentationStatus(options.jobs, status);
    return { status: 'preserved' };
  }
  options = { ...options, cache: join(cacheRoot, 'sources', `steam-${manifest}`) };
  const existing = new Set();
  if (itemBank && owned) {
    const entries = await readdir(target, { withFileTypes: true });
    if (entries.length > 128) throw Error('Native model directory scan exceeds its bound.');
    for (const entry of entries)
      if (ids.includes(entry.name)) {
        const path = join(target, entry.name);
        try {
          await validateItem(path, kind, manifest, entry.name);
          existing.add(entry.name);
        } catch {
          await retire(path, entry.name);
        }
      }
  }
  let unsupported =
    itemBank && previous?.manifest === manifest
      ? (previous.unsupported || []).filter((id) => ids.includes(id) && !existing.has(id))
      : [];
  const missing = ids.filter((id) => !existing.has(id) && !unsupported.includes(id));
  if (itemBank && !missing.length) {
    status.categories[kind] = {
      manifest,
      generation: previous?.generation || randomBytes(12).toString('hex'),
      status: 'ready',
      attempts: 0,
      updatedAt: now(),
      unsupported,
      ...(kind === 'viewmodels' && unsupported.length
        ? { unsupportedCode: 'missing_official_resource' }
        : {}),
      counts: {
        ready: existing.size,
        unavailable: unsupported.length,
        total: ids.length,
      },
    };
    await writePresentationStatus(options.jobs, status);
    return { status: 'installed' };
  }
  const sameSource = previous?.manifest === manifest;
  if (sameSource && previous.status === 'failed' && previous.code === 'source_mismatch')
    return { status: 'failed' };
  const itemRetries = Object.fromEntries(
    Object.entries(sameSource ? previous.itemRetries || {} : {}).filter(([id]) =>
      missing.includes(id),
    ),
  );
  if (itemBank && sameSource && previous.attempts && missing.includes(previous.item)) {
    const { attempts, generation, updatedAt, retryAt, code } = previous;
    itemRetries[previous.item] = {
      attempts,
      generation,
      updatedAt,
      ...(retryAt === undefined ? {} : { retryAt }),
      ...(code ? { code } : {}),
    };
  }
  const item = missing.find(
    (id) =>
      !(itemRetries[id]?.attempts >= presentationPreparationLimits.attempts) &&
      !(itemRetries[id]?.retryAt > now()),
  );
  if (itemBank && !item) {
    const retryable = missing.filter(
      (id) => itemRetries[id].attempts < presentationPreparationLimits.attempts,
    );
    const held = retryable.length
      ? retryable.reduce((earliest, id) =>
          itemRetries[id].retryAt < itemRetries[earliest].retryAt ? id : earliest,
        )
      : missing[0];
    const failure = itemRetries[held];
    status.categories[kind] = {
      manifest,
      ...failure,
      status: 'failed',
      item: held,
      itemRetries,
      code: failure.code || 'interrupted',
      unsupported,
      counts: { ready: existing.size, unavailable: unsupported.length, total: ids.length },
    };
    await writePresentationStatus(options.jobs, status);
    return retryable.length
      ? { status: 'backoff', retryAt: failure.retryAt }
      : { status: 'failed' };
  }
  const previousAttempt = itemBank ? itemRetries[item] : sameSource && previous;
  if (!itemBank && previousAttempt && !repairingBank && previous.status !== 'ready') {
    if (previous.attempts >= presentationPreparationLimits.attempts) return { status: 'failed' };
    if (previous.retryAt > now()) return { status: 'backoff', retryAt: previous.retryAt };
  }
  const controller = options.signal
    ? AbortSignal.any([
        options.signal,
        AbortSignal.timeout(
          itemBank
            ? presentationPreparationLimits.modelDeadlineMs
            : presentationPreparationLimits.deadlineMs,
        ),
      ])
    : AbortSignal.timeout(
        itemBank
          ? presentationPreparationLimits.modelDeadlineMs
          : presentationPreparationLimits.deadlineMs,
      );
  const attempts =
    (previousAttempt && (itemBank || previous?.status !== 'ready') ? previousAttempt.attempts : 0) +
    1;
  const generation = previousAttempt?.generation || randomBytes(12).toString('hex');
  if (itemBank) delete itemRetries[item];
  const update = async (value) => {
    status.categories[kind] = {
      manifest,
      generation,
      attempts,
      updatedAt: now(),
      ...(itemBank
        ? {
            item,
            ...(Object.keys(itemRetries).length ? { itemRetries } : {}),
            unsupported,
            ...(kind === 'viewmodels' && unsupported.length
              ? { unsupportedCode: 'missing_official_resource' }
              : {}),
            counts: {
              ready: existing.size,
              unavailable: unsupported.length,
              total: ids.length,
            },
          }
        : {}),
      ...value,
    };
    await writePresentationStatus(options.jobs, status);
  };
  await update({ status: 'preparing', stage: 'acquiring' });
  let stage, publishing;
  try {
    await options.prepareSource?.(manifest, options.cache);
    await (adapters.storage || checkStorage)(options.cache, output);
    stage = await mkdtemp(join(output, '.presentation-'));
    await registerPresentationStage(stageOptions, stage, { manifest, kind, location: 'assets' });
    const common = {
      cache: options.cache,
      output: stage,
      toolchainCache: options.toolchainCache,
      manifest,
      networkDeny: options.networkDeny,
      signal: controller,
      onConverting: () => update({ status: 'preparing', stage: 'converting' }),
      registerStage: (path) =>
        registerPresentationStage(stageOptions, path, { manifest, kind, location: 'source' }),
    };
    const installerAdapters = {
      ...adapters.installAdapters,
      ...(adapters.run ? { run: adapters.run } : {}),
      ...(options.pinnedIndexes ? { pinnedIndexes: options.pinnedIndexes } : {}),
    };
    options.log?.({ event: 'presentation.preparing', kind, manifest, attempt: attempts });
    let installation;
    if (kind === 'equipment')
      installation = await (adapters.installIcons || installEquipmentIcons)(
        common,
        installerAdapters,
      );
    else
      installation = await (adapters.installModels || installEquipmentModels)(
        {
          ...common,
          ...(kind === 'agents'
            ? { agents: ['ct', 't'] }
            : kind === 'viewmodels'
              ? { viewmodel: item }
              : { items: [item], allowMissing: true, firstItemOnly: true }),
          cleanup: true,
        },
        installerAdapters,
      );
    controller.throwIfAborted();
    if (
      kind === 'equipment' &&
      (!Number.isSafeInteger(installation?.count) ||
        installation.count < 1 ||
        installation.count > Object.keys(equipmentIconSources).length ||
        !Array.isArray(installation.unsupported) ||
        installation.unsupported.some((id) => !Object.hasOwn(equipmentIconSources, id)) ||
        new Set(installation.unsupported).size !== installation.unsupported.length ||
        installation.count + installation.unsupported.length !==
          Object.keys(equipmentIconSources).length)
    )
      throw Error('Invalid fixed icon coverage.');
    let modelId;
    if (itemBank) {
      if (
        !Array.isArray(installation?.unsupported) ||
        installation.unsupported.some((id) => id !== item) ||
        !Array.isArray(installation.installed) ||
        installation.installed.length > 1 ||
        installation.installed.some((id) => id !== item)
      )
        throw Error('Invalid fixed native-model installation result.');
      unsupported = [...new Set([...unsupported, ...installation.unsupported])];
      modelId = installation.installed[0];
      if (!modelId) {
        if (!unsupported.includes(item))
          throw Error('Native model preparation produced no available model.');
        const remaining = missing.some((id) => !unsupported.includes(id));
        await update({
          status: remaining ? 'preparing' : 'ready',
          attempts: 0,
          ...(remaining ? { stage: 'acquiring' } : {}),
        });
        options.log?.({
          event: 'presentation.item_unsupported',
          kind,
          item,
          code: 'missing_official_resource',
        });
        return { status: 'checked', remaining };
      }
    }
    await update({ status: 'preparing', stage: 'publishing' });
    const categoryBank = join(stage, kind);
    await validateBank(categoryBank, kind, manifest, true);
    const extending = itemBank && owned;
    const bank = extending ? join(categoryBank, modelId) : categoryBank;
    if (!extending)
      await writeFile(
        join(bank, markerName),
        JSON.stringify({ schemaVersion: preparerRevision, kind, manifest }),
        {
          flag: 'wx',
          mode: 0o600,
        },
      );
    await options.beforePublish?.();
    await (adapters.reserve || checkFreeReserve)(options.cache, output);
    controller.throwIfAborted();
    publishing = await mkdtemp(
      join(extending ? target : output, extending ? '.equipment-' : '.presentation-'),
    );
    await registerPresentationStage(stageOptions, publishing, {
      manifest,
      kind,
      location: extending ? 'models' : 'assets',
      futureIdentity: presentationStageIdentity(await lstat(bank, { bigint: true })),
    });
    await rename(bank, publishing);
    const result = spawnSync(
      options.networkDeny,
      [
        extending ? '--publish-equipment' : '--publish-presentation',
        publishing,
        extending ? join(target, modelId) : target,
      ],
      {
        stdio: 'ignore',
        timeout: 10000,
      },
    );
    if (result.error || result.status !== 0) throw Error('Native presentation publication failed.');
    publishing = undefined;
    if (modelId) existing.add(modelId);
    const remaining = itemBank && ids.some((id) => !existing.has(id) && !unsupported.includes(id));
    await update({
      status: remaining ? 'preparing' : 'ready',
      attempts: itemBank ? 0 : attempts,
      ...(kind === 'equipment'
        ? {
            counts: {
              ready: installation.count,
              unavailable: installation.unsupported.length,
              total: Object.keys(equipmentIconSources).length,
            },
            unsupported: installation.unsupported,
          }
        : {}),
      ...(remaining ? { stage: 'acquiring' } : {}),
      ...(modelId
        ? {
            item: modelId,
            counts: {
              ready: existing.size,
              unavailable: unsupported.length,
              total: ids.length,
            },
          }
        : {}),
    });
    options.log?.({
      event: remaining ? 'presentation.item_ready' : 'presentation.ready',
      kind,
      manifest,
      ...(modelId ? { item: modelId } : {}),
    });
    return { status: 'prepared', remaining };
  } catch (error) {
    const code = failureCode(error, controller);
    await update({
      status: 'failed',
      code,
      ...(code === 'source_mismatch'
        ? { attempts: presentationPreparationLimits.attempts }
        : { retryAt: now() + (code === 'steam_rate_limited' ? 900 : 300) }),
    });
    throw error;
  } finally {
    await cleanPresentationStages(stageOptions);
  }
}

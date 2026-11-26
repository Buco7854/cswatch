/** Worker-private crash journal. Every cleanup path is derived from fixed roots and recorded identity. */
import { constants } from 'node:fs';
import { lstat, open, readFile, readdir, rename, rm, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve, basename } from 'node:path';
import { withDirectory, regularFile, bytesFrom } from '../../backend/dist/map-asset-files.js';
import { presentationKinds } from '../../backend/dist/presentation-assets.js';
import { equipmentIconSources } from './install-equipment-icons.mjs';
import { selectedSteamManifest } from './steam-assets-plan.mjs';
import { localDirectory } from './toolchain-security.mjs';

import { preparerRevision } from '../../backend/dist/asset-preparer.js';
const fileName = `presentation-stages-v${preparerRevision}.json`;
const identity = (stat) => ({ dev: String(stat.dev), ino: String(stat.ino) });
function validate(value) {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    Object.keys(value).sort().join(',') !== 'records,schemaVersion' ||
    !Array.isArray(value.records) ||
    value.records.length > 8
  )
    throw Error('Invalid private presentation stage journal.');
  for (const row of value.records) {
    if (
      !row ||
      Object.keys(row).some(
        (key) =>
          ![
            'location',
            'manifest',
            'kind',
            'basename',
            'dev',
            'ino',
            'emptyDev',
            'emptyIno',
            'retired',
          ].includes(key),
      ) ||
      !presentationKinds.includes(row.kind) ||
      !['assets', 'models', 'source'].includes(row.location) ||
      !/^[0-9]{1,40}$/.test(row.dev) ||
      !/^[0-9]{1,40}$/.test(row.ino)
    )
      throw Error('Invalid private stage identity.');
    selectedSteamManifest(row.manifest);
    const pattern =
      row.location === 'assets'
        ? /^\.presentation-[A-Za-z0-9]{6}$/
        : row.location === 'models'
          ? /^\.equipment-[A-Za-z0-9]{6}$/
          : /^(?:equipment-install-|icon-install-)[A-Za-z0-9]{6}$/;
    const retired =
      typeof row.retired === 'string' &&
      /^[a-z0-9-]{1,40}$/.test(row.retired) &&
      row.basename.startsWith(`.retired-${row.retired}-`) &&
      /-[a-f0-9]{24}$/.test(row.basename);
    if (
      (row.retired === undefined
        ? !pattern.test(row.basename)
        : !retired || row.location === 'source') ||
      (row.emptyDev !== undefined &&
        (!/^[0-9]{1,40}$/.test(row.emptyDev) || !/^[0-9]{1,40}$/.test(row.emptyIno)))
    )
      throw Error('Invalid private stage name.');
  }
  return value;
}
function parent(options, row) {
  return row.location === 'assets'
    ? options.assets
    : row.location === 'models'
      ? join(options.assets, row.kind)
      : join(options.cache, 'sources', `steam-${row.manifest}`);
}
async function readJournal(jobs) {
  let failed;
  const result = await withDirectory(jobs, [], async (directory) => {
    let file;
    try {
      file = await regularFile(directory, fileName, 2, 8192);
      if (!file) throw Error('Unsafe private stage journal.');
      return validate(
        JSON.parse((await bytesFrom(file, (await file.stat()).size, 8192)).toString('utf8')),
      );
    } catch (error) {
      if (error?.code === 'ENOENT') return { schemaVersion: 1, records: [] };
      failed = error;
    } finally {
      await file?.close();
    }
  });
  if (failed) throw failed;
  if (!result) throw Error('Private presentation journal could not be read.');
  return result;
}
async function writeJournal(jobs, journal) {
  const bytes = Buffer.from(JSON.stringify(validate(journal)));
  if (bytes.length > 8192) throw Error('Private stage journal exceeds its bound.');
  const saved = await withDirectory(jobs, [], async (directory) => {
    const temporary = `/proc/self/fd/${directory.fd}/.presentation-stages-${randomBytes(12).toString('hex')}.tmp`;
    let file;
    try {
      file = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      await file.writeFile(bytes);
      await file.sync();
      await file.close();
      file = undefined;
      await rename(temporary, `/proc/self/fd/${directory.fd}/${fileName}`);
      await directory.sync();
      return true;
    } finally {
      await file?.close();
      await unlink(temporary).catch(() => undefined);
    }
  });
  if (!saved) throw Error('Private presentation journal could not be saved.');
}
export async function registerPresentationStage(
  options,
  path,
  { manifest, kind, location, futureIdentity, retirement } = {},
) {
  const row = {
    manifest,
    kind,
    location,
    basename: basename(path),
    ...identity(await lstat(retirement || path, { bigint: true })),
    ...(retirement ? { retired: basename(retirement) } : {}),
  };
  if (futureIdentity) {
    row.emptyDev = row.dev;
    row.emptyIno = row.ino;
    Object.assign(row, futureIdentity);
  }
  validate({ schemaVersion: 1, records: [row] });
  if (resolve(dirname(path)) !== resolve(parent(options, row)))
    throw Error('Private presentation stage escaped its fixed parent.');
  const journal = await readJournal(options.jobs);
  if (
    journal.records.some(
      (entry) =>
        entry.location === row.location &&
        entry.basename === row.basename &&
        entry.manifest === row.manifest,
    )
  )
    throw Error('Presentation stage already registered.');
  journal.records.push(row);
  await writeJournal(options.jobs, journal);
}
async function safeTree(root, allowed) {
  let entries = 0,
    bytes = 0;
  async function walk(path, depth) {
    if (allowed && depth) throw Error('Unexpected nested entry in retired bank.');
    if (depth > 32) throw Error('Private stage cleanup depth exceeded.');
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (allowed && (!allowed.has(entry.name) || !entry.isFile()))
        throw Error('Foreign entry in retired bank.');
      if (++entries > 4096) throw Error('Private stage cleanup entry bound exceeded.');
      const child = join(path, entry.name),
        stat = await lstat(child);
      if (stat.uid !== process.getuid() || stat.isSymbolicLink() || stat.mode & 0o022)
        throw Error('Unsafe private stage child.');
      if (stat.isDirectory()) await walk(child, depth + 1);
      else if (stat.isFile() && stat.nlink === 1) {
        bytes += stat.size;
        if (bytes > 4 * 1024 ** 3) throw Error('Private stage cleanup byte bound exceeded.');
      } else throw Error('Unsafe private stage child.');
    }
  }
  await walk(root, 0);
}
export function retiredPresentationFiles(kind, item) {
  if (item) return new Set(['model.glb', 'manifest.json', 'provenance.json', 'installation.json']);
  const shared = ['.cswatch-presentation.json'];
  if (kind === 'agents')
    return new Set([
      ...shared,
      'installation.json',
      ...['ct', 't', 'actions'].flatMap((team) =>
        ['glb', 'manifest.json', 'provenance.json'].map((suffix) => team + '.' + suffix),
      ),
    ]);
  if (kind === 'equipment')
    return new Set([
      ...shared,
      'provenance.json',
      'source.provenance.json',
      ...Object.keys(equipmentIconSources).map((id) => id + '.png'),
    ]);
  throw Error('Expected a fixed presentation bank or item.');
}
export async function checkPresentationRetirement(path, kind, item) {
  await safeTree(path, retiredPresentationFiles(kind, item));
}

/** Call only while holding the asset worker flock, before any new converter starts. */
export async function cleanPresentationStages(options) {
  const journal = await readJournal(options.jobs),
    retained = [];
  for (const row of journal.records) {
    const root = parent(options, row),
      path = join(root, row.basename);
    try {
      await localDirectory(root);
      if (row.location === 'models') {
        const info = await lstat(join(root, '.cswatch-presentation.json'));
        if (!info.isFile() || info.nlink !== 1 || info.size > 256)
          throw Error('Unsafe model parent marker.');
        const marker = JSON.parse(await readFile(join(root, '.cswatch-presentation.json'), 'utf8'));
        if (marker.schemaVersion !== preparerRevision || marker.kind !== row.kind)
          throw Error('Unknown model parent.');
      }
      const stat = await lstat(path, { bigint: true });
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.uid !== BigInt(process.getuid()) ||
        stat.mode & 0o022n
      )
        throw Error('Unsafe private stage root.');
      const actual = identity(stat);
      if (actual.dev === row.emptyDev && actual.ino === row.emptyIno) {
        if ((await readdir(path)).length) throw Error('Private claim directory changed.');
      } else if (actual.dev !== row.dev || actual.ino !== row.ino)
        throw Error('Private stage directory identity changed.');
      await safeTree(
        path,
        row.retired ? retiredPresentationFiles(row.kind, row.location === 'models') : undefined,
      );
      const after = identity(await lstat(path, { bigint: true }));
      if (after.dev !== actual.dev || after.ino !== actual.ino)
        throw Error('Private stage root changed.');
      await rm(path, { recursive: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') retained.push(row);
    }
  }
  await writeJournal(options.jobs, { schemaVersion: 1, records: retained });
  return retained.length;
}
export const presentationStageIdentity = identity;

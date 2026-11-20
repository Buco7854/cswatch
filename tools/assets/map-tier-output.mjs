/** A fresh, exclusively owned tier directory; never overwrites an installed pack. */
import { createHash } from 'node:crypto';
import { mkdir, rm, statfs, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { applyTextureBudget } from './texture-budget.mjs';
import { localDirectory } from './toolchain-security.mjs';
import { writePreparedModel } from './prepared-model-output.mjs';
import { steamAssetLimits } from './steam-assets-plan.mjs';
import { compressGlbGeometry } from './meshopt-glb.mjs';
export async function writeTierMetadata(path, bytes) {
  const disk = await statfs(dirname(path), { bigint: true });
  if (disk.bavail * disk.bsize < BigInt(bytes.length + steamAssetLimits.reserveBytes))
    throw new Error('Insufficient disk space for tier provenance and 512 MiB reserve.');
  await writeFile(path, bytes, { flag: 'wx', mode: 0o644 });
}
export async function writeMapTier({
  document,
  io,
  target,
  map,
  tier,
  assetVersion,
  source,
  s2v,
  geometry = 'preserved',
  budgetBytes,
  bakedLighting,
}) {
  if (
    !/^[a-zA-Z0-9_-]{1,80}$/.test(map) ||
    !['desktop', 'mobile'].includes(tier) ||
    typeof assetVersion !== 'string' ||
    !assetVersion.trim() ||
    assetVersion.length > 100 ||
    typeof source?.file !== 'string' ||
    source.file.length > 255 ||
    !/^[0-9a-f]{64}$/.test(source.sha256) ||
    !Number.isSafeInteger(source.bytes) ||
    source.bytes < 1
  )
    throw new Error('Invalid prepared map tier identity or source provenance.');
  const output = resolve(target);
  await localDirectory(dirname(output), true);
  await mkdir(output, { mode: 0o755 });
  try {
    const budget = await applyTextureBudget(document, {
      tier,
      ...(budgetBytes === undefined ? {} : { budgetBytes }),
    });
    document
      .getRoot()
      .listExtensionsUsed()
      .find((extension) => extension.extensionName === 'EXT_meshopt_compression')
      ?.dispose();
    const compression = await compressGlbGeometry(await io.writeBinary(document));
    const encoded = compression.bytes;
    const bytes = await writePreparedModel(join(output, 'scene.glb'), encoded);
    const manifest = {
      schemaVersion: 1,
      map,
      tier,
      bytes,
      outputSha256: createHash('sha256').update(encoded).digest('hex'),
      sourceFile: source.file,
      sourceSha256: source.sha256,
      sourceBytes: source.bytes,
      s2v: s2v || 'operator-export',
      assetVersion,
      coordinateSystem: 'S2V glTF meters Y-up; viewer rotates +90deg about Y',
      geometry,
      geometryCompression: compression.report,
      textureBudget: budget.manifest,
      ...(bakedLighting ? { bakedLighting } : {}),
      preparedAt: new Date().toISOString(),
    };
    const serialized = Buffer.from(JSON.stringify(manifest, null, 2));
    if (serialized.length > 16384)
      throw new Error('Prepared tier manifest exceeds its 16 KiB bound.');
    await writeTierMetadata(join(output, 'texture-plan.json'), budget.planBytes);
    await writeTierMetadata(join(output, 'manifest.json'), serialized);
    return {
      path: join(output, 'scene.glb'),
      directory: output,
      manifest,
      texturePlan: budget.plan,
    };
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

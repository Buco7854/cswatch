/** A fresh, exclusively owned tier directory; never overwrites an installed pack. */
import { createHash } from 'node:crypto';
import { mkdir, rm, statfs, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { graphicsLimits as limits } from './map-graphics-contract.mjs';
import { inspectMapGraphics } from './map-visual-audit.mjs';
import { batchMapMeshes } from './batch-map-meshes.mjs';
import { applyTextureBudget } from './texture-budget.mjs';
import { localDirectory } from './toolchain-security.mjs';
import { writePreparedModel } from './prepared-model-output.mjs';
import { steamAssetLimits } from './steam-assets-plan.mjs';
import { compressMapDocumentGeometry } from './meshopt-glb.mjs';
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
  batchStatic = false,
  budgetBytes,
  bakedLighting,
  vertexLighting,
  environmentAlbedo,
  lightingFallback,
  worldMaterials,
  graphics = inspectMapGraphics(document),
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
    console.error(`${tier}: preparing textures`);
    const budget = await applyTextureBudget(document, {
      tier,
      preserveCutoutCoverage: Boolean(worldMaterials),
      ...(budgetBytes === undefined ? {} : { budgetBytes }),
    });
    // Drop oversized texture inputs before joining duplicate geometry arrays.
    globalThis.gc?.();
    const batching = batchStatic ? await batchMapMeshes(document, { cellSize: 64 }) : null;
    document
      .getRoot()
      .listExtensionsUsed()
      .find((extension) => extension.extensionName === 'EXT_meshopt_compression')
      ?.dispose();
    globalThis.gc?.();
    console.error(`${tier}: serializing scene`);
    const compression = await compressMapDocumentGeometry(io, document);
    const encoded = compression.bytes;
    const bytes = await writePreparedModel(join(output, 'scene.glb'), encoded);
    const outputSha256 = createHash('sha256').update(encoded).digest('hex');
    const audit = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        map,
        tier,
        assetVersion,
        sourceSha256: source.sha256,
        modelSha256: outputSha256,
        coordinateSystem: 'gltf-meters-y-up',
        ...graphics,
      }),
    );
    if (audit.length > limits.bytes) throw Error('Map graphics audit exceeds its size limit.');
    await writeTierMetadata(join(output, 'visual-audit.json'), audit);
    const manifest = {
      schemaVersion: 1,
      map,
      tier,
      bytes,
      outputSha256,
      visualAuditSha256: createHash('sha256').update(audit).digest('hex'),
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
      ...(environmentAlbedo ? { environmentAlbedo } : {}),
      ...(vertexLighting ? { vertexLighting } : {}),
      ...(lightingFallback ? { lightingFallback } : {}),
      ...(worldMaterials ? { worldMaterials } : {}),
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
      batching,
    };
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

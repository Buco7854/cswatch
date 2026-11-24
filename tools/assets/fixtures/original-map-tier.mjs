import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { NodeIO } from '@gltf-transform/core';
import { applyTextureBudget } from '../texture-budget.mjs';
import { inspectMapGraphics } from '../map-visual-audit.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

// These publication tests exercise their own original GLB without transforming its bytes.
export async function writeOriginalMapTier(directory, model, map, tier, assetVersion) {
  const document = await new NodeIO().readBinary(model);
  const modelSha256 = hash(model);
  const audit = JSON.stringify({
    schemaVersion: 1,
    map,
    tier,
    assetVersion,
    sourceSha256: modelSha256,
    modelSha256,
    coordinateSystem: 'gltf-meters-y-up',
    ...inspectMapGraphics(document),
  });
  const budget = await applyTextureBudget(document, { tier });
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'scene.glb'), model);
  await writeFile(join(directory, 'texture-plan.json'), budget.planBytes);
  await writeFile(join(directory, 'visual-audit.json'), audit);
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      map,
      tier,
      assetVersion,
      bytes: model.length,
      outputSha256: modelSha256,
      sourceSha256: modelSha256,
      visualAuditSha256: hash(audit),
      textureBudget: budget.manifest,
    }),
  );
}

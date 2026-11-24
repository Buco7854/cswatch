import { NodeIO } from '@gltf-transform/core';
import { copyToDocument } from '@gltf-transform/functions';
import { doorStageLimits } from './install-door-stages.mjs';
import { modelResourceId } from './recorded-breakable-geometry.mjs';
import { addDoorStage, rigidMapMesh } from './prepare-rigid-door.mjs';
import { regularFile } from './toolchain-security.mjs';

async function decodedStage(row, bytes) {
  const io = new NodeIO(),
    json = await io.binaryToJSON(bytes);
  const meta = json.json;
  if (
    meta.buffers?.length !== 1 ||
    meta.buffers[0].uri ||
    meta.images?.length ||
    meta.textures?.length ||
    meta.extensionsUsed?.length ||
    meta.animations?.length ||
    meta.nodes?.length > 16 ||
    meta.meshes?.length !== 1 ||
    meta.meshes[0].primitives.length !== 1 ||
    meta.accessors?.length > 24 ||
    meta.accessors?.some((a) => a.sparse || a.count > doorStageLimits.triangles * 3)
  )
    return;
  const source = await io.readJSON(json),
    nodes = source
      .getRoot()
      .listNodes()
      .filter((n) => n.getMesh());
  if (nodes.length !== 1) return;
  const node = nodes[0];
  if (!node.getWorldMatrix().every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) <= 0.00001))
    return;
  const mesh = rigidMapMesh(source, node, new Set(), new Map());
  const primitive = mesh?.listPrimitives()[0];
  if (
    !primitive ||
    primitive.getMode() !== 4 ||
    primitive.getIndices()?.getCount() !== row.indices ||
    primitive.getAttribute('POSITION')?.getCount() !== row.vertices ||
    !primitive.getAttribute('TEXCOORD_0') ||
    !primitive.getAttribute('NORMAL')
  )
    return;
  return { source, mesh, bytes: bytes.length };
}
async function readStage(row) {
  const { handle } = await regularFile(row.file, doorStageLimits.glb);
  let bytes;
  try {
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  // Everything below this boundary is an in-memory decode of a verified local
  // output. Unsupported optional representations leave the intact model usable.
  try {
    return await decodedStage(row, bytes);
  } catch {
    return;
  }
}

/** Share one verified geometry per exported variant. Use each intact instance's
 * own VMAT binding, including authored paint, rather than an arbitrary material
 * with the same basename. Unsupported or missing variants leave the intact stage. */
export async function attachDoorStages(document, rows = []) {
  if (!Array.isArray(rows) || rows.length > doorStageLimits.variants)
    throw Error('Invalid prepared door variants.');
  const doors = document
    .getRoot()
    .listNodes()
    .filter((n) => n.getExtras().cswatchDoor);
  const proof = [];
  let bytes = 0,
    triangles = 0;
  for (const row of rows) {
    const matches = doors.filter(
      (d) =>
        d.getExtras().cswatchDoor.model === row.base &&
        !d.listChildren().some((n) => n.getExtras().cswatchDoorStage?.stage === row.stage),
    );
    if (
      !matches.length ||
      !Number.isInteger(row.stage) ||
      row.stage < 1 ||
      row.stage > 4 ||
      !Number.isInteger(row.indices) ||
      row.indices < 3 ||
      row.indices % 3 !== 0 ||
      triangles + row.indices / 3 > doorStageLimits.triangles
    )
      continue;
    const stage = await readStage(row);
    if (!stage || bytes + stage.bytes > doorStageLimits.bytes) continue;
    const selected = new Map();
    for (const door of matches) {
      const base = door.listChildren().find((n) => n.getExtras().cswatchDoorStage?.stage === 0);
      const primitives = base?.listChildren()[0]?.getMesh()?.listPrimitives();
      const materials = new Set(primitives?.map((p) => p.getMaterial()));
      if (materials.size !== 1) continue;
      const [material] = materials;
      if (!material || material.getExtras()?.vmat?.Name !== row.material) continue;
      if (!selected.has(material)) selected.set(material, []);
      selected.get(material).push(door);
    }
    if (!selected.size) continue;
    const id = modelResourceId(row.path);
    const imported = copyToDocument(document, stage.source, [stage.mesh]).get(stage.mesh);
    const draw = imported.listPrimitives()[0];
    let first = true;
    for (const [material, placements] of selected) {
      const mesh = first
        ? imported
        : document.createMesh(imported.getName()).addPrimitive(draw.clone());
      first = false;
      mesh.listPrimitives()[0].setMaterial(material);
      for (const door of placements)
        addDoorStage(document, door, mesh, { stage: row.stage, modelId: id });
    }
    bytes += stage.bytes;
    triangles += row.indices / 3;
    proof.push({
      model: row.base,
      stage: row.stage,
      modelId: id,
      instances: [...selected.values()].reduce((n, v) => n + v.length, 0),
      triangles: row.indices / 3,
    });
  }
  return proof;
}

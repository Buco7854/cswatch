import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { frameDoors } from './frame-doors.mjs';

const track = {
  modelId: '101',
  origin: [1, 2, 3],
  angles: [0, -90, 0],
  samples: [
    [3, 0],
    [4, 30],
    [10, null],
  ],
  hidden: [[7, 9]],
  models: [
    [4, '203'],
    [6, '204'],
    [9, null],
  ],
};
const tag = {
  model: 'models/test/door.vmdl',
  modelId: track.modelId,
  origin: track.origin,
  angles: [0, 270, 0],
  hammerId: 'door-a',
  className: 'prop_door_rotating',
};
const stages = (shown) =>
  ['101', '203', '204'].map((modelId, stage) => ({ stage, modelId, visible: modelId === shown }));
const at = (tick, yaw, shown, visible = true) =>
  frameDoors([track], 20, tick, { nodes: [{ ...tag, yaw, visible, stages: stages(shown) }] });

test('paused door diagnostics compare the observed hinge and exact native model at transitions, rewind and reset', () => {
  for (const [tick, yaw, id, hidden] of [
    [3, 0, '101', false],
    [3.5, 15, '101', false],
    [4, 30, '203', false],
    [6, 30, '204', false],
    [7, null, null, true],
    [9, 30, '101', false],
    [10, null, '101', false],
    [6, 30, '204', false],
  ]) {
    const r = at(tick, yaw, id, !hidden);
    assert.equal(r.status, 'matched');
    assert.equal(r.tracks[0].model, id);
    assert.equal(r.tracks[0].actualModel, id);
    assert.equal(r.expectedOpen, Number(yaw === 15 || yaw === 30));
    assert.equal(r.expectedHidden, Number(hidden));
    assert.equal(r.expectedDamaged, Number(id === '203' || id === '204'));
  }
  assert.equal(at(9, 30, '203').stageMismatches, 1);
  assert.equal(at(4, 0, '203').disagreed, 1);
  assert.equal(at(7, 30, '203', true).disagreed, 1);
});

test('missing or duplicate prepared stages and ambiguous map instances cannot certify a recorded model', () => {
  const node = { ...tag, visible: true, yaw: 30 };
  const check = (nodes) => frameDoors([track], 20, 4, { nodes });
  assert.equal(check([{ ...node, stages: stages('101').slice(0, 1) }]).missingStages, 1);
  const wrong = check([{ ...node, stages: stages('204') }]);
  assert.equal(wrong.status, 'mismatch');
  assert.equal(wrong.tracks[0].actualModel, '204');
  const duplicate = check([{ ...node, stages: [...stages('203'), stages('203')[1]] }]);
  assert.equal(duplicate.unknownStages, 1);
  assert.equal(check([node, node]).ambiguous, 1);
  assert.equal(check([{ ...node, angles: [0, 240, 0] }]).ambiguous, 1);
  assert.equal(check([]).missing, 1);
  assert.equal(frameDoors([], 20, 4, { nodes: [] }).status, 'no-recorded-evidence');
  assert.equal(frameDoors([track], 20, 4, { reason: 'node-limit' }).status, 'unavailable');
  assert.equal(frameDoors([track], 20, -1, { nodes: [] }).reason, 'invalid-recording-or-tick');
});

test('a channel without pose or model evidence at the selected tick remains unknown and detail rows are bounded', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({
    ...track,
    models: undefined,
    samples: [[8, 90]],
    origin: [i, 2, 3],
  }));
  const nodes = rows.map((r) => ({ ...tag, origin: r.origin, visible: true, yaw: 0, stages: [] }));
  const r = frameDoors(rows, 20, 2, { nodes });
  assert.equal(r.status, 'partial');
  assert.equal(r.unknown, 30);
  assert.equal(r.expectedStages, 0);
  assert.equal(r.matched, 30);
  assert.equal(r.tracks.length, 16);
  assert.equal(r.omittedTrackDetails, 14);
});

test('paused canvas probe measures the mounted hinge in map space, exact child model and ancestor visibility', async () => {
  const { Scene, Group, PerspectiveCamera, Matrix4, Vector3 } = createRequire(
    new URL('../../frontend/package.json', import.meta.url),
  )('three');
  const scene = new Scene(),
    map = new Group(),
    parent = new Group(),
    door = new Group();
  map.immutableDescendants = true;
  map.canTrackRigCasters = false;
  scene.add(map);
  map.add(parent);
  parent.add(door);
  map.position.set(3, -2, 5);
  map.rotation.y = Math.PI / 2;
  parent.position.set(14, -3, 1);
  parent.rotation.z = Math.PI / 3;
  door.position.set(0.2, -0.1, 0.3);
  door.rotation.x = Math.PI / 4;
  door.userData.cswatchDoor = tag;
  for (const s of stages('203')) {
    const child = new Group();
    child.userData.cswatchDoorStage = s;
    if (!s.visible) child.scale.setScalar(0);
    door.add(child);
  }
  scene.updateMatrixWorld(true);
  const hinge = new Vector3(tag.origin[1], tag.origin[2], tag.origin[0]).multiplyScalar(0.0254);
  const rest = door.matrix.clone();
  const rotate = new Matrix4()
    .makeTranslation(hinge.x, hinge.y, hinge.z)
    .multiply(new Matrix4().makeRotationY(Math.PI / 6))
    .multiply(new Matrix4().makeTranslation(-hinge.x, -hinge.y, -hinge.z));
  door.matrixAutoUpdate = false;
  door.matrix
    .copy(parent.matrix.clone().invert())
    .multiply(rotate)
    .multiply(parent.matrix)
    .multiply(rest);
  scene.updateMatrixWorld(true);
  const camera = new PerspectiveCamera();
  const element = { dataset: {}, querySelector: () => canvas };
  const canvas = { closest: () => element };
  const fiber = {
    memoizedProps: {
      data: { frames: [] },
      selected: 'player',
      settings: {},
      mapAssets: {},
      tick: 4,
      mode: 'pov',
    },
  };
  fiber.stateNode = { current: fiber };
  element.__reactFiber$qa = fiber;
  const gl = {
    domElement: canvas,
    render() {},
    getRenderTarget: () => null,
    getContext: () => ({ isContextLost: () => false, getExtension: () => null }),
  };
  scene.__r3f = {
    root: { getState: () => ({ scene, gl, camera, invalidate: () => gl.render(scene, camera) }) },
  };
  const window = {};
  const probe = await readFile(new URL('./viewer-probe.js', import.meta.url), 'utf8');
  runInNewContext(probe, {
    window,
    EventTarget,
    innerWidth: 20,
    innerHeight: 20,
    document: { querySelector: () => element, documentElement: { dataset: {} } },
    requestAnimationFrame: (fn) => fn(),
  });
  const event = new Event('observe');
  event.detail = scene;
  window.__THREE_DEVTOOLS__.dispatchEvent(event);
  const capture = async () => (await window.captureViewerCanvas()).observedDoors;
  const observation = await capture();
  assert.equal(frameDoors([track], 20, 4, observation).status, 'matched');
  assert.ok(Math.abs(observation.nodes[0].yaw - 30) < 1e-5);
  door.matrix.premultiply(new Matrix4().makeTranslation(0.25, 0, 0));
  assert.equal((await capture()).nodes[0].yaw, null);
  parent.visible = false;
  assert.equal(frameDoors([track], 20, 7, await capture()).status, 'matched');
  assert.ok((await capture()).nodes[0].stages.every((stage) => !stage.visible));
});

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  AnimationClip,
  Bone,
  Group,
  Matrix4,
  PerspectiveCamera,
  Vector3,
  VectorKeyframeTrack,
} from '../../frontend/node_modules/three/build/three.module.js';
import {
  agentWeaponClass,
  agentStrideProfile,
  createDirectionalAgent,
  directionalClips,
  directionalGait,
  type DirectionalSample,
} from '../../frontend/src/directional-agent.js';
import { agentPoseVisibility } from '../../frontend/src/agent-culling.js';
import { agentCenteredMotionAt } from '../../frontend/src/agent-phase.js';
import {
  agentActionAt,
  deadAgentsAt,
  indexAgentDraws,
  indexAgentEvents,
} from '../../frontend/src/agent-replay.js';
import {
  directionalRoles,
  directionalMovementRoles,
} from '../../shared/agent-animation-contract.mjs';
import type { DirectionalAgentRole } from '../../shared/agent-animation.js';
import {
  encodeGaitHistory,
  integrateGait,
  validGaitHistory,
} from '../../shared/agent-gait-history.mjs';
import type { Playback, Position } from '../../shared/playback.js';
import { replayAgentDeaths, validAgentDeaths } from '../src/replay-agent-deaths.js';
import { validateReplayArtifacts, writeReplay } from '../src/replay.js';

const idle = { yaw: 0, pitch: 0, velocityX: 0, velocityY: 0, weapon: 'ak47' };
function fixture(roles: readonly DirectionalAgentRole[] = directionalRoles) {
  const clips: AnimationClip[] = [];
  const declarations = roles.map((role, i) => {
    const strideMeters = role.includes('-run-') ? 4 : role.includes('-crouch-') ? 1 : 2;
    const base = role.startsWith('death') ? -1 : i / 100;
    const clip = new AnimationClip('cswatch:' + role, 1, [
      new VectorKeyframeTrack(
        'root_motion.position',
        [0, 0.5, 1],
        [0, base, 0, 0, base + 0.5, 0, 0, base, 0],
      ),
      new VectorKeyframeTrack('wpnPivot.position', [0, 1], [0, 1, 0.25, 0, 1, 0.25]),
      new VectorKeyframeTrack(
        'hand_L.position',
        [0, 1],
        [0, 0.2, 0.4, 0, role === 'rifle-fire' ? 0.6 : 0.2, 0.4],
      ),
    ]);
    clips.push(clip);
    return {
      name: clip.name,
      extras: {
        cswatch: {
          kind: 'native-agent',
          schemaVersion: 3,
          role,
          rootMotion: 'recorded-position',
          ...(directionalMovementRoles.has(role) ? { strideMeters, phaseOffset: 0 } : {}),
        },
      },
    };
  });
  return { clips, declarations, validated: directionalClips(clips, declarations)! };
}

test('directional sets use authored speed, stride, and Source yaw handedness at angle wrap', () => {
  const { validated } = fixture();
  const gait = (input: Partial<DirectionalSample>, speed = 2, duck = 0, phase = 1.37) =>
    directionalGait(validated, { ...idle, ...input }, speed, duck, phase);
  assert.deepEqual(gait({ velocityY: 2 }).samples, [{ role: 'rifle-walk-w', weight: 1 }]);
  assert.deepEqual(gait({ velocityY: -2 }).samples, [{ role: 'rifle-walk-e', weight: 1 }]);
  assert.deepEqual(gait({ velocityX: -2 }).samples, [{ role: 'rifle-walk-s', weight: 1 }]);
  assert.deepEqual(gait({ yaw: 180, velocityY: -2 }, 1, 1).samples, [
    { role: 'rifle-crouch-w', weight: 1 },
  ]);
  assert.equal(gait({ velocityY: 1 }, 1, 1).stride, 1);
  assert.equal(gait({ velocityX: 2, yaw: 360 }).stride, 2);
  const blend = gait({ yaw: 22.5, velocityX: 2 }, 3);
  assert.deepEqual(blend.samples, [
    { role: 'rifle-walk-ne', weight: 0.25 },
    { role: 'rifle-walk-n', weight: 0.25 },
    { role: 'rifle-run-ne', weight: 0.25 },
    { role: 'rifle-run-n', weight: 0.25 },
  ]);
  assert.equal(blend.stride, 3);
  assert.ok(Math.abs(blend.phase - 0.37) < 1e-10);
});

test('requires the complete role set and exact metadata for all authored clips', () => {
  const pack = fixture();
  assert.equal(agentWeaponClass('weapon_glock'), 'pistol');
  assert.equal(agentWeaponClass('weapon_smokegrenade'), 'knife');
  assert.equal(agentWeaponClass('weapon_c4'), 'knife');
  const sample = { ...idle, weapon: 'glock', velocityX: 3 };
  assert.equal(directionalGait(pack.validated, sample, 3, 0, 1).weapon, 'pistol');
  assert.equal(
    fixture(directionalRoles.filter((role) => role !== 'knife-draw')).validated,
    undefined,
  );
  assert.equal(
    directionalClips(pack.clips, [...pack.declarations.slice(1), pack.declarations[1]]),
    undefined,
  );
  pack.declarations[2].extras.cswatch.strideMeters = Infinity;
  assert.equal(directionalClips(pack.clips, pack.declarations), undefined);
});

for (const team of ['ct', 't']) {
  test(`${team} sampled pose seeks both ways, carries the weapon rigidly, and clamps death to its last pose`, () => {
    const rig = new Group();
    const add = (name: string, parent = rig as Group | Bone) => {
      const joint = new Bone();
      joint.name = name;
      parent.add(joint);
      return joint;
    };
    const root = add('root_motion'),
      weapon = add('wpnPivot', root);
    let chest = root;
    for (let i = 0; i < 4; i++) {
      chest = add('spine_' + i, chest);
      chest.position.y = 0.2;
    }
    const hand = add('hand_L', chest);
    const sampler = createDirectionalAgent(rig, fixture().validated)!;
    const draw = (seconds: number, pitch: number, other = {}) =>
      sampler.sample(seconds, 2, 0, 0.5, { ...idle, velocityY: 2, pitch, ...other });
    const snapshot = () => {
      rig.updateMatrixWorld(true);
      return [...weapon.matrixWorld.elements, ...hand.matrixWorld.elements];
    };
    const grip = () => new Matrix4().copy(weapon.matrixWorld).invert().multiply(hand.matrixWorld);
    draw(7, 0);
    const level = snapshot(),
      unpitchedGrip = grip();
    draw(7, -65);
    const up = snapshot();
    assert.ok(new Vector3(0, 0, 1).transformDirection(weapon.matrixWorld).y > 0.85);
    grip().elements.forEach((value, i) =>
      assert.ok(Math.abs(value - unpitchedGrip.elements[i]) < 1e-10),
    );
    draw(7, 65);
    snapshot();
    assert.ok(new Vector3(0, 0, 1).transformDirection(weapon.matrixWorld).y < -0.85);
    draw(7, -65);
    assert.deepEqual(snapshot(), up);
    draw(7, 0);
    assert.deepEqual(snapshot(), level);
    const rootPosition = root.position.clone();
    draw(7, 0, { action: { kind: 'fire', age: 0.25 } });
    const fired = snapshot();
    assert.deepEqual(root.position, rootPosition, 'action mask preserves locomotion root');
    assert.notDeepEqual(fired, level);
    draw(7, 0);
    draw(7, 0, { action: { kind: 'fire', age: 0.25 } });
    assert.deepEqual(snapshot(), fired);
    draw(123, 0);
    assert.deepEqual(snapshot(), level, 'gait uses observed distance');
    draw(100, 0, { death: { variant: 42, age: 2 } });
    const dead = snapshot();
    draw(7, 0);
    draw(200, 0, { death: { variant: 42, age: 100 } });
    assert.deepEqual(snapshot(), dead);
  });
}

test('draw, reload and fire use newest evidence, while a death anchor survives an unloaded slice', async () => {
  const player: Position = {
    id: '90071992547409999',
    team: 2,
    alive: true,
    x: 13,
    y: 20,
    z: 0,
    yaw: 2,
    pitch: 0,
    health: 100,
    weapon: 'ak47',
  };
  const observer = { ...player, id: '123', team: 3 };
  const rounds = [{ number: 1, tick: 0, endTick: 640 }];
  const playback: Playback = {
    map: 'de_mirage',
    sample: false,
    tickRate: 64,
    players: [
      { id: player.id, name: 'fixture', team: player.team },
      { id: observer.id, name: 'observer', team: observer.team },
    ],
    rounds,
    frames: [
      { tick: 4, players: [{ ...player, weapon: 'glock' }] },
      { tick: 8, players: [player] },
      { tick: 16, players: [{ ...player, reloadStarted: 16 }] },
      { tick: 32, players: [observer] },
      { tick: 80, players: [observer] },
    ],
    events: [
      { type: 'weapon_fire', tick: 20, user_steamid: player.id, weapon: 'ak47' },
      { type: 'player_death', tick: 21, user_steamid: player.id },
    ],
  };
  const events = indexAgentEvents(playback),
    draws = indexAgentDraws(playback);
  const action = (p: Position, tick: number) =>
    agentActionAt(events, draws, p, tick, 64, 0, true, true);
  assert.equal(action(player, 7), undefined);
  assert.deepEqual(action(player, 12), { kind: 'draw', age: 4 / 64, previousWeapon: 'glock' });
  assert.deepEqual(action({ ...player, reloadStarted: 16 }, 19), { kind: 'reload', age: 3 / 64 });
  assert.deepEqual(action({ ...player, reloadStarted: 16 }, 20), { kind: 'fire', age: 0 });
  assert.equal(deadAgentsAt(playback, events, 20, rounds[0]).length, 0);
  const agentDeaths = replayAgentDeaths(playback);
  assert.ok(validAgentDeaths(agentDeaths));
  const folder = await mkdtemp(join(tmpdir(), 'agent-death-replay-'));
  try {
    await writeReplay(folder, playback);
    assert.deepEqual(validateReplayArtifacts(folder).manifest.agentDeaths, agentDeaths);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
  const chunk = { ...playback, agentDeaths, frames: playback.frames.slice(-1) };
  const bodies = deadAgentsAt(chunk, indexAgentEvents(chunk), 639, rounds[0]);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].position.x, 13);
  assert.equal(bodies[0].age, (639 - 21) / 64);
  assert.equal(deadAgentsAt(chunk, events, 640, rounds[0]).length, 0);
  assert.equal(deadAgentsAt(chunk, events, 639, { number: 2, tick: 630 }).length, 0);
  assert.equal(
    deadAgentsAt(chunk, indexAgentEvents(chunk), 639, rounds[0], {
      tick: 635,
      players: [player],
    }).length,
    0,
  );
  assert.equal(
    deadAgentsAt({ ...chunk, agentDeaths: undefined }, events, 639, rounds[0]).length,
    0,
  );
});

test('authored stride integrates across direction and crouch changes, holds across gaps, and agrees at cold seams', async () => {
  const id = '121';
  const player: Position = {
    id,
    team: 2,
    alive: true,
    health: 100,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    weapon: 'ak47',
    duck: 0,
  };
  const samples = [
    [0, 0, 0, 0],
    [4, 4, 0, 0],
    [8, 4, 4, 0],
    [12, 4, 4, 0],
    [16, 4, 4, 1],
    [20, 0, 4, 1],
    [24, 0, 4, 1],
    [28, 600, 4, 1],
  ];
  const data: Playback = {
    map: 'de_mirage',
    sample: false,
    tickRate: 64,
    events: [],
    players: [{ id, team: 2, name: 'fixture' }],
    rounds: [{ number: 1, tick: 0 }],
    frames: samples.map(([tick, x, y, duck]) => ({ tick, players: [{ ...player, x, y, duck }] })),
  };
  const history = encodeGaitHistory(data)!;
  assert.equal(validGaitHistory(history, new Set([id]), 0, 28, 64), true);
  assert.equal(validGaitHistory(history, new Set([id]), 0, 24 - 8, 64), false);
  const folder = await mkdtemp(join(tmpdir(), 'agent-gait-replay-'));
  try {
    await writeReplay(folder, data);
    assert.deepEqual(validateReplayArtifacts(folder).manifest.gaitHistory, history);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
  const calibration = agentStrideProfile(fixture().validated);
  const sample = () =>
    integrateGait(history.players[0][1], 64, calibration.strideAt, history.version);
  const continuously = sample(),
    cold = sample();
  assert.equal(continuously(16), continuously(8));
  assert.equal(continuously(28), continuously(20));
  for (const tick of [22, 1, 16, 5, 8, 17, 20]) {
    assert.equal(continuously(tick), cold(tick));
  }
  assert.ok(Math.abs(continuously(20) - (0.102 / 2 + 0.102 / 2 + 0.102)) < 1e-10);
});

test('pose frustum gate includes nearby rigs, rejects offscreen corpses, and preserves x-ray', () => {
  const visible = agentPoseVisibility();
  const camera = new PerspectiveCamera(60, 1, 0.1, 200);
  const rig = new Group();
  rig.position.set(0, 0, -12);
  assert.equal(visible(camera, rig, false), true);
  rig.position.set(35, 0, -12);
  assert.equal(visible(camera, rig, false), false);
  assert.equal(visible(camera, rig, true), true);
  camera.position.x = 35;
  assert.equal(visible(camera, rig, false), true);
});

test('centred motion cancels counter-strafes and uses identical evidence after a cold seek', () => {
  const id = '123';
  const player: Position = {
    id,
    team: 2,
    alive: true,
    health: 100,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    weapon: 'ak47',
  };
  const data: Playback = {
    map: 'de_mirage',
    sample: false,
    tickRate: 64,
    events: [],
    players: [{ id, team: 2, name: 'fixture' }],
    rounds: [
      { number: 1, tick: 0 },
      { number: 2, tick: 44 },
    ],
    frames: Array.from({ length: 19 }, (_, i) => {
      const tick = i * 4;
      return {
        tick,
        players: [
          {
            ...player,
            alive: tick !== 52,
            x:
              (tick < 44 ? Math.min(tick, 32 - tick) : tick - 44 + 500) * 3 +
              (tick >= 64 ? 9000 : 0),
          },
        ],
      };
    }),
  };
  const history = encodeGaitHistory(data)!;
  const first = agentCenteredMotionAt(history, id, 64)!;
  const cold = agentCenteredMotionAt(structuredClone(history), id, 64)!;
  for (const tick of [16, 43, 10, 32, 24.125, 14, 44, 49, 54, 62, 65]) {
    assert.deepEqual(first(tick), cold(tick));
  }
  const incoming = first(9);
  const reversed = first(23);
  assert.ok(incoming.velocityX > 4 && reversed.velocityX < -4);
  assert.ok(first(16).speed < 1e-4);
  const motion = first(16);
  const gait = directionalGait(fixture().validated, { ...idle, ...motion }, motion.speed, 0);
  assert.deepEqual(gait.samples, [{ role: 'rifle-idle', weight: 1 }]);
  assert.equal(first(43).speed, 0);
  assert.ok(first(44).speed > 4, 'round start samples the new life only');
  assert.equal(first(50).speed, 0, 'death gap is idle');
  assert.ok(first(56).speed > 4, 'respawn starts a new movement run');
  assert.equal(first(62).speed, 0, 'teleport gap is idle');
  assert.ok(first(65).speed > 4);
});

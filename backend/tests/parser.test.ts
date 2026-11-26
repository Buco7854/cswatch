import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  copyFileSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync, zstdCompressSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseTicks } from '@laihoe/demoparser2';
import { decodeAimChunk, sampleAim } from '../../shared/aim-track.mjs';
import type { PlaybackManifest } from '../../shared/playback.js';
import { shortestAngle } from '../../frontend/src/player-pose.js';
import { parse } from '../src/parser.js';
import { validateReplayArtifacts } from '../src/replay.js';
import { collectFrameState } from '../src/frame-state.js';
import { buildReviewPrompts } from '../../frontend/src/review-prompts.js';
const fixture = resolve(process.env.DEMO_FIXTURE || '../var/fixture/input.dem');
const pinnedFixture = '84a1a4191302bdd2a3bbb5a727842093744b1fb1a228aeec630369e44b622cb2';

function verifyAim(folder: string, manifest: PlaybackManifest) {
  const actors = new Set(manifest.players.map((player) => player.id));
  const decoded = manifest.chunks.map(({ index, startTick, endTick }) => {
    const chunk = JSON.parse(
      gunzipSync(readFileSync(join(folder, 'chunks', `${index}.json.gz`))).toString(),
    );
    return decodeAimChunk(chunk.aim, startTick, endTick, actors);
  });
  const errors = { yaw: [] as number[], pitch: [] as number[], worstAxis: [] as number[] };
  let outside = 0;
  const file = join(folder, 'input.dem');
  for (let start = 0; start <= manifest.lastTick + 4; start += 16384) {
    const end = Math.min(manifest.lastTick + 4, start + 16383);
    const wanted = Array.from({ length: end - start + 1 }, (_, i) => start + i);
    const source = parseTicks(file, ['yaw', 'pitch', 'is_alive'], wanted, undefined, true);
    for (const [i, tick] of (source.tick as number[]).entries()) {
      if (source.is_alive[i] !== true) continue;
      if (tick < manifest.firstTick || tick > manifest.lastTick) {
        outside++;
        continue;
      }
      const id = source.steamid[i];
      const chunk = manifest.chunks.findLastIndex((candidate) => candidate.startTick <= tick);
      const track = decoded[chunk].get(id);
      const aim = track && sampleAim(track, tick);
      assert.ok(aim, `Missing aim for alive tick ${tick}`);
      const yaw = Math.abs(shortestAngle(source.yaw[i], aim.yaw));
      const pitch = Math.abs(shortestAngle(source.pitch[i], aim.pitch));
      errors.yaw.push(yaw);
      errors.pitch.push(pitch);
      errors.worstAxis.push(Math.max(yaw, pitch));
    }
  }
  assert.equal(outside, 0, 'Living fixture samples outside replay bounds');
  assert.ok(errors.yaw.length > 400000);
  const percentiles = (values: number[]) => {
    values.sort((a, b) => a - b);
    const at = (p: number) => values[Math.ceil(values.length * p) - 1];
    return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
  };
  const metrics = Object.fromEntries(
    Object.entries(errors).map(([axis, values]) => [axis, percentiles(values)]),
  );
  assert.ok(metrics.worstAxis.p99 < 0.05);
  assert.ok(metrics.worstAxis.max <= 1 / 256);
  return { aliveSamples: errors.yaw.length, outside, degrees: metrics };
}

for (const compressed of [false, true])
  test(
    `real Mirage ${compressed ? '.dem.zst' : '.dem'} parses rounds, positions, utilities, dead time and string Steam IDs`,
    { skip: !existsSync(fixture) },
    async (t) => {
      const dir = mkdtempSync(join(tmpdir(), 'cswatch-parse-'));
      try {
        if (compressed)
          writeFileSync(join(dir, 'input.zst'), zstdCompressSync(readFileSync(fixture)));
        else copyFileSync(fixture, join(dir, 'input.dem'));
        await parse(dir, 2048 * 1024 ** 2);
        const { manifest } = validateReplayArtifacts(dir);
        if (!compressed)
          await t.test('pinned Mirage aim matches all living samples', (context) => {
            if (
              createHash('sha256')
                .update(readFileSync(join(dir, 'input.dem')))
                .digest('hex') !== pinnedFixture
            ) {
              context.skip('accuracy reference uses the pinned Mirage recording');
              return;
            }
            context.diagnostic(JSON.stringify(verifyAim(dir, manifest)));
          });
        const frames = manifest.chunks.flatMap((part, index) => {
          const chunk = JSON.parse(
            gunzipSync(readFileSync(join(dir, 'chunks', `${index}.json.gz`))).toString(),
          );
          return chunk.frames.filter(
            (frame: { tick: number }) =>
              index === 0 || frame.tick > manifest.chunks[index - 1].endTick,
          );
        });
        const grenades = manifest.chunks.flatMap(
          (_part, index) =>
            JSON.parse(gunzipSync(readFileSync(join(dir, 'chunks', `${index}.json.gz`))).toString())
              .grenades,
        );
        const data = { ...manifest, frames, grenades };
        const itemSamples = manifest.chunks.flatMap(
          (_part, index) =>
            JSON.parse(gunzipSync(readFileSync(join(dir, 'chunks', `${index}.json.gz`))).toString())
              .itemSamples || [],
        );
        assert.equal(typeof data.itemState?.complete, 'boolean');
        assert.equal(data.itemState?.coverage?.projectile, true);
        assert.equal(data.itemState?.coverage?.planted, true);
        assert.ok(
          itemSamples.some(
            (entry: any) => entry.present && entry.kind === 'dropped' && entry.equipment === 'ak47',
          ),
        );
        assert.ok(
          itemSamples.some(
            (entry: any) =>
              entry.present && entry.kind === 'planted' && entry.equipment === 'plantedc4',
          ),
        );
        for (const equipment of ['flashbang', 'hegrenade', 'smokegrenade', 'molotov', 'incgrenade'])
          assert.ok(
            itemSamples.some(
              (entry: any) =>
                entry.present && entry.kind === 'projectile' && entry.equipment === equipment,
            ),
          );
        assert.ok(
          itemSamples.some((entry: any) => !entry.present),
          'real removals/ownership changes close world visibility',
        );
        assert.ok(
          itemSamples
            .filter((entry: any) => entry.present)
            .every((entry: any) =>
              [entry.x, entry.y, entry.z, entry.pitch, entry.yaw, entry.roll].every(
                (value) => typeof value === 'number' && Number.isFinite(value),
              ),
            ),
        );
        assert.equal(data.map, 'de_mirage');
        assert.deepEqual(data.mapIdentity, {
          map: 'de_mirage',
          buildNum: 9842,
          patchVersion: 13984,
          demoVersionGuid: '8e9d71ab-04a1-4c01-bb61-acfede27c046',
          addonPresence: 'none',
        });
        assert.equal(data.players.length, 10);
        assert.ok(data.frames.length > 1000);
        assert.equal(typeof data.players[0].id, 'string');
        assert.ok(data.players[0].id.length > 15);
        assert.ok(data.rounds.some((r: any) => r.liveTick > r.tick));
        assert.ok(data.deadTimes.some((d: any) => d.kind === 'freeze' && d.end > d.start));
        assert.ok(data.events.some((e: any) => e.type === 'player_death'));
        const elimination = data.events.find((e: any) => e.type === 'player_death');
        assert.equal(typeof elimination.attacker_steamid, 'string');
        assert.equal(typeof elimination.user_steamid, 'string');
        assert.ok(data.grenades.some((g: any) => g.points.length > 2));
        const prompts = data.players.map((player) =>
          buildReviewPrompts(
            { ...data, version: 1 },
            player.id,
            frames[0].tick,
            frames.at(-1)!.tick,
          ),
        );
        assert.ok(prompts.some((index) => index.throws.length > 0));
        assert.ok(
          prompts.some((index) =>
            index.landings.some((landing) => landing.source === 'recorded-detonation'),
          ),
        );
        assert.equal(data.capabilities?.economy, true);
        assert.equal(data.capabilities?.equipment, true);
        assert.equal(data.capabilities?.inventory, true);
        assert.equal(data.capabilities?.inputButtons, 'network');
        assert.equal(data.capabilities?.mouseInput, false);
        assert.equal(data.capabilities?.utilityThrows, true);
        assert.equal(data.capabilities?.pawnMovement, true);
        const living = data.frames.flatMap((frame: any) =>
          frame.players.filter((player: any) => player.alive),
        );
        // Mirage fixture: map-based ctm_sas (CT) and tm_phoenix (T) handles, jumps and ladders.
        assert.deepEqual(
          [...new Set(living.map((player: any) => player.team + ':' + player.agentModel))].sort(),
          ['2:13181005211767972979', '3:10254416614829638596'],
        );
        assert.ok(living.some((player: any) => player.airborne === true));
        assert.ok(living.some((player: any) => player.ladder === true));
        assert.ok(living.some((player: any) => player.walking === true));
        assert.ok(living.filter((player: any) => player.airborne).length < living.length / 10);
        assert.ok(
          data.frames[0].players.some((player: any) => player.stats?.kills > 0),
          'pre-recording native totals survive instead of invented event-derived zeroes',
        );
        assert.ok(
          data.frames.some((frame: any) =>
            frame.players.some((player: any) => player.stats?.damage > 0),
          ),
        );
        assert.ok(
          data.frames[0].players.some((player: any) => player.stats?.damage === undefined),
          'missing early damage counters stay unknown',
        );
        assert.deepEqual(data.eventAvailability, { player_death: true, player_hurt: true });
        assert.equal(data.crosshairs?.complete, true);
        assert.ok(data.crosshairs.samples.length >= 10 && data.crosshairs.samples.length <= 10000);
        assert.equal(
          new Set(
            data.crosshairs.samples.filter((sample) => sample.code).map((sample) => sample.actor),
          ).size,
          10,
        );
        assert.ok(
          data.crosshairs.samples.every((sample) =>
            data.players.some((player) => player.id === sample.actor),
          ),
        );
        assert.equal(data.matchState?.complete, true);
        assert.equal(
          data.matchState.samples.find((state) => state.phase === 'live')?.roundNumber,
          1,
        );
        assert.equal(
          data.matchState.samples.find((state) => state.phase === 'live')?.roundNumberSource,
          'completed-counter',
        );
        assert.equal(
          data.matchState.samples.find((state) => state.phase === 'game-over')?.roundNumber,
          10,
        );
        assert.ok(data.matchState.samples.length > 10 && data.matchState.samples.length < 1000);
        assert.ok(
          data.matchState.samples.some((state) => state.ctScore === 2 && state.tScore === 8),
        );
        assert.ok(
          data.matchState.samples.some(
            (state) =>
              state.phase === 'live' &&
              state.clock?.kind === 'round' &&
              state.clock.startTick !== undefined &&
              state.clock.endTick! - state.clock.startTick === 115 * 64,
          ),
        );
        assert.ok(
          data.matchState.samples.some(
            (state) => state.phase === 'freeze' && state.clock?.kind === 'freeze',
          ),
        );
        assert.ok(data.throwInputs && data.throwInputs.length > 20);
        assert.ok(
          data.throwInputs.some(
            (snapshot) =>
              snapshot.provenance === 'event-network' && typeof snapshot.input.buttons === 'string',
          ),
        );
        for (const snapshot of data.throwInputs) {
          const event = data.events[snapshot.eventIndex];
          assert.equal(event.tick, snapshot.tick);
          assert.equal(event.user_steamid, snapshot.actorId);
        }
        assert.ok(
          data.events.some(
            (event) =>
              event.type === 'player_death' &&
              event.attacker_team_num === 3 &&
              event.user_team_num === 2,
          ),
        );
        assert.equal(data.objectives?.complete, true);
        assert.ok(data.objectives.samples.length > 5 && data.objectives.samples.length < 1000);
        assert.ok(
          data.objectives.samples.some(
            (sample) =>
              sample.kind === 'plant' &&
              sample.arming &&
              sample.actor &&
              sample.endTick !== undefined,
          ),
        );
        assert.ok(
          data.objectives.samples.some(
            (sample) =>
              sample.kind === 'bomb' &&
              sample.ticking &&
              sample.duration === 40 &&
              sample.endTick !== undefined,
          ),
        );
        assert.ok(
          data.objectives.samples.some(
            (sample) =>
              sample.kind === 'bomb' &&
              sample.beingDefused &&
              sample.actor &&
              sample.defuseDuration === 10 &&
              sample.defuseEndTick !== undefined,
          ),
        );
        assert.ok(
          data.events.some(
            (event) => event.type === 'bomb_beginplant' && typeof event.user_steamid === 'string',
          ),
        );
        assert.ok(
          data.events.some((event) => event.type === 'bomb_begindefuse' && event.haskit === false),
        );
        assert.ok(
          data.frames.some((frame: any) =>
            frame.players.some(
              (player: any) =>
                player.money !== undefined &&
                player.inventory &&
                player.input?.source === 'network' &&
                player.input.buttons !== '0',
            ),
          ),
        );
        assert.ok(
          data.events.some(
            (event: any) =>
              event.type === 'weapon_fire' &&
              event.weapon === 'weapon_smokegrenade' &&
              typeof event.user_steamid === 'string' &&
              Number.isFinite(event.user_X),
          ),
        );
        for (let i = 1; i < data.frames.length; i++)
          assert.ok(data.frames[i].tick > data.frames[i - 1].tick);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
test(
  'compressed expansion is bounded before native parsing',
  { skip: !existsSync(fixture) },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cswatch-bomb-'));
    try {
      writeFileSync(join(dir, 'input.zst'), zstdCompressSync(Buffer.alloc(4 * 1024 ** 2, 65)));
      await assert.rejects(parse(dir, 1024), /Expanded limit exceeded/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
test('raw demos obey the expansion ceiling before native code runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cswatch-raw-limit-'));
  try {
    writeFileSync(
      join(dir, 'input.dem'),
      Buffer.concat([Buffer.from('PBDEMS2\0'), Buffer.alloc(4096)]),
    );
    await assert.rejects(parse(dir, 1024), /Expanded limit exceeded/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('unordered native rows produce ordered frames and continuous recorded timeout segments', () => {
  const row = (tick: number, steamid: string, freeze: boolean) => ({
    tick,
    steamid,
    name: steamid,
    X: tick,
    Y: 0,
    Z: 0,
    health: 100,
    team_num: 2,
    is_alive: true,
    is_freeze_period: freeze,
  });
  const data = collectFrameState([
    row(12, '76561198000000001', false),
    row(4, '76561198000000002', true),
    row(8, '76561198000000001', true),
    row(4, '76561198000000001', true),
  ]);
  assert.deepEqual(
    data.frames.map((frame) => [frame.tick, frame.players.length]),
    [
      [4, 2],
      [8, 1],
      [12, 1],
    ],
  );
  assert.deepEqual(data.deadTimes, [{ start: 4, end: 12, kind: 'freeze' }]);
  assert.equal(data.players.length, 2);
});

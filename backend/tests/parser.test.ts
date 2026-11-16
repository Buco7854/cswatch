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
import { parse } from '../src/parser.js';
import { validateReplayArtifacts } from '../src/replay.js';
import { collectFrameState } from '../src/frame-state.js';
const fixture = resolve(process.env.DEMO_FIXTURE || '../var/fixture/input.dem');
for (const compressed of [false, true])
  test(
    `real Mirage ${compressed ? '.dem.zst' : '.dem'} parses rounds, positions, utilities, dead time and string Steam IDs`,
    { skip: !existsSync(fixture) },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cswatch-parse-'));
      try {
        if (compressed)
          writeFileSync(join(dir, 'input.zst'), zstdCompressSync(readFileSync(fixture)));
        else copyFileSync(fixture, join(dir, 'input.dem'));
        await parse(dir, 2048 * 1024 ** 2);
        const { manifest } = validateReplayArtifacts(dir);
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
        assert.equal(data.map, 'de_mirage');
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
        assert.equal(data.capabilities?.economy, true);
        assert.equal(data.capabilities?.equipment, true);
        assert.equal(data.capabilities?.inventory, true);
        assert.equal(data.capabilities?.inputButtons, 'network');
        assert.equal(data.capabilities?.mouseInput, false);
        assert.equal(data.capabilities?.utilityThrows, true);
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

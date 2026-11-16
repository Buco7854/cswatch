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
        const data = JSON.parse(gunzipSync(readFileSync(join(dir, 'playback.json.gz'))).toString());
        assert.equal(data.map, 'de_mirage');
        assert.equal(data.players.length, 10);
        assert.ok(data.frames.length > 1000);
        assert.equal(typeof data.players[0].id, 'string');
        assert.ok(data.players[0].id.length > 15);
        assert.ok(data.rounds.some((r: any) => r.liveTick > r.tick));
        assert.ok(data.deadTimes.some((d: any) => d.kind === 'freeze' && d.end > d.start));
        assert.ok(data.events.some((e: any) => e.type === 'player_death'));
        assert.ok(data.grenades.some((g: any) => g.points.length > 2));
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

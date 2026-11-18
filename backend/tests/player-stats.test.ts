import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync, gunzipSync } from 'node:zlib';
import { collectColumnFrameState, collectFrameState } from '../src/frame-state.js';
import { readPlayerColumns } from '../src/parser-fields.js';
import { columnsOf } from './fixtures/player-columns.js';
import { validateReplayArtifacts, writeReplay } from '../src/replay.js';
import { sample } from '../../frontend/src/sample.js';

const row = (tick: number) => ({
  tick,
  steamid: '76561198000000001',
  name: 'Recorded player',
  X: 0,
  Y: 0,
  Z: 0,
});

test('controller counters preserve pre-recording totals and actual zeroes while missing, coerced and invalid values remain absent', () => {
  const { frames } = collectFrameState([
    {
      ...row(100),
      kills_total: 12,
      deaths_total: 7,
      assists_total: 0,
      headshot_kills_total: 8,
      damage_total: null,
    },
    {
      ...row(104),
      kills_total: 0,
      deaths_total: 0,
      assists_total: 0,
      headshot_kills_total: 0,
      damage_total: 0,
    },
    {
      ...row(108),
      kills_total: '3',
      deaths_total: -1,
      assists_total: 1.5,
      headshot_kills_total: Infinity,
      damage_total: 1000000001,
    },
  ]);
  assert.deepEqual(frames[0].players[0].stats, {
    kills: 12,
    deaths: 7,
    assists: 0,
    headshotKills: 8,
  });
  assert.deepEqual(frames[1].players[0].stats, {
    kills: 0,
    deaths: 0,
    assists: 0,
    headshotKills: 0,
    damage: 0,
  });
  assert.equal(frames[2].players[0].stats, undefined);
});

test('unsupported optional counter fields do not erase other counters or economy state', () => {
  const columns = readPlayerColumns(
    (fields) => {
      if (fields.includes('damage_total')) throw new Error('Native property unsupported');
      return columnsOf([
        {
          ...row(100),
          ...(fields.includes('balance') ? { balance: 800 } : {}),
          ...(fields.includes('kills_total') ? { kills_total: 12 } : {}),
        },
      ]);
    },
    ['X', 'Y', 'Z'],
    [['balance'], ['kills_total', 'damage_total']],
  );
  const player = collectColumnFrameState(columns).frames[0].players[0];
  assert.equal(player.money, 800);
  assert.deepEqual(player.stats, { kills: 12 });
});

test('published frame counters stay bounded and cannot smuggle metadata or invalid numeric totals', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'cswatch-player-stats-'));
  try {
    await writeReplay(folder, {
      ...sample,
      frames: sample.frames.map((frame) => ({
        ...frame,
        players: frame.players.map((player) => ({
          ...player,
          stats: { kills: 12, deaths: 7, assists: 0, headshotKills: 8, damage: 1450 },
        })),
      })),
    });
    const { manifest } = validateReplayArtifacts(folder);
    const path = join(folder, 'chunks', '0.json.gz');
    const original = JSON.parse(gunzipSync(readFileSync(path)).toString());
    assert.deepEqual(original.frames[0].players[0].stats, {
      kills: 12,
      deaths: 7,
      assists: 0,
      headshotKills: 8,
      damage: 1450,
    });
    const changes: ((stats: any) => void)[] = [
      (stats) => {
        stats.kills = -1;
      },
      (stats) => {
        stats.deaths = 1.5;
      },
      (stats) => {
        stats.assists = '2';
      },
      (stats) => {
        stats.damage = 1000000001;
      },
      (stats) => {
        stats.headshotKills = null;
      },
      (stats) => {
        stats.url = 'https://example.com';
      },
    ];
    for (const change of changes) {
      const chunk = structuredClone(original);
      change(chunk.frames[0].players[0].stats);
      const json = JSON.stringify(chunk),
        metadata = structuredClone(manifest);
      metadata.chunks[0].bytes = Buffer.byteLength(json);
      writeFileSync(path, gzipSync(json));
      writeFileSync(join(folder, 'manifest.json.gz'), gzipSync(JSON.stringify(metadata)));
      assert.throws(() => validateReplayArtifacts(folder));
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

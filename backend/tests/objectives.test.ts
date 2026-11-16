import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { DemoReader } from 'cs2parser';
import { networkHandle, objectiveDeadline, observeObjectives } from '../src/objectives.js';
import { objectiveSampleSchema, validateReplayArtifacts, writeReplay } from '../src/replay.js';
import { sample } from '../../frontend/src/sample.js';

test('recorded server deadlines map to demo time without confusing relative time or native entity-handle bit widths', () => {
  assert.equal(objectiveDeadline(238.796875, 8259, 12723, 1 / 64, 64), 10819);
  assert.equal(objectiveDeadline(307.75, 14592, 19056, 1 / 64, 64), 15232);
  assert.equal(objectiveDeadline(198.515625, 8049, 12513, 1 / 64, 64), 8241);
  assert.equal(objectiveDeadline(198, 100, undefined, 1 / 64, 64), undefined);
  assert.equal(objectiveDeadline(0, 100, 10, 1 / 64, 64), undefined);
  assert.equal(objectiveDeadline(Infinity, 100, 10, 1 / 64, 64), undefined);
  assert.equal(networkHandle(9863309), 9863309);
  assert.equal(networkHandle(0xffffff), undefined);
  assert.equal(networkHandle(0xffffffff), undefined);
  assert.equal(networkHandle(-1), undefined);
  assert.equal(networkHandle(0x100000000), undefined);
});

test('objective snapshots retain only changed recorded state and resolve full serial-bearing handles to string identities', () => {
  class Reader extends EventEmitter {
    currentTick = 100;
    currentTime = 100 / 64;
    entities: { properties: Record<string, unknown> }[] = [];
  }
  const reader = new Reader();
  const finish = observeObjectives(reader as unknown as DemoReader, 64, 1000);
  const handle = (200 << 14) | 3001;
  reader.entities[10] = {
    properties: {
      'CCSPlayerController.m_hPlayerPawn': handle,
      'CCSPlayerController.m_steamID': '76561198000000001',
    },
  };
  reader.emit('entitycreated', [10, 1, 0, 'CCSPlayerController', 1]);
  reader.entities[20] = {
    properties: {
      'CC4.m_hOwnerEntity': handle,
      'CC4.m_bStartedArming': true,
      'CC4.m_fArmedTime': 19,
    },
  };
  reader.emit('serverinfo', { tick_interval: 1 / 64 });
  reader.emit('net_Tick', { tick: 1024 });
  reader.emit('entitycreated', [20, 2, 0, 'CC4', 2]);
  reader.emit('tickend');
  reader.currentTick = 101;
  reader.emit('net_Tick', { tick: 1025 });
  reader.emit('tickend');
  assert.equal(
    finish(true).samples.length,
    1,
    'unchanged objective values do not grow with frame count',
  );
  const first = finish(true).samples[0];
  assert.equal(first.actor, '76561198000000001');
  assert.equal(first.endTick, 292);
  reader.currentTick = 105;
  reader.emit('tickend');
  assert.equal(
    finish(true).samples.length,
    1,
    'missing network clock messages do not move a known deadline',
  );
  reader.currentTick = 110;
  // Direct property writes have no entityupdated callback in the underlying WASM reader.
  reader.entities[20].properties['CC4.m_bStartedArming'] = false;
  reader.emit('tickend');
  reader.emit('entitydeleted', 20);
  const result = finish(true);
  assert.equal(result.complete, true);
  assert.equal(result.samples.length, 3);
  assert.equal(result.samples[1].kind === 'plant' && result.samples[1].arming, false);
  assert.equal(result.samples[2].present, false);
  assert.equal(finish(false).complete, false);
});

test('untrusted objective metadata is bounded and rejects invalid identities, event times and extra fields', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'cswatch-objectives-'));
  try {
    await writeReplay(folder, {
      ...sample,
      objectives: {
        complete: true,
        samples: [
          {
            kind: 'bomb',
            entity: 'bomb:20:2:100',
            tick: 100,
            present: true,
            ticking: true,
            actor: '1',
            endTick: 1000,
            duration: 900 / 64,
            site: 0,
          },
        ],
      },
    });
    const path = join(folder, 'manifest.json.gz');
    const original = JSON.parse(gunzipSync(readFileSync(path)).toString());
    assert.equal(validateReplayArtifacts(folder).manifest.objectives?.samples[0].actor, '1');
    for (const change of [
      (value: any) => {
        value.objectives.samples[0].actor = '76561198000000099';
      },
      (value: any) => {
        value.objectives.samples[0].tick = value.lastTick + 1;
      },
      (value: any) => {
        value.objectives.samples[0].site = 184;
      },
      (value: any) => {
        value.objectives.samples[0].endTick = Infinity;
      },
      (value: any) => {
        value.objectives.samples[0].duration = 0;
      },
      (value: any) => {
        value.objectives.samples[0].path = '/etc/shadow';
      },
      (value: any) => {
        value.objectives.samples = [
          value.objectives.samples[0],
          { ...value.objectives.samples[0], tick: 99 },
        ];
      },
      (value: any) => {
        value.objectives.samples = Array.from({ length: 10001 }, () => value.objectives.samples[0]);
      },
    ]) {
      const metadata = structuredClone(original);
      change(metadata);
      writeFileSync(path, gzipSync(JSON.stringify(metadata)));
      assert.throws(() => validateReplayArtifacts(folder));
    }
    assert.equal(
      objectiveSampleSchema.safeParse({
        kind: 'plant',
        tick: 100,
        entity: 'plant',
        present: true,
        endTick: -1,
      }).success,
      false,
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

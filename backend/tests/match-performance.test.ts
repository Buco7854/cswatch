import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DemoReader } from 'cs2parser';
import { observeMatchPerformance } from '../src/match-performance.js';

test('recorded rank updates use an exact Steam identity and validated new/old ranks', () => {
  const reader = new EventEmitter();
  const id = '76561197960265729';
  const finish = observeMatchPerformance(reader as DemoReader, new Set([id]));
  reader.emit('CS_UM_ServerRankUpdate', {
    rank_update: [
      { account_id: 1, rank_type_id: 11, rank_new: 15280, rank_old: 15000, rank_change: 999 },
      { account_id: 2, rank_type_id: 11, rank_new: 20000 },
      { account_id: 1, rank_type_id: 12, rank_new: 19 },
      { account_id: 1, rank_type_id: 10, rank_new: 2 },
    ],
  });
  assert.deepEqual(finish(), { [id]: { rank: { mode: 'Premier', value: 15280, change: 280 } } });
});

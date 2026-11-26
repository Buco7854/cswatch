import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { now, Store } from '../src/db.js';
import {
  agentModelLimits,
  cleanupAgentModelRequestTemps,
  officialAgentModels,
  readAgentModelRequests,
  recordedAgentModels,
  requestedAgentModels,
  writeAgentModelRequests,
} from '../src/agent-model-requests.js';
import { modelResourceId } from '../../shared/model-resource-id.mjs';
import catalogue from '../../shared/agent-models.json' with { type: 'json' };

const handle = (entry: string) => modelResourceId(`characters/models/${entry}.vmdl`);
// The fixture demo records the two team defaults.
const defaults = { ct: '10254416614829638596', t: '13181005211767972979' };

test('the official catalogue keys every pinned agent by its recorded handle', () => {
  assert.equal(handle('ctm_sas/ctm_sas'), defaults.ct);
  assert.equal(handle('tm_phoenix/tm_phoenix'), defaults.t);
  assert.equal(catalogue.agents.length, 78);
  assert.equal(officialAgentModels.size, 78);
  assert.equal(officialAgentModels.has(defaults.ct), false);
  assert.equal(officialAgentModels.has(defaults.t), false);
  const fbi = officialAgentModels.get(handle('ctm_fbi/ctm_fbi_varianta'));
  assert.deepEqual(fbi, {
    handle: handle('ctm_fbi/ctm_fbi_varianta'),
    entry: 'ctm_fbi/ctm_fbi_varianta',
    team: 'ct',
    resource: 'agents/models/ctm_fbi/ctm_fbi_varianta.vmdl_c',
  });
  assert.equal(officialAgentModels.get(handle('tm_leet/tm_leet_varianta'))?.team, 't');
  const teams = [...officialAgentModels.values()].map((agent) => agent.team);
  assert.ok(teams.includes('ct') && teams.includes('t'));
});

test('a replay keeps the distinct handles of living players, bounded', () => {
  const frames = [
    {
      players: [
        { alive: true, agentModel: defaults.ct },
        { alive: true, agentModel: defaults.t },
        { alive: false },
      ],
    },
    { players: [{ alive: true, agentModel: defaults.ct }, { agentModel: 'not-a-handle' }] },
  ];
  assert.deepEqual(recordedAgentModels(frames), [defaults.ct, defaults.t]);
  const many = Array.from({ length: 200 }, (_, i) => ({
    players: [{ alive: true, agentModel: String(1000 + i) }],
  }));
  assert.equal(recordedAgentModels(many).length, agentModelLimits.perDemo);
});

test('ready demos publish only catalogued agents for the asset worker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cswatch-agent-models-'));
  const jobs = join(root, 'jobs');
  const db = new Store(join(root, 'data'));
  try {
    db.run(
      "INSERT INTO users(id,username,password_hash,role,created_at) VALUES('owner','owner',NULL,'member',?)",
      now(),
    );
    const fbi = handle('ctm_fbi/ctm_fbi_varianta'),
      leet = handle('tm_leet/tm_leet_varianta'),
      diver = handle('ctm_diver/ctm_diver_varianta');
    const insert = (id: string, status: string, metadata: unknown) =>
      db.run(
        'INSERT INTO demos(id,owner_id,name,source,status,size,created_at,metadata) VALUES(?,?,?,?,?,?,?,?)',
        id,
        'owner',
        id,
        'upload',
        status,
        1,
        now(),
        typeof metadata === 'string' ? metadata : JSON.stringify(metadata),
      );
    insert('a', 'ready', { agentModels: [defaults.ct, fbi, leet] });
    insert('b', 'ready', { agentModels: [leet, '12345'] });
    insert('c', 'processing', { agentModels: [diver] });
    insert('d', 'ready', { agentModels: 'invalid' });
    insert('e', 'ready', '{not json');
    insert('f', 'ready', {});
    assert.deepEqual(requestedAgentModels(db), [fbi, leet].sort());

    // Without a request the worker prepares nothing.
    assert.deepEqual(await readAgentModelRequests(jobs), []);
    const { mkdirSync } = await import('node:fs');
    mkdirSync(jobs, { mode: 0o750 });
    assert.deepEqual(await readAgentModelRequests(jobs), []);
    assert.equal(await writeAgentModelRequests(jobs, requestedAgentModels(db)), true);
    assert.deepEqual(await readAgentModelRequests(jobs), [fbi, leet].sort());
    // Unchanged requests are not rewritten.
    assert.equal(await writeAgentModelRequests(jobs, [leet, fbi]), false);
    // Only catalogue handles are ever published.
    await assert.rejects(writeAgentModelRequests(jobs, [defaults.ct]));
    await assert.rejects(writeAgentModelRequests(jobs, [fbi, fbi]));
    assert.deepEqual(await readAgentModelRequests(jobs), [fbi, leet].sort());

    // A tampered or unsafe request reads as empty, never as foreign handles.
    const file = join(jobs, 'agent-model-requests.json');
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, handles: ['12345'] }));
    assert.deepEqual(await readAgentModelRequests(jobs), []);
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, handles: [fbi] }));
    chmodSync(file, 0o666);
    assert.deepEqual(await readAgentModelRequests(jobs), []);
    chmodSync(file, 0o640);
    assert.deepEqual(await readAgentModelRequests(jobs), [fbi]);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).handles, [fbi]);

    // Startup reclaims only this module's own orphan temporary files.
    writeFileSync(join(jobs, '.agent-model-requests-0123456789abcdef01234567.tmp'), '{}', {
      mode: 0o600,
    });
    writeFileSync(join(jobs, '.agent-model-requests-other.tmp'), '{}', { mode: 0o600 });
    assert.equal(await cleanupAgentModelRequestTemps(jobs), 1);
    assert.deepEqual(readdirSync(jobs).sort(), [
      '.agent-model-requests-other.tmp',
      'agent-model-requests.json',
    ]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

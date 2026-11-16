import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Store, now } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { reserve } from '../src/ingestion.js';
import { validateReplayArtifacts, writeReplay } from '../src/replay.js';
import { processTranscriptionOne } from '../src/transcription-worker.js';

test(
  'public speech completes durable ASR through the required kernel sandbox with a readonly offline model',
  {
    skip:
      !process.env.CSWATCH_TRANSCRIPTION_TEST_MODEL &&
      'Prepare the offline model and set CSWATCH_TRANSCRIPTION_TEST_MODEL to exercise confined CPU inference.',
  },
  async () => {
    const { fixturePackets, fixtureReplay } =
      await import('../../tools/transcription/verify-transcription.mjs');
    const data = fixtureReplay(await fixturePackets());
    const root = mkdtempSync(join(tmpdir(), 'cswatch-kernel-transcription-'));
    const config = loadConfig({
      APP_URL: 'http://localhost:8000',
      COOKIE_SECURE: 'false',
      DATA_DIR: root,
      MAX_UPLOAD_MB: '1',
      TRANSCRIPTION_ENABLED: 'true',
      TRANSCRIPTION_MODEL_DIR: resolve(process.env.CSWATCH_TRANSCRIPTION_TEST_MODEL!),
      TRANSCRIPTION_LANGUAGE: 'auto',
      TRANSCRIPTION_TIMEOUT_SECONDS: '120',
    });
    const db = new Store(root);
    try {
      db.run(
        'INSERT INTO users VALUES(?,?,?,?,?)',
        'public-fixture-user',
        'public-fixture-user',
        null,
        0,
        now(),
      );
      const demo = reserve(
        db,
        config,
        'public-fixture-user',
        'Public-domain JFK speech contract fixture',
        'synthetic-qa',
      );
      await writeReplay(demo.folder, data);
      const prepared = validateReplayArtifacts(demo.folder);
      db.run(
        "UPDATE demos SET status='ready',transcription_status='queued',size=? WHERE id=?",
        prepared.bytes,
        demo.id,
      );
      assert.equal(await processTranscriptionOne(db, config), true);
      const row = db.one('SELECT * FROM demos WHERE id=?', demo.id)!;
      assert.equal(row.status, 'ready');
      assert.equal(row.transcription_status, 'ready');
      const output = JSON.parse(
        gunzipSync(readFileSync(join(demo.folder, row.transcription_artifact))).toString('utf8'),
      );
      assert.equal(output.status, 'ready');
      assert.ok(output.cues.length > 0);
      assert.match(
        output.cues.map((cue: { text: string }) => cue.text).join(' '),
        /fellow Americans/i,
      );
      assert.ok(
        output.cues.every(
          (cue: { language: string; source: string; speaker: string }) =>
            cue.language === 'en' &&
            cue.source === 'local-transcription' &&
            cue.speaker === data.players[0].id,
        ),
      );
      assert.equal(row.size, prepared.bytes + row.transcription_bytes);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

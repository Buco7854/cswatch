import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  classifyParserFailure,
  JobFailure,
  processingFailure,
  sandboxFailureReason,
} from '../src/parser-failure.js';

test('processing failures distinguish resource, host, parser and publication problems without exposing raw messages', () => {
  assert.equal(classifyParserFailure(new Error('Expanded limit exceeded')).code, 'demo_limit');
  assert.equal(classifyParserFailure(new Error('Replay output limit')).code, 'demo_limit');
  assert.equal(
    classifyParserFailure(Object.assign(new Error('private path'), { code: 'ENOSPC' })).code,
    'storage_limit',
  );
  assert.equal(classifyParserFailure(new Error('heap out of memory')).code, 'memory_limit');
  assert.equal(
    classifyParserFailure(new Error('private filename and user data')).code,
    'invalid_demo',
  );
  assert.deepEqual(
    processingFailure(Object.assign(new Error('/private/secret'), { code: 'ENOENT' }), 'sandbox'),
    { code: 'sandbox_unavailable', systemCode: 'ENOENT' },
  );
  assert.deepEqual(processingFailure(new Error('invalid raw secret'), 'validation'), {
    code: 'invalid_output',
  });
  assert.deepEqual(
    processingFailure(
      new JobFailure('parser_crash', { signal: 'SIGSEGV', exitCode: null }),
      'sandbox',
    ),
    { code: 'parser_crash', signal: 'SIGSEGV', exitCode: null },
  );
  assert.equal(
    JSON.stringify(processingFailure(new Error('credential-value'), 'publication')).includes(
      'credential-value',
    ),
    false,
  );
  const invalid = z
    .object({ frames: z.array(z.object({ health: z.number() })) })
    .safeParse({ frames: [{ health: 'private value' }] });
  assert.equal(invalid.success, false);
  if (!invalid.success)
    assert.deepEqual(processingFailure(invalid.error, 'validation'), {
      code: 'invalid_output',
      validation: 'invalid_type: frames.0.health',
    });
});

test('only bounded sandbox launcher diagnostics are retained from child output', () => {
  assert.equal(sandboxFailureReason('arbitrary native output with private values'), undefined);
  assert.equal(
    sandboxFailureReason(
      'cswatch parser sandbox: Landlock ABI 3 or newer required (Function not implemented)\nsecret=private',
    ),
    'Landlock ABI 3 or newer required (Function not implemented)',
  );
  assert.equal(
    sandboxFailureReason('cswatch parser sandbox: ' + 'a'.repeat(300) + ' (error)'),
    undefined,
  );
});

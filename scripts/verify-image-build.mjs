/** CI checks the running image, independently of the tag used to start it. */
import assert from 'node:assert/strict';

const expected = process.env.CSWATCH_EXPECTED_REVISION;
assert.match(expected || '', /^[a-f0-9]{40}$/, 'Provide the exact expected build revision.');
const response = await fetch('http://localhost:8000/api/config', {
  signal: AbortSignal.timeout(10000),
});
assert.equal(response.status, 200);
assert.equal(response.headers.get('cache-control'), 'private, no-store');
const { build } = await response.json();
assert.equal(build?.revision, expected, 'The running container must contain this workflow source.');
assert.equal(new Date(build.builtAt).toISOString(), build.builtAt);
console.log(
  JSON.stringify({ runningImageRevision: build.revision, builtAt: build.builtAt, verified: true }),
);

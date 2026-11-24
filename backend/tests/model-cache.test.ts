import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelCache, type ModelResource } from '../../frontend/src/model-cache.js';

type Asset = { name: string; resources: ModelResource[] };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function harness(
  options: {
    unused?: number;
    bytes?: number | ((active: boolean) => number);
    resident?: number;
  } = {},
) {
  const starts: {
      url: string;
      loaded: (value: Asset) => void;
      failed: (error: unknown) => void;
      aborts: number;
    }[] = [],
    cleared: string[] = [],
    loaded: Asset[] = [],
    errors: unknown[] = [];
  const cache = new ModelCache<Asset>({
    inactiveBytes: (active) =>
      typeof options.bytes === 'function' ? options.bytes(active) : (options.bytes ?? 1000),
    maxUnused: options.unused ?? 2,
    residentBytes: options.resident !== undefined ? () => options.resident! : undefined,
    maxConcurrent: 2,
    inspect: (value) => value.resources,
    clear: (url) => cleared.push(url),
    load: (url, callbacks) => {
      const job = { url, ...callbacks, aborts: 0 };
      starts.push(job);
      return () => job.aborts++;
    },
  });
  const request = (url: string) =>
    cache.request(url, {
      loaded: (value) => loaded.push(value),
      failed: (error) => errors.push(error),
    });
  const create = (name: string, bytes = 10) => {
    let disposals = 0;
    const value = { name, resources: [{ key: {}, bytes, dispose: () => disposals++ }] };
    return { value, disposals: () => disposals };
  };
  return { cache, starts, cleared, loaded, errors, request, create };
}
test('Scene pin preserves2D reuse and actual Model reference protects async renderer teardown', async () => {
  const h = harness({ unused: 0 }),
    scope = h.cache.scope('a'),
    scene = scope.acquire(),
    model = scope.acquire(),
    asset = h.create('a');
  h.request('a');
  await flush();
  h.starts[0].loaded(asset.value);
  await flush();
  model();
  await flush();
  assert.equal(asset.disposals(), 0);
  h.request('a');
  assert.equal(h.starts.length, 1);
  assert.equal(h.loaded.length, 2);
  const newModel = scope.acquire();
  scene();
  await flush();
  assert.equal(asset.disposals(), 0);
  newModel();
  await flush();
  assert.equal(asset.disposals(), 1);
  assert.deepEqual(h.cleared, ['a']);
});
test('LRU retains at most2 unused entries and keeps active assets while evicting least recently used', async () => {
  const h = harness(),
    assets = [];
  for (const url of ['a', 'b']) {
    const scope = h.cache.scope(url),
      release = scope.acquire(),
      asset = h.create(url);
    assets.push(asset);
    h.request(url);
    await flush();
    h.starts.at(-1)!.loaded(asset.value);
    release();
    await flush();
  }
  const touch = h.cache.scope('a').acquire();
  touch();
  await flush();
  const active = h.cache.scope('c').acquire(),
    c = h.create('c');
  h.request('c');
  await flush();
  h.starts.at(-1)!.loaded(c.value);
  await flush();
  assert.equal(assets[0].disposals(), 0);
  assert.equal(assets[1].disposals(), 0);
  active();
  await flush();
  assert.equal(assets[1].disposals(), 1);
  assert.equal(assets[0].disposals(), 0);
  assert.equal(c.disposals(), 0);
});
test('inactive byte ceiling evicts even below entry count limit and alias resources close only after all owners leave', async () => {
  const h = harness({ bytes: 50 }),
    shared = {};
  let closed = 0;
  for (const url of ['a', 'b']) {
    const release = h.cache.scope(url).acquire();
    h.request(url);
    await flush();
    h.starts
      .at(-1)!
      .loaded({ name: url, resources: [{ key: shared, bytes: 40, dispose: () => closed++ }] });
    release();
    await flush();
  }
  assert.equal(closed, 0, 'The same bitmap is counted once across aliases');
  const release = h.cache.scope('c').acquire(),
    c = h.create('c', 60);
  h.request('c');
  await flush();
  h.starts.at(-1)!.loaded(c.value);
  release();
  await flush();
  assert.equal(closed, 1);
  assert.equal(
    c.disposals(),
    1,
    'An individual oversized inactive entry cannot exceed the byte ceiling',
  );
});
test('eviction never closes aliases still referenced by an active model', async () => {
  const h = harness({ unused: 0 }),
    shared = {};
  let disposed = 0;
  const a = h.cache.scope('a').acquire(),
    b = h.cache.scope('b').acquire();
  h.request('a');
  h.request('b');
  await flush();
  for (const job of h.starts)
    job.loaded({
      name: job.url,
      resources: [{ key: shared, bytes: 100, dispose: () => disposed++ }],
    });
  a();
  await flush();
  assert.equal(disposed, 0);
  b();
  await flush();
  assert.equal(disposed, 1);
});
test('late abandoned results dispose without replacing a newer same-URL generation or poisoning its public cache', async () => {
  const h = harness(),
    oldScope = h.cache.scope('a'),
    old = oldScope.acquire();
  h.request('a');
  await flush();
  old();
  await flush();
  assert.equal(h.starts[0].aborts, 1);
  assert.equal(h.errors.length, 1);
  assert.deepEqual(h.cleared, ['a']);
  const freshScope = h.cache.scope('a'),
    fresh = freshScope.acquire();
  h.request('a');
  await flush();
  assert.equal(
    h.starts.length,
    1,
    'Do not join the global FileLoader request while its old abort is settling',
  );
  const abandoned = h.create('abandoned');
  h.starts[0].loaded(abandoned.value);
  await flush();
  assert.equal(abandoned.disposals(), 1);
  assert.equal(h.starts.length, 2);
  const current = h.create('fresh');
  h.starts[1].loaded(current.value);
  await flush();
  oldScope.invalidate();
  await flush();
  assert.equal(freshScope.isCurrent(), true);
  assert.equal(current.disposals(), 0);
  assert.deepEqual(
    h.loaded.map((value) => value.name),
    ['fresh'],
  );
  assert.deepEqual(h.cleared, ['a']);
  fresh();
});
test('uncancellable decodes continue occupying one of2 slots while queued current maps make progress', async () => {
  const h = harness(),
    releases = ['a', 'b', 'c'].map((url) => h.cache.scope(url).acquire());
  for (const url of ['a', 'b', 'c']) h.request(url);
  await flush();
  assert.deepEqual(
    h.starts.map((job) => job.url),
    ['a', 'b'],
  );
  releases[0]();
  await flush();
  assert.equal(h.starts.length, 2);
  h.starts[1].loaded(h.create('b').value);
  await flush();
  assert.deepEqual(
    h.starts.map((job) => job.url),
    ['a', 'b', 'c'],
  );
  const late = h.create('late');
  h.starts[0].loaded(late.value);
  await flush();
  assert.equal(late.disposals(), 1);
  h.starts[2].loaded(h.create('c').value);
  releases[1]();
  releases[2]();
  await flush();
});
test('failed scope invalidation permits retry and an uncommitted render scope can safely acquire after idle cleanup', async () => {
  const h = harness(),
    scope = h.cache.scope('a');
  await flush();
  const release = scope.acquire();
  h.request('a');
  await flush();
  h.starts[0].failed(new Error('Original QA decode failure'));
  await flush();
  assert.equal(h.errors.length, 1);
  scope.invalidate();
  release();
  await flush();
  const retry = h.cache.scope('a'),
    pin = retry.acquire();
  h.request('a');
  await flush();
  assert.equal(h.starts.length, 2);
  h.starts[1].loaded(h.create('retry').value);
  await flush();
  assert.equal(h.loaded.at(-1)!.name, 'retry');
  pin();
});

test('hard resident equipment budget evicts idle resources but never disposes active aliased resources', async () => {
  const h = harness({ resident: 50 }),
    shared = {};
  let closed = 0;
  const a = h.cache.scope('a').acquire();
  h.request('a');
  await flush();
  h.starts[0].loaded({
    name: 'a',
    resources: [{ key: shared, bytes: 30, dispose: () => closed++ }],
  });
  const b = h.cache.scope('b').acquire();
  h.request('b');
  await flush();
  h.starts[1].loaded({
    name: 'b',
    resources: [{ key: shared, bytes: 30, dispose: () => closed++ }],
  });
  const c = h.cache.scope('c').acquire(),
    tooLarge = h.create('c', 30);
  h.request('c');
  await flush();
  h.starts[2].loaded(tooLarge.value);
  await flush();
  assert.equal(h.errors.length, 1);
  assert.equal(tooLarge.disposals(), 1);
  assert.equal(closed, 0);
  assert.deepEqual(
    h.loaded.map((asset) => asset.name),
    ['a', 'b'],
  );
  a();
  b();
  c();
  await flush();
  const d = h.cache.scope('d').acquire(),
    replacement = h.create('d', 40);
  h.request('d');
  await flush();
  h.starts.at(-1)!.loaded(replacement.value);
  await flush();
  assert.equal(closed, 1, 'idle aliased asset releases only after both entries evict');
  assert.equal(replacement.disposals(), 0);
  assert.equal(h.loaded.at(-1)?.name, 'd');
  d();
});

test('resident weapons reuse spare capacity during play and return to the idle ceiling when the last lease closes', async () => {
  const h = harness({ bytes: (active) => (active ? 35 : 10), resident: 35 }),
    scene = h.cache.scope('agent').acquire();
  h.request('agent');
  await flush();
  h.starts.at(-1)!.loaded(h.create('agent').value);
  const first = h.create('rifle'),
    second = h.create('grenade');
  for (const asset of [first, second]) {
    const release = h.cache.scope(asset.value.name).acquire();
    h.request(asset.value.name);
    await flush();
    h.starts.at(-1)!.loaded(asset.value);
    release();
    await flush();
  }
  const again = h.cache.scope('rifle').acquire();
  h.request('rifle');
  assert.equal(h.starts.length, 3);
  assert.equal(h.loaded.at(-1), first.value);
  again();
  scene();
  await flush();
  assert.equal(first.disposals(), 1);
  assert.equal(second.disposals(), 1);
});

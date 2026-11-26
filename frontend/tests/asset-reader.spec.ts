import { expect, test } from '@playwright/test';
import type { Manifest } from '../src/world/format';

/** Records the worker requests; the reader's own bookkeeping is under test. */
class RecordingWorker {
  static last: RecordingWorker | undefined;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  posted: { id: number; file: string }[] = [];
  terminated = false;
  constructor() {
    RecordingWorker.last = this;
  }
  postMessage(message: { id: number; file: string }) {
    this.posted.push(message);
  }
  terminate() {
    this.terminated = true;
  }
}

test('closing a map reader ends in-flight reads as a handled abort, including unawaited prefetches', async () => {
  const unhandled: unknown[] = [];
  const track = (reason: unknown) => unhandled.push(reason);
  const previous = (globalThis as { Worker?: unknown }).Worker;
  (globalThis as { Worker?: unknown }).Worker = RecordingWorker;
  process.on('unhandledRejection', track);
  try {
    const { assetReader } = await import('../src/world/asset-reader');
    const manifest = { files: { 'a.bin': {}, 'b.bin': {} } } as unknown as Manifest;
    const reader = assetReader(new URL('http://localhost/world/'), manifest);
    const awaited = reader.read('a.bin');
    // A texture stream prefetches the next page; teardown can leave it unawaited.
    reader.read('b.bin');
    expect(RecordingWorker.last!.posted.map(({ file }) => file)).toEqual(['a.bin', 'b.bin']);
    reader.close();
    await expect(awaited).rejects.toMatchObject({ name: 'AbortError', message: 'Map closed' });
    expect(RecordingWorker.last!.terminated).toBe(true);
    // Unhandled rejections are reported after the microtask queue drains.
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);

    // A failure the worker reports still reaches the caller unchanged.
    const failing = assetReader(new URL('http://localhost/world/'), manifest);
    const read = failing.read('a.bin');
    RecordingWorker.last!.onmessage!({ data: { id: 1, error: 'hash mismatch' } });
    await expect(read).rejects.toThrow('hash mismatch');
    failing.close();
  } finally {
    process.off('unhandledRejection', track);
    (globalThis as { Worker?: unknown }).Worker = previous;
  }
});

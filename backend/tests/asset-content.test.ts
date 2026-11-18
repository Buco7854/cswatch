import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { fileDigest, fileVersion } from '../src/asset-content.js';

function memoryFile(initial: Buffer) {
  let data = initial;
  const reads: number[] = [];
  const handle = {
    stat: async (options?: { bigint?: boolean }) => ({
      isFile: () => true,
      nlink: options?.bigint ? 1n : 1,
      dev: 1n,
      ino: 2n,
      ctimeNs: 3n,
      mtimeNs: 4n,
      size: options?.bigint ? BigInt(data.length) : data.length,
    }),
    read: async (buffer: Buffer, offset: number, length: number, position: number) => {
      reads.push(length);
      const bytesRead = data.copy(
        buffer,
        offset,
        position,
        Math.min(data.length, position + length),
      );
      return { bytesRead, buffer };
    },
  } as unknown as FileHandle;
  return {
    handle,
    reads,
    replace: (next: Buffer) => {
      data = next;
    },
  };
}

test('content proofs detect same-size changes even when inode and nanosecond timestamps are identical', async () => {
  const first = Buffer.alloc(80, 1),
    second = Buffer.alloc(80, 2),
    file = memoryFile(first);
  const identity = await fileVersion(file.handle),
    before = await fileDigest(file.handle, 80);
  file.replace(second);
  assert.equal(
    await fileVersion(file.handle),
    identity,
    'The filesystem identity intentionally does not change.',
  );
  const after = await fileDigest(file.handle, 80);
  assert.equal(before, createHash('sha256').update(first).digest('hex'));
  assert.equal(after, createHash('sha256').update(second).digest('hex'));
  assert.notEqual(after, before);
});

test('content verification reads fixed-size slices and refuses data beyond the public asset bound', async () => {
  const file = memoryFile(Buffer.alloc(192 * 1024, 3));
  await fileDigest(file.handle, 192 * 1024);
  assert.ok(file.reads.length >= 3);
  assert.ok(file.reads.every((length) => length <= 65536));
  await assert.rejects(fileDigest(file.handle, 192 * 1024 - 1), /bound/);
});

test('content verification stops after an aborted in-flight slice without reading the rest of the file', async () => {
  const file = memoryFile(Buffer.alloc(192 * 1024, 3)),
    controller = new AbortController(),
    reason = new Error('Original disconnect fixture');
  const read = file.handle.read.bind(file.handle);
  file.handle.read = (async (...args: Parameters<typeof read>) => {
    const result = await read(...args);
    controller.abort(reason);
    return result;
  }) as typeof file.handle.read;
  await assert.rejects(
    fileDigest(file.handle, 192 * 1024, controller.signal),
    (error) => error === reason,
  );
  assert.equal(file.reads.length, 1);
  assert.equal(file.reads[0], 65536);
});

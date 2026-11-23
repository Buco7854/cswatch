import { readSync, writeSync } from 'node:fs';
import { open } from 'node:fs/promises';
import bzip from 'seek-bzip';

/** Decode one complete BZip2 stream in the disposable parser process. */
export async function expandBzip2(source: string, destination: string, maxExpanded: number) {
  await using input = await open(source, 'r');
  await using output = await open(destination, 'wx', 0o600);
  const compressed = Buffer.allocUnsafe(64 * 1024);
  const decoded = Buffer.allocUnsafe(64 * 1024);
  let next = 0,
    available = 0,
    buffered = 0,
    remaining = maxExpanded;
  function readByte() {
    if (next === available) {
      available = readSync(input.fd, compressed, 0, compressed.length, null);
      if (!available) throw new Error('Truncated BZip2 stream');
      next = 0;
    }
    return compressed[next++];
  }
  function flush() {
    for (let offset = 0; offset < buffered;) {
      offset += writeSync(output.fd, decoded, offset, buffered - offset);
    }
    buffered = 0;
  }
  // Without an optional eof() method the decoder must read the end marker
  // and checksum. Returning zero-filled bytes at EOF could hide truncation.
  bzip.decode(
    {
      readByte,
      read(buffer, offset, length) {
        for (let i = 0; i < length; i++) buffer[offset + i] = readByte();
        return length;
      },
    },
    {
      writeByte(byte) {
        if (remaining-- <= 0) throw new Error('Expanded limit exceeded');
        decoded[buffered++] = byte;
        if (buffered === decoded.length) flush();
      },
    },
  );
  if (next !== available || readSync(input.fd, compressed, 0, 1, null))
    throw new Error('Trailing data after BZip2 stream');
  flush();
}

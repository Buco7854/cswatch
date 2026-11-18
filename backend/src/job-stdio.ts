/** Trusted preload for disposable child jobs only. Node's lazy stderr pipe
 * initializes a Socket using ioctl, which the kernel boundary deliberately
 * denies. A non-TTY stream writes only the already-inherited diagnostic fd. */
import { writeSync } from 'node:fs';
import { Writable } from 'node:stream';

const stderr = new Writable({
  write(chunk: Buffer, _encoding, complete) {
    let offset = 0;
    while (offset < chunk.length) {
      try {
        const written = writeSync(2, chunk, offset, chunk.length - offset);
        if (written <= 0) break;
        offset += written;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EINTR') continue;
        // Diagnostics are best-effort if the bounded parent pipe closes or is
        // full. Logging must not turn a model import into an inference failure.
        break;
      }
    }
    complete();
  },
});
Object.assign(stderr, { fd: 2, isTTY: false });
stderr.on('error', () => {});
Object.defineProperty(process, 'stderr', {
  value: stderr,
  configurable: true,
  enumerable: true,
});

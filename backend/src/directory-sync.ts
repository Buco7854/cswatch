import { closeSync, constants, fsyncSync, openSync } from 'node:fs';

export function syncDirectory(path: string, flags = 0) {
  const directory = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | flags);
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

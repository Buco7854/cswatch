import { decodeMatchShareCode } from 'csgo-sharecode';
import { t } from './i18n';

export type ReplayFolder = FileSystemDirectoryHandle & { keys(): AsyncIterable<string> };

export function folderPicker() {
  return (
    window as Window & {
      showDirectoryPicker?: (options: { mode: 'read' }) => Promise<ReplayFolder>;
    }
  ).showDirectoryPicker?.bind(window);
}

export function replayIdentity(id: string, code: string) {
  try {
    const identity = decodeMatchShareCode(code);
    return identity.matchId.toString() === id ? identity : undefined;
  } catch {
    return undefined;
  }
}

// CS2 writes the match ID in the first protobuf field of the .dem.info sidecar.
// Only read that field. Unsupported encodings can still be imported by hand.
async function sidecarMatchId(file: File) {
  const bytes = new Uint8Array(await file.slice(0, 11).arrayBuffer());
  if (bytes[0] !== 8) return undefined;
  let value = 0n;
  for (let i = 1; i < bytes.length; i++) {
    const byte = bytes[i];
    if (i === 10 && byte > 1) return undefined;
    value |= BigInt(byte & 127) << BigInt(7 * (i - 1));
    if (byte < 128) return value;
  }
}

// A downloaded Source 2 demo has a patched file-info offset in the header.
// Its final packet must already be present in full, even if a writer has paused.
async function hasFinalPacket(file: File) {
  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (header.length !== 16 || new TextDecoder().decode(header.subarray(0, 8)) !== 'PBDEMS2\0')
    return false;
  const offset = new DataView(header.buffer).getUint32(8, true);
  if (offset < 16 || offset >= file.size) return false;
  const packet = new Uint8Array(await file.slice(offset, offset + 12).arrayBuffer());
  // DEM_FileInfo (2), optionally compressed (64).
  if ((packet[0] & ~64) !== 2) return false;
  let cursor = 1;
  function uint32() {
    let result = 0;
    for (let i = 0; i < 5 && cursor < packet.length; i++) {
      const byte = packet[cursor++];
      if (i === 4 && byte > 15) return undefined;
      result += (byte & 127) * 2 ** (7 * i);
      if (byte < 128) return result;
    }
    return undefined;
  }
  if (uint32() === undefined) return false;
  const length = uint32();
  return length !== undefined && length > 0 && offset + cursor + length === file.size;
}

export async function findSteamReplay(
  folder: ReplayFolder,
  identity: ReturnType<typeof decodeMatchShareCode>,
  maxMb: number,
  signal: AbortSignal,
): Promise<File | 'incomplete' | undefined> {
  const reservation = identity.reservationId.toString().padStart(21, '0');
  let entries = 0;
  let name: string | undefined;
  for await (const entry of folder.keys()) {
    signal.throwIfAborted();
    if (++entries > 8192)
      throw new Error(t('Too many files to check. Choose the demo file directly.'));
    const match = /^match730_(\d{21})_(\d{10})_(\d{1,10})\.dem$/.exec(entry);
    if (!match || match[1] !== reservation || Number(match[2]) % 65536 !== identity.tvPort)
      continue;
    if (name)
      throw new Error(t('Several files match this reservation. Choose the demo file directly.'));
    name = entry;
  }
  if (!name) return undefined;
  try {
    const info = await (await folder.getFileHandle(name + '.info')).getFile();
    const matchId = await sidecarMatchId(info);
    if (matchId === undefined && info.size < 11) return 'incomplete';
    if (matchId !== identity.matchId)
      throw new Error(
        t('The replay information does not confirm this match. Choose the demo file directly.'),
      );
    const file = await (await folder.getFileHandle(name)).getFile();
    if (file.size > maxMb * 1024 ** 2)
      throw new Error(t('Maximum file size is {{v0}} MB.', { v0: maxMb }));
    return (await hasFinalPacket(file)) ? file : 'incomplete';
  } catch (error) {
    // CS2 may still be writing or renaming either file.
    if (error instanceof DOMException && ['NotFoundError', 'NotReadableError'].includes(error.name))
      return 'incomplete';
    throw error;
  }
}

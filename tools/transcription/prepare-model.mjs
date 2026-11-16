/** Trusted operator CLI. Runtime transcription never downloads models or sends audio. */
import { readFileSync, lstatSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const manifest = JSON.parse(readFileSync(new URL('./model-manifest.json', import.meta.url)));
const MAX_FILE = 40 * 1024 ** 2;
const MAX_TOTAL = 64 * 1024 ** 2;
const hash = (data) => createHash('sha256').update(data).digest('hex');

export async function prepareModel(destination) {
  const output = resolve(destination);
  mkdirSync(output, { recursive: true, mode: 0o755 });
  let total = 0;
  for (const file of manifest.files) {
    if (
      !/^[a-z0-9_/.-]+$/i.test(file.path) ||
      file.path.split('/').includes('..') ||
      file.path.startsWith('/') ||
      file.bytes > MAX_FILE ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new Error('Invalid pinned model manifest.');
    total += file.bytes;
    if (total > MAX_TOTAL) throw new Error('Pinned model exceeds the preparation limit.');
    const target = join(output, file.path);
    try {
      const stat = lstatSync(target);
      if (stat.isFile() && stat.size === file.bytes) {
        const cached = readFileSync(target);
        if (hash(cached) === file.sha256) continue;
      }
    } catch {
      /* Download a missing file. */
    }
    const url = `https://huggingface.co/${manifest.model}/resolve/${manifest.revision}/${file.path}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
    if (
      !response.ok ||
      !response.body ||
      (response.headers.get('content-length') &&
        Number(response.headers.get('content-length')) > MAX_FILE)
    )
      throw new Error('Model download failed: ' + file.path);
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.byteLength;
      if (length > file.bytes) {
        await response.body.cancel().catch(() => {});
        throw new Error('Model download exceeds its pinned size.');
      }
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256)
      throw new Error('Model checksum mismatch: ' + file.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    const temporary = target + '.' + process.pid + '.partial';
    try {
      writeFileSync(temporary, bytes, { mode: 0o644, flag: 'wx' });
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
    console.log('Verified ' + file.path);
  }
  writeFileSync(join(output, 'cswatch-model.json'), JSON.stringify(manifest, null, 2) + '\n', {
    mode: 0o644,
  });
  console.log('Offline model prepared at ' + output);
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--out')
    throw new Error(
      'Usage: node tools/transcription/prepare-model.mjs --out /path/to/whisper-tiny',
    );
  await prepareModel(args[1]);
}

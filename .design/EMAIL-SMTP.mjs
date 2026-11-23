import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { withLoopbackEmail } from '../frontend/tests/fixtures/run-email-smtp.mjs';

process.exitCode = await withLoopbackEmail(async ({ origin }) => {
  const capture = spawn(process.execPath, ['.design/EMAIL-VISUAL.mjs', origin], { stdio: 'inherit' });
  const [code] = await once(capture, 'exit');
  return code ?? 1;
});

import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { connect } from 'node:tls';
import type { Config } from './config.js';

export type AccountMessage = { to: string; subject: string; body: string };
const responseLimit = 8192;
const submissionDeadlineMs = 8000;
const failed = () => new Error('SMTP submission failed.');
class RelayRefusal extends Error {}

function messageData(from: string, domain: string, message: AccountMessage) {
  const body =
    Buffer.from(message.body)
      .toString('base64')
      .match(/.{1,76}/g) ?? [];
  return [
    `From: cswatch <${from}>`,
    `To: <${message.to}>`,
    `Subject: =?UTF-8?B?${Buffer.from(message.subject).toString('base64')}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    ...body,
    '.',
    '',
  ].join('\r\n');
}

/** A single submission to the configured relay, over certificate-verified implicit TLS. */
export async function submitAccountMessage(
  smtp: NonNullable<Config['smtp']>,
  message: AccountMessage,
  signal: AbortSignal,
  current: () => boolean,
  deliveryPossible: (possible: boolean) => void,
) {
  signal.throwIfAborted();
  const socket = connect({
    host: smtp.host,
    port: smtp.port,
    servername: isIP(smtp.host) ? undefined : smtp.host,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
  });
  const interrupt = () => {
    socket.destroy(failed());
  };
  const deadline = setTimeout(interrupt, submissionDeadlineMs);
  deadline.unref();
  signal.addEventListener('abort', interrupt, { once: true });
  const iterator = socket[Symbol.asyncIterator]();
  let pending = '';

  async function expect(codes: number[], command?: string) {
    if (command) socket.write(command + '\r\n');
    let consumed = 0;
    let responseCode: number | undefined;
    const lines: string[] = [];
    while (true) {
      const end = pending.indexOf('\r\n');
      if (end < 0) {
        const chunk = await iterator.next();
        if (chunk.done) throw failed();
        pending += Buffer.from(chunk.value).toString('latin1');
        if (consumed + pending.length > responseLimit) throw failed();
        continue;
      }
      const line = pending.slice(0, end);
      pending = pending.slice(end + 2);
      consumed += end + 2;
      const response = /^([2-5][0-9]{2})([- ]?)([\x09\x20-\x7e]*)$/.exec(line);
      if (!response || (!response[2] && response[3])) throw failed();
      const code = Number(response[1]);
      if (responseCode !== undefined && responseCode !== code) throw failed();
      responseCode = code;
      lines.push(response[3]);
      if (response[2] !== '-') {
        if (pending.length) throw failed();
        if (!codes.includes(code)) {
          if (code >= 400) throw new RelayRefusal('SMTP submission refused.');
          throw failed();
        }
        return lines;
      }
    }
  }

  try {
    const domain = smtp.from.slice(smtp.from.indexOf('@') + 1);
    await expect([220]);
    if (!socket.authorized || !current()) return;
    const features = await expect([250], `EHLO ${domain}`);
    if (
      !features.some((line) => {
        const [extension, ...mechanisms] = line.toUpperCase().split(/[=\t ]+/);
        return extension === 'AUTH' && mechanisms.includes('PLAIN');
      })
    )
      throw failed();
    const auth = Buffer.from(`\0${smtp.username}\0${smtp.password}`).toString('base64');
    await expect([235], `AUTH PLAIN ${auth}`);
    if (!current()) return;
    await expect([250], `MAIL FROM:<${smtp.from}>`);
    if (!current()) return;
    await expect([250, 251], `RCPT TO:<${message.to}>`);
    await expect([354], 'DATA');
    if (!current()) return;
    deliveryPossible(true);
    socket.write(messageData(smtp.from, domain, message));
    try {
      await expect([250]);
    } catch (error) {
      // A definitive failure at end-of-DATA permits a new code. A lost acknowledgement does not.
      if (error instanceof RelayRefusal) deliveryPossible(false);
      throw error;
    }
    await expect([221], 'QUIT');
  } finally {
    signal.removeEventListener('abort', interrupt);
    clearTimeout(deadline);
    socket.destroy();
  }
}

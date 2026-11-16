import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { HttpError } from './security.js';

const blockedV4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blockedV4.addSubnet(address, prefix, 'ipv4');

const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const blockedV6 = new BlockList();
for (const [address, prefix] of [
  ['2001::', 23], // Special-purpose space, including Teredo and benchmarking.
  ['2001:db8::', 32],
  ['2002::', 16], // 6to4 embeds an IPv4 destination.
  ['3fff::', 20],
] as const)
  blockedV6.addSubnet(address, prefix, 'ipv6');

/** Conservative global-unicast policy: mapped, transition and local addresses are excluded. */
export function isPublicDownloadAddress(address: string) {
  if (address.includes('%')) return false;
  const family = isIP(address);
  if (family === 4) return !blockedV4.check(address, 'ipv4');
  return family === 6 && globalV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6');
}

export function validateRemoteUrl(value: string, allowedHosts: readonly string[]) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(502, 'The demo source has an invalid download address.');
  }
  if (
    value.length > 4096 ||
    url.protocol !== 'https:' ||
    (url.port && url.port !== '443') ||
    url.username ||
    url.password ||
    url.hash ||
    isIP(url.hostname) ||
    !allowedHosts.some((host) => host.toLowerCase() === url.hostname) ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname)
  )
    throw new HttpError(502, 'The demo source uses an unsupported download host.');
  return url;
}

type Address = { address: string; family: number };
export type DownloadLookup = (hostname: string) => Promise<Address[]>;

export async function resolveRemoteAddress(
  url: URL,
  resolver: DownloadLookup = (hostname) => lookup(hostname, { all: true, verbatim: true }),
) {
  let addresses: Address[];
  try {
    addresses = await resolver(url.hostname);
  } catch {
    throw new HttpError(502, 'The demo source could not be resolved.');
  }
  // Reject mixed public/private answers rather than selecting only the public answer.
  if (
    !addresses.length ||
    addresses.some(
      ({ address, family }) => !isPublicDownloadAddress(address) || isIP(address) !== family,
    )
  )
    throw new HttpError(502, 'The demo source resolved to a restricted network address.');
  return addresses[0];
}

type Request = (
  url: URL,
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => Pick<ClientRequest, 'on' | 'end' | 'destroy'>;
export type RemoteDownloadOptions = {
  allowedHosts: readonly string[];
  maxBytes: number;
  signal: AbortSignal;
  sha256?: string;
};

async function abortable<T>(promise: Promise<T>, signal: AbortSignal) {
  signal.throwIfAborted();
  let rejectAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(signal.reason);
    signal.addEventListener('abort', rejectAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', rejectAbort);
  }
}

/**
 * Downloads an already-authorized resource. Never pass an arbitrary client URL here.
 * DNS is checked once and pinned on this request; TLS still verifies the original hostname.
 */
export async function downloadRemoteDemo(
  value: string,
  destination: string,
  options: RemoteDownloadOptions,
  dependencies: { lookup?: DownloadLookup; request?: Request } = {},
) {
  const url = validateRemoteUrl(value, options.allowedHosts);
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0)
    throw new Error('A positive download byte limit is required.');
  if (options.sha256 && !/^[a-f0-9]{64}$/i.test(options.sha256))
    throw new Error('Invalid expected SHA-256 digest.');
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(180000)]);
  signal.throwIfAborted();
  const address = await abortable(resolveRemoteAddress(url, dependencies.lookup), signal);
  signal.throwIfAborted();
  let bytes = 0;
  const hash = createHash('sha256');
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = (dependencies.request ?? httpsRequest)(
      url,
      {
        agent: false,
        family: address.family,
        signal,
        headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'cswatch/1 demo-import' },
        // autoSelectFamily is disabled by an explicit family. No second DNS lookup is possible.
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      },
      resolve,
    );
    request.on('error', reject);
    request.end();
  });
  if (response.statusCode !== 200) {
    response.destroy();
    throw new HttpError(502, 'The demo source did not return a downloadable file.');
  }
  const encoding = response.headers['content-encoding'];
  const length = response.headers['content-length'];
  if (encoding && encoding !== 'identity') {
    response.destroy();
    throw new HttpError(502, 'The demo source returned an unsupported transfer encoding.');
  }
  if (length && (!/^\d+$/.test(length) || Number(length) > options.maxBytes)) {
    response.destroy();
    throw new HttpError(413, 'Demo exceeds the upload limit.');
  }
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      if (bytes > options.maxBytes) callback(new HttpError(413, 'Demo exceeds the upload limit.'));
      else {
        hash.update(chunk);
        callback(null, chunk);
      }
    },
  });
  await pipeline(response, limiter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }), {
    signal,
  });
  if (!bytes || (length && bytes !== Number(length)))
    throw new HttpError(502, 'The demo download was incomplete.');
  if (options.sha256 && hash.digest('hex') !== options.sha256.toLowerCase())
    throw new HttpError(502, 'The demo did not match the expected checksum.');
  return { bytes };
}

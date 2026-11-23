import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { HttpError } from './errors.js';

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

type SteamReplayFile = { outcome_id: string; token: number };

/** Only the coordinator-supplied, code-bound Valve object may use plain HTTP. */
export function validateSteamReplayUrl(value: string, expected: SteamReplayFile) {
  const parts =
    value.length <= 128 &&
    /^https?:\/\/replay[0-9]{1,3}\.valve\.net\/730\/([0-9]{21})_([0-9]{10})\.dem\.bz2$/.exec(value);
  if (
    !parts ||
    parts[0] !== value ||
    parts[1] !== expected.outcome_id.padStart(21, '0') ||
    Number(parts[2]) > 0xffffffff ||
    Number(parts[2]) % 65536 !== expected.token
  )
    throw new HttpError(502, 'Steam could not confirm the replay for this match.');
  return new URL(value);
}

type Address = { address: string; family: number };
type DownloadLookup = (hostname: string) => Promise<Address[]>;
class DownloadNetworkFailure extends HttpError {}

const networkErrors = new Set([
  'EAI_AGAIN',
  'EAI_FAIL',
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EPROTO',
  'ERR_STREAM_PREMATURE_CLOSE',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
]);
function networkError(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return (
    error instanceof DownloadNetworkFailure ||
    Boolean(
      code &&
      (networkErrors.has(code) || code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_')),
    )
  );
}

export async function resolveRemoteAddress(
  url: URL,
  resolver: DownloadLookup = (hostname) => lookup(hostname, { all: true, verbatim: true }),
) {
  let addresses: Address[];
  try {
    addresses = await resolver(url.hostname);
  } catch (error) {
    const Failure = networkError(error) ? DownloadNetworkFailure : HttpError;
    throw new Failure(502, 'The demo source could not be resolved.');
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
type DownloadDependencies = { lookup?: DownloadLookup; request?: Request };
type TransferOptions = {
  onResponse?: (status: number, retryAfter?: string | null) => void;
  onNetworkFailure?: () => void;
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
  options: TransferOptions & { allowedHosts: readonly string[] },
  dependencies: DownloadDependencies = {},
) {
  return transfer(
    validateRemoteUrl(value, options.allowedHosts),
    destination,
    options,
    dependencies,
    false,
  );
}

export async function downloadSteamReplay(
  value: string,
  destination: string,
  options: TransferOptions & { expected: SteamReplayFile },
  dependencies: DownloadDependencies = {},
) {
  return transfer(
    validateSteamReplayUrl(value, options.expected),
    destination,
    options,
    dependencies,
    true,
  );
}

async function transfer(
  url: URL,
  destination: string,
  options: TransferOptions,
  dependencies: DownloadDependencies,
  steam: boolean,
) {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0)
    throw new Error('A positive download byte limit is required.');
  if (options.sha256 && !/^[a-f0-9]{64}$/i.test(options.sha256))
    throw new Error('Invalid expected SHA-256 digest.');
  const deadline = AbortSignal.timeout(180000);
  const signal = AbortSignal.any([options.signal, deadline]);
  function reportFailure(error: unknown): never {
    if (!options.signal.aborted && (deadline.aborted || networkError(error)))
      options.onNetworkFailure?.();
    throw error;
  }
  signal.throwIfAborted();
  const address = await abortable(resolveRemoteAddress(url, dependencies.lookup), signal).catch(
    reportFailure,
  );
  signal.throwIfAborted();
  let bytes = 0;
  const hash = createHash('sha256');
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = (
      dependencies.request ?? (url.protocol === 'https:' ? httpsRequest : httpRequest)
    )(
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
  }).catch(reportFailure);
  try {
    if (steam) {
      const peer = response.socket?.remoteAddress;
      const pinned = new BlockList();
      const family = address.family === 6 ? 'ipv6' : 'ipv4';
      pinned.addAddress(address.address, family);
      if (
        !peer ||
        !isPublicDownloadAddress(peer) ||
        isIP(peer) !== address.family ||
        !pinned.check(peer, family)
      )
        throw new HttpError(502, 'The demo source resolved to a restricted network address.');
    }
    options.onResponse?.(response.statusCode ?? 0, response.headers['retry-after']);
  } catch (error) {
    response.destroy();
    throw error;
  }
  if (response.statusCode !== 200) {
    const unavailable = [401, 403, 404, 410].includes(response.statusCode ?? 0);
    response.destroy();
    if (steam && (response.statusCode === 429 || response.statusCode === 503))
      throw new HttpError(
        response.statusCode,
        'Steam is temporarily unavailable or limiting requests. Try again later.',
      );
    if (unavailable)
      throw new HttpError(
        steam ? 404 : 502,
        'The demo download is unavailable or has expired. Try again or upload manually.',
        undefined,
        steam ? 'steam_no_demo' : undefined,
      );
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
  }).catch(reportFailure);
  if (length && bytes !== Number(length))
    reportFailure(new DownloadNetworkFailure(502, 'The demo download was incomplete.'));
  if (!bytes) throw new HttpError(502, 'The demo download was incomplete.');
  if (options.sha256 && hash.digest('hex') !== options.sha256.toLowerCase())
    throw new HttpError(502, 'The demo did not match the expected checksum.');
  return { bytes };
}

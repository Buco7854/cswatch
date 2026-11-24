import { BlockList, isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import type { AdminAddressIssue, AdminNetworkDiagnostic } from '../../shared/admin-network.js';
import type { Config } from './config.js';

export function canonicalAddress(text: string) {
  if (text.includes('%')) return null;
  const family = isIP(text);
  if (family === 4) return { ip: text, family: 'ipv4' as const, mapped: false };
  if (family !== 6) return null;
  const ip = new URL('http://[' + text + ']').hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(ip);
  if (!mapped) return { ip, family: 'ipv6' as const, mapped: false };
  const bytes = mapped.slice(1).flatMap((pair) => {
    const value = parseInt(pair, 16);
    return [value >>> 8, value & 255];
  });
  return { ip: bytes.join('.'), family: 'ipv4' as const, mapped: true };
}

function networks(entries: readonly string[], setting: string) {
  const result = { ipv4: new BlockList(), ipv6: new BlockList() };
  for (const entry of entries) {
    const [literal, prefix, extra] = entry.split('/');
    const parsed = canonicalAddress(literal);
    if (
      !parsed ||
      extra !== undefined ||
      (prefix !== undefined && !/^(0|[1-9]\d{0,2})$/.test(prefix))
    )
      throw Error(setting + ' requires comma-separated IP addresses or CIDRs.');
    const width = parsed.family === 'ipv4' ? 32 : 128;
    const bits = prefix === undefined ? width : Number(prefix) - (parsed.mapped ? 96 : 0);
    if (bits < 0 || bits > width) throw Error(setting + ' has an invalid CIDR prefix.');
    result[parsed.family].addSubnet(parsed.ip, bits, parsed.family);
  }
  return result;
}

export function configuredNetworks(value: string | undefined, setting: string) {
  if (!value?.trim()) return [];
  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.length > 256) throw Error(setting + ' allows up to 256 entries.');
  networks(entries, setting);
  return entries;
}

type NetworkSet = ReturnType<typeof networks>;
type NetworkPolicy = { allowed: NetworkSet; proxies: NetworkSet };
const policies = new WeakMap<Config, NetworkPolicy>();
type HostAddress = NonNullable<ReturnType<typeof canonicalAddress>>;
const contains = (list: NetworkSet, host: HostAddress) =>
  list[host.family].check(host.ip, host.family);

function networkPolicy(config: Config) {
  let policy = policies.get(config);
  if (!policy) {
    policy = {
      allowed: networks(config.adminAllowedIps, 'ADMIN_ALLOWED_IPS'),
      proxies: networks(
        Array.isArray(config.trustProxy) ? config.trustProxy : [],
        'TRUSTED_PROXY_IPS',
      ),
    };
    policies.set(config, policy);
  }
  return policy;
}

export function trustProxyAddress(config: Config, ip: string) {
  const host = canonicalAddress(ip);
  return host !== null && contains(networkPolicy(config).proxies, host);
}

const forwardingHeader = (name: string) =>
  /^(?:forwarded$|x-forwarded-|x-real-ip$|cf-connecting-ip$|true-client-ip$|x-client-ip$)/i.test(
    name,
  );

function resolveAddress(
  request: FastifyRequest,
  config: Config,
): { connection: HostAddress | null; client: HostAddress | null; issue?: AdminAddressIssue } {
  const socketIp = request.raw.socket.remoteAddress;
  const connection = socketIp ? canonicalAddress(socketIp) : null;
  const unknown = (issue: AdminAddressIssue) => ({ connection, client: null, issue });
  if (!connection) return unknown('socket_unavailable');
  const headers = request.headers;
  if (!Object.keys(headers).some(forwardingHeader)) return { connection, client: connection };
  const { proxies } = networkPolicy(config);
  if (!contains(proxies, connection)) return unknown('untrusted_proxy');
  const seen = new Set<string>();
  const rawHeaders = request.raw.rawHeaders;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i].toLowerCase();
    if (!forwardingHeader(name)) continue;
    if (seen.has(name)) return unknown('duplicate_header');
    seen.add(name);
  }
  if (
    ['forwarded', 'cf-connecting-ip', 'true-client-ip', 'x-client-ip'].some(
      (name) => headers[name] !== undefined,
    )
  )
    return unknown('unsupported_header');
  const real = headers['x-real-ip'];
  const forwarded = headers['x-forwarded-for'] ?? real;
  if (forwarded === undefined) return unknown('missing_address');
  if (typeof forwarded !== 'string' || forwarded.length > 2048) return unknown('invalid_address');
  const chain = forwarded.split(',');
  if (chain.length > 32) return unknown('invalid_address');
  let client = connection;
  for (let i = chain.length - 1; i >= 0; i--) {
    const hop = canonicalAddress(chain[i].trim());
    if (!hop) return unknown('invalid_address');
    if (contains(proxies, client)) client = hop;
  }
  if (real !== undefined) {
    const realIp = typeof real === 'string' && canonicalAddress(real);
    if (!realIp) return unknown('invalid_address');
    if (realIp.ip !== client.ip) return unknown('conflicting_addresses');
  }
  return { connection, client };
}

export function adminClientAddress(request: FastifyRequest, config: Config) {
  return resolveAddress(request, config).client;
}

export function adminNetworkDenial(request: FastifyRequest, config: Config) {
  if (!config.adminAllowedIps.length) return null;
  const { connection, client, issue } = resolveAddress(request, config);
  if (client && contains(networkPolicy(config).allowed, client)) return null;
  const diagnostic: AdminNetworkDiagnostic = {
    connection: connection?.ip ?? null,
    client: client?.ip ?? null,
    ...(issue && { issue }),
  };
  return {
    reason: client ? ('outside_network' as const) : ('unknown_client' as const),
    diagnostic,
  };
}

export function adminNetworkAllowed(request: FastifyRequest, config: Config) {
  return adminNetworkDenial(request, config) === null;
}

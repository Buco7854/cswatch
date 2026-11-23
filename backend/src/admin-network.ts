import { BlockList, isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
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

export function adminClientAddress(request: FastifyRequest, config: Config) {
  const { proxies } = networkPolicy(config);
  const socketIp = request.raw.socket.remoteAddress;
  let peer = socketIp && canonicalAddress(socketIp);
  if (!peer) return null;
  const headers = request.headers;
  const forwardedName = (name: string) =>
    /^(?:forwarded$|x-forwarded-|x-real-ip$|cf-connecting-ip$|true-client-ip$|x-client-ip$)/i.test(
      name,
    );
  if (!contains(proxies, peer)) return Object.keys(headers).some(forwardedName) ? null : peer;
  const real = headers['x-real-ip'];
  // A trusted single-hop proxy can overwrite X-Real-IP instead of sending a chain.
  const forwarded = headers['x-forwarded-for'] ?? real;
  const forwardingHeaders = new Set<string>();
  const rawHeaders = request.raw.rawHeaders;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i].toLowerCase();
    if (!forwardedName(name)) continue;
    if (forwardingHeaders.has(name)) return null;
    forwardingHeaders.add(name);
  }
  if (
    typeof forwarded !== 'string' ||
    forwarded.length > 2048 ||
    headers.forwarded !== undefined ||
    headers['cf-connecting-ip'] !== undefined ||
    headers['true-client-ip'] !== undefined ||
    headers['x-client-ip'] !== undefined
  )
    return null;
  const chain = forwarded.split(',').map((item) => canonicalAddress(item.trim()));
  if (chain.length > 32 || chain.some((item) => !item)) return null;
  for (let i = chain.length - 1; i >= 0 && contains(proxies, peer); i--) peer = chain[i]!;
  // Every hop is trusted infrastructure: there is no distinct client address.
  if (contains(proxies, peer)) return null;
  if (real !== undefined && (typeof real !== 'string' || canonicalAddress(real)?.ip !== peer.ip))
    return null;
  return peer;
}

export function adminNetworkDenial(request: FastifyRequest, config: Config) {
  if (!config.adminAllowedIps.length) return null;
  const client = adminClientAddress(request, config);
  if (!client) return 'unknown_client';
  return contains(networkPolicy(config).allowed, client) ? null : 'outside_network';
}

export function adminNetworkAllowed(request: FastifyRequest, config: Config) {
  return adminNetworkDenial(request, config) === null;
}

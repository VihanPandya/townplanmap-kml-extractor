/**
 * SSRF defences.
 *
 * The tool takes URLs discovered inside third-party HTML and JavaScript and
 * fetches them server-side, which is exactly the shape of a classic SSRF. Every
 * URL crosses this module before a socket is opened, and it is applied again to
 * each redirect hop rather than only to the URL the caller supplied.
 */

import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/** Only these two schemes ever reach the network. */
const ALLOWED_PROTOCOLS = new Set(['https:', 'http:']);

/**
 * Hostnames that resolve to the host itself or to well-known link-local
 * metadata services. Blocked by name as well as by resolved address, so a
 * CNAME to `localhost` is rejected before DNS is consulted.
 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
]);

/** Suffixes that denote host-local or cluster-internal namespaces. */
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.svc', '.svc.cluster.local', '.home.arpa'];

export type SsrfRejection = {
  ok: false;
  reason: string;
};

export type SsrfAcceptance = {
  ok: true;
  url: URL;
  /** Addresses the hostname resolved to, already checked. */
  addresses: string[];
};

export type SsrfVerdict = SsrfAcceptance | SsrfRejection;

function reject(reason: string): SsrfRejection {
  return { ok: false, reason };
}

/** Expand an IPv4-mapped/compatible IPv6 address to its embedded IPv4 form. */
function embeddedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (mapped?.[1]) return mapped[1];
  const compat = /^::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (compat?.[1]) return compat[1];
  // ::ffff:c0a8:0001 style
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hexMapped?.[1] && hexMapped[2]) {
    const high = Number.parseInt(hexMapped[1], 16);
    const low = Number.parseInt(hexMapped[2], 16);
    return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
  }
  return null;
}

/**
 * True when an IPv4 address is outside the public unicast range: loopback,
 * RFC1918 private space, link-local (including the 169.254.169.254 cloud
 * metadata address), CGNAT, multicast, broadcast and the reserved blocks.
 */
function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true; // Unparseable: treat as unsafe.
  }
  const [a = 0, b = 0] = parts;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 192 && b === 0) return true; // IETF protocol assignments / 192.0.2.0 TEST-NET
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true; // TEST-NET-2
  if (a === 203 && b === 0) return true; // TEST-NET-3
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/** True when an IPv6 address is loopback, unique-local, link-local or reserved. */
function isPrivateIpv6(address: string): boolean {
  const lower = address.toLowerCase().split('%')[0] ?? '';
  if (lower === '::' || lower === '::1') return true;
  const mapped = embeddedIpv4(lower);
  if (mapped) return isPrivateIpv4(mapped);
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return true; // link-local fe80::/10
  }
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique-local fc00::/7
  if (lower.startsWith('ff')) return true; // multicast
  if (lower.startsWith('2001:db8')) return true; // documentation
  if (lower.startsWith('64:ff9b')) return true; // NAT64 — can wrap private v4
  return false;
}

/** True when the literal address must not be contacted. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true; // Not an IP literal at all: caller should not have passed it.
}

function hostnameIsBlocked(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  return BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Validate a URL and resolve its hostname, rejecting anything that points at
 * the host itself, a private network, or a non-HTTP protocol.
 *
 * DNS resolution happens here and the resolved addresses are returned so the
 * caller can pin the connection to an address that was actually checked, which
 * closes the DNS-rebinding window between validation and connection.
 */
export async function assertSafeUrl(input: string | URL): Promise<SsrfVerdict> {
  let url: URL;
  try {
    url = input instanceof URL ? input : new URL(input);
  } catch {
    return reject('Malformed URL.');
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return reject(
      `Protocol "${url.protocol}" is not permitted. Only http: and https: URLs are fetched.`,
    );
  }

  if (url.username || url.password) {
    return reject('URLs carrying embedded credentials are rejected.');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname) return reject('URL has no host.');
  if (hostnameIsBlocked(hostname)) {
    return reject(`Host "${hostname}" resolves to a host-local or internal namespace.`);
  }

  // An IP literal needs no DNS, but still needs the range check.
  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    if (isBlockedAddress(hostname)) {
      return reject(`Address ${hostname} is in a private, loopback or reserved range.`);
    }
    return { ok: true, url, addresses: [hostname] };
  }

  let resolved: Array<{ address: string; family: number }>;
  try {
    resolved = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    return reject(`Host "${hostname}" could not be resolved.`);
  }

  if (resolved.length === 0) {
    return reject(`Host "${hostname}" resolved to no addresses.`);
  }

  // Every address must be public. If a name resolves to a mix, the safe read is
  // that it is not a legitimate public endpoint.
  for (const entry of resolved) {
    if (isBlockedAddress(entry.address)) {
      return reject(
        `Host "${hostname}" resolves to ${entry.address}, which is in a private, loopback or reserved range.`,
      );
    }
  }

  return { ok: true, url, addresses: resolved.map((entry) => entry.address) };
}

import { describe, expect, it } from 'vitest';
import { assertSafeUrl, isBlockedAddress } from '@/lib/net/ssrf';

describe('isBlockedAddress', () => {
  it('blocks loopback, private, link-local and CGNAT IPv4', () => {
    const blocked = [
      '127.0.0.1',
      '127.1.2.3',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
    ];
    for (const address of blocked) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it('allows public IPv4', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '142.250.183.14']) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it('blocks IPv6 loopback, unique-local and link-local', () => {
    for (const address of ['::1', '::', 'fe80::1', 'fd00::1', 'fc00::1', 'ff02::1']) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it('blocks IPv4-mapped IPv6 that wraps a private address', () => {
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true);
    expect(isBlockedAddress('::ffff:10.0.0.1')).toBe(true);
  });

  it('blocks the hex form of an IPv4-mapped private address', () => {
    // ::ffff:c0a8:0001 is 192.168.0.1
    expect(isBlockedAddress('::ffff:c0a8:0001')).toBe(true);
  });
});

describe('assertSafeUrl', () => {
  it('rejects non-HTTP protocols', async () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com']) {
      const verdict = await assertSafeUrl(url);
      expect(verdict.ok, url).toBe(false);
    }
  });

  it('rejects localhost by name before DNS is consulted', async () => {
    const verdict = await assertSafeUrl('http://localhost:8080/admin');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/host-local|internal/i);
  });

  it('rejects cloud metadata hostnames', async () => {
    const verdict = await assertSafeUrl('http://metadata.google.internal/computeMetadata/v1/');
    expect(verdict.ok).toBe(false);
  });

  it('rejects the cloud metadata IP literal', async () => {
    const verdict = await assertSafeUrl('http://169.254.169.254/latest/meta-data/');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/private, loopback or reserved/i);
  });

  it('rejects a private IP literal', async () => {
    const verdict = await assertSafeUrl('https://10.1.2.3/api');
    expect(verdict.ok).toBe(false);
  });

  it('rejects embedded credentials', async () => {
    const verdict = await assertSafeUrl('https://user:pass@example.com/');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/credentials/i);
  });

  it('rejects internal-looking suffixes', async () => {
    for (const url of ['http://api.internal/x', 'http://db.svc.cluster.local/x', 'http://thing.local/x']) {
      const verdict = await assertSafeUrl(url);
      expect(verdict.ok, url).toBe(false);
    }
  });

  it('rejects a malformed URL', async () => {
    const verdict = await assertSafeUrl('not a url at all');
    expect(verdict.ok).toBe(false);
  });

  it('accepts a public IP literal', async () => {
    const verdict = await assertSafeUrl('https://1.1.1.1/');
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.addresses).toEqual(['1.1.1.1']);
  });
});

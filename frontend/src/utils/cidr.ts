/**
 * CIDR-aware search matching using proper IP arithmetic
 * (mirrors Go's net/netip behaviour)
 *
 * Rules:
 *  - No slash in query  → plain substring match on the CIDR string
 *  - Valid CIDR in query → true if the row's CIDR overlaps the queried CIDR
 *    (i.e. one is a subnet of the other)
 *  - Invalid CIDR with slash → fall back to substring match
 */
export function cidrMatchesSearch(rowCIDR: string, query: string): boolean {
  const q = query.trim();
  if (!q) return true;

  if (!q.includes('/')) {
    return rowCIDR.includes(q);
  }

  try {
    return cidrOverlaps(rowCIDR, q);
  } catch {
    return rowCIDR.includes(q);
  }
}

// ─── IPv4 helpers ─────────────────────────────────────────────────────────────

function ipv4ToU32(addr: string): number {
  const p = addr.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => isNaN(x) || x < 0 || x > 255))
    throw new Error('bad ipv4');
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

// ─── IPv6 helpers ─────────────────────────────────────────────────────────────

function ipv6ToBigInt(addr: string): bigint {
  let a = addr.toLowerCase();
  if (a.includes('::')) {
    const [l, r] = a.split('::');
    const lg = l ? l.split(':') : [];
    const rg = r ? r.split(':') : [];
    const pad = new Array(8 - lg.length - rg.length).fill('0');
    a = [...lg, ...pad, ...rg].join(':');
  }
  const groups = a.split(':');
  if (groups.length !== 8) throw new Error('bad ipv6');
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g || '0', 16)), 0n);
}

// ─── Overlap check ────────────────────────────────────────────────────────────

function cidrOverlaps(a: string, b: string): boolean {
  const [addrA, bA] = a.split('/');
  const [addrB, bB] = b.split('/');
  if (!bA || !bB) throw new Error('no mask');

  const bitsA = parseInt(bA, 10);
  const bitsB = parseInt(bB, 10);

  if (addrA.includes('.')) {
    // IPv4
    const ipA = ipv4ToU32(addrA);
    const ipB = ipv4ToU32(addrB);
    const mA = bitsA === 0 ? 0 : ((~0) << (32 - bitsA)) >>> 0;
    const mB = bitsB === 0 ? 0 : ((~0) << (32 - bitsB)) >>> 0;
    // B inside A, or A inside B
    return (ipB & mA) >>> 0 === (ipA & mA) >>> 0 ||
           (ipA & mB) >>> 0 === (ipB & mB) >>> 0;
  } else {
    // IPv6
    const ipA = ipv6ToBigInt(addrA);
    const ipB = ipv6ToBigInt(addrB);
    const full = (1n << 128n) - 1n;
    const mA = bitsA === 0 ? 0n : full ^ ((1n << BigInt(128 - bitsA)) - 1n);
    const mB = bitsB === 0 ? 0n : full ^ ((1n << BigInt(128 - bitsB)) - 1n);
    return (ipB & mA) === (ipA & mA) || (ipA & mB) === (ipB & mB);
  }
}

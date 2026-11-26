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
  const parts = addr.split('.');
  if (parts.length !== 4 || parts.some((s) => !/^\d+$/.test(s))) {
    throw new Error('bad ipv4');
  }
  const p = parts.map((s) => parseInt(s, 10));
  if (p.some((x) => Number.isNaN(x) || x < 0 || x > 255)) {
    throw new Error('bad ipv4');
  }
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

// ─── IPv6 helpers ─────────────────────────────────────────────────────────────

function ipv6ToBigInt(addr: string): bigint {
  let a = addr.toLowerCase();
  if (a.includes('::')) {
    const dbl = a.split('::');
    if (dbl.length !== 2) throw new Error('bad ipv6');
    const [l, r] = dbl;
    const lg = l ? l.split(':') : [];
    const rg = r ? r.split(':') : [];
    const padLen = 8 - lg.length - rg.length;
    if (padLen < 1) throw new Error('bad ipv6');
    const pad = new Array(padLen).fill('0');
    a = [...lg, ...pad, ...rg].join(':');
  }
  const groups = a.split(':');
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) {
    throw new Error('bad ipv6');
  }
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}

// ─── Overlap check ────────────────────────────────────────────────────────────

function cidrOverlaps(a: string, b: string): boolean {
  const partsA = a.split('/');
  const partsB = b.split('/');
  if (partsA.length !== 2 || partsB.length !== 2) throw new Error('no mask');
  const [addrA, bA] = partsA;
  const [addrB, bB] = partsB;
  if (!/^\d+$/.test(bA) || !/^\d+$/.test(bB)) throw new Error('bad mask');

  const isV4A = addrA.includes('.');
  const isV4B = addrB.includes('.');
  // IPv4 与 IPv6 地址族不同，绝无重叠
  if (isV4A !== isV4B) return false;

  const bitsA = parseInt(bA, 10);
  const bitsB = parseInt(bB, 10);

  if (isV4A) {
    if (bitsA < 0 || bitsA > 32 || bitsB < 0 || bitsB > 32) {
      throw new Error('ipv4 mask out of range');
    }
    const ipA = ipv4ToU32(addrA);
    const ipB = ipv4ToU32(addrB);
    const mA = bitsA === 0 ? 0 : ((~0) << (32 - bitsA)) >>> 0;
    const mB = bitsB === 0 ? 0 : ((~0) << (32 - bitsB)) >>> 0;
    return (ipB & mA) >>> 0 === (ipA & mA) >>> 0 ||
           (ipA & mB) >>> 0 === (ipB & mB) >>> 0;
  } else {
    if (bitsA < 0 || bitsA > 128 || bitsB < 0 || bitsB > 128) {
      throw new Error('ipv6 mask out of range');
    }
    const ipA = ipv6ToBigInt(addrA);
    const ipB = ipv6ToBigInt(addrB);
    const full = (1n << 128n) - 1n;
    const mA = bitsA === 0 ? 0n : full ^ ((1n << BigInt(128 - bitsA)) - 1n);
    const mB = bitsB === 0 ? 0n : full ^ ((1n << BigInt(128 - bitsB)) - 1n);
    return (ipB & mA) === (ipA & mA) || (ipA & mB) === (ipB & mB);
  }
}

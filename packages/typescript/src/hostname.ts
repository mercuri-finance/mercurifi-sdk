/**
 * One hostname rule for links (safeView.ts), mirrored by Python's `safe_view._host_ok`: printable ASCII only, so an
 * internationalised name must arrive in its punycode `xn--` form (no homoglyph can pass as another host).
 */

const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const NUMERIC_TAIL = /^(?:[0-9]+|0[xX][0-9A-Fa-f]*)$/;
const IPV4_PART = /^(?:0|[1-9][0-9]{0,2})$/;

/** RFC 3492 decode of the part after `xn--`; null when it is not valid punycode. */
export const punycodeDecode = (input: string): string | null => {
  const base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700;
  if (!/^[A-Za-z0-9-]*$/.test(input)) return null;
  const cut = input.lastIndexOf('-');
  const out: number[] = cut > 0 ? Array.from(input.slice(0, cut), (c) => c.charCodeAt(0)) : [];
  let n = 128, i = 0, bias = 72;
  const adapt = (delta: number, points: number, first: boolean): number => {
    let d = first ? Math.floor(delta / damp) : delta >> 1;
    d += Math.floor(d / points);
    let k = 0;
    while (d > ((base - tMin) * tMax) >> 1) {
      d = Math.floor(d / (base - tMin));
      k += base;
    }
    return k + Math.floor(((base - tMin + 1) * d) / (d + skew));
  };
  const digit = (c: number): number => (c - 48 < 10 ? c - 22 : c - 65 < 26 ? c - 65 : c - 97 < 26 ? c - 97 : base);
  for (let p = cut > 0 ? cut + 1 : 0; p < input.length;) {
    const oldi = i;
    for (let w = 1, k = base; ; k += base) {
      if (p >= input.length) return null;
      const d = digit(input.charCodeAt(p++));
      if (d >= base || d > Math.floor((0x7fffffff - i) / w)) return null;
      i += d * w;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (d < t) break;
      if (w > Math.floor(0x7fffffff / (base - t))) return null;
      w *= base - t;
    }
    const len = out.length + 1;
    bias = adapt(i - oldi, len, oldi === 0);
    if (Math.floor(i / len) > 0x10ffff - n) return null;
    n += Math.floor(i / len);
    i %= len;
    if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return null;
    out.splice(i, 0, n);
    i += 1;
  }
  return String.fromCodePoint(...out);
};

/** A punycode label must decode to a name of letters, marks, digits and hyphens with at least one non-ASCII character. */
const punycodeLabelOk = (label: string): boolean => {
  if (!/^xn--/i.test(label)) return true;
  const decoded = punycodeDecode(label.slice(4));
  return decoded !== null && decoded !== '' && /[^\x00-\x7f]/.test(decoded) && /^[\p{L}\p{M}\p{N}-]+$/u.test(decoded) && decoded.normalize('NFC') === decoded;
};

/**
 * `host[:port]` of a link: DNS labels of letters, digits and inner hyphens (at most 63 each, 253 in all, an optional
 * final dot), valid punycode for `xn--` labels, a dotted-quad IPv4 (no leading zeros) when the last label is numeric,
 * and a port of at most 65535. No IPv6 literal, no percent sign, no non-ASCII character.
 */
export const linkAuthorityOk = (authority: string): boolean => {
  const m = /^([^:]*)(?::([0-9]{0,5}))?$/.exec(authority);
  if (m === null) return false;
  const host = m[1]!;
  if (m[2] !== undefined && m[2] !== '' && Number(m[2]) > 65535) return false;
  if (host === '' || host.length > 254) return false;
  const bare = host.endsWith('.') ? host.slice(0, -1) : host;
  if (bare === '' || bare.length > 253) return false;
  const labels = bare.split('.');
  if (!labels.every((l) => LABEL.test(l))) return false;
  if (NUMERIC_TAIL.test(labels[labels.length - 1]!)) {
    return labels.length === 4 && labels.every((l) => IPV4_PART.test(l) && Number(l) <= 255);
  }
  return labels.every(punycodeLabelOk);
};

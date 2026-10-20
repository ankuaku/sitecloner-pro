// SSRF protection: blocks requests to private / internal network addresses.
import dns from 'node:dns/promises';
import net from 'node:net';

function ipv4Private(ip) {
  const p = ip.split('.').map(Number);
  return (
    p[0] === 10 || p[0] === 127 || p[0] === 0 ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    p[0] >= 224
  );
}

function ipPrivate(ip) {
  if (net.isIPv4(ip)) return ipv4Private(ip);
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return ipv4Private(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

const cache = new Map();

export async function assertPublicUrl(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { throw new Error('Invalid URL'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http/https URLs are allowed');
  if (process.env.ALLOW_PRIVATE_NETWORK === 'true') return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new Error('Private / internal addresses are not allowed');
  }
  let ok = cache.get(host);
  if (ok === undefined) {
    const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
    if (!addrs.length) throw new Error(`Could not resolve host: ${host}`);
    ok = addrs.every(a => !ipPrivate(a.address));
    cache.set(host, ok);
    if (cache.size > 5000) cache.clear();
  }
  if (!ok) throw new Error('Private / internal addresses are not allowed');
  return u;
}

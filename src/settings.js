// Settings + stats stored in data/settings.json (editable from the admin panel).
import fs from 'node:fs';
import path from 'node:path';

const FILE = path.resolve('data/settings.json');

export const DEFAULTS = {
  siteName: 'SiteCloner Pro',
  tagline: 'Paste a URL and get the complete frontend — exact UI, every asset, working offline.',
  primaryColor: '#5b5bf0',
  logoText: 'SC',
  maxPagesLimit: 10,          // highest "pages" value a visitor can choose
  maxSizeMb: 120,              // max total download per clone
  maxAssets: 600,
  timeoutSec: 180,
  clonesPerHour: 10,          // per IP
  allowRender: true,          // real-browser engine (needs puppeteer)
  keepZipMinutes: 30,
  maintenance: false,
  adHeader: '',               // raw HTML (e.g. AdSense) shown above the tool
  adFooter: '',               // raw HTML shown below results
  headCode: '',               // analytics etc. injected in <head>
  footerText: '© SiteCloner Pro',
  termsText: 'Only clone websites you own or have permission to copy. You are responsible for how you use cloned content.',
  blockedDomains: '',         // one per line
};

let cache = null;

export function getSettings() {
  if (cache) return cache;
  try { cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')).settings }; }
  catch { cache = { ...DEFAULTS }; }
  return cache;
}

export function getStats() {
  try { return { totalClones: 0, failedClones: 0, lastClones: [], ...JSON.parse(fs.readFileSync(FILE, 'utf8')).stats }; }
  catch { return { totalClones: 0, failedClones: 0, lastClones: [] }; }
}

function save(settings, stats) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ settings, stats }, null, 2));
}

export function updateSettings(patch) {
  const cur = getSettings();
  const next = { ...cur };
  for (const [k, def] of Object.entries(DEFAULTS)) {
    if (!(k in patch)) continue;
    const v = patch[k];
    if (typeof def === 'number') { const n = Number(v); if (Number.isFinite(n) && n >= 0) next[k] = n; }
    else if (typeof def === 'boolean') next[k] = v === true || v === 'true' || v === 'on';
    else next[k] = String(v ?? '').slice(0, 20000);
  }
  cache = next;
  save(next, getStats());
  return next;
}

export function recordClone(entry) {
  const stats = getStats();
  if (entry.ok) stats.totalClones++; else stats.failedClones++;
  stats.lastClones = [entry, ...stats.lastClones].slice(0, 50);
  save(getSettings(), stats);
}

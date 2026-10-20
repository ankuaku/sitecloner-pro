import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CloneJob } from './src/cloner.js';
import { getSettings, getStats, updateSettings, recordClone } from './src/settings.js';
import { loadPuppeteer } from './src/browser.js';

const browserInstalled = !!(await loadPuppeteer());
if (!browserInstalled) console.warn('⚠  Browser engine (puppeteer) not installed — only the fast engine is available. Run: npm i puppeteer');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 2);
const WORK = path.resolve('downloads');
const PUBLIC = path.resolve('public');
fs.mkdirSync(WORK, { recursive: true });

if (ADMIN_PASSWORD === 'admin123') console.warn('⚠  Using default admin password. Set ADMIN_PASSWORD in .env before going live.');

const app = express();
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser(SECRET));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ---------------- jobs ----------------
const jobs = new Map();
const waiting = [];
let running = 0;

function pump() {
  while (running < MAX_CONCURRENT && waiting.length) {
    const job = waiting.shift();
    running++;
    job.run().finally(() => {
      running--;
      recordClone({ url: job.url, ok: job.status === 'done', pages: job.progress.pages, assets: job.progress.assets,
        error: job.error, ip: job.ip, at: new Date().toISOString() });
      pump();
    });
  }
  waiting.forEach((j, i) => { j.status = 'queued'; j.log = [`Waiting in queue (position ${i + 1})`]; });
}

setInterval(() => {
  const ttl = getSettings().keepZipMinutes * 60000;
  for (const [id, job] of jobs) {
    if (Date.now() - job.createdAt > ttl && !['running', 'zipping'].includes(job.status)) {
      fs.rm(job.zipPath, { force: true }, () => {});
      jobs.delete(id);
    }
  }
}, 60000).unref();

// ---------------- pages ----------------
function sendPage(file) {
  return (req, res) => {
    const s = getSettings();
    let html = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
    html = html.replace('<!--HEAD_CODE-->', s.headCode || '')
      .replaceAll('{{SITE_NAME}}', escapeHtml(s.siteName))
      .replaceAll('{{PRIMARY}}', /^#[0-9a-f]{3,8}$/i.test(s.primaryColor) ? s.primaryColor : '#5b5bf0');
    res.type('html').send(html);
  };
}
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

app.get('/', sendPage('index.html'));
app.get('/admin', sendPage('admin.html'));
app.use('/static', express.static(path.join(PUBLIC, 'static'), { maxAge: '7d' }));

// ---------------- public API ----------------
app.get('/api/config', (req, res) => {
  const s = getSettings();
  res.json({
    siteName: s.siteName, tagline: s.tagline, primaryColor: s.primaryColor, logoText: s.logoText,
    maxPagesLimit: s.maxPagesLimit, browser: s.allowRender && browserInstalled, maintenance: s.maintenance,
    adHeader: s.adHeader, adFooter: s.adFooter, footerText: s.footerText, termsText: s.termsText,
  });
});

const cloneLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: () => Math.max(1, getSettings().clonesPerHour),
  standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Hourly clone limit reached. Please try again later.' },
  skip: req => isAdmin(req),
});

app.post('/api/clone', cloneLimiter, (req, res) => {
  const s = getSettings();
  if (s.maintenance && !isAdmin(req)) return res.status(503).json({ error: 'The service is under maintenance. Please try later.' });
  const { url, pages, includeJs, includeMedia, engine, output, agree } = req.body || {};
  if (!agree) return res.status(400).json({ error: 'Please accept the terms first.' });
  let target;
  try {
    target = new URL(/^https?:\/\//i.test(String(url).trim()) ? String(url).trim() : `https://${String(url).trim()}`);
  } catch { return res.status(400).json({ error: 'Please enter a valid URL.' }); }
  const blocked = s.blockedDomains.split(/\s+/).map(d => d.trim().toLowerCase()).filter(Boolean);
  const host = target.hostname.toLowerCase();
  if (blocked.some(d => host === d || host.endsWith('.' + d))) return res.status(403).json({ error: 'This domain cannot be cloned.' });
  if (waiting.length > 50) return res.status(503).json({ error: 'Server is busy. Please try again in a minute.' });

  const id = crypto.randomBytes(12).toString('hex');
  const job = new CloneJob(id, target.href, {
    maxPages: Math.min(Math.max(1, Number(pages) || 1), s.maxPagesLimit),
    engine: engine === 'fast' || !s.allowRender || !browserInstalled ? 'fast' : 'browser',
    output: ['static', 'interactive', 'both'].includes(output) ? output : 'both',
    includeJs: includeJs !== false,
    includeMedia: !!includeMedia,
    maxAssets: s.maxAssets,
    maxBytes: s.maxSizeMb * 1024 * 1024,
    timeoutMs: s.timeoutSec * 1000,
  }, WORK);
  job.ip = req.ip;
  jobs.set(id, job);
  waiting.push(job);
  pump();
  res.json({ id });
});

app.get('/api/clone/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found or expired.' });
  res.json(job.toJSON());
});

app.get('/api/clone/:id/download', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done' || !fs.existsSync(job.zipPath)) return res.status(404).send('File expired or not ready.');
  const name = new URL(job.url).hostname.replace(/^www\./, '').replace(/[^a-z0-9.-]/gi, '_');
  res.download(job.zipPath, `${name}-clone.zip`);
});

// ---------------- admin ----------------
const adminToken = () => crypto.createHmac('sha256', SECRET).update('admin:' + ADMIN_PASSWORD).digest('hex');
function isAdmin(req) {
  const t = req.signedCookies?.sc_admin;
  return !!t && t.length === adminToken().length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(adminToken()));
}
const requireAdmin = (req, res, next) => isAdmin(req) ? next() : res.status(401).json({ error: 'Login required' });

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, message: { error: 'Too many attempts. Try again in 15 minutes.' } });
app.post('/api/admin/login', loginLimiter, (req, res) => {
  const pw = String(req.body?.password || '');
  const ok = pw.length === ADMIN_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(ADMIN_PASSWORD));
  if (!ok) return res.status(401).json({ error: 'Wrong password' });
  res.cookie('sc_admin', adminToken(), { signed: true, httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: 7 * 864e5 });
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => { res.clearCookie('sc_admin'); res.json({ ok: true }); });
app.get('/api/admin/me', (req, res) => res.json({ admin: isAdmin(req) }));
app.get('/api/admin/settings', requireAdmin, (req, res) => res.json(getSettings()));
app.post('/api/admin/settings', requireAdmin, (req, res) => res.json(updateSettings(req.body || {})));
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  res.json({ ...getStats(), running, queued: waiting.length, activeJobs: jobs.size, puppeteerInstalled: browserInstalled, version: '1.1.0' });
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Server error' }); });

app.listen(PORT, () => console.log(`SiteCloner Pro running on http://localhost:${PORT}`));

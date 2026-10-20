import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import AdmZip from 'adm-zip';
import { CloneJob } from './src/cloner.js';
import { AIJob } from './src/aijob.js';
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
const PUB = path.resolve('data/published');       // published websites live here (needs a persistent disk)
const PUB_INDEX = path.resolve('data/published.json');
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(PUB, { recursive: true });

const readPublished = () => { try { return JSON.parse(fs.readFileSync(PUB_INDEX, 'utf8')); } catch { return []; } };
const writePublished = list => { try { fs.writeFileSync(PUB_INDEX, JSON.stringify(list, null, 2)); } catch {} };

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
      fs.rm(job.workDir, { recursive: true, force: true }, () => {});
      jobs.delete(id);
    }
  }
}, 60000).unref();

// ---------------- pages ----------------
// Changes on every restart (i.e. every deploy), so browsers always fetch fresh CSS/JS.
const BUILD = Date.now().toString(36);
function sendPage(file) {
  return (req, res) => {
    const s = getSettings();
    let html = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
    html = html.replace('<!--HEAD_CODE-->', s.headCode || '')
      .replaceAll('{{SITE_NAME}}', escapeHtml(s.siteName))
      .replaceAll('{{PRIMARY}}', /^#[0-9a-f]{3,8}$/i.test(s.primaryColor) ? s.primaryColor : '#5b5bf0')
      .replace(/(\/static\/(?:app\.js|style\.css))/g, `$1?v=${BUILD}`);
    res.set('Cache-Control', 'no-cache');
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
    fullSite: s.allowFullSite,
    fullSitePagesLimit: s.fullSitePagesLimit, fullSiteDepthLimit: s.fullSiteDepthLimit,
    publish: s.allowPublish && !s.publishAdminOnly,  // visitor-facing publish button
    publishAny: s.allowPublish, maxZipMb: s.maxZipMb,
    aiMerge: s.allowAiMerge && !!s.aiApiKey && !s.aiMergeAdminOnly,
    aiMergeAny: s.allowAiMerge && !!s.aiApiKey,
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
  const { url, pages, includeJs, includeMedia, engine, output, crawl, depth, agree } = req.body || {};
  if (!agree) return res.status(400).json({ error: 'Please accept the terms first.' });
  let target;
  try {
    target = new URL(/^https?:\/\//i.test(String(url).trim()) ? String(url).trim() : `https://${String(url).trim()}`);
  } catch { return res.status(400).json({ error: 'Please enter a valid URL.' }); }
  const blocked = s.blockedDomains.split(/\s+/).map(d => d.trim().toLowerCase()).filter(Boolean);
  const host = target.hostname.toLowerCase();
  if (blocked.some(d => host === d || host.endsWith('.' + d))) return res.status(403).json({ error: 'This domain cannot be cloned.' });
  if (waiting.length > 50) return res.status(503).json({ error: 'Server is busy. Please try again in a minute.' });

  const useBrowser = engine !== 'fast' && s.allowRender && browserInstalled;
  const fullSite = crawl === 'full' && s.allowFullSite;
  const id = crypto.randomBytes(12).toString('hex');
  const job = new CloneJob(id, target.href, {
    maxPages: Math.min(Math.max(1, Number(pages) || 1), s.maxPagesLimit),
    engine: useBrowser ? 'browser' : 'fast',
    crawl: fullSite ? 'full' : 'single',
    maxSitePages: s.fullSitePagesLimit,
    maxDepth: Math.min(Math.max(1, Number(depth) || s.fullSiteDepthLimit), s.fullSiteDepthLimit),
    respectRobots: s.respectRobots,
    politenessMs: s.politenessMs,
    flaresolverrUrl: (s.flaresolverrUrl || process.env.FLARESOLVERR_URL || '').trim(),
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

// Resolve a clone's files from disk by id, so download/preview still work if the
// in-memory job record was dropped (e.g. cleanup) but the files are still present.
function zipPathFor(id) { return path.join(WORK, id + '.zip'); }
function staticDirFor(id) {
  const site = path.join(WORK, id, 'site');
  const withStatic = path.join(site, 'static');
  if (fs.existsSync(withStatic)) return withStatic;
  if (fs.existsSync(site)) return site;
  return null;
}

app.get('/api/clone/:id/download', (req, res) => {
  const id = req.params.id;
  if (!/^[a-f0-9]+$/.test(id)) return res.status(400).send('Bad id.');
  const job = jobs.get(id);
  const zip = job?.zipPath && fs.existsSync(job.zipPath) ? job.zipPath : (fs.existsSync(zipPathFor(id)) ? zipPathFor(id) : null);
  if (!zip) return res.status(404).send('File expired or not ready.');
  let name = 'site';
  try { name = new URL(job?.url || 'http://site').hostname.replace(/^www\./, '').replace(/[^a-z0-9.-]/gi, '_') || 'site'; } catch {}
  res.download(zip, `${name}-clone.zip`);
});

// In-browser preview of the cloned static copy.
const PREVIEW_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject', '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain; charset=utf-8' };

app.get(/^\/api\/clone\/([a-f0-9]+)\/preview(\/.*)?$/, (req, res) => {
  const id = req.params[0];
  const job = jobs.get(id);
  const dir = (job && job.status === 'done' && job.wantStatic) ? job.staticDir : staticDirFor(id);
  if (!dir) return res.status(404).send('Preview not available (the clone may have expired — please clone again).');
  const root = path.resolve(dir);
  if (!fs.existsSync(root)) return res.status(404).send('Preview expired.');
  let rel = decodeURIComponent((req.params[1] || '/').split('?')[0]);
  let file = path.resolve(root, '.' + rel);
  if (file !== root && !file.startsWith(root + path.sep)) return res.status(403).send('Forbidden');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
  if (!fs.existsSync(file)) return res.status(404).send('Not found.');
  res.set('Content-Type', PREVIEW_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Cache-Control', 'no-store');
  fs.createReadStream(file).pipe(res);
});

// ---------------- publish (self-hosted static hosting) ----------------
const publicBase = req => `${req.protocol}://${req.get('host')}`;

app.post('/api/clone/:id/publish', (req, res) => {
  const s = getSettings();
  if (!s.allowPublish) return res.status(403).json({ error: 'Publishing is disabled.' });
  if (s.publishAdminOnly && !isAdmin(req)) return res.status(403).json({ error: 'Only the admin can publish here.' });
  const id = req.params.id;
  if (!/^[a-f0-9]+$/.test(id)) return res.status(400).json({ error: 'Bad id.' });
  const job = jobs.get(id);
  const dir = (job && job.status === 'done' && job.wantStatic) ? job.staticDir : staticDirFor(id);
  if (!dir || !fs.existsSync(dir)) return res.status(404).json({ error: 'Clone not found or expired — clone again, then publish.' });
  const slug = crypto.randomBytes(5).toString('hex');
  const dest = path.join(PUB, slug);
  try {
    fs.cpSync(dir, dest, { recursive: true });
  } catch (e) { return res.status(500).json({ error: 'Could not publish: ' + e.message }); }
  const list = readPublished();
  list.unshift({ slug, source: job?.url || '', at: new Date().toISOString(), ip: req.ip });
  writePublished(list);
  res.json({ url: `${publicBase(req)}/s/${slug}/`, slug });
});

// AI merge: put a new frontend design into an existing backend template (OpenAI-compatible API).
function chatUrl(base) {
  const b = base.replace(/\/+$/, '');
  return /\/v\d+$/.test(b) ? b + '/chat/completions' : b + '/v1/chat/completions';
}
function extractCode(text) {
  const m = text.match(/```[a-zA-Z0-9]*\n([\s\S]*?)```/);
  return (m ? m[1] : text).trim();
}

// One chat call to the configured OpenAI-compatible endpoint. Returns the message text.
async function callAi(system, user) {
  const s = getSettings();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 120000);
  try {
    const r = await fetch(chatUrl(s.aiBaseUrl), {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + s.aiApiKey },
      body: JSON.stringify({ model: s.aiModel, temperature: 0.2, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error?.message || `HTTP ${r.status}`);
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('empty AI response');
    return content;
  } finally { clearTimeout(t); }
}

// AI chat: talk to the AI about your code — explain, debug, paste an error, get a fix.
app.post('/api/ai-chat', async (req, res) => {
  const s = getSettings();
  if (!s.allowAiMerge || !s.aiApiKey) return res.status(403).json({ error: 'AI is not enabled.' });
  if (s.aiMergeAdminOnly && !isAdmin(req)) return res.status(403).json({ error: 'Only the admin can use AI.' });
  let msgs = Array.isArray(req.body?.messages) ? req.body.messages : [];
  msgs = msgs.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').slice(-20);
  if (!msgs.length) return res.status(400).json({ error: 'Nothing to send.' });
  const total = msgs.reduce((n, m) => n + m.content.length, 0);
  if (total > 120000) return res.status(400).json({ error: 'Conversation is too long — start a new chat or shorten the pasted code.' });
  const sys = 'You are a helpful senior web developer assistant. Help the user with their website/code: explain clearly, debug, and fix. When the user pastes an error or code, find the cause and give the corrected code. Put any code in a fenced code block. Keep answers concise and practical.';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 120000);
  try {
    const r = await fetch(chatUrl(s.aiBaseUrl), {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + s.aiApiKey },
      body: JSON.stringify({ model: s.aiModel, temperature: 0.3, messages: [{ role: 'system', content: sys }, ...msgs] }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: 'AI error: ' + (data.error?.message || `HTTP ${r.status}`) });
    const reply = data.choices?.[0]?.message?.content;
    if (!reply) return res.status(502).json({ error: 'AI returned no reply.' });
    res.json({ reply, usage: data.usage || null });
  } catch (e) {
    res.status(502).json({ error: e.name === 'AbortError' ? 'AI request timed out.' : 'Could not reach the AI service.' });
  } finally { clearTimeout(t); }
});

// ---- whole-project AI jobs ----
const aiJobs = new Map();
const uploadProject = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024, files: 2 } })
  .fields([{ name: 'project', maxCount: 1 }, { name: 'backend', maxCount: 1 }, { name: 'frontend', maxCount: 1 }]);

setInterval(() => {
  for (const [id, job] of aiJobs) {
    if (Date.now() - job.createdAt > 60 * 60000 && !['running', 'zipping'].includes(job.status)) {
      fs.rm(job.zipPath, { force: true }, () => {});
      fs.rm(job.previewDir, { recursive: true, force: true }, () => {});
      aiJobs.delete(id);
    }
  }
}, 120000).unref();

app.post('/api/ai-project', (req, res) => {
  const s = getSettings();
  if (!s.allowAiMerge || !s.aiApiKey) return res.status(403).json({ error: 'AI is not enabled.' });
  if (s.aiMergeAdminOnly && !isAdmin(req)) return res.status(403).json({ error: 'Only the admin can use AI.' });
  uploadProject(req, res, err => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'ZIP is too large.' : 'Upload failed.' });
    const mode = req.body?.mode === 'merge' ? 'merge' : 'edit';
    const command = String(req.body?.command || '');
    const f = req.files || {};
    const opts = { command, maxFiles: s.aiMaxFiles, maxFileBytes: 80000 };
    if (mode === 'edit') {
      if (!f.project?.[0]) return res.status(400).json({ error: 'Upload the project ZIP.' });
      if (!command.trim()) return res.status(400).json({ error: 'Type the change you want applied.' });
      opts.projectBuf = f.project[0].buffer;
    } else {
      if (!f.backend?.[0] || !f.frontend?.[0]) return res.status(400).json({ error: 'Upload both the backend ZIP and the frontend/design ZIP.' });
      opts.backendBuf = f.backend[0].buffer;
      opts.frontendBuf = f.frontend[0].buffer;
    }
    const id = crypto.randomBytes(10).toString('hex');
    const job = new AIJob(id, mode, opts, WORK, callAi);
    aiJobs.set(id, job);
    job.run();
    res.json({ id });
  });
});

app.get('/api/ai-project/:id', (req, res) => {
  const job = aiJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found or expired.' });
  res.json(job.toJSON());
});

app.get('/api/ai-project/:id/download', (req, res) => {
  const job = aiJobs.get(req.params.id);
  if (!job || job.status !== 'done' || !fs.existsSync(job.zipPath)) return res.status(404).send('Not ready or expired.');
  res.download(job.zipPath, `ai-${job.mode}-project.zip`);
});

app.get(/^\/api\/ai-project\/([a-f0-9]+)\/preview(\/.*)?$/, (req, res) => {
  const job = aiJobs.get(req.params[0]);
  if (!job || !job.canPreview || !fs.existsSync(job.previewDir)) return res.status(404).send('Preview not available for this project.');
  const root = path.resolve(job.previewDir);
  let rel = decodeURIComponent((req.params[1] || '/').split('?')[0]);
  if (rel === '/' || rel === '') rel = '/' + job.previewIndex;
  let file = path.resolve(root, '.' + rel);
  if (file !== root && !file.startsWith(root + path.sep)) return res.status(403).send('Forbidden');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, job.previewIndex);
  if (!fs.existsSync(file)) return res.status(404).send('Not found.');
  res.set('Content-Type', PREVIEW_TYPES[path.extname(file).toLowerCase()] || 'text/plain; charset=utf-8');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Cache-Control', 'no-store');
  fs.createReadStream(file).pipe(res);
});

app.post('/api/ai-merge', async (req, res) => {
  const s = getSettings();
  if (!s.allowAiMerge || !s.aiApiKey) return res.status(403).json({ error: 'AI merge is not enabled.' });
  if (s.aiMergeAdminOnly && !isAdmin(req)) return res.status(403).json({ error: 'Only the admin can run AI merge.' });
  const design = String(req.body?.design || '');
  const template = String(req.body?.template || '');
  const instruction = String(req.body?.instruction || '').slice(0, 2000);
  if (!design.trim() || !template.trim()) return res.status(400).json({ error: 'Provide both the new design and the backend/template code.' });
  if (design.length > 80000 || template.length > 80000) return res.status(400).json({ error: 'Each file is too large — merge one page at a time (max ~80 KB each).' });

  const sys = 'You are a senior web developer. You merge a new front-end design into an existing server-side template, keeping ALL of the template\'s dynamic code intact — its variables, loops, conditionals, includes, CSRF tokens, form actions and server tags (e.g. {{ }}, {% %}, <?php ?>, <%= %>, @if, ${ }). Apply the new design\'s HTML structure and CSS/classes, but wire every dynamic value from the original into the right place in the new markup. Do not invent new backend variables. Output ONLY the final merged file, inside a single code block, with no explanation.';
  const user = `EXISTING BACKEND TEMPLATE (keep all dynamic code working):\n\`\`\`\n${template}\n\`\`\`\n\nNEW FRONT-END DESIGN (use this look/structure):\n\`\`\`\n${design}\n\`\`\`\n\n${instruction ? 'EXTRA INSTRUCTION: ' + instruction + '\n\n' : ''}Return the merged template file only.`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 120000);
  try {
    const r = await fetch(chatUrl(s.aiBaseUrl), {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + s.aiApiKey },
      body: JSON.stringify({ model: s.aiModel, temperature: 0.2, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: 'AI error: ' + (data.error?.message || `HTTP ${r.status}`) });
    const content = data.choices?.[0]?.message?.content;
    if (!content) return res.status(502).json({ error: 'AI returned no result.' });
    res.json({ merged: extractCode(content), usage: data.usage || null });
  } catch (e) {
    res.status(502).json({ error: e.name === 'AbortError' ? 'AI request timed out.' : 'Could not reach the AI service.' });
  } finally { clearTimeout(t); }
});

// AI edit: change one file by a plain-language command (keeps the rest intact).
app.post('/api/ai-edit', async (req, res) => {
  const s = getSettings();
  if (!s.allowAiMerge || !s.aiApiKey) return res.status(403).json({ error: 'AI is not enabled.' });
  if (s.aiMergeAdminOnly && !isAdmin(req)) return res.status(403).json({ error: 'Only the admin can use AI.' });
  const code = String(req.body?.code || '');
  const command = String(req.body?.command || '').slice(0, 2000);
  if (!code.trim()) return res.status(400).json({ error: 'Paste or pick a file to edit.' });
  if (!command.trim()) return res.status(400).json({ error: 'Type what you want to change.' });
  if (code.length > 80000) return res.status(400).json({ error: 'File is too large — edit one page at a time (max ~80 KB).' });

  const sys = 'You are a senior web developer. Apply ONLY the change the user asks for to the given file. Keep everything else exactly as it is, including all dynamic/server code (variables, loops, conditionals, includes, form actions, server tags like {{ }}, {% %}, <?php ?>, <%= %>, ${ }). Do not refactor or remove anything unrelated to the request. Output ONLY the full updated file inside a single code block, with no explanation.';
  const user = `FILE:\n\`\`\`\n${code}\n\`\`\`\n\nCHANGE REQUESTED: ${command}\n\nReturn the full updated file only.`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 120000);
  try {
    const r = await fetch(chatUrl(s.aiBaseUrl), {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + s.aiApiKey },
      body: JSON.stringify({ model: s.aiModel, temperature: 0.2, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: 'AI error: ' + (data.error?.message || `HTTP ${r.status}`) });
    const content = data.choices?.[0]?.message?.content;
    if (!content) return res.status(502).json({ error: 'AI returned no result.' });
    res.json({ merged: extractCode(content), usage: data.usage || null });
  } catch (e) {
    res.status(502).json({ error: e.name === 'AbortError' ? 'AI request timed out.' : 'Could not reach the AI service.' });
  } finally { clearTimeout(t); }
});

// Upload a ZIP of a static site and publish it (Netlify-style).
const uploadZip = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024, files: 1 },
}).single('zip');

app.post('/api/publish-zip', (req, res) => {
  const s = getSettings();
  if (!s.allowPublish) return res.status(403).json({ error: 'Publishing is disabled.' });
  if (s.publishAdminOnly && !isAdmin(req)) return res.status(403).json({ error: 'Only the admin can publish here.' });
  uploadZip(req, res, err => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'ZIP is too large.' : 'Upload failed.' });
    if (!req.file) return res.status(400).json({ error: 'Please choose a ZIP file.' });
    if (req.file.size > s.maxZipMb * 1024 * 1024) return res.status(400).json({ error: `ZIP is larger than the ${s.maxZipMb} MB limit.` });
    let zip;
    try { zip = new AdmZip(req.file.buffer); } catch { return res.status(400).json({ error: 'That is not a valid ZIP file.' }); }
    const entries = zip.getEntries().filter(e => !e.isDirectory);
    if (!entries.length) return res.status(400).json({ error: 'The ZIP is empty.' });
    if (entries.length > 8000) return res.status(400).json({ error: 'Too many files in the ZIP (max 8000).' });
    const total = entries.reduce((n, e) => n + (e.header.size || 0), 0);
    if (total > s.maxZipMb * 4 * 1024 * 1024) return res.status(400).json({ error: 'The ZIP expands to too much data.' });

    // If every file sits under one top folder, strip it so index.html lands at the root.
    const tops = new Set(entries.map(e => e.entryName.replace(/\\/g, '/').split('/')[0]));
    const strip = tops.size === 1 && entries.every(e => e.entryName.replace(/\\/g, '/').includes('/')) ? [...tops][0] + '/' : '';

    const slug = crypto.randomBytes(5).toString('hex');
    const dest = path.join(PUB, slug);
    let written = 0, hasIndex = false;
    try {
      for (const e of entries) {
        let name = e.entryName.replace(/\\/g, '/');
        if (strip && name.startsWith(strip)) name = name.slice(strip.length);
        if (!name || name.startsWith('/') || name.includes('..') || /^[a-zA-Z]:/.test(name)) continue; // skip unsafe paths
        if (/(^|\/)(__MACOSX|\.DS_Store|\.git)(\/|$)/.test(name)) continue;
        const out = path.resolve(dest, name);
        if (out !== dest && !out.startsWith(dest + path.sep)) continue;
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, e.getData());
        written++;
        if (name.toLowerCase() === 'index.html') hasIndex = true;
      }
    } catch (e) { fs.rmSync(dest, { recursive: true, force: true }); return res.status(500).json({ error: 'Could not extract the ZIP.' }); }
    if (!written) { fs.rmSync(dest, { recursive: true, force: true }); return res.status(400).json({ error: 'No usable files found in the ZIP.' }); }
    // If there is no index.html but a single HTML file, use it as the entry page.
    if (!hasIndex) {
      const htmls = entries.map(e => (strip && e.entryName.startsWith(strip) ? e.entryName.slice(strip.length) : e.entryName)).filter(n => /\.html?$/i.test(n) && !n.includes('/'));
      if (htmls.length === 1) { try { fs.copyFileSync(path.join(dest, htmls[0]), path.join(dest, 'index.html')); hasIndex = true; } catch {} }
    }
    const list = readPublished();
    list.unshift({ slug, source: '(uploaded ZIP: ' + req.file.originalname.slice(0, 80) + ')', at: new Date().toISOString(), ip: req.ip });
    writePublished(list);
    res.json({ url: `${publicBase(req)}/s/${slug}/`, slug, files: written, index: hasIndex });
  });
});

// Serve published sites at /s/<slug>/...
app.get(/^\/s\/([a-z0-9]+)(\/.*)?$/, (req, res) => {
  const slug = req.params[0];
  const root = path.resolve(PUB, slug);
  if (root !== path.resolve(PUB, slug) || !root.startsWith(PUB + path.sep) || !fs.existsSync(root)) return res.status(404).send('Site not found.');
  if (!req.params[1]) return res.redirect(301, `/s/${slug}/`);
  let rel = decodeURIComponent(req.params[1].split('?')[0]);
  let file = path.resolve(root, '.' + rel);
  if (file !== root && !file.startsWith(root + path.sep)) return res.status(403).send('Forbidden');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
  if (!fs.existsSync(file)) return res.status(404).send('Not found.');
  res.set('Content-Type', PREVIEW_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
  res.set('Cache-Control', 'public, max-age=300');
  fs.createReadStream(file).pipe(res);
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
app.get('/api/admin/settings', requireAdmin, (req, res) => {
  const s = { ...getSettings() };
  if (s.aiApiKey) s.aiApiKey = '';          // never send the stored key back
  s.aiApiKeySet = !!getSettings().aiApiKey;  // just tell the UI whether one is saved
  res.json(s);
});
app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const body = { ...(req.body || {}) };
  if (!body.aiApiKey) delete body.aiApiKey;   // empty = keep the existing key (the GET never returns it)
  const s = updateSettings(body);
  const out = { ...s }; if (out.aiApiKey) out.aiApiKey = ''; out.aiApiKeySet = !!s.aiApiKey;
  res.json(out);
});
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  res.json({ ...getStats(), running, queued: waiting.length, activeJobs: jobs.size, puppeteerInstalled: browserInstalled, version: '1.2.0' });
});
app.get('/api/admin/published', requireAdmin, (req, res) => {
  res.json(readPublished().map(p => ({ ...p, url: `${publicBase(req)}/s/${p.slug}/` })));
});
app.post('/api/admin/published/delete', requireAdmin, (req, res) => {
  const slug = String(req.body?.slug || '');
  if (!/^[a-z0-9]+$/.test(slug)) return res.status(400).json({ error: 'Bad slug.' });
  fs.rm(path.join(PUB, slug), { recursive: true, force: true }, () => {});
  writePublished(readPublished().filter(p => p.slug !== slug));
  res.json({ ok: true });
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Server error' }); });

app.listen(PORT, () => console.log(`SiteCloner Pro running on http://localhost:${PORT}`));

// SiteCloner Pro — core clone engine.
// Two engines:
//   browser — real headless Chrome; captures exactly what is on screen (React, Vue, Next.js, CSS-in-JS…)
//   fast    — plain HTTP download of the server HTML (no browser needed, best for simple/static sites)
// Two outputs (or both):
//   static      — editable HTML/CSS with every asset local; opens straight from disk
//   interactive — the site's own JavaScript replayed offline through a service worker
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import { ZipArchive } from 'archiver';
import { assertPublicUrl } from './guard.js';
import { BrowserSession, loadPuppeteer } from './browser.js';
import { buildMirror } from './mirror.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const EXT_BY_TYPE = {
  'text/css': '.css', 'application/javascript': '.js', 'text/javascript': '.js',
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/svg+xml': '.svg', 'image/avif': '.avif', 'image/x-icon': '.ico', 'image/vnd.microsoft.icon': '.ico',
  'font/woff2': '.woff2', 'font/woff': '.woff', 'font/ttf': '.ttf', 'font/otf': '.otf',
  'application/font-woff': '.woff', 'application/font-woff2': '.woff2', 'application/vnd.ms-fontobject': '.eot',
  'application/manifest+json': '.json', 'application/json': '.json', 'video/mp4': '.mp4', 'video/webm': '.webm',
};

const KIND_BY_EXT = {
  '.css': 'css', '.js': 'js', '.mjs': 'js',
  '.png': 'img', '.jpg': 'img', '.jpeg': 'img', '.gif': 'img', '.webp': 'img', '.svg': 'img', '.avif': 'img', '.ico': 'img', '.bmp': 'img',
  '.woff': 'fonts', '.woff2': 'fonts', '.ttf': 'fonts', '.otf': 'fonts', '.eot': 'fonts',
  '.mp4': 'media', '.webm': 'media', '.mp3': 'media', '.ogg': 'media',
};

function limiter(n) {
  let active = 0; const q = [];
  const next = () => {
    if (active >= n || !q.length) return;
    active++;
    const { fn, res, rej } = q.shift();
    fn().then(res, rej).finally(() => { active--; next(); });
  };
  return fn => new Promise((res, rej) => { q.push({ fn, res, rej }); next(); });
}

const stripHash = u => { const x = new URL(u); x.hash = ''; return x.href; };

export class CloneJob {
  constructor(id, url, opts, workRoot) {
    this.id = id;
    this.url = url;
    this.opts = {
      maxPages: 1, engine: 'browser', output: 'both', includeJs: true, includeMedia: false,
      crawl: 'single',          // 'single' = this page (+ up to maxPages linked) | 'full' = whole site
      maxSitePages: 200,        // hard cap on pages in full-site mode
      maxDepth: 4,              // how many clicks deep from the start page
      politenessMs: 0,          // delay between pages, to be gentle on the target
      respectRobots: true,      // obey robots.txt Disallow rules
      includeSubdomains: false, // also follow links to sub-domains of the same site
      maxAssets: 600, maxBytes: 120 * 1024 * 1024, timeoutMs: 180000, ...opts,
    };
    this.status = 'queued';
    this.progress = { pages: 0, assets: 0, failed: 0, bytes: 0, queued: 0 };
    this.log = [];
    this.error = null;
    this.createdAt = Date.now();
    this.workDir = path.join(workRoot, id);
    this.siteDir = path.join(this.workDir, 'site');
    this.zipPath = path.join(workRoot, `${id}.zip`);
    this.assets = new Map();  // absolute url -> Promise<local path | null>
    this.pages = new Map();   // absolute url -> local file name
    this.depth = new Map();   // absolute url -> crawl depth from start
    this.queue = [];
    this.disallow = [];       // robots.txt Disallow path prefixes
    this.limit = limiter(8);
    this.deadline = 0;
    this.session = null;
  }

  get pageCap() { return this.opts.crawl === 'full' ? this.opts.maxSitePages : this.opts.maxPages; }

  say(msg) { this.log.push(msg); if (this.log.length > 200) this.log.shift(); }

  toJSON() {
    return { id: this.id, url: this.url, status: this.status, progress: this.progress,
      log: this.log.slice(-12), error: this.error, ready: this.status === 'done',
      engine: this.session ? 'browser' : 'fast', output: this.opts.output, crawl: this.opts.crawl };
  }

  get wantStatic() { return this.opts.output !== 'interactive'; }
  get wantMirror() { return this.opts.output !== 'static' && !!this.session; }
  get staticDir() { return this.opts.output === 'both' && this.session ? path.join(this.siteDir, 'static') : this.siteDir; }
  get mirrorDir() { return this.opts.output === 'both' ? path.join(this.siteDir, 'interactive') : this.siteDir; }

  // ---------- networking ----------
  async fetchUrl(urlStr, maxSize) {
    const cached = this.session?.net.get(urlStr);
    if (cached) return { buf: cached.buf, type: cached.type, finalUrl: urlStr };
    let current = urlStr;
    for (let hop = 0; hop < 6; hop++) {
      await assertPublicUrl(current);
      if (Date.now() > this.deadline) throw new Error('Time limit reached');
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      let res;
      try {
        res = await fetch(current, {
          redirect: 'manual', signal: ctrl.signal,
          headers: { 'user-agent': UA, accept: '*/*', 'accept-language': 'en-US,en;q=0.9', referer: this.url },
        });
      } finally { clearTimeout(t); }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location'), current).href;
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const len = Number(res.headers.get('content-length') || 0);
      if (len && len > maxSize) throw new Error('File too large');
      const chunks = []; let size = 0;
      for await (const c of res.body) {
        size += c.length;
        if (size > maxSize) throw new Error('File too large');
        chunks.push(c);
      }
      const buf = Buffer.concat(chunks);
      this.progress.bytes += buf.length;
      if (this.progress.bytes > this.opts.maxBytes) throw new Error('Total size limit reached');
      return { buf, type: (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(), finalUrl: current };
    }
    throw new Error('Too many redirects');
  }

  // ---------- assets ----------
  localName(absUrl, type) {
    const u = new URL(absUrl);
    let base = decodeURIComponent(path.posix.basename(u.pathname)) || 'file';
    let ext = path.extname(base).toLowerCase();
    if (!ext || ext.length > 6 || !(ext in KIND_BY_EXT)) {
      ext = EXT_BY_TYPE[type] || (ext in KIND_BY_EXT ? ext : '');
      if (ext && !base.toLowerCase().endsWith(ext)) base += ext;
    }
    base = base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-60);
    const hash = crypto.createHash('md5').update(absUrl).digest('hex').slice(0, 6);
    const stem = base.slice(0, base.length - ext.length) || 'file';
    const kind = KIND_BY_EXT[ext] || (type.startsWith('image/') ? 'img' : type.includes('font') ? 'fonts' : 'other');
    return `assets/${kind}/${stem}-${hash}${ext}`;
  }

  // Returns the asset's path relative to the static site root, or null on failure.
  asset(rawUrl, baseUrl, hint) {
    if (!rawUrl) return Promise.resolve(null);
    rawUrl = rawUrl.trim();
    if (!rawUrl || /^(data:|blob:|javascript:|mailto:|tel:|#|about:)/i.test(rawUrl)) return Promise.resolve(null);
    let abs;
    try { abs = stripHash(new URL(rawUrl, baseUrl).href); } catch { return Promise.resolve(null); }
    if (!/^https?:/.test(abs)) return Promise.resolve(null);
    if (this.assets.has(abs)) return this.assets.get(abs);
    if (this.assets.size >= this.opts.maxAssets) return Promise.resolve(null);
    const p = this.limit(async () => {
      try {
        const { buf, type, finalUrl } = await this.fetchUrl(abs, 25 * 1024 * 1024);
        let rel = this.localName(abs, type);
        if (hint === 'css' && !rel.endsWith('.css')) rel = rel.replace(/^assets\/\w+\//, 'assets/css/') + '.css';
        let data = buf;
        if (hint === 'css' || type === 'text/css' || rel.endsWith('.css')) {
          data = Buffer.from(await this.processCss(buf.toString('utf8'), finalUrl, path.posix.dirname(rel)));
        }
        const out = path.join(this.staticDir, rel);
        await fsp.mkdir(path.dirname(out), { recursive: true });
        await fsp.writeFile(out, data);
        this.progress.assets++;
        return rel;
      } catch (e) {
        this.progress.failed++;
        this.say(`Skipped ${abs.slice(0, 90)} (${e.message})`);
        return null;
      }
    });
    this.assets.set(abs, p);
    return p;
  }

  // Rewrites url(...) and @import inside CSS. fromDir = directory of this CSS relative to the site root.
  async processCss(css, baseUrl, fromDir) {
    const refs = [];
    const urlRe = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
    const importRe = /@import\s+(['"])([^'"]+)\1/gi;
    let m;
    while ((m = urlRe.exec(css))) refs.push({ raw: m[2], css: /\.css(\?|$)/i.test(m[2]) || /fonts\.googleapis\.com\/css/i.test(m[2]) });
    while ((m = importRe.exec(css))) refs.push({ raw: m[2], css: true });
    const map = new Map();
    await Promise.all(refs.map(async r => {
      const local = await this.asset(r.raw, baseUrl, r.css ? 'css' : undefined);
      if (local) map.set(r.raw, path.posix.relative(fromDir, local));
    }));
    const swap = raw => map.get(raw) ?? (/^(data:|#)/i.test(raw) ? raw : this.absolute(raw, baseUrl));
    return css
      .replace(urlRe, (all, q, raw) => `url(${q}${swap(raw)}${q})`)
      .replace(importRe, (all, q, raw) => `@import ${q}${swap(raw)}${q}`);
  }

  absolute(raw, base) { try { return new URL(raw, base).href; } catch { return raw; } }

  // ---------- pages ----------
  pageFileFor(absUrl) {
    if (this.pages.has(absUrl)) return this.pages.get(absUrl);
    if (this.pages.size === 0) { this.pages.set(absUrl, 'index.html'); return 'index.html'; }
    const u = new URL(absUrl);
    let slug = (u.pathname + (u.search ? '-' + u.search.slice(1) : ''))
      .replace(/\.(html?|php|aspx?)$/i, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 70) || 'page';
    let name = `${slug}.html`, i = 2;
    const used = new Set(this.pages.values());
    while (used.has(name)) name = `${slug}-${i++}.html`;
    this.pages.set(absUrl, name);
    return name;
  }

  sameSite(u) {
    const start = new URL(this.url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (this.opts.includeSubdomains) {
      const root = start.hostname.replace(/^www\./, '');
      return u.hostname === root || u.hostname.endsWith('.' + root);
    }
    return u.hostname === start.hostname;
  }

  allowedByRobots(pathname) {
    if (!this.opts.respectRobots || !this.disallow.length) return true;
    return !this.disallow.some(p => pathname.startsWith(p));
  }

  isPageLink(abs) {
    let u; try { u = new URL(abs); } catch { return false; }
    if (!this.sameSite(u)) return false;
    if (!this.allowedByRobots(u.pathname)) return false;
    const ext = path.extname(u.pathname).toLowerCase();
    return !ext || ['.html', '.htm', '.php', '.asp', '.aspx', '.jsp'].includes(ext);
  }

  // Loads and parses robots.txt once, collecting Disallow rules for all user-agents.
  async loadRobots() {
    if (!this.opts.respectRobots) return;
    try {
      const { origin } = new URL(this.url);
      const { buf } = await this.fetchUrl(origin + '/robots.txt', 512 * 1024);
      let applies = false;
      for (let line of buf.toString('utf8').split('\n')) {
        line = line.replace(/#.*/, '').trim();
        const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
        if (!m) continue;
        const key = m[1].toLowerCase(), val = m[2].trim();
        if (key === 'user-agent') applies = val === '*';
        else if (key === 'disallow' && applies && val) this.disallow.push(val.replace(/\*.*$/, ''));
      }
      if (this.disallow.length) this.say(`robots.txt: avoiding ${this.disallow.length} path rule(s)`);
    } catch { /* no robots.txt — allow everything */ }
  }

  // Finds same-site pages to clone next, within depth and page limits.
  discover(html, base, depth) {
    if (this.opts.crawl !== 'full' && this.opts.maxPages <= 1) return;
    if (depth >= this.opts.maxDepth) return;
    const $ = cheerio.load(html);
    const found = new Set();
    $('a[href]').each((_, el) => {
      const v = $(el).attr('href');
      if (!v || /^(#|mailto:|tel:|javascript:|data:)/i.test(v)) return;
      let abs; try { abs = new URL(v, base); } catch { return; }
      abs.hash = ''; abs.search = abs.search; // keep query (some sites paginate by it)
      found.add(abs.href);
    });
    for (const href of found) {
      if (this.pages.size >= this.pageCap) break;
      if (this.pages.has(href) || !this.isPageLink(href)) continue;
      this.pageFileFor(href);
      this.depth.set(href, depth + 1);
      this.queue.push(href);
    }
    this.progress.queued = this.queue.length;
  }

  async processPage(html, finalUrl, rendered) {
    const keepJs = this.opts.includeJs && !rendered;
    const $ = cheerio.load(html, { decodeEntities: false });
    const baseHref = $('base[href]').attr('href');
    const base = baseHref ? this.absolute(baseHref, finalUrl) : finalUrl;
    $('base').remove();
    $('meta[http-equiv="Content-Security-Policy" i]').remove();
    $('[integrity]').removeAttr('integrity');
    $('link[crossorigin], script[crossorigin]').removeAttr('crossorigin');

    const jobs = [];
    const setAttr = (el, attr, hint) => {
      const v = $(el).attr(attr);
      if (!v) return;
      jobs.push(this.asset(v, base, hint).then(loc => $(el).attr(attr, loc ?? this.absolute(v, base))));
    };
    const setSrcset = (el, attr) => {
      const v = $(el).attr(attr);
      if (!v) return;
      const parts = v.split(/,\s+(?=\S)/).map(p => p.trim()).filter(Boolean);
      jobs.push(Promise.all(parts.map(async p => {
        const [u, ...d] = p.split(/\s+/);
        const loc = await this.asset(u, base);
        return [loc ?? this.absolute(u, base), ...d].join(' ');
      })).then(list => $(el).attr(attr, list.join(', '))));
    };

    // stylesheets, icons, preloads
    $('link[href]').each((_, el) => {
      const rel = ($(el).attr('rel') || '').toLowerCase();
      const as = ($(el).attr('as') || '').toLowerCase();
      if (rel.includes('stylesheet') || (rel.includes('preload') && as === 'style')) setAttr(el, 'href', 'css');
      else if (rel.includes('icon') || rel.includes('apple-touch') || rel === 'mask-icon' || (rel.includes('preload') && ['font', 'image'].includes(as))) setAttr(el, 'href');
      else if (rel.includes('preload') && as === 'script' && keepJs) setAttr(el, 'href');
      else if (['preconnect', 'dns-prefetch', 'prefetch', 'modulepreload', 'preload', 'manifest'].some(r => rel.includes(r))) $(el).remove();
      else $(el).attr('href', this.absolute($(el).attr('href'), base));
    });

    // scripts
    if (keepJs) $('script[src]').each((_, el) => setAttr(el, 'src'));
    else {
      $('script').filter((_, el) => !/ld\+json/i.test($(el).attr('type') || '')).remove();
      if (rendered) $('noscript').remove();
      else $('noscript').each((_, el) => { $(el).replaceWith($(el).html() || ''); });
      // inline event handlers do nothing without the scripts
      $('*').each((_, el) => { for (const a of Object.keys(el.attribs || {})) if (/^on[a-z]+$/i.test(a)) $(el).removeAttr(a); });
    }

    // images & lazy-load attributes
    $('img, source, input[type="image"]').each((_, el) => {
      for (const a of ['data-src', 'data-lazy-src', 'data-original']) {
        const v = $(el).attr(a);
        if (v && !/^data:/.test(v)) { if (!rendered || !$(el).attr('src')) $(el).attr('src', v); $(el).removeAttr(a); }
      }
      for (const a of ['data-srcset', 'data-lazy-srcset']) {
        const v = $(el).attr(a);
        if (v) { if (!rendered || !$(el).attr('srcset')) $(el).attr('srcset', v); $(el).removeAttr(a); }
      }
      $(el).removeAttr('loading');
      const parentIsMedia = $(el).parent().is('video, audio');
      if ($(el).attr('src') && (!parentIsMedia || this.opts.includeMedia)) setAttr(el, 'src');
      else if ($(el).attr('src')) $(el).attr('src', this.absolute($(el).attr('src'), base));
      setSrcset(el, 'srcset');
    });
    $('video[poster]').each((_, el) => setAttr(el, 'poster'));
    $('video[src], audio[src]').each((_, el) => this.opts.includeMedia ? setAttr(el, 'src') : $(el).attr('src', this.absolute($(el).attr('src'), base)));
    $('[data-bg], [data-background], [data-bg-src]').each((_, el) => {
      for (const a of ['data-bg', 'data-background', 'data-bg-src']) if ($(el).attr(a)) setAttr(el, a);
    });
    $('image').each((_, el) => { setAttr(el, 'href'); setAttr(el, 'xlink:href'); });
    $('use[href], use[xlink\\:href]').each((_, el) => {
      for (const a of ['href', 'xlink:href']) {
        const v = $(el).attr(a);
        if (v && !v.startsWith('#')) {
          const [file, frag] = v.split('#');
          jobs.push(this.asset(file, base).then(loc => $(el).attr(a, (loc ?? this.absolute(file, base)) + (frag ? '#' + frag : ''))));
        }
      }
    });

    // inline CSS (also inside declarative shadow DOM templates)
    $('style').each((_, el) => {
      jobs.push(this.processCss($(el).html() || '', base, '.').then(css => $(el).html(css)));
    });
    $('[style*="url("]').each((_, el) => {
      jobs.push(this.processCss($(el).attr('style'), base, '.').then(css => $(el).attr('style', css)));
    });

    // links between pages
    $('a[href]').each((_, el) => {
      const v = $(el).attr('href');
      if (/^(#|mailto:|tel:|javascript:)/i.test(v)) return;
      let abs; try { abs = new URL(v, base); } catch { return; }
      const hash = abs.hash; abs.hash = '';
      if (this.pages.has(abs.href)) $(el).attr('href', this.pages.get(abs.href) + hash);
      else $(el).attr('href', abs.href + hash);
    });
    $('form[action]').each((_, el) => $(el).attr('action', this.absolute($(el).attr('action'), base)));
    $('iframe[src]').each((_, el) => $(el).attr('src', this.absolute($(el).attr('src'), base)));

    await Promise.all(jobs);
    $('head').prepend(`\n<!-- Cloned with SiteCloner Pro from ${finalUrl} on ${new Date().toISOString().slice(0, 10)} -->\n`);
    if (!$('meta[charset]').length) $('head').prepend('<meta charset="utf-8">');
    return $.html();
  }

  async loadPage(pageUrl) {
    if (this.session) return { ...(await this.session.render(pageUrl)), rendered: true };
    const r = await this.fetchUrl(pageUrl, 15 * 1024 * 1024);
    if (!r.type.includes('html') && r.type) throw new Error(`Not an HTML page (${r.type})`);
    return { html: r.buf.toString('utf8'), finalUrl: r.finalUrl, rendered: false };
  }

  async run() {
    this.status = 'running';
    this.deadline = Date.now() + this.opts.timeoutMs;
    try {
      const start = stripHash((await assertPublicUrl(this.url)).href);
      this.url = start;
      await fsp.mkdir(this.siteDir, { recursive: true });

      if (this.opts.engine === 'browser') {
        if (await loadPuppeteer()) {
          this.say('Starting real browser engine…');
          this.session = new BrowserSession(this);
          await this.session.start();
        } else {
          this.say('Browser engine not installed — using fast engine');
        }
      }
      if (!this.session && this.opts.output === 'interactive') this.opts.output = 'static';
      if (this.opts.crawl === 'full') this.say(`Full-site crawl: up to ${this.opts.maxSitePages} pages, depth ${this.opts.maxDepth}`);

      await this.loadRobots();
      this.pageFileFor(start);
      this.depth.set(start, 0);
      this.queue.push(start);
      const done = new Set();
      while (this.queue.length) {
        if (Date.now() > this.deadline) { this.say(`Time limit reached — stopping with ${this.progress.pages} page(s)`); break; }
        const pageUrl = this.queue.shift();
        if (done.has(pageUrl)) continue;
        done.add(pageUrl);
        const depth = this.depth.get(pageUrl) || 0;
        const file = this.pages.get(pageUrl);
        this.progress.queued = this.queue.length;
        this.say(`[${this.progress.pages + 1}] Loading: ${pageUrl}${this.queue.length ? `  (+${this.queue.length} queued)` : ''}`);
        try {
          const { html, finalUrl, rendered } = await this.loadPage(pageUrl);
          this.discover(html, finalUrl, depth);
          if (this.wantStatic) {
            const out = await this.processPage(html, finalUrl, rendered);
            await fsp.mkdir(this.staticDir, { recursive: true });
            await fsp.writeFile(path.join(this.staticDir, file), out);
          }
          this.progress.pages++;
        } catch (e) {
          if (done.size === 1) throw e;
          this.say(`Page failed: ${pageUrl} (${e.message})`);
          if (this.wantStatic) await fsp.writeFile(path.join(this.staticDir, file),
            `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${pageUrl}"><a href="${pageUrl}">${pageUrl}</a>`);
        }
        if (this.opts.politenessMs && this.queue.length) await new Promise(r => setTimeout(r, this.opts.politenessMs));
      }
      this.progress.queued = 0;
      await Promise.all(this.assets.values());

      if (this.wantMirror) {
        this.say('Building interactive copy…');
        await fsp.mkdir(this.mirrorDir, { recursive: true });
        const mirrorCap = this.opts.crawl === 'full' ? Math.max(this.opts.maxAssets * 6, 6000) : Math.max(this.opts.maxAssets * 3, 1500);
        const n = await buildMirror(this.session, start, this.mirrorDir, mirrorCap);
        this.say(`Interactive copy: ${n} files recorded`);
        if (!this.wantStatic) this.progress.assets = n;
      }
      await this.session?.close();

      const parts = [];
      if (this.wantStatic) parts.push(`${this.opts.output === 'both' && this.session ? 'static/       ' : ''}Editable HTML + CSS. Open index.html directly (double-click).`);
      if (this.wantMirror) parts.push(`${this.opts.output === 'both' ? 'interactive/  ' : ''}Runs the site's own JavaScript. Start with START-WINDOWS.bat or "node serve.js" (see its README.txt).`);
      await fsp.writeFile(path.join(this.siteDir, 'CLONE-INFO.txt'),
        `Source: ${this.url}\nDate: ${new Date().toISOString()}\nEngine: ${this.session ? 'real browser' : 'fast'}\nPages: ${this.progress.pages}\nFiles: ${this.progress.assets} (${this.progress.failed} skipped)\n\n${parts.join('\n')}\n`);
      this.status = 'zipping';
      this.say('Creating ZIP…');
      await this.zip();
      await fsp.rm(this.workDir, { recursive: true, force: true });
      this.status = 'done';
      this.say(`Done — ${this.progress.pages} page(s), ${this.progress.assets} file(s)`);
    } catch (e) {
      this.status = 'error';
      this.error = e.message || String(e);
      this.say(`Error: ${this.error}`);
      await this.session?.close();
      await fsp.rm(this.workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  zip() {
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(this.zipPath);
      const archive = new ZipArchive({ zlib: { level: 9 } });
      out.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(out);
      const folder = new URL(this.url).hostname.replace(/^www\./, '');
      archive.directory(this.siteDir, folder);
      archive.finalize();
    });
  }
}

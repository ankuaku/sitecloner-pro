// Real-browser engine: loads pages in headless Chrome, records every network response
// and produces a "frozen" HTML snapshot of exactly what is on screen.
import { assertPublicUrl } from './guard.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let puppeteerMod;
export async function loadPuppeteer() {
  if (puppeteerMod !== undefined) return puppeteerMod;
  try { puppeteerMod = (await import('puppeteer')).default; } catch { puppeteerMod = null; }
  return puppeteerMod;
}

export class BrowserSession {
  constructor(job) {
    this.job = job;
    this.net = new Map();     // url -> { buf, type, status, kind }
    this.docs = new Map();    // navigated page url -> raw document response
    this.capturing = true;
  }

  async start() {
    const puppeteer = await loadPuppeteer();
    if (!puppeteer) throw new Error('Browser engine not installed (npm i puppeteer)');
    const args = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars', '--mute-audio'];
    if (process.env.BROWSER_PROXY) args.push(`--proxy-server=${process.env.BROWSER_PROXY}`);
    // LOW_MEMORY=true — for 512 MB hosts (Render free/starter): one process, small JS heap
    if (process.env.LOW_MEMORY === 'true') args.push('--renderer-process-limit=1', '--disable-dev-shm-usage',
      '--disable-extensions', '--disable-background-networking', '--disable-features=site-per-process,Translate,MediaRouter',
      '--js-flags=--max-old-space-size=192');
    this.browser = await puppeteer.launch({
      headless: true, args,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });
    const page = this.page = await this.browser.newPage();
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    page.setDefaultTimeout(process.env.LOW_MEMORY === 'true' ? 90000 : 30000);
    await page.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });
    // Keep the site from registering its own service worker
    await page.evaluateOnNewDocument(() => {
      try { if (navigator.serviceWorker) navigator.serviceWorker.register = () => new Promise(() => {}); } catch {}
    });
    await page.setRequestInterception(true);
    page.on('request', req => {
      const url = req.url();
      if (/^(data|blob|about|chrome-extension):/i.test(url)) return req.continue().catch(() => {});
      if (/^wss?:/i.test(url)) return req.abort().catch(() => {});
      const type = req.resourceType();
      if (type === 'media' && !this.job.opts.includeMedia) return req.abort().catch(() => {});
      assertPublicUrl(url).then(() => req.continue().catch(() => {}), () => req.abort().catch(() => {}));
    });
    page.on('response', res => this.capture(res));
  }

  async capture(res) {
    try {
      const req = res.request();
      const status = res.status();
      if (status < 200 || status >= 300 || req.method() !== 'GET') return;
      const kind = req.resourceType();
      if (['websocket', 'eventsource', 'ping', 'cspviolationreport', 'preflight'].includes(kind)) return;
      const url = res.url().split('#')[0];
      if (!/^https?:/.test(url) || this.net.has(url)) return;
      const buf = await res.buffer();
      if (buf.length > 25 * 1024 * 1024) return;
      if (!this.capturing) return;
      if (this.job.progress.bytes + buf.length > this.job.opts.maxBytes) {
        this.capturing = false;
        this.job.say('Size limit reached — remaining files skipped');
        return;
      }
      this.job.progress.bytes += buf.length;
      const type = (res.headers()['content-type'] || '').split(';')[0].trim().toLowerCase();
      this.net.set(url, { buf, type, status, kind });
      if (kind === 'document' && req.isNavigationRequest() && req.frame() === this.page.mainFrame()) {
        this.docs.set(url, { buf, type });
      }
    } catch { /* body not available (redirect, cancelled) */ }
  }

  async render(url) {
    await assertPublicUrl(url);
    const page = this.page;
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: process.env.LOW_MEMORY === 'true' ? 90000 : 45000 });
    } catch (e) {
      if (!/timeout/i.test(e.message)) throw e;
      this.job.say('Page kept loading — continuing with what is on screen');
    }
    // Scroll through the page so lazy images, animations and infinite sections load
    await page.evaluate(async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      let last = -1;
      for (let i = 0; i < 80; i++) {
        const h = document.documentElement.scrollHeight;
        const y = Math.min(window.scrollY + window.innerHeight * 0.8, h);
        window.scrollTo(0, y);
        await wait(140);
        if (y >= h - window.innerHeight && h === last) break;
        last = h;
      }
      await wait(500);
      window.scrollTo(0, 0);
    }).catch(() => {});
    await page.waitForNetworkIdle({ idleTime: 600, timeout: 8000 }).catch(() => {});
    await page.evaluate(async () => {
      const imgs = [...document.images].filter(i => !i.complete);
      await Promise.race([
        Promise.all(imgs.map(i => new Promise(r => { i.onload = i.onerror = r; }))),
        new Promise(r => setTimeout(r, 4000)),
      ]);
      try { await document.fonts.ready; } catch {}
    }).catch(() => {});
    await sleep(400);
    const html = await page.evaluate(freezeAndSerialize);
    return { html, finalUrl: page.url() };
  }

  async close() { try { await this.browser?.close(); } catch {} }
}

// Runs inside the page. Turns live state into plain HTML.
function freezeAndSerialize() {
  const rulesText = sheet => { try { return [...sheet.cssRules].map(r => r.cssText).join('\n'); } catch { return null; } };

  // 1. CSS-in-JS (styled-components, emotion, JSS…) writes rules straight into the CSSOM.
  for (const sheet of [...document.styleSheets]) {
    const node = sheet.ownerNode;
    if (!node || node.tagName !== 'STYLE') continue;
    const css = rulesText(sheet);
    if (css != null && css.length > (node.textContent || '').trim().length) node.textContent = css;
  }

  // 2. Shadow roots (web components) + constructable / adopted stylesheets
  const roots = [];
  const walk = root => {
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) { roots.push(el.shadowRoot); walk(el.shadowRoot); }
  };
  walk(document);
  const inlineAdopted = (root, target) => {
    const sheets = root.adoptedStyleSheets || [];
    if (!sheets.length) return;
    const st = document.createElement('style');
    st.setAttribute('data-clone-adopted', '');
    st.textContent = sheets.map(rulesText).filter(Boolean).join('\n');
    target.appendChild(st);
  };
  inlineAdopted(document, document.head);
  for (const r of roots) {
    for (const s of r.querySelectorAll('style')) if (s.sheet) { const c = rulesText(s.sheet); if (c && c.length > s.textContent.length) s.textContent = c; }
    inlineAdopted(r, r);
  }

  // 3. Form state
  for (const el of document.querySelectorAll('input')) {
    if (['checkbox', 'radio'].includes(el.type)) el.toggleAttribute('checked', el.checked);
    else if (el.type !== 'password' && el.type !== 'file') el.setAttribute('value', el.value);
  }
  for (const el of document.querySelectorAll('textarea')) el.textContent = el.value;
  for (const el of document.querySelectorAll('select')) for (const o of el.options) o.toggleAttribute('selected', o.selected);

  // 4. Canvas (charts, graphics) -> image
  for (const c of document.querySelectorAll('canvas')) {
    try {
      const img = document.createElement('img');
      img.src = c.toDataURL('image/png');
      img.className = c.className;
      const st = c.getAttribute('style');
      if (st) img.setAttribute('style', st);
      const r = c.getBoundingClientRect();
      if (!img.style.width && r.width) img.style.width = r.width + 'px';
      if (!img.style.height && r.height) img.style.height = r.height + 'px';
      img.style.display = getComputedStyle(c).display;
      c.replaceWith(img);
    } catch { /* tainted canvas */ }
  }

  // 5. Responsive images: keep the picked file when a srcset has many sizes (Next.js etc.)
  for (const img of document.images) {
    const set = img.getAttribute('srcset');
    if (img.currentSrc && set && set.split(',').length > 3) {
      img.setAttribute('src', img.currentSrc);
      img.removeAttribute('srcset');
      img.removeAttribute('sizes');
      const pic = img.parentElement;
      if (pic && pic.tagName === 'PICTURE') pic.querySelectorAll('source').forEach(s => { if ((s.getAttribute('srcset') || '').split(',').length > 3) s.remove(); });
    } else if (img.currentSrc && !img.getAttribute('src')) img.setAttribute('src', img.currentSrc);
  }

  // 6. Serialize, including open shadow roots as declarative shadow DOM
  const doctype = document.doctype ? `<!DOCTYPE ${document.doctype.name}>` : '<!DOCTYPE html>';
  const open = document.documentElement.outerHTML.match(/^<html[^>]*>/i)?.[0] || '<html>';
  let inner;
  try { inner = document.documentElement.getHTML({ serializableShadowRoots: true, shadowRoots: roots }); }
  catch { inner = document.documentElement.innerHTML; }
  return `${doctype}\n${open}${inner}</html>`;
}

// Interactive mirror: stores every response the browser received and replays it offline
// through a service worker, so the original JavaScript (React, Vue, routers, API calls) keeps working.
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const EXT = {
  'text/html': '.html', 'text/css': '.css', 'application/javascript': '.js', 'text/javascript': '.js',
  'application/json': '.json', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/avif': '.avif', 'image/svg+xml': '.svg', 'image/x-icon': '.ico', 'font/woff2': '.woff2', 'font/woff': '.woff',
  'font/ttf': '.ttf', 'font/otf': '.otf', 'application/wasm': '.wasm', 'video/mp4': '.mp4', 'video/webm': '.webm',
};

const SW = `/* SiteCloner Pro — offline replay service worker */
let M;
async function manifest() {
  if (!M) {
    const m = await (await fetch('/clone-manifest.json', { cache: 'no-store' })).json();
    m.loose = {};
    for (const k in m.entries) { const b = k.split('?')[0]; if (!(b in m.loose)) m.loose[b] = m.entries[k]; }
    M = m;
  }
  return M;
}
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(manifest()); });
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin === location.origin && (u.pathname === '/sw-clone.js' || u.pathname === '/clone-manifest.json' || u.pathname.startsWith('/_files/'))) return;
  if (e.request.method !== 'GET') return;
  e.respondWith(handle(e.request, u));
});
async function handle(req, u) {
  const m = await manifest();
  const key = u.origin === location.origin ? m.origin + u.pathname + u.search : u.href;
  let hit = m.entries[key] || m.entries[key.replace(/\\/$/, '')] || m.entries[key + '/'] || m.loose[key.split('?')[0]];
  if (!hit && req.mode === 'navigate') hit = m.entries[m.origin + m.start];
  if (hit) {
    const r = await fetch('/' + hit.f);
    return new Response(r.body, { status: 200, headers: { 'content-type': hit.t || 'application/octet-stream', 'access-control-allow-origin': '*' } });
  }
  try { return await fetch(req); } catch { return new Response('', { status: 504, statusText: 'Offline' }); }
}
`;

const LOADER = (title) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f7fb;color:#1b1e27}
.box{max-width:520px;padding:28px;background:#fff;border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.08)}code{background:#eef0f7;padding:2px 6px;border-radius:5px}</style>
</head><body><div class="box" id="box">Loading clone…</div>
<script>
const box = document.getElementById('box');
if (location.protocol === 'file:') {
  box.innerHTML = '<b>Open this clone through a local server.</b><p>Double-click <code>START-WINDOWS.bat</code> (Windows) or run <code>node serve.js</code> in this folder, then open the address it shows. You can also upload the folder to any https host (Netlify, Vercel, cPanel).</p><p>For a version that opens directly from disk, use the <code>static</code> folder.</p>';
} else if (!('serviceWorker' in navigator)) {
  box.textContent = 'This browser does not support service workers. Please use Chrome, Edge or Firefox.';
} else {
  navigator.serviceWorker.register('/sw-clone.js', { scope: '/' }).then(() => navigator.serviceWorker.ready).then(() => {
    const last = Number(sessionStorage.getItem('__clone_reload') || 0);
    if (Date.now() - last > 4000) { sessionStorage.setItem('__clone_reload', Date.now()); location.reload(); }
    else box.innerHTML = 'Almost there — press <b>F5</b> to load the page.';
  }).catch(err => { box.textContent = 'Could not start the clone: ' + err.message; });
}
</script></body></html>`;

const SERVE = `#!/usr/bin/env node
// Zero-dependency local server for the interactive clone. Usage: node serve.js [port]
const http = require('http'), fs = require('fs'), path = require('path');
const root = __dirname;
let port = Number(process.argv[2] || process.env.PORT || 8080);
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.json':'application/json',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.avif':'image/avif', '.svg':'image/svg+xml',
  '.ico':'image/x-icon', '.woff2':'font/woff2', '.woff':'font/woff', '.ttf':'font/ttf', '.otf':'font/otf', '.wasm':'application/wasm', '.mp4':'video/mp4', '.webm':'video/webm' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  let file = path.normalize(path.join(root, p));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
  res.writeHead(200, { 'content-type': types[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});
server.on('error', e => { if (e.code === 'EADDRINUSE') { port++; server.listen(port); } else throw e; });
server.listen(port, () => {
  const url = 'http://localhost:' + port;
  console.log('\\n  Clone running at ' + url + '\\n  Press Ctrl+C to stop.\\n');
  const cmd = process.platform === 'win32' ? 'start "" ' : process.platform === 'darwin' ? 'open ' : 'xdg-open ';
  require('child_process').exec(cmd + url, () => {});
});
`;

const BAT = `@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is required: https://nodejs.org & pause & exit /b)
node serve.js
pause
`;

export async function buildMirror(session, startUrl, dir, maxFiles) {
  const origin = new URL(startUrl).origin;
  const start = new URL(startUrl).pathname + new URL(startUrl).search;
  const entries = {};
  await fsp.mkdir(path.join(dir, '_files'), { recursive: true });
  let count = 0;
  for (const [url, r] of session.net) {
    if (count >= maxFiles) break;
    let buf = r.buf;
    let type = r.type;
    if (r.kind === 'document' || type === 'text/html') {
      // stop the original site from replacing our service worker; drop CSP meta that could block replay
      let html = buf.toString('utf8')
        .replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, '');
      const guard = '<script>try{navigator.serviceWorker&&(navigator.serviceWorker.register=function(){return new Promise(function(){})})}catch(e){}</script>';
      html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + guard) : guard + html;
      buf = Buffer.from(html);
      type = 'text/html';
    }
    const hash = crypto.createHash('md5').update(url).digest('hex').slice(0, 12);
    const ext = EXT[type] || path.extname(new URL(url).pathname).slice(0, 6) || '';
    const f = `_files/${hash}${ext}`;
    await fsp.writeFile(path.join(dir, f), buf);
    entries[url] = { f, t: type || undefined };
    count++;
  }
  const title = `Clone of ${new URL(startUrl).hostname}`;
  await fsp.writeFile(path.join(dir, 'clone-manifest.json'), JSON.stringify({ origin, start, created: new Date().toISOString(), entries }));
  await fsp.writeFile(path.join(dir, 'sw-clone.js'), SW);
  await fsp.writeFile(path.join(dir, 'index.html'), LOADER(title));
  await fsp.writeFile(path.join(dir, 'serve.js'), SERVE);
  await fsp.writeFile(path.join(dir, 'START-WINDOWS.bat'), BAT.replace(/\n/g, '\r\n'));
  await fsp.writeFile(path.join(dir, 'start.sh'), '#!/bin/sh\ncd "$(dirname "$0")" && node serve.js\n', { mode: 0o755 });
  await fsp.writeFile(path.join(dir, '_redirects'), '/*  /index.html  200\n');
  await fsp.writeFile(path.join(dir, 'vercel.json'), JSON.stringify({ rewrites: [{ source: '/(.*)', destination: '/index.html' }] }, null, 2));
  await fsp.writeFile(path.join(dir, 'README.txt'),
`INTERACTIVE CLONE of ${startUrl}

This copy runs the site's own JavaScript, so menus, sliders, tabs, routing and
data loaded when the page opened all work offline.

HOW TO OPEN
  Windows:  double-click START-WINDOWS.bat
  Mac/Linux: ./start.sh   (or: node serve.js)
  Needs Node.js (https://nodejs.org). It opens http://localhost:8080 automatically.

HOST IT ONLINE
  Upload this folder to Netlify, Vercel, Cloudflare Pages or any https hosting.

NOTE
  Opening index.html by double-click (file://) will not work — browsers only allow
  service workers on http(s). Use the "static" folder for a copy that opens from disk.
  Actions that send data to a server (login, checkout, forms) need the real backend.
`);
  return count;
}

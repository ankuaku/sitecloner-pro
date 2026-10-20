(() => {
  const $ = id => document.getElementById(id);
  let cfg = {}, poll = null;

  // --- recent clones, saved in this browser only ---
  const HKEY = 'sc_recent';
  const loadHistory = () => { try { return JSON.parse(localStorage.getItem(HKEY) || '[]'); } catch { return []; } };
  const saveHistory = h => { try { localStorage.setItem(HKEY, JSON.stringify(h.slice(0, 10))); } catch {} };
  function addHistory(item) {
    const h = loadHistory().filter(x => x.id !== item.id);
    h.unshift(item); saveHistory(h); renderHistory();
  }
  const ago = t => { const s = (Date.now() - t) / 1000; if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + ' min ago'; if (s < 86400) return Math.floor(s / 3600) + ' h ago'; return Math.floor(s / 86400) + ' d ago'; };
  function renderHistory() {
    const h = loadHistory();
    if (!h.length) { $('recentWrap').style.display = 'none'; return; }
    $('recentWrap').style.display = '';
    $('recentList').innerHTML = h.map(x => `<div class="feat" style="display:flex;align-items:center;gap:12px;justify-content:space-between">
      <div style="min-width:0"><div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.url)}</div>
      <div style="color:var(--muted);font-size:13px">${esc(ago(x.time))} · ${esc(x.engine || 'browser')}${x.crawl === 'full' ? ' · whole site' : ''}</div></div>
      <span style="display:flex;gap:8px;flex-shrink:0">${x.canPreview ? `<a class="btn ghost" style="min-height:38px;padding:0 14px" target="_blank" rel="noopener" href="/api/clone/${x.id}/preview/">Preview</a>` : ''}
      <a class="btn" style="min-height:38px;padding:0 14px" href="/api/clone/${x.id}/download">Download</a></span></div>`).join('');
  }
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Inserts admin-provided HTML and re-creates <script> tags so ad code runs.
  function injectHtml(el, html) {
    if (!html) return;
    el.innerHTML = html;
    el.querySelectorAll('script').forEach(old => {
      const s = document.createElement('script');
      [...old.attributes].forEach(a => s.setAttribute(a.name, a.value));
      s.text = old.text;
      old.replaceWith(s);
    });
  }

  fetch('/api/config').then(r => r.json()).then(c => {
    cfg = c;
    document.documentElement.style.setProperty('--primary', c.primaryColor);
    $('logo').textContent = c.logoText || 'SC';
    $('tagline').textContent = c.tagline;
    $('terms').textContent = c.termsText;
    $('footerText').textContent = c.footerText;
    if (!c.browser) {
      $('engine').value = 'fast'; $('engine').querySelector('[value=browser]').disabled = true;
    }
    syncOutput();
    $('maint').style.display = c.maintenance ? 'block' : 'none';
    const sel = $('pages');
    sel.innerHTML = '';
    [1, 3, 5, 10, 20, 50].filter(n => n <= c.maxPagesLimit).concat(c.maxPagesLimit)
      .filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b)
      .forEach(n => sel.add(new Option(n === 1 ? '1 (this page)' : String(n), n)));
    const dsel = $('depth');
    for (let d = 1; d <= (c.fullSiteDepthLimit || 5); d++) dsel.add(new Option(d === 1 ? '1 level' : d + ' levels', d));
    dsel.value = Math.min(3, c.fullSiteDepthLimit || 3);
    if (!c.fullSite) $('crawl').querySelector('[value=full]').disabled = true;
    injectHtml($('adHeader'), c.adHeader);
    injectHtml($('adFooter'), c.adFooter);
    const showPublishUI = () => {
      if (cfg.publish || isAdmin) $('uploadBox').style.display = '';
      if (cfg.aiMerge || (cfg.aiMergeAny && isAdmin)) $('aiBox').style.display = '';
    };
    if (c.publish || c.aiMerge) showPublishUI();
    if (c.publishAny || c.aiMergeAny) fetch('/api/admin/me').then(r => r.json()).then(m => { isAdmin = !!m.admin; showPublishUI(); }).catch(() => {});
  });

  // Upload a ZIP and publish it
  const bindZip = () => {
    if (!$('zipGo')) return;
    $('zipGo').onclick = async () => {
      const f = $('zipFile').files[0];
      $('zipAlert').classList.remove('show'); $('zipResult').style.display = 'none';
      if (!f) { $('zipAlert').textContent = 'Please choose a ZIP file.'; $('zipAlert').classList.add('show'); return; }
      const max = (cfg.maxZipMb || 50) * 1048576;
      if (f.size > max) { $('zipAlert').textContent = `File is larger than ${cfg.maxZipMb} MB.`; $('zipAlert').classList.add('show'); return; }
      $('zipGo').disabled = true; $('zipGo').textContent = 'Uploading…';
      try {
        const fd = new FormData(); fd.append('zip', f);
        const r = await fetch('/api/publish-zip', { method: 'POST', body: fd });
        const d = await r.json();
        if (!r.ok) { $('zipAlert').textContent = d.error || 'Upload failed.'; $('zipAlert').classList.add('show'); }
        else {
          $('zipResult').style.display = ''; $('zipLink').textContent = d.url; $('zipLink').href = d.url;
          if (!d.index) { $('zipAlert').textContent = 'Published, but no index.html found — the site may not open at the root.'; $('zipAlert').classList.add('show'); }
        }
      } catch { $('zipAlert').textContent = 'Network error.'; $('zipAlert').classList.add('show'); }
      $('zipGo').disabled = false; $('zipGo').textContent = 'Upload & publish';
    };
  };
  bindZip();

  // AI merge
  $('aiGo') && ($('aiGo').onclick = async () => {
    const template = $('aiTemplate').value, design = $('aiDesign').value;
    $('aiAlert').classList.remove('show'); $('aiResultWrap').style.display = 'none';
    if (!template.trim() || !design.trim()) { $('aiAlert').textContent = 'Paste both the template and the new design.'; $('aiAlert').classList.add('show'); return; }
    $('aiGo').disabled = true; $('aiGo').textContent = 'Merging…';
    try {
      const r = await fetch('/api/ai-merge', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ template, design, instruction: $('aiInstruction').value }) });
      const d = await r.json();
      if (!r.ok) { $('aiAlert').textContent = d.error || 'Merge failed.'; $('aiAlert').classList.add('show'); }
      else { $('aiResultWrap').style.display = ''; $('aiResult').value = d.merged; }
    } catch { $('aiAlert').textContent = 'Network error.'; $('aiAlert').classList.add('show'); }
    $('aiGo').disabled = false; $('aiGo').textContent = 'Merge with AI';
  });
  $('aiCopy') && ($('aiCopy').onclick = () => { $('aiResult').select(); try { document.execCommand('copy'); $('aiCopy').textContent = 'Copied'; setTimeout(() => $('aiCopy').textContent = 'Copy', 1500); } catch {} });
  $('aiDownload') && ($('aiDownload').onclick = () => {
    const blob = new Blob([$('aiResult').value], { type: 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'merged.txt'; a.click(); URL.revokeObjectURL(a.href);
  });

  let isAdmin = false, lastCloneId = null;
  $('publish').onclick = async () => {
    if (!lastCloneId) return;
    $('publish').disabled = true; $('publish').textContent = 'Publishing…';
    try {
      const r = await fetch('/api/clone/' + lastCloneId + '/publish', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) { showError(d.error || 'Could not publish.'); }
      else { $('published').style.display = ''; $('publishedLink').textContent = d.url; $('publishedLink').href = d.url; $('publish').style.display = 'none'; }
    } catch { showError('Network error while publishing.'); }
    $('publish').disabled = false; $('publish').textContent = 'Publish as website';
  };

  function syncOutput() {
    const fast = $('engine').value === 'fast';
    $('output').querySelectorAll('[value=both],[value=interactive]').forEach(o => o.disabled = fast);
    if (fast) $('output').value = 'static';
    else if ($('output').value === 'static' && !$('output').dataset.touched) $('output').value = 'both';
    syncScope();
  }
  function syncScope() {
    const full = $('crawl').value === 'full';
    $('pagesWrap').hidden = full;
    $('depthWrap').hidden = !full;
  }
  $('engine').onchange = syncOutput;
  $('crawl').onchange = syncScope;
  $('output').onchange = () => { $('output').dataset.touched = 1; };

  const fmt = b => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB';
  const showError = m => { $('alert').textContent = m; $('alert').classList.add('show'); };

  function reset() {
    clearInterval(poll);
    $('status').classList.remove('show');
    $('result').classList.remove('show');
    $('alert').classList.remove('show');
    $('go').disabled = false;
    $('url').disabled = false;
    $('url').focus();
  }
  $('again').onclick = () => { $('url').value = ''; reset(); };

  $('form').addEventListener('submit', async e => {
    e.preventDefault();
    $('alert').classList.remove('show');
    if (!$('agree').checked) return showError('Please tick the checkbox to confirm you have permission to clone this site.');
    const url = $('url').value.trim();
    if (!url) return;
    $('go').disabled = true; $('url').disabled = true;
    $('status').classList.add('show');
    $('result').classList.remove('show');
    $('bar').classList.add('indet');
    $('log').textContent = 'Starting…';
    try {
      const r = await fetch('/api/clone', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, pages: Number($('pages').value), engine: $('engine').value,
          crawl: $('crawl').value, depth: Number($('depth').value), output: $('output').value,
          includeMedia: $('includeMedia').checked, agree: true }),
      });
      const d = await r.json();
      if (!r.ok) { reset(); return showError(d.error || 'Something went wrong.'); }
      track(d.id);
    } catch { reset(); showError('Network error. Please try again.'); }
  });

  function track(id) {
    clearInterval(poll);
    poll = setInterval(async () => {
      let j;
      try { j = await (await fetch('/api/clone/' + id)).json(); } catch { return; }
      if (j.error && !j.status) { clearInterval(poll); reset(); return showError(j.error); }
      $('cPages').textContent = j.progress.pages;
      $('cAssets').textContent = j.progress.assets;
      $('cSize').textContent = fmt(j.progress.bytes);
      $('cFailed').textContent = j.progress.failed;
      if (j.crawl === 'full') { $('cQueuedWrap').hidden = false; $('cQueued').textContent = j.progress.queued || 0; }
      $('log').textContent = j.log.join('\n');
      $('log').scrollTop = 1e6;
      if (j.status === 'done' || j.status === 'error') {
        clearInterval(poll);
        $('bar').classList.remove('indet');
        $('bar').firstElementChild.style.width = '100%';
        $('result').classList.add('show');
        $('go').disabled = false; $('url').disabled = false;
        if (j.status === 'done') {
          $('msg').className = 'msg ok';
          $('msg').textContent = j.output === 'both' && j.engine === 'browser'
            ? 'Clone ready! ZIP has static/ (open index.html) and interactive/ (run START-WINDOWS.bat).'
            : j.output === 'interactive' ? 'Clone ready! Run START-WINDOWS.bat inside the ZIP to open it.' : 'Clone ready! Open index.html inside the ZIP.';
          $('dl').style.display = '';
          $('dl').href = '/api/clone/' + id + '/download';
          if (j.canPreview) { $('preview').style.display = ''; $('preview').href = '/api/clone/' + id + '/preview/'; }
          else $('preview').style.display = 'none';
          lastCloneId = id;
          $('published').style.display = 'none';
          $('publish').style.display = (j.canPreview && (cfg.publish || isAdmin)) ? '' : 'none';
          addHistory({ id, url: $('url').value.trim() || j.url, time: Date.now(), engine: j.engine, crawl: j.crawl, canPreview: j.canPreview });
        } else {
          $('msg').className = 'msg err';
          $('msg').textContent = 'Failed: ' + j.error;
          $('dl').style.display = 'none';
          $('preview').style.display = 'none';
        }
      }
    }, 1000);
  }

  renderHistory();
})();

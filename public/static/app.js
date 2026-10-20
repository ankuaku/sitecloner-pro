(() => {
  const $ = id => document.getElementById(id);
  let cfg = {}, poll = null;

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
    injectHtml($('adHeader'), c.adHeader);
    injectHtml($('adFooter'), c.adFooter);
  });

  function syncOutput() {
    const fast = $('engine').value === 'fast';
    $('output').querySelectorAll('[value=both],[value=interactive]').forEach(o => o.disabled = fast);
    if (fast) $('output').value = 'static';
    else if ($('output').value === 'static' && !$('output').dataset.touched) $('output').value = 'both';
  }
  $('engine').onchange = syncOutput;
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
          output: $('output').value, includeMedia: $('includeMedia').checked, agree: true }),
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
        } else {
          $('msg').className = 'msg err';
          $('msg').textContent = 'Failed: ' + j.error;
          $('dl').style.display = 'none';
        }
      }
    }, 1000);
  }
})();

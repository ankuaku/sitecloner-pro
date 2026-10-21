// Whole-project AI jobs: process every relevant file in an uploaded project ZIP
// and return the full project back as a ZIP.
//   mode 'edit'  — apply a plain-language command to every text/template file
//   mode 'merge' — merge a frontend design ZIP into a backend project, matching files by name
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';

const TEXT_EXT = /\.(html?|php|phtml|ejs|twig|vue|jsx|tsx|svelte|liquid|hbs|handlebars|mustache|erb|aspx|cshtml|astro|htm|css|js|ts|txt|json|xml|md)$/i;
const MERGE_EXT = /\.(html?|php|phtml|ejs|twig|vue|jsx|tsx|svelte|liquid|hbs|erb|aspx|cshtml|astro)$/i; // files worth merging a design into
const SKIP = /(^|\/)(__MACOSX|node_modules|\.git|vendor|dist|build)\//i;
const baseKey = p => path.posix.basename(p).replace(/\.[^.]+$/, '').toLowerCase();

const SYS_EDIT = 'You are a senior web developer. Apply ONLY the change the user asks for to the given file. Keep everything else exactly as it is, including all dynamic/server code (variables, loops, conditionals, includes, form actions, server tags like {{ }}, {% %}, <?php ?>, <%= %>, ${ }). Do not refactor or remove anything unrelated. If this file is clearly irrelevant to the request, return it unchanged. Output ONLY the full file inside one code block, no explanation.';
const SYS_MERGE = 'You are a senior web developer. You merge a new front-end design into an existing server-side template, keeping ALL of the template\'s dynamic code intact — its variables, loops, conditionals, includes, CSRF tokens, form actions and server tags. Apply the new design\'s HTML structure and CSS/classes, wiring every dynamic value from the original into the right place. Do not invent backend variables. Output ONLY the final merged file inside one code block, no explanation.';

function extractCode(text) {
  const m = text.match(/```[a-zA-Z0-9]*\n([\s\S]*?)```/);
  return (m ? m[1] : text).trim();
}

export class AIJob {
  constructor(id, mode, opts, workRoot, callAi) {
    this.id = id;
    this.mode = mode; // 'edit' | 'merge'
    this.opts = { command: '', maxFiles: 60, maxFileBytes: 256 * 1024, ...opts };
    this.callAi = callAi; // async (systemPrompt, userPrompt) => string
    this.status = 'queued';
    this.progress = { total: 0, done: 0, changed: 0, failed: 0, skipped: 0, current: '' };
    this.log = [];
    this.error = null;
    this.createdAt = Date.now();
    this.zipPath = path.join(workRoot, `${id}-ai.zip`);
    this.previewDir = path.join(workRoot, `${id}-ai`);
    this.previewIndex = null;
    this.canPreview = false;
  }
  say(m) { this.log.push(m); if (this.log.length > 200) this.log.shift(); }
  toJSON() {
    return { id: this.id, mode: this.mode, status: this.status, progress: this.progress,
      log: this.log.slice(-14), error: this.error, ready: this.status === 'done',
      canPreview: this.canPreview };
  }

  finalize(out) {
    this.status = 'zipping'; this.say('Packing project…');
    fs.writeFileSync(this.zipPath, out.toBuffer());
    try { out.extractAllTo(this.previewDir, true); } catch {}
    const names = out.getEntries().filter(e => !e.isDirectory).map(e => e.entryName);
    const htmls = names.filter(n => /\.html?$/i.test(n));
    this.previewIndex = htmls.find(n => /(^|\/)index\.html?$/i.test(n)) || htmls.sort((a, b) => a.length - b.length)[0] || null;
    this.canPreview = !!this.previewIndex;
  }

  async run() {
    this.status = 'running';
    try {
      const out = this.mode === 'edit' ? await this.runEdit() : await this.runMerge();
      this.finalize(out);
      this.status = 'done';
      this.say(`Done — ${this.progress.changed} file(s) updated, ${this.progress.skipped} kept, ${this.progress.failed} failed`);
    } catch (e) {
      this.status = 'error';
      this.error = e.message || String(e);
      this.say('Error: ' + this.error);
    }
  }

  async runEdit() {
    const zip = new AdmZip(this.opts.projectBuf);
    const out = new AdmZip();
    const entries = zip.getEntries().filter(e => !e.isDirectory);
    const targets = entries.filter(e => TEXT_EXT.test(e.entryName) && !SKIP.test(e.entryName) && (e.header.size || 0) <= this.opts.maxFileBytes);
    const toProcess = targets.slice(0, this.opts.maxFiles);
    this.progress.total = toProcess.length;
    this.say(`${entries.length} files in ZIP, editing up to ${toProcess.length}`);
    const processed = new Set(toProcess.map(e => e.entryName));

    for (const e of toProcess) {
      this.progress.current = e.entryName;
      try {
        const original = e.getData().toString('utf8');
        const user = `FILE (${e.entryName}):\n\`\`\`\n${original}\n\`\`\`\n\nCHANGE REQUESTED: ${this.opts.command}\n\nReturn the full file only.`;
        const result = extractCode(await this.callAi(SYS_EDIT, user));
        out.addFile(e.entryName, Buffer.from(result, 'utf8'));
        if (result.trim() !== original.trim()) { this.progress.changed++; this.say(`✎ ${e.entryName}`); }
        else { this.progress.skipped++; }
      } catch (err) {
        out.addFile(e.entryName, e.getData()); // keep original on failure
        this.progress.failed++; this.say(`✗ ${e.entryName} (${err.message})`);
      }
      this.progress.done++;
    }
    // copy everything we did not process, untouched
    for (const e of entries) if (!processed.has(e.entryName)) out.addFile(e.entryName, e.getData());
    this.progress.skipped += entries.length - toProcess.length;
    return out;
  }

  async runMerge() {
    const backend = new AdmZip(this.opts.backendBuf);
    const front = new AdmZip(this.opts.frontendBuf);
    const out = new AdmZip();
    const bEntries = backend.getEntries().filter(e => !e.isDirectory);
    // index design files by basename
    const designs = new Map();
    for (const e of front.getEntries()) {
      if (e.isDirectory || SKIP.test(e.entryName) || !/\.(html?|css|htm)$/i.test(e.entryName)) continue;
      if ((e.header.size || 0) > this.opts.maxFileBytes) continue;
      const k = baseKey(e.entryName);
      if (!designs.has(k)) designs.set(k, e);
    }
    const candidates = bEntries.filter(e => MERGE_EXT.test(e.entryName) && !SKIP.test(e.entryName) && designs.has(baseKey(e.entryName)) && (e.header.size || 0) <= this.opts.maxFileBytes);
    const toProcess = candidates.slice(0, this.opts.maxFiles);
    this.progress.total = toProcess.length;
    this.say(`${bEntries.length} backend files, ${designs.size} designs — ${toProcess.length} matched for merge`);
    if (!toProcess.length) this.say('No filename matches found (e.g. product.php ↔ product.html). Backend returned unchanged.');
    const processed = new Set(toProcess.map(e => e.entryName));

    for (const e of toProcess) {
      this.progress.current = e.entryName;
      try {
        const tpl = e.getData().toString('utf8');
        const design = designs.get(baseKey(e.entryName)).getData().toString('utf8');
        const user = `EXISTING BACKEND TEMPLATE (${e.entryName}, keep all dynamic code working):\n\`\`\`\n${tpl}\n\`\`\`\n\nNEW FRONT-END DESIGN:\n\`\`\`\n${design}\n\`\`\`\n\n${this.opts.command ? 'EXTRA INSTRUCTION: ' + this.opts.command + '\n\n' : ''}Return the merged template file only.`;
        out.addFile(e.entryName, Buffer.from(extractCode(await this.callAi(SYS_MERGE, user)), 'utf8'));
        this.progress.changed++; this.say(`✎ ${e.entryName}  ← ${designs.get(baseKey(e.entryName)).entryName}`);
      } catch (err) {
        out.addFile(e.entryName, e.getData());
        this.progress.failed++; this.say(`✗ ${e.entryName} (${err.message})`);
      }
      this.progress.done++;
    }
    for (const e of bEntries) if (!processed.has(e.entryName)) out.addFile(e.entryName, e.getData());
    this.progress.skipped = bEntries.length - toProcess.length;
    return out;
  }
}

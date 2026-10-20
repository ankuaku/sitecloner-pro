# SiteCloner Pro — Website UI Cloner (Node.js)

Paste a URL → get a ZIP with the page's HTML, CSS, JavaScript, images and fonts, with every path rewritten so it opens offline.

## Features
- **Whole-site crawl** — clone every page of a site from one URL (depth + page limits, robots.txt respected), with the Smart or Fast engine
- **Smart engine** — real headless Chrome renders the page first: React, Vue, Angular, Next.js, Nuxt, Svelte
- **Two copies in one ZIP**
  - `static/` — exact, editable HTML + CSS + images + fonts; opens with a double-click
  - `interactive/` — the site's own JS and every loaded response (chunks, fonts, GET API data) replayed offline via a service worker; menus, sliders and routing keep working
- Captures CSS-in-JS (styled-components, Emotion/MUI, JSS), shadow DOM, canvas charts, lazy images, form state
- Fast engine (no browser) for simple sites, multi-page crawl, deep CSS rewrite (`@import`, `url()`, `@font-face`)
- Admin panel: branding, limits, per-IP rate limit, blocked domains, ads, analytics code, maintenance mode, history
- Security: private-network (SSRF) protection on every request (server and browser), size/file/time limits, auto-delete

## Quick start
```bash
npm install
cp .env.example .env      # set ADMIN_PASSWORD and SESSION_SECRET
npm start                 # http://localhost:3000   admin: /admin
```
`npm install` also downloads Chrome for the Smart engine (~170 MB). Use 2 GB RAM for best results.

## Deploy
- **Render.com**: push to GitHub, "New → Blueprint", pick the repo (uses `render.yaml` + `Dockerfile`). Set `ADMIN_PASSWORD`.
- **VPS**: `npm install && npm i -g pm2 && pm2 start ecosystem.config.cjs`, then put Nginx in front.
- **Docker**: `docker build -t sitecloner . && docker run -p 3000:3000 --env-file .env -v $PWD/data:/app/data sitecloner`

Full guide: open `documentation/index.html`.

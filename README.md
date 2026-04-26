# oskarseweryn.github.io

Personal site for [Oskar Seweryn](https://github.com/oskarseweryn) — Data Scientist · AI-First Problem Solver.

Static, no build step. `index.html` + `style.css` deployed straight via GitHub Pages.

## Local preview

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploy

This repo must be named **`oskarseweryn.github.io`** for GitHub Pages user-site routing.

```bash
git init
git add .
git commit -m "init personal site"
git branch -M main
git remote add origin git@github.com:oskarseweryn/oskarseweryn.github.io.git
git push -u origin main
```

GitHub Pages auto-publishes the `main` branch root at `https://oskarseweryn.github.io`.

## Structure

- `index.html` — landing: hero, about, now-building, how-I-work, contact
- `blog/index.html` — `/blog/` notes index
- `projects/index.html` — `/projects/` full project list
- `404.html` — custom GitHub Pages 404
- `style.css` — dark theme, mono accents, scroll-reveal, sticky nav
- `main.js` — vanilla JS: reveal-on-scroll, hero glow, word rotator, card tilt; honors `prefers-reduced-motion`
- No JS framework, no tracker, no fonts CDN — fast and private

## Verifying locally

```bash
python3 -m http.server 8000
# open http://localhost:8000/
# open http://localhost:8000/blog/
# open http://localhost:8000/projects/
# open http://localhost:8000/does-not-exist  # to see 404.html
```

Subpages use absolute paths (`/style.css`, `/main.js`) so they resolve identically under
`python3 -m http.server` and under GitHub Pages user-site routing.

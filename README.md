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

- `index.html` — single-page layout: hero, featured work, how-I-work, contact
- `style.css` — dark theme, mono accents, responsive grid
- No JS framework, no tracker, no fonts CDN — keeps the page fast and private

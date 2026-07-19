# Roulette Chip Analytics

A static casino-style roulette web app with:
- Three.js 3D table rendering with a fixed south-side camera and neck-style pan
- Chart.js payout curve
- American roulette layout with 0, 00, green courtesy bet, dozens, columns, splits, and corners
- Exact per-outcome payout table
- No backend required

## Run locally

Because this app is static, you can run it with any lightweight file server.

### Option 1: Python
```bash
python3 -m http.server 8000
```
Then open <http://localhost:8000>

**Controls:** click to place chips; right-drag, Shift-drag, or Alt-drag to look around the table.

### Option 2: Node
```bash
npx serve .
```
Then open the local URL it prints.

## Project structure

```
roulette-cursor-project/
├── index.html
├── README.md
├── .gitignore
└── package.json
```

## Cursor workflow

Open the folder in Cursor and use prompts like:
- "Refactor this single-file app into separate HTML, CSS, and JS files."
- "Add animated chip drops and a spinning roulette wheel overlay."
- "Make the board responsive for mobile while preserving chip hit targets."
- "Replace Chart.js with a custom canvas chart for a fully self-contained build."

## Cheap hosting

Good static hosting options:
- GitHub Pages
- Cloudflare Pages
- Netlify
- Vercel

This app currently uses CDN-hosted Fontshare fonts and Chart.js, so it works well on any static host.

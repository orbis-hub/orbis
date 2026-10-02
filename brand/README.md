# orbis brand

pixel art on a 16×16 grid, like the rest of the app. regenerate everything with `node brand/generate.mjs` (needs the root devDependency `sharp`).

| file | use |
| --- | --- |
| `logo.svg` / `logo-dark.svg` | the mark, transparent, light / dark palette |
| `logo-mono.svg` | single colour (`currentColor`) for favicons, status bars |
| `logo-tile.svg`, `png/avatar-*.png` | mark on dark paper with padding: org/repo avatars, app icon |
| `wordmark.svg` / `wordmark-dark.svg` / `wordmark-auto.svg` | mark + "orbis"; `-auto` switches with `prefers-color-scheme` (works in github readmes) |
| `wordmark-text.svg` | just the letters, `currentColor` |
| `social-preview.svg` / `png/social-preview.png` | 1280×640 repo social preview |

colours: pink `#e2789b` (dark `#ff8fb4`), lavender `#8b7fd6` (dark `#b0a4ff`), ink `#3b2c3a` (dark `#f1e7f0`), paper dark `#1f1826`, bg dark `#17121c`.

the mark is an orbit: ring (pink), core (lavender), one satellite (lavender) outside the ring. keep it on the grid – no anti-aliasing, no rounded corners.

## favicons

`node brand/favicons.mjs` writes `favicon.ico` (16/32/48), `favicon-32.png`, `apple-touch-icon.png` and the manifest pngs (192, 512, maskable) into `apps/web/public/` from `logo-tile.svg` and the small pixel mark in `apps/web/public/icon.svg`. the web app references them in `app/layout.tsx` and `manifest.webmanifest`.

# 2026-11-15T05:20+08:00 — Viewer tab identity (favicon + per-design title) and a README demo image

**1. Viewer tab identity**
- `ui/public/favicon.svg` — square mark: paper tile `#FAF4EF` (rx 14/64) with the existing logo paths (head silhouette `#205080` + gold brush tip `#908030`) fitted to the tile. Generated from `assets/logo.svg` so geometry stays identical; Inkscape namespace attributes stripped so the file is standalone-valid.
- `ui/public/favicon-32.png`, `ui/public/apple-touch-icon.png` — raster fallbacks (Safari < 26, iOS home screen).
- `ui/index.html` — title `paintress · design viewer`, description, the three icon links, `theme-color #f6f1ea` (matches the app's paper background).
- `ui/src/App.tsx` — `createEffect` writes `document.title`: `<file> · paintress`, else `<project> · paintress`, else the shell title.
- `src/web/daemon.ts` — the server-rendered fallback page (`layout()`) gets the same icon links and a viewport meta.

**2. README demo**
- `demo/demo-calculator.webp` — 1600×809, 32 KB, cropped from the operator's screenshot to the viewer-only area (browser chrome and desktop wallpaper removed), WebP q88 method 6.
- `README.md` / `README.zh-CN.md` — centered hero image linking to the full-size file, captioned with the originating prompt (`设计一个时尚的计算器界面` + English gloss).

## Why demo/ and not assets/

`package.json` `files` is a whitelist (`dist`, `ui/dist`, `skills`, `assets`), so anything in `demo/` stays out of the npm tarball. Verified: `npm pack --dry-run --ignore-scripts` lists 18 files and no demo entry. Consequence, accepted by the operator: the image renders on GitHub but not on npmjs.com.

## Verification

- `pnpm check` (tsc --noEmit) clean.
- `pnpm build` clean; `ui/dist/index.html` carries the new title and icon links; `/favicon.svg`, `/favicon-32.png`, `/apple-touch-icon.png` all serve 200 `image/svg+xml` / `image/png`.
- `pnpm test`: 32 files / 418 tests pass, including the new `标签页标题：跟着当前设计稿走` case in `test/ui-interaction.spec.ts` (real Chromium, asserts `design.ptr · paintress` then `second.ptr · paintress`).
- Commits: `3ccaf72` (viewer identity), `683f7e1` (README demo). Not pushed.

# 2026-11-15T17:05+08:00 — Count highlight expiry from the last write and shorten it to three minutes

1. The first expiry implementation started a fresh five-minute timer whenever `applyChanges()` painted the highlight. A refresh four minutes after an edit could therefore keep the ring alive for almost ten minutes, violating the idle-time requirement. Added `ui/src/changed.ts` with a pure `changedRemainingMs(at, now)` helper; the viewer now schedules only the remaining lifetime from the daemon's write timestamp. It also clears stale timers before applying a new file's changes.
2. The requested lifetime is now **3 minutes**, not 5. Both `ChangesStore` and the viewer use the same window, and tool/SKILL/README text was updated.

## Explanation for the old 60-second behavior

The previous daemon TTL only controlled whether `/api/changes` returned ids and whether a later repaint could recreate the highlight. It never removed `data-ptr-changed` from the already-rendered iframe, so the user could not observe it expiring. The new client timer and `changes-cleared` event provide the missing active removal.

## Verification

- Added pure time-math tests: fresh record = 3 minutes, two-minute-old record = one minute left, expired = zero, missing timestamp = full fallback; also asserts UI and daemon TTL constants stay equal.
- Rebuilt UI/server, `pnpm check` clean, full `pnpm test`: 34 files / **450 tests pass**.

Out-of-scope note: ast-grep reports pre-existing conditional-spread/nested-ternary style warnings in `src/mcp/tools.ts`; the only tools.ts line changed in this review is the 5→3 minute description, so those warnings were recorded rather than refactored.

# 2026-11-15T14:34+08:00 — Close the design-root force, config and auto-register gaps found in review

Reviewed only the design-root / project-root-guard round (`9bca6f4`).

1. `force: true` previously could not recover from `confident: false`: `ensureViewer` threw before the request reached the daemon, even though the error text recommended `force`. It now deliberately selects the supplied cwd, marks the decision confident, and lets the same force flag pass the daemon guard. Covered through the real `paintress_viewer` tool entry.
2. `autoRegister(cwd)` previously resolved against `process.cwd()` and used its argument only for logging. Added `EnsureViewerOptions.cwd` and pass it through, so the caller-supplied project directory is actually inspected.
3. Invalid `paintress.json` (bad JSON, invalid `root`, missing/non-directory target) previously fell through to heuristics and could register a different directory. Declarations now fail closed with a specific message.
4. Upward config lookup could cross a repository root and apply an unrelated ancestor's `paintress.json`. Lookup now stops at repository boundaries while allowing `AGENTS.md`/`CLAUDE.md` in nested directories.
5. Successful root decisions are cached per cwd/explicit directory for the MCP process, avoiding a synchronous child-tree scan before every write. Uncertain decisions remain uncached so creating `design/` takes effect on the next call.
6. Blank explicit `dir` is treated as omitted, and watch usage/docs now show `--force`.

## Verification

- Focused: `pnpm vitest run test/design-root.spec.ts test/viewer-ensure.spec.ts` — 31 tests pass.
- `pnpm check` — clean.
- `pnpm build` — clean.
- `pnpm test` — final sequential run: 33 files / 438 tests pass. An earlier run executed concurrently with the build had one UI-test failure; the sequential rerun passed in full.

Remaining limitations are heuristic rather than regressions: only cwd plus direct children are candidates, child inspection is capped at 100 directories, and a design directory carrying project-root markers but no designs still requires `--force`.

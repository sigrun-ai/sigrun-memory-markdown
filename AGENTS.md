# AGENTS.md — sigrun-memory-markdown

Guidance for coding agents working in this repository.

## What this is

`@sigrun/memory-markdown`: long-term memory for
[sigrun](https://github.com/sigrun-ai/sigrun) — per-user `USER.md` /
`MEMORY.md` under hard char limits, rendered live into the
`long-term-memory` section, plus the `memory` curation target
(`memory_write` / `undo` / `maintain`) that makes the package a worked
example of sigrun's curation-targets contract (P7). The curator is the
only writer; `memory_recall` still searches the calling conversation's
transcript only.

A sigrun extension (pi-durable loader contract): a default export or
named factory consumed by sigrun's extension loader. Small,
single-purpose, no cross-extension coupling. Requires a sigrun core
build with curationTargets support (no `@sigrun/sigrun` runtime
dependency — types are a devDependency).

## Layout

- `src/index.ts` — public surface (re-exports the factory + types).
- `src/degenerate.ts` — the wiring: factory, extension (tools +
  section), `runSettled`/`userDeleted` handlers, live-section render.
- `src/backend.ts` — the `MemoryBackend` contract (observe/recall/section).
- `src/files.ts` — per-user memory files: limits, atomic batches,
  versions, undo, the delimiter guard.
- `src/target.ts` — the `memory` curation target + `memory_write` tool.
- `test/` — vitest suites. `scripts/check-manifest.mjs` — manifest
  hygiene (runs in `npm test`).
- `dist/` — **committed build output** (git-source installs load
  `dist/index.js` with no build step). Rebuild with `npm run build` and
  commit whenever `src/` moves; a stale dist is ship-blocking.

## Run and test

```sh
npm install
npm test            # check-manifest + vitest
npm run typecheck   # tsc --noEmit
npm run build       # tsc -> dist/ (commit the result)
```

## Conventions

- **Commit dist**: tracked by design (see the `.gitignore` comment). If
  `git status` shows `dist/` changes after a build, those belong in the
  same commit as the source change.
- **Verification before completion**: `npm test` + `npm run typecheck` +
  `npm run build` with a clean `git status -- dist` before claiming done.
- Tests own their literals: synthetic hosts (`example.invalid`), no real
  tokens or private URLs in fixtures.
- **CHANGELOG discipline**: user-visible changes land in `CHANGELOG.md`
  (Keep-a-Changelog) in the same commit as the change; the minimum
  sigrun-core version in the README gets pinned at release time, not in
  feature commits.

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.5] - 2026-11-08

- CI: test against the latest released core (core-ref: release). No code change.

## [0.2.4] - 2026-11-07

## [Unreleased]

### Changed

- Declare the `limits` settings as JSON Schema through `host.settings.declare`, so the extension's settings page is a generated form (a `Limits` group holding the `USER` and `MEMORY` budgets). The hand-written `mergeLimits` parser is gone: core's checked read applies the defaults (`DEFAULT_LIMITS`, 1375/2200) and repairs a malformed or non-positive stored limit to them — the old gentle-parse fallback, now with a load-time warning and an admin notice instead of silence. Requires sigrun 0.13.0 or newer.
- **Fix:** the `limits` setting now actually applies. The factory used to read it during its body, i.e. under the loader's provisional, package-derived slug (`memory-markdown`), while the settings page writes the extension's declared slug (`sigrun-memory`, from the `sigrun.memory` name) — so an edited limit never reached the files. The read moved to first use and is memoized for the boot; `MemoryFilesFor` is now async (`files(user)` and `files.limits()` return promises).
- peer pi-durable/pi-ai/chord ~1.5.0 (requires sigrun 0.11.0).


## [0.2.1] - 2026-11-02
### Fixed
- The lockfile carries the `@sigrun` sibling link entries, so `npm ci`
  (the release test job) is in sync with the `file:` dev specs.

## [0.2.0] - 2026-11-01
### Added
- Per-user long-term memory files: `USER.md` (who the user is —
  preferences, communication and work style) and `MEMORY.md` (their
  environment and projects — tool quirks, paths, endpoints, decisions)
  under the owner's data directory. One fact is one entry, entries are
  joined by `§` separators, and every accepted change saves the previous
  bytes as a version (newest ten per file) so any change can be undone.
- The `memory` curation target (the curator contract, spec P7): the
  `memory_write` tool — one atomic batch of `add`/`replace`/`remove`
  operations over one file, reporting `details.curation = {changeId,
  summary}` for the curator's undo surface — plus routing guidance,
  `undo`, and a `maintain` pass (toolless digest runs per non-empty
  file; a proposal that would remove more than a quarter of a file's
  entries is discarded). The factory result carries the target on
  `curationTargets`; the curator is the only writer, and a
  `memory_write` call outside a curator run is captured as a review
  hint ("remember this") rather than applied.
- Hard per-file char limits (default 1375 for `USER.md`, 2200 for
  `MEMORY.md`), checked on the batch RESULT — a batch that removes or
  shortens enough to fit is one atomic step, never a rejected
  intermediate state. The deployment `limits` settings block
  (`{"limits":{"user":1375,"memory":2200}}`) overrides them; read
  once at startup (restart-required, per the sigrun convention).
- The `long-term-memory` section now renders real memory: the
  conversation owner's two files, each under a usage header (`USER
  PROFILE [63% — 867/1375 chars]`). Existing installs start empty — the
  files do not exist until the first write, and the section shows
  `No long-term memories yet.` until then. A file that cannot be read
  is reported in place and left unchanged, never repaired.

### Changed
- Requires a sigrun core build that ships the curation-targets
  contract (P7, `curationTargets` on the extension factory result).
  That core support is unreleased at the time of this version bump, so
  the minimum core version is deliberately not stated as a number —
  it gets pinned in the README at release time. The package still adds
  no `@sigrun/sigrun` dependency: the core types stay a devDependency.
- **Breaking (behaviour):** `userDeleted` now DELETES the departing
  user's memory — observe ring, `USER.md`/`MEMORY.md`, and versions —
  instead of transferring the ring to the receiving owner. Memory is
  personal: it describes its user, and a recipient's memory must never
  absorb it. A recreated same-name user starts fresh.

### Fixed
- `add`/`replace` text containing the entry delimiter (`\n§\n`) is
  rejected before anything is written. Such text would embed the
  separator inside one entry, so the next read would re-segment the
  file — entry counts and match uniqueness shifting under the layer's
  own contract. This layer can no longer produce delimiter-embedded
  entries.

## [0.1.2] - 2026-10-29
### Changed
- Forward-compatible with pi-durable 1.4.0 (widened peer range). No
  behaviour change.

## [0.1.1] - 2026-10-27
### Added
- `userDeleted` transfers the deleted owner's observed records to the
  receiving owner's ring, appending them after existing records and marking
  each with `transferredFrom`. The combined ring keeps the same capacity
  bound, while self-transfers and owners without records leave memory
  unchanged.

### Security
- `memory_recall` now searches only the calling conversation. It previously
  read whichever conversation settled a run most recently, regardless of
  owner, so one user's agent could read another user's transcript through a
  tool that described itself as searching "this conversation". A
  conversation that has never settled answers "No matches found" instead of
  reaching another conversation's history.

### Changed
- Breaking, for a backend implementing `MemoryBackend`: `recall` now takes
  the conversation to search (`recall(query, conversationId, context)`) and
  no longer reads one process-global source, and `ObserveRecord` gained an
  optional `owner`.
- A conversation's transcript reader is resolved from the runs that have
  settled **in this process**, so a recall issued before it is as useless as
  before a restart: it answers "No matches found" even though the transcript
  is durable and readable. Resolving the reader per call would need a
  history reader on `ToolExecutionApi`, which pi-durable 1.3.0 does not
  expose; the per-conversation map is the only shape that answers from the
  calling conversation rather than the latest one.

## [0.1.0] - 2026-10-13
### Added
- Renamed to `@sigrun/memory-markdown` for the 0.1.0 release (repo
  stays `sigrun-ai/sigrun-memory-markdown`): the factory is now the
  package's DEFAULT export (the sigrun extension contract's supported
  form; the named `createMemory` export remains), published package
  metadata (`publishConfig` access/provenance), host modules moved to
  `peerDependencies` mirrored in `devDependencies` at exact `1.3.0`,
  CHANGELOG.md joined the files whitelist, and a manifest hygiene check
  wired into `npm test`.
- Markdown memory-backend for sigrun (the degenerate-memory reference):
  observe/recall tools over markdown files with a capacity-bounded ring,
  long-term-memory section, and memory-recall submit binding.## [0.2.3] - 2026-11-02
### Fixed
- The 0.2.2 lockfile version stamp (its tag predates the stamp fix and
  cannot move — immutable ruleset; it publishes nothing).



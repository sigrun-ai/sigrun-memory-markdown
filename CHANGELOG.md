# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Changed
- Forward-compatible with pi-durable 1.4.0 (widened peer range). No behaviour change.

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
  long-term-memory section, and memory-recall submit binding.

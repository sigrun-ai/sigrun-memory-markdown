# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security
- `memory_recall` now searches only the calling conversation. It previously
  read whichever conversation settled a run most recently, regardless of
  owner, so one user's agent could read another user's transcript through a
  tool that described itself as searching "this conversation". A
  conversation that has never settled answers "No matches found" instead of
  reaching another conversation's history.

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

# @sigrun/memory-markdown

Degenerate MemoryBackend extension for [sigrun](https://github.com/sigrun-ai/sigrun) (pi-durable): the reference implementation satisfying the sigrun spec §3 memory row. `createMemory(host)` takes the host as its first declared parameter (the sigrun loader's arity rule) and returns `{ backend, extension, files, runSettled, userDeleted }`; the host's memory seam delivers settled runs to `runSettled`, which observes both halves of an answered turn. The returned extension installs the `memory_recall` tool and the live `long-term-memory` section: it resolves the conversation's owner (`host.identity.actingUser`) and renders that user's `USER.md` and `MEMORY.md` under usage headers, entries joined by `§` lines; empty or ownerless memory renders a neutral line (`wiring.files(owner)` exposes the same per-user `MemoryFiles` the memory target writes). Recall searches only the CALLING conversation's durable transcript, including history compacted out of the live window — never another conversation's transcript. Observe rings are keyed per owner (`""` when ownerless), and `userDeleted` transfers the departing owner's ring to the receiving owner without moving transcript readers. Richer backends (spec B's honcho mapping) implement the same `MemoryBackend` interface; this package is the reference that mapping targets.

## Install

```sh
npm install @sigrun/memory-markdown
```

```ts
import createMemory from "@sigrun/memory-markdown";

const memory = await createMemory(host);
registry.install(memory.extension);
// The host memory seam delivers memory.runSettled and memory.userDeleted.
```

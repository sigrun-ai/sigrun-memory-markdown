# @sigrun/memory-markdown

Degenerate MemoryBackend extension for [sigrun](https://github.com/sigrun-ai/sigrun) (pi-durable): the reference implementation satisfying the sigrun spec §3 memory row. `createMemory()` returns `{ backend, extension, runSettled, userDeleted }`; the host's memory seam delivers settled runs to `runSettled`, which observes both halves of an answered turn. The returned extension installs the `memory_recall` tool and the stable `long-term-memory` placeholder section. Recall searches only the CALLING conversation's durable transcript, including history compacted out of the live window — never another conversation's transcript. Observe rings are keyed per owner (`""` when ownerless), and `userDeleted` transfers the departing owner's ring to the receiving owner without moving transcript readers. Richer backends (spec B's honcho mapping) implement the same `MemoryBackend` interface; this package is the reference that mapping targets.

## Install

```sh
npm install @sigrun/memory-markdown
```

```ts
import createMemory from "@sigrun/memory-markdown";

const memory = createMemory();
registry.install(memory.extension);
// The host memory seam delivers memory.runSettled and memory.userDeleted.
```

# @sigrun/ext-memory-markdown

Degenerate MemoryBackend extension for [sigrun](https://github.com/sigrun-ai/sigrun) (pi-durable): the reference implementation satisfying the sigrun spec §3 memory row. `createMemory()` wires the `afterResponse` observe hook, the `memory_recall` tool, and the stable `long-term-memory` placeholder section over one durable Harness — install the returned extension into your registry and submit through the wiring's `submit()` so both halves of each turn are observed; recall scans the durable transcript (`conversation.entries()`), so it reaches history the live window compacted away. Richer backends (spec B's honcho mapping) implement the same `MemoryBackend` interface; this package is the reference that mapping targets.

## Install

```sh
npm install @sigrun/ext-memory-markdown
```

```ts
import createMemory from "@sigrun/ext-memory-markdown";

const memory = createMemory();
registry.install(memory.extension);
// then submit inputs through memory.submit(root, draft, context)
```

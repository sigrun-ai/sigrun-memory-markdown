/**
 * @sigrun/memory-markdown: the degenerate MemoryBackend extension
 * for sigrun.
 *
 * The public surface of the package. The DEFAULT export (the
 * `createMemory()` factory) is what a host integrates — the sigrun
 * extension contract's supported form (the host is the first declared
 * parameter, per the loader's arity rule); the named `createMemory`
 * export remains for direct programmatic use. The types are what spec B's
 * richer backends implement.
 */
export { createMemory, createMemory as default, DegenerateMemoryBackend, MEMORY_PLACEHOLDER, renderMemorySection, } from "./degenerate.js";
export type { MemoryEventApi, MemoryFilesFor, MemoryHost, MemoryWiring, RunSettledEvent, UserDeletedPayload, } from "./degenerate.js";
export type { MemoryBackend, MemoryRole, ObserveRecord, RecallResult, } from "./backend.js";

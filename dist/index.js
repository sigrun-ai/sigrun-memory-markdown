/**
 * sigrun-ext-memory-markdown: the degenerate MemoryBackend extension for sigrun.
 *
 * The public surface of the package. `createMemory()` is what a host
 * integrates; the types are what spec B's richer backends implement.
 */
export { createMemory, DegenerateMemoryBackend, MEMORY_PLACEHOLDER, } from "./degenerate.js";

/**
 * sigrun-ext-memory-markdown: the degenerate MemoryBackend extension for sigrun.
 *
 * The public surface of the package. `createMemory()` is what a host
 * integrates; the types are what spec B's richer backends implement.
 */

export {
	createMemory,
	DegenerateMemoryBackend,
	MEMORY_PLACEHOLDER,
} from "./degenerate.js";
export type {
	MemoryEventApi,
	MemoryWiring,
	RunSettledEvent,
} from "./degenerate.js";
export type {
	MemoryBackend,
	MemoryRole,
	ObserveRecord,
	RecallResult,
} from "./backend.js";
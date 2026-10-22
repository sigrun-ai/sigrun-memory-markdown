/**
 * @sigrun/memory-markdown: the degenerate MemoryBackend extension
 * for sigrun.
 *
 * The public surface of the package. The DEFAULT export (the
 * `createMemory()` factory) is what a host integrates — the sigrun
 * extension contract's supported form; the named `createMemory` export
 * remains for direct programmatic use. The types are what spec B's
 * richer backends implement.
 */

export {
	createMemory,
	createMemory as default,
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
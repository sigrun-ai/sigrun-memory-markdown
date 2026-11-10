/**
 * @sigrun/memory-markdown: the degenerate MemoryBackend extension
 * for sigrun.
 *
 * The public surface of the package. The DEFAULT export (the
 * `createMemory()` factory) is what a host integrates — the sigrun
 * extension contract's supported form (the host is the first declared
 * parameter, per the loader's arity rule); the named `createMemory`
 * export remains for direct programmatic use. The factory result also
 * carries the `memory` curation target (Task C3) on its
 * `curationTargets`. The types are what spec B's richer backends
 * implement.
 */

export {
	createMemory,
	createMemory as default,
	DegenerateMemoryBackend,
	MEMORY_PLACEHOLDER,
	renderMemorySection,
} from "./degenerate.js";
export type {
	MemoryEventApi,
	MemoryFilesFor,
	MemoryHost,
	MemoryWiring,
	RunSettledEvent,
	UserDeletedPayload,
} from "./degenerate.js";
export {
	createMemoryTarget,
	MEMORY_GUIDANCE,
	memoryWriteTool,
} from "./target.js";
export type {
	MemoryBackend,
	MemoryRole,
	ObserveRecord,
	RecallResult,
} from "./backend.js";
export { MEMORY_MARKDOWN_SETTINGS_SCHEMA } from "./settings-schema.js";
export type { MemoryMarkdownSettings } from "./settings-schema.js";

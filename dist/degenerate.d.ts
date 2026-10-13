/**
 * The degenerate memory backend (spec §3 memory row, M1): proves the
 * {@link MemoryBackend} seam end-to-end with zero external services.
 *
 * - `observe` appends to an in-process ring buffer — the schema is what
 *   spec B's honcho mapping consumes; the buffer itself is intentionally
 *   volatile (a degenerate backend is not durable memory).
 * - `recall` scans the durable transcript (`conversation.entries()`,
 *   newest-first, paginated) — NOT the observe buffer — so it reaches
 *   entries the live context window compacted away (App C verification).
 * - `section` returns the stable placeholder; spec B replaces the string.
 *
 * App C.1 user capture: `HookApi` exposes no submission/entry reads, and
 * `LiveDoc.run.inputs` carries submission *ids*, not text. So the user half
 * of each turn is captured at the submit boundary: hosts submit through the
 * wiring's `submit()` (which records submission id → text and binds the
 * conversation as the recall source), and the generation `afterResponse`
 * hook pairs those texts with the live run's input ids. Conversations whose
 * inputs bypass `submit()` observe assistant records only — documented,
 * not silently guessed.
 *
 * Replay guard: generation retries and crash recovery re-run `afterResponse`
 * for the same generation task; `api.memo` keyed by the generation id makes
 * the observe side effect first-write-wins.
 */
import type { Context } from "@earendil-works/chord";
import type { Conversation, Extension, Submission, SubmissionDraft } from "@earendil-works/pi-durable";
import type { MemoryBackend, ObserveRecord, RecallResult } from "./backend.js";
/** The stable `long-term-memory` section until a real backend is wired (spec B). */
export declare const MEMORY_PLACEHOLDER = "long-term memory backend not configured";
/** Ring buffer capacity; the oldest records drop once full. */
export declare const DEFAULT_RING_CAPACITY = 1000;
/** Anything with the `Conversation.entries` newest-first history scan. */
type RecallSource = Pick<Conversation, "id" | "entries">;
/**
 * The degenerate backend: in-process observe ring + transcript recall.
 * Bind a conversation (the wiring does, at the submit boundary) to give
 * `recall` its durable source.
 */
export declare class DegenerateMemoryBackend implements MemoryBackend {
    #private;
    readonly capacity: number;
    constructor(capacity?: number);
    observe(record: ObserveRecord): void;
    recall(query: string): Promise<RecallResult[]>;
    section(): string;
    /** Bind `source` as the conversation `recall` scans. Wiring-internal. */
    bindRecallSource(source: RecallSource): void;
    /** Whether a recall source is bound (the tool's no-early-answers guard). */
    hasRecallSource(): boolean;
    /** The observed records, oldest first. Test/diagnostic surface. */
    records(): readonly ObserveRecord[];
}
/** Scan one conversation's newest-first history for query matches. */
export declare function recallFromEntries(source: RecallSource, query: string, context: Context): Promise<RecallResult[]>;
/** What `createMemory` wires together for a host. */
export interface MemoryWiring {
    /** The backend the extension observes into and the tool recalls from. */
    readonly backend: DegenerateMemoryBackend;
    /** Install into the harness registry (hooks/tools/section). */
    readonly extension: Extension;
    /**
     * Submit through the memory wiring: records the input text for the
     * observe hook, binds the conversation as the recall source, and admits
     * the submission. Hosts that bypass this observe assistant records only.
     */
    submit(root: Conversation, submission: SubmissionDraft, context: Context): Promise<Submission>;
}
/** Build the degenerate memory wiring. */
export declare function createMemory(backend?: DegenerateMemoryBackend): MemoryWiring;
export {};

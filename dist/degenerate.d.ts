/**
 * The degenerate memory backend (spec §3 memory row, M1): proves the
 * {@link MemoryBackend} seam end-to-end with zero external services.
 *
 * - `observe` appends to an in-process ring buffer — the schema is what
 *   spec B's honcho mapping consumes; the buffer itself is intentionally
 *   volatile (a degenerate backend is not durable memory).
 * - `recall` scans the durable transcript (`entries()`, newest-first,
 *   paginated) — NOT the observe buffer — so it reaches entries the live
 *   context window compacted away (App C verification).
 * - `section` returns the stable placeholder; spec B replaces the string.
 *
 * Capture (memory-seam port): the host delivers one `runSettled` event per
 * settled run — the run's input texts already host-resolved from the
 * durable transcript, plus the run's outcome (the final answer, or the
 * unanswered reason). The extension observes the user halves from
 * `inputTexts` and the assistant half from an answered outcome; an
 * unanswered run observes NOTHING (no orphan user record — the behavior
 * the pre-seam afterResponse hook pinned). The same delivery binds the
 * event's entries surface as the recall source, so no submit-boundary
 * pass-through exists anymore.
 */
import type { Context } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Cursor, EntryId, EntryRecord, Extension, Page, SubmissionId } from "@earendil-works/pi-durable";
import type { MemoryBackend, ObserveRecord, RecallResult } from "./backend.js";
/** The stable `long-term-memory` section until a real backend is wired (spec B). */
export declare const MEMORY_PLACEHOLDER = "long-term memory backend not configured";
/** Ring buffer capacity; the oldest records drop once full. */
export declare const DEFAULT_RING_CAPACITY = 1000;
/**
 * The settled-run event the host delivers to {@link MemoryWiring.runSettled}
 * — a structural mirror of sigrun core's `RunSettledEvent`
 * (src/harness/event-bus.ts; this package has no core dependency, so the
 * shapes are restated here and the loader validates the handler by name).
 * `inputTexts` is position-paired with `inputs`; an input whose entry is
 * unresolvable contributes `""` at its position.
 */
export interface RunSettledEvent {
    readonly conversationId: number;
    readonly inputs: readonly SubmissionId[];
    readonly inputTexts: readonly string[];
    readonly outcome: {
        readonly status: "answered";
        readonly answerEntryId: EntryId;
        readonly answer: AssistantMessage;
    } | {
        readonly status: "unanswered";
        readonly reason: string;
    };
}
/**
 * The narrowed read surface a `runSettled` handler receives — a structural
 * mirror of sigrun core's `MemoryEventApi`. `entry`/`entries` are bound to
 * the event's conversation; `document` reads any conversation's doc.
 */
export interface MemoryEventApi {
    entry(id: EntryId, context: Context): Promise<EntryRecord | undefined>;
    entries(query: Record<string, never>, limit: number, cursor: Cursor | undefined, context: Context): Promise<Page<EntryRecord, Cursor>>;
    document(token: unknown, conversationId: number, context: Context): Promise<unknown>;
}
/** Anything with the newest-first history scan recall needs. */
type RecallSource = {
    readonly id: number;
    entries: MemoryEventApi["entries"];
};
/**
 * The degenerate backend: in-process observe ring + transcript recall.
 * The wiring attaches the recall source when the first `runSettled` event
 * arrives; before that, recall reports the unbound state, never guesses.
 */
export declare class DegenerateMemoryBackend implements MemoryBackend {
    #private;
    readonly capacity: number;
    constructor(capacity?: number);
    observe(record: ObserveRecord): void;
    recall(query: string): Promise<RecallResult[]>;
    section(): string;
    /**
     * Wiring-internal: the `runSettled` delivery attaches the settled
     * conversation's transcript as the recall source. Hosts never call this.
     */
    attachRecallSource(source: RecallSource): void;
    /** Whether a recall source is attached (the tool's no-early-answers guard). */
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
    /** Install into the harness registry (tools/section). */
    readonly extension: Extension;
    /**
     * The host's settled-run delivery (sigrun memory seam): observes the
     * run's user inputs (host-resolved `inputTexts`) and, when the run
     * answered, the assistant answer; attaches the settled conversation as
     * the recall source. An unanswered run observes nothing.
     */
    runSettled(event: RunSettledEvent, api: MemoryEventApi, context: Context): void | Promise<void>;
}
/** Build the degenerate memory wiring. */
export declare function createMemory(backend?: DegenerateMemoryBackend): MemoryWiring;
export {};

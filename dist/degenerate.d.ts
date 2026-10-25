/**
 * The degenerate memory backend (spec §3 memory row, M1): proves the
 * {@link MemoryBackend} seam end-to-end with zero external services.
 *
 * - `observe` appends to an in-process ring buffer — the schema is what
 *   spec B's honcho mapping consumes; the buffer itself is intentionally
 *   volatile (a degenerate backend is not durable memory). Rings are
 *   keyed by the run's owner (`""` when ownerless), so one user's turns
 *   never sit in another user's ring.
 * - `recall` scans the durable transcript (`entries()`, newest-first,
 *   paginated) — NOT the observe buffer — so it reaches entries the live
 *   context window compacted away (App C verification). Recall reads the
 *   CALLING conversation's transcript only: pi-durable 1.3.0's
 *   `ConversationHandle` has no `entries`, and `ToolExecutionApi` no
 *   history reader, so each `runSettled` records that conversation's
 *   transcript reader and the tool looks up its own conversation id.
 * - `section` returns the stable placeholder; spec B replaces the string.
 *
 * The recorded readers are held in PROCESS memory, not in the durable
 * store: after a restart a conversation has no reader again until its
 * next run settles, so a recall that lands before that answers "No
 * matches found." even though the transcript is intact and readable. The
 * alternative — resolving the reader per call — needs a history reader on
 * `ToolExecutionApi`, which pi-durable 1.3.0 does not expose, so the
 * per-conversation map is the only shape that answers from the calling
 * conversation instead of the latest one.
 *
 * Capture (memory-seam port): the host delivers one `runSettled` event per
 * settled run — the run's input texts already host-resolved from the
 * durable transcript, plus the run's outcome (the final answer, or the
 * unanswered reason). The extension observes the user halves from
 * `inputTexts` and the assistant half from an answered outcome; an
 * unanswered run observes NOTHING (no orphan user record — the behavior
 * the pre-seam afterResponse hook pinned). The same delivery records the
 * event's entries surface as that conversation's recall source, so no
 * submit-boundary pass-through exists anymore.
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
 * The settled-run event the host delivers to {@link MemoryWiring.runSettled}.
 * It restates sigrun core's `RunSettledEvent` (src/harness/event-bus.ts) so
 * this package carries no core dependency, and the loader validates the
 * handler by name rather than by shape.
 *
 * Core stamps `owner`; it is absent for ownerless conversations. `inputTexts` is
 * position-paired with `inputs`; an input whose entry is unresolvable
 * contributes `""` at its position.
 */
export interface RunSettledEvent {
    readonly conversationId: number;
    readonly owner?: string;
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
 * The user-removal transfer payload, restating sigrun core's
 * `UserDeletedPayload` so this package carries no core dependency. The
 * loader validates `userDeleted` handlers by name rather than by shape.
 */
export interface UserDeletedPayload {
    readonly user: string;
    readonly transferTo: string;
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
 * The degenerate backend: in-process observe rings + transcript recall.
 * Each `runSettled` delivery records its conversation's transcript reader,
 * so recall answers from the calling conversation and nothing else; a
 * conversation that never settled has no source and reports no matches —
 * never another conversation's history.
 */
export declare class DegenerateMemoryBackend implements MemoryBackend {
    #private;
    readonly capacity: number;
    constructor(capacity?: number);
    /** Key a run by its owner: `""` is the ownerless (single-user) ring. */
    static ringKey(owner: string | undefined): string;
    observe(record: ObserveRecord): void;
    recall(query: string, conversationId: number, context: Context): Promise<RecallResult[]>;
    section(): string;
    /**
     * The recorded entries reader for one conversation. The binding keeps the
     * reader the host handed to that conversation's `runSettled`, so it must
     * stay valid after the delivery returns — core's does (it re-reads through
     * the harness per call, never an invocation-bound handle).
     */
    bindRecallSource(source: RecallSource): void;
    /**
     * The observed records for one owner (`""` = ownerless), oldest first.
     * Test/diagnostic surface; it never reads another owner's ring, and the
     * copy keeps a caller from mutating the ring it was handed.
     */
    records(owner?: string): readonly ObserveRecord[];
    /**
     * Deletion delivery can be retried, so the source ring must not remain
     * available for a duplicate transfer. Self-transfer and an absent source
     * are no-ops because neither has a distinct destination to receive memory.
     */
    transferOwner(user: string, transferTo: string): void;
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
     * answered, the assistant answer; records the settled conversation's
     * transcript as that conversation's recall source. An unanswered run
     * observes nothing.
     */
    runSettled(event: RunSettledEvent, api: MemoryEventApi, context: Context): void | Promise<void>;
    /** Memory is content, so it follows ownership when a user is deleted. */
    userDeleted(event: UserDeletedPayload, api: MemoryEventApi, context: Context): void | Promise<void>;
}
/** Build the degenerate memory wiring. */
export declare function createMemory(backend?: DegenerateMemoryBackend): MemoryWiring;
export {};

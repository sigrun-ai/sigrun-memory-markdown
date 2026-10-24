/**
 * The memory backend contract (spec B seam, M0 shape).
 *
 * A backend observes completed generation turns and answers recall queries
 * plus the long-term-memory prompt section. The degenerate implementation
 * ({@link ./degenerate.ts}) proves the seam; spec B (honcho mapping)
 * replaces it without touching the harness wiring.
 */

import type { Context } from "@earendil-works/chord";
import type { EntryId } from "@earendil-works/pi-durable";

/** Which side of one generation turn the record captures. */
export type MemoryRole = "user" | "assistant";

/** One observed generation turn half, exactly the record spec B maps to honcho. */
export type ObserveRecord = {
	/** Conversation the turn belongs to. */
	conversationId: number;
	/**
	 * The owning user the run settled for; absent when the conversation is
	 * ownerless. Rings are keyed by this, so no record ever reaches a ring
	 * another user reads.
	 */
	owner?: string;
	/** The settled answer's EntryId surrogate both halves of the turn share — the runSettled event exposes no generation task id, and the answer entry is the run's one stable transcript anchor. */
	generationId: number;
	role: MemoryRole;
	/** Plain text of the user input or the assistant answer. */
	text: string;
	/** Epoch milliseconds, from the hook's message or the submit boundary. */
	timestamp: number;
	/** Transcript entry the record was sourced from, when known. */
	entryId?: EntryId;
};

/** One recall hit. */
export type RecallResult = {
	conversationId: number;
	role: MemoryRole;
	/** Entry id of the matched transcript entry. */
	entryId: EntryId;
	/** Matched text. */
	text: string;
};

/**
 * The seam every memory implementation satisfies. `observe` is synchronous
 * and infallible from the caller's side (a degenerate backend cannot break
 * generation); `recall` reads durable history, so it can fail and does.
 */
export interface MemoryBackend {
	/** Record one observed turn half. Duplicates must be idempotent. */
	observe(record: ObserveRecord): void;
	/**
	 * Search `conversationId`'s long-term history for `query`. The degenerate
	 * backend scans the durable transcript (`conversation.entries()`), not the
	 * observe buffer: recall must work for history the live window compacted
	 * away (App C). A conversation with no recorded source answers empty rather
	 * than reaching any other conversation. `context` is the caller's, so a
	 * cancelled run stops its scan.
	 */
	recall(
		query: string,
		conversationId: number,
		context: Context,
	): Promise<RecallResult[]>;
	/** The rendered `long-term-memory` prompt section; stable per backend. */
	section(): string;
}

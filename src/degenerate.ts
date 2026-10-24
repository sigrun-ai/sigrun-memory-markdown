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
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	defineExtension,
	defineTool,
	section,
	UserEntry,
} from "@earendil-works/pi-durable";
import type {
	Cursor,
	EntryId,
	EntryRecord,
	Extension,
	Page,
	SubmissionId,
} from "@earendil-works/pi-durable";
import type {
	MemoryBackend,
	MemoryRole,
	ObserveRecord,
	RecallResult,
} from "./backend.js";

/** The stable `long-term-memory` section until a real backend is wired (spec B). */
export const MEMORY_PLACEHOLDER = "long-term memory backend not configured";

/** Ring buffer capacity; the oldest records drop once full. */
export const DEFAULT_RING_CAPACITY = 1000;

/** Entries fetched per `entries()` page while scanning. */
const RECALL_PAGE_SIZE = 100;
/** Upper bound on entries scanned per recall, so a scan always terminates. */
const RECALL_SCAN_LIMIT = 10_000;
/** Max hits returned per recall. */
const RECALL_HIT_LIMIT = 20;

/**
 * The settled-run event the host delivers to {@link MemoryWiring.runSettled}
 * — a structural mirror of sigrun core's `RunSettledEvent`
 * (src/harness/event-bus.ts; this package has no core dependency, so the
 * shapes are restated here and the loader validates the handler by name).
 * `inputTexts` is position-paired with `inputs`; an input whose entry is
 * unresolvable contributes `""` at its position. `owner` is the run's
 * owning user (absent when the conversation is ownerless).
 */
export interface RunSettledEvent {
	readonly conversationId: number;
	readonly owner?: string;
	readonly inputs: readonly SubmissionId[];
	readonly inputTexts: readonly string[];
	readonly outcome:
		| {
				readonly status: "answered";
				readonly answerEntryId: EntryId;
				readonly answer: AssistantMessage;
		  }
		| { readonly status: "unanswered"; readonly reason: string };
}

/**
 * The narrowed read surface a `runSettled` handler receives — a structural
 * mirror of sigrun core's `MemoryEventApi`. `entry`/`entries` are bound to
 * the event's conversation; `document` reads any conversation's doc.
 */
export interface MemoryEventApi {
	entry(id: EntryId, context: Context): Promise<EntryRecord | undefined>;
	entries(
		query: Record<string, never>,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<EntryRecord, Cursor>>;
	document(
		token: unknown,
		conversationId: number,
		context: Context,
	): Promise<unknown>;
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
export class DegenerateMemoryBackend implements MemoryBackend {
	#rings = new Map<string, ObserveRecord[]>();
	#sources = new Map<number, RecallSource>();

	constructor(readonly capacity: number = DEFAULT_RING_CAPACITY) {}

	/** Key a run by its owner: `""` is the ownerless (single-user) ring. */
	static ringKey(owner: string | undefined): string {
		return owner ?? "";
	}

	observe(record: ObserveRecord): void {
		const key = DegenerateMemoryBackend.ringKey(record.owner);
		const ring = this.#rings.get(key);
		if (ring === undefined) {
			this.#rings.set(key, [record]);
			return;
		}
		ring.push(record);
		if (ring.length > this.capacity) {
			ring.splice(0, ring.length - this.capacity);
		}
	}

	async recall(query: string, conversationId: number): Promise<RecallResult[]> {
		const source = this.#sources.get(conversationId);
		if (source === undefined) return [];
		// BACKGROUND_CONTEXT: recall is a host-initiated read with no incoming
		// request context (the tool passes none); the degenerate scan carries
		// no caller deadline to honour.
		return recallFromEntries(source, query, BACKGROUND_CONTEXT);
	}

	section(): string {
		return MEMORY_PLACEHOLDER;
	}

	/**
	 * Wiring-internal: record one conversation's transcript reader as its
	 * recall source. Hosts never call this — `runSettled` does.
	 */
	bindRecallSource(source: RecallSource): void {
		this.#sources.set(source.id, source);
	}

	/**
	 * The observed records for one owner (`""` = ownerless), oldest first.
	 * Test/diagnostic surface; it never reads another owner's ring.
	 */
	records(owner?: string): readonly ObserveRecord[] {
		return this.#rings.get(DegenerateMemoryBackend.ringKey(owner)) ?? [];
	}
}

/** Plain text of a user input (`string | (TextContent|ImageContent)[]`). */
function contentText(
	content: string | readonly { type: string; text?: string }[],
): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("");
}

/** Plain text across an entry's model contributions (review Finding 5). */
function entryText(entry: EntryRecord): string {
	return (entry.model ?? [])
		.map((message) => {
			if (message.role === "user") return contentText(message.content);
			if (message.role === "assistant") {
				return message.content
					.filter((block) => block.type === "text")
					.map((block) => (block.type === "text" ? block.text : ""))
					.join("");
			}
			return "";
		})
		.filter((text) => text !== "")
		.join("\n");
}

/** Scan one conversation's newest-first history for query matches. */
export async function recallFromEntries(
	source: RecallSource,
	query: string,
	context: Context,
): Promise<RecallResult[]> {
	const needle = query.toLowerCase();
	const hits: RecallResult[] = [];
	let cursor: Cursor | undefined = undefined;
	let scanned = 0;
	do {
		const page: Page<EntryRecord, Cursor> = await source.entries(
			{},
			RECALL_PAGE_SIZE,
			cursor,
			context,
		);
		for (const entry of page.items) {
			scanned++;
			const role: MemoryRole | undefined = UserEntry.is(entry)
				? "user"
				: AssistantEntry.is(entry)
					? "assistant"
					: undefined;
			if (role !== undefined && entry.id !== undefined) {
				const text = entryText(entry);
				if (text.toLowerCase().includes(needle)) {
					hits.push({
						conversationId: entry.conversationId,
						role,
						entryId: entry.id,
						text,
					});
					if (hits.length >= RECALL_HIT_LIMIT) return hits;
				}
			}
			if (scanned >= RECALL_SCAN_LIMIT) return hits;
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return hits;
}

/**
 * The recall tool the extension registers.
 *
 * The tool reads the CALLING conversation (`api.conversationId`) and scans
 * that conversation's transcript only — the source its own `runSettled`
 * delivery recorded. A conversation that never settled has no source and
 * therefore answers "No matches found.": it never falls back to another
 * conversation's history, which is the leak this scoping closes.
 */
function recallTool(backend: DegenerateMemoryBackend) {
	return defineTool({
		name: "memory_recall",
		description:
			"Search this conversation's durable transcript (including history " +
			"compacted out of the live context) for messages containing the query. " +
			"Returns the matching messages, newest first.",
		parameters: Type.Object({
			query: Type.String({ description: "Text to search for." }),
		}),
		async execute(args, api, _context) {
			const hits = await backend.recall(args.query, api.conversationId);
			if (hits.length === 0) {
				return {
					output: [{ type: "text", text: "No matches found." }],
				};
			}
			const body = hits
				.map((hit) => `[${hit.role}] ${hit.text} (entry ${hit.entryId})`)
				.join("\n");
			return { output: [{ type: "text", text: body }] };
		},
	});
}

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
	runSettled(
		event: RunSettledEvent,
		api: MemoryEventApi,
		context: Context,
	): void | Promise<void>;
}

/** Build the degenerate memory wiring. */
export function createMemory(
	backend: DegenerateMemoryBackend = new DegenerateMemoryBackend(),
): MemoryWiring {
	const extension = defineExtension({
		name: "sigrun.memory",
		tools: [recallTool(backend)],
		sections: [section("long-term-memory", () => backend.section())],
	});

	return {
		backend,
		extension,
		runSettled(event, api, _context) {
			// Each settled conversation keeps its own transcript reader: recall
			// answers from the CALLING conversation, so one conversation's history
			// never answers another's search (M4 Task 1).
			backend.bindRecallSource({
				id: event.conversationId,
				entries: api.entries,
			});

			// Unanswered runs (model_error / aborted / reset) observe NOTHING:
			// the pre-seam afterResponse hook fired only on answer rounds, and
			// the failed-turn test pinned "no orphan user record". The seam
			// keeps that contract — an unanswered outcome captures nothing.
			if (event.outcome.status !== "answered") return;

			// The run surrogate key both halves share (ObserveRecord.generationId):
			// the answer entry id — the event carries no generation task id, and
			// the answer entry is the run's one stable transcript anchor.
			const runId = event.outcome.answerEntryId as number;
			const now = Date.now();
			for (const text of event.inputTexts) {
				// Unresolvable inputs contribute "" — nothing to record (the
				// pre-seam wiring likewise never observed a text it never saw).
				if (text === "") continue;
				backend.observe({
					conversationId: event.conversationId,
					...(event.owner === undefined ? {} : { owner: event.owner }),
					generationId: runId,
					role: "user",
					text,
					timestamp: now,
				});
			}
			const answerText = event.outcome.answer.content
				.filter((block) => block.type === "text")
				.map((block) => (block.type === "text" ? block.text : ""))
				.join("");
			backend.observe({
				conversationId: event.conversationId,
				...(event.owner === undefined ? {} : { owner: event.owner }),
				generationId: runId,
				role: "assistant",
				text: answerText,
				timestamp: event.outcome.answer.timestamp,
				entryId: event.outcome.answerEntryId,
			});
		},
	};
}

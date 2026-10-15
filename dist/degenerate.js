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
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { AssistantEntry, defineExtension, defineTool, section, UserEntry, } from "@earendil-works/pi-durable";
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
 * The degenerate backend: in-process observe ring + transcript recall.
 * The wiring attaches the recall source when the first `runSettled` event
 * arrives; before that, recall reports the unbound state, never guesses.
 */
export class DegenerateMemoryBackend {
    capacity;
    #ring = [];
    #recallSource;
    constructor(capacity = DEFAULT_RING_CAPACITY) {
        this.capacity = capacity;
    }
    observe(record) {
        this.#ring.push(record);
        if (this.#ring.length > this.capacity) {
            this.#ring.splice(0, this.#ring.length - this.capacity);
        }
    }
    async recall(query) {
        const source = this.#recallSource;
        if (source === undefined)
            return [];
        // BACKGROUND_CONTEXT: recall is a host-initiated read with no incoming
        // request context (the tool passes none); the degenerate scan carries
        // no caller deadline to honour.
        return recallFromEntries(source, query, BACKGROUND_CONTEXT);
    }
    section() {
        return MEMORY_PLACEHOLDER;
    }
    /**
     * Wiring-internal: the `runSettled` delivery attaches the settled
     * conversation's transcript as the recall source. Hosts never call this.
     */
    attachRecallSource(source) {
        this.#recallSource = source;
    }
    /** Whether a recall source is attached (the tool's no-early-answers guard). */
    hasRecallSource() {
        return this.#recallSource !== undefined;
    }
    /** The observed records, oldest first. Test/diagnostic surface. */
    records() {
        return this.#ring;
    }
}
/** Plain text of a user input (`string | (TextContent|ImageContent)[]`). */
function contentText(content) {
    if (typeof content === "string")
        return content;
    return content
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("");
}
/** Plain text across an entry's model contributions (review Finding 5). */
function entryText(entry) {
    return (entry.model ?? [])
        .map((message) => {
        if (message.role === "user")
            return contentText(message.content);
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
export async function recallFromEntries(source, query, context) {
    const needle = query.toLowerCase();
    const hits = [];
    let cursor = undefined;
    let scanned = 0;
    do {
        const page = await source.entries({}, RECALL_PAGE_SIZE, cursor, context);
        for (const entry of page.items) {
            scanned++;
            const role = UserEntry.is(entry)
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
                    if (hits.length >= RECALL_HIT_LIMIT)
                        return hits;
                }
            }
            if (scanned >= RECALL_SCAN_LIMIT)
                return hits;
        }
        cursor = page.next;
    } while (cursor !== undefined);
    return hits;
}
/**
 * The recall tool the extension registers.
 *
 * The tool queries the backend's attached recall source — the settled
 * conversation's transcript, attached by the first `runSettled` delivery.
 * Before any run settles (or in a recovered process that re-executes the
 * tool first), no source is attached and the tool reports that, never
 * guesses.
 */
function recallTool(backend) {
    return defineTool({
        name: "memory_recall",
        description: "Search this conversation's durable transcript (including history " +
            "compacted out of the live context) for messages containing the query. " +
            "Returns the matching messages, newest first.",
        parameters: Type.Object({
            query: Type.String({ description: "Text to search for." }),
        }),
        async execute(args, _api, _context) {
            if (!backend.hasRecallSource()) {
                return {
                    output: [
                        { type: "text", text: "No conversation bound to memory recall yet." },
                    ],
                    isError: true,
                };
            }
            const hits = await backend.recall(args.query);
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
/** Build the degenerate memory wiring. */
export function createMemory(backend = new DegenerateMemoryBackend()) {
    const extension = defineExtension({
        name: "sigrun.memory",
        tools: [recallTool(backend)],
        sections: [section("long-term-memory", () => backend.section())],
    });
    return {
        backend,
        extension,
        runSettled(event, api, _context) {
            // The settled conversation's transcript becomes the recall source.
            // One source per backend: conversations share the degenerate ring,
            // and the latest settled conversation is the one a recall call is
            // about (the single-conversation host shape today).
            backend.attachRecallSource({
                id: event.conversationId,
                entries: api.entries,
            });
            // Unanswered runs (model_error / aborted / reset) observe NOTHING:
            // the pre-seam afterResponse hook fired only on answer rounds, and
            // the failed-turn test pinned "no orphan user record". The seam
            // keeps that contract — an unanswered outcome captures nothing.
            if (event.outcome.status !== "answered")
                return;
            // The run surrogate key both halves share (ObserveRecord.generationId):
            // the answer entry id — the event carries no generation task id, and
            // the answer entry is the run's one stable transcript anchor.
            const runId = event.outcome.answerEntryId;
            const now = Date.now();
            for (const text of event.inputTexts) {
                // Unresolvable inputs contribute "" — nothing to record (the
                // pre-seam wiring likewise never observed a text it never saw).
                if (text === "")
                    continue;
                backend.observe({
                    conversationId: event.conversationId,
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
                generationId: runId,
                role: "assistant",
                text: answerText,
                timestamp: event.outcome.answer.timestamp,
                entryId: event.outcome.answerEntryId,
            });
        },
    };
}

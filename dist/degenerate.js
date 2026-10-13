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
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { AssistantEntry, defineExtension, defineTool, GenerationTask, hook, LiveDoc, section, UserEntry, } from "@earendil-works/pi-durable";
/** The stable `long-term-memory` section until a real backend is wired (spec B). */
export const MEMORY_PLACEHOLDER = "long-term memory backend not configured";
/** Ring buffer capacity; the oldest records drop once full. */
export const DEFAULT_RING_CAPACITY = 1000;
/** Entries fetched per `conversation.entries()` page while scanning. */
const RECALL_PAGE_SIZE = 100;
/** Upper bound on entries scanned per recall, so a scan always terminates. */
const RECALL_SCAN_LIMIT = 10_000;
/** Max hits returned per recall. */
const RECALL_HIT_LIMIT = 20;
/**
 * The degenerate backend: in-process observe ring + transcript recall.
 * Bind a conversation (the wiring does, at the submit boundary) to give
 * `recall` its durable source.
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
    /** Bind `source` as the conversation `recall` scans. Wiring-internal. */
    bindRecallSource(source) {
        this.#recallSource = source;
    }
    /** Whether a recall source is bound (the tool's no-early-answers guard). */
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
 * `ToolExecutionApi.conversation()` returns only a `ConversationHandle`,
 * which exposes no `entries()` scan (verified: harness/types.d.ts:70-80) --
 * so the tool queries the backend's bound recall source, the full
 * `Conversation` the wiring bound at the submit boundary. In a recovered
 * process that re-executes the tool before any submit, no source is bound
 * and the tool reports that, never guesses.
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
                    content: [
                        { type: "text", text: "No conversation bound to memory recall yet." },
                    ],
                    isError: true,
                };
            }
            const hits = await backend.recall(args.query);
            if (hits.length === 0) {
                return {
                    content: [{ type: "text", text: "No matches found." }],
                };
            }
            const body = hits
                .map((hit) => `[${hit.role}] ${hit.text} (entry ${hit.entryId})`)
                .join("\n");
            return { content: [{ type: "text", text: body }] };
        },
    });
}
/** Build the degenerate memory wiring. */
export function createMemory(backend = new DegenerateMemoryBackend()) {
    /**
     * Input texts pending observation, keyed by submission id (review Finding
     * 2). Recorded synchronously *before* admission so no generation can outrun
     * the capture. `afterResponse` matches the live run's `inputs` by identity,
     * so a steering-merged input gets its own user record and a rejected /
     * requeued submit never mis-pairs a stale text to a later run. An input
     * that is admitted but never answered (busy-rejected is the only path that
     * writes nothing; a queued input carries its id) keeps its text here until
     * its run answers — a documented degenerate limitation.
     */
    const pendingInputs = new Map();
    async function afterResponse(message, api, context) {
        // afterResponse fires per terminal provider MESSAGE (every round:
        // tool requests, error rounds, retries — verified generation.js:335,
        // before classification), NOT once per turn. Observe only the round
        // that ANSWERS the run; error/tool rounds observe nothing, so a
        // retried turn records exactly its final answer and a model-failed
        // run leaves no orphan user record. Answer classification mirrors
        // upstream's (generation.js:337-340): stop/length, and toolUse with
        // no tool-call block (a tool request is a round, not the answer).
        const calls = message.content.filter((block) => block.type === "toolCall");
        const isAnswer = message.stopReason === "stop" ||
            message.stopReason === "length" ||
            (message.stopReason === "toolUse" && calls.length === 0);
        if (!isAnswer)
            return;
        // Replay guard (review Finding 3): the memo carries the RECORDS, so a
        // crash between memo-write and observe could not lose them. First
        // write wins — a retry/recovery replay returns the stored winner and
        // re-observes it (idempotent), never re-deriving timestamps.
        const memoName = `sigrun.memory.observe:${api.taskId}`;
        const records = await api.memo(memoName, context);
        if (records !== undefined) {
            for (const record of records)
                backend.observe(record);
            return;
        }
        const now = Date.now();
        const pending = [];
        // Which submissions this generation answers (still live: afterResponse
        // fires inside classify, before endRun — verified dist/harness/generation.js).
        // Match by submission IDENTITY (review Finding 2), not FIFO count: a
        // rejected/requeued submit no longer mis-pairs a stale text to this run.
        const live = await api.snapshot(LiveDoc, api.conversationId, context);
        const inputs = live?.run?.inputs ?? [];
        for (const id of inputs) {
            const input = pendingInputs.get(id);
            if (input === undefined)
                continue; // submitted outside the wiring
            pendingInputs.delete(id);
            pending.push({
                conversationId: api.conversationId,
                generationId: api.taskId,
                role: "user",
                text: input.text,
                timestamp: now,
            });
        }
        const answerText = message.content
            .filter((block) => block.type === "text")
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("");
        pending.push({
            conversationId: api.conversationId,
            generationId: api.taskId,
            role: "assistant",
            text: answerText,
            timestamp: message.timestamp,
        });
        await api.memo(memoName, pending, context);
        for (const record of pending)
            backend.observe(record);
    }
    const extension = defineExtension({
        name: "sigrun.memory",
        tools: [recallTool(backend)],
        sections: [section("long-term-memory", () => backend.section())],
        hooks: [hook(GenerationTask, { afterResponse })],
    });
    return {
        backend,
        extension,
        async submit(root, submission, context) {
            backend.bindRecallSource(root);
            const placed = await root.submit(submission, context);
            // Record after admission: `placed.id` is the submission id the run's
            // `run.inputs` carries, so the hook matches by identity, not order.
            // Admission resolved before any generation can answer it, so the id
            // is in the map before `afterResponse` can fire for this turn.
            if (submission.type === "input" &&
                typeof submission.content === "string") {
                pendingInputs.set(placed.id, {
                    conversationId: root.id,
                    text: submission.content,
                });
            }
            return placed;
        },
    };
}

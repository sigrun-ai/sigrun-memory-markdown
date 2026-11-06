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
 * - `section` renders the per-user memory files live (Task C2): the owner
 *   resolves through `host.identity.actingUser`, each file renders under a
 *   usage header with its entries joined by `§` lines, and empty or
 *   ownerless memory renders the neutral line. `MEMORY_PLACEHOLDER` stays
 *   exported for back-compat but nothing renders it anymore.
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
import { rm } from "node:fs/promises";
import { Type } from "typebox";
import { AssistantEntry, defineExtension, defineTool, section, UserEntry, } from "@earendil-works/pi-durable";
import { DEFAULT_LIMITS, MemoryFiles, } from "./files.js";
import { createMemoryTarget, memoryWriteTool } from "./target.js";
/** The stable `long-term-memory` section until a real backend is wired (spec B). Kept exported for back-compat; the live section never renders it. */
export const MEMORY_PLACEHOLDER = "long-term memory backend not configured";
/** What empty or ownerless memory renders — never the old placeholder. */
const NO_LONG_TERM_MEMORIES = "No long-term memories yet.";
/** Ring buffer capacity; the oldest records drop once full. */
export const DEFAULT_RING_CAPACITY = 1000;
/** Entries fetched per `entries()` page while scanning. */
const RECALL_PAGE_SIZE = 100;
/** Upper bound on entries scanned per recall, so a scan always terminates. */
const RECALL_SCAN_LIMIT = 10_000;
/** Max hits returned per recall. */
const RECALL_HIT_LIMIT = 20;
/** One section block's label, on-disk name, and file key, in render order. */
const SECTION_FILES = [
    { file: "user", label: "USER PROFILE", name: "USER.md" },
    { file: "memory", label: "MEMORY", name: "MEMORY.md" },
];
/**
 * Render the live `long-term-memory` body from both files' reads: one
 * block per file under its usage header (`USER PROFILE [<pct>% —
 * <chars>/<limit> chars]`, then `MEMORY [...]`), entries joined by `§`
 * lines. Both files empty → the neutral line. A malformed file renders
 * `(<name> could not be read; it is left unchanged)` in ITS block; the
 * other block still renders. The percentage is rounded to the nearest
 * integer (1,474/2,200 renders 67%).
 */
export function renderMemorySection(files) {
    const bothEmpty = [files.user, files.memory].every((read) => read.entries.length === 0 && read.malformed === undefined);
    if (bothEmpty)
        return NO_LONG_TERM_MEMORIES;
    return SECTION_FILES.map(({ file, label, name }) => {
        const read = files[file];
        const pct = Math.round((read.chars / read.limit) * 100);
        const head = `${label} [${pct}% — ${read.chars}/${read.limit} chars]`;
        if (read.malformed !== undefined) {
            return `${head}\n(${name} could not be read; it is left unchanged)`;
        }
        if (read.entries.length === 0)
            return head;
        return `${head}\n${MemoryFiles.contentOf(read.entries)}`;
    }).join("\n\n");
}
/**
 * Parse the deployment `limits` settings block over the defaults.
 * Gentle-parse posture (the settings convention): a malformed or
 * non-positive limit falls back to its default — the parser never throws.
 */
function mergeLimits(raw) {
    const block = raw.limits;
    if (typeof block !== "object" || block === null)
        return DEFAULT_LIMITS;
    const overrides = {};
    for (const file of ["user", "memory"]) {
        const value = block[file];
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
            overrides[file] = value;
        }
    }
    return Object.freeze({ ...DEFAULT_LIMITS, ...overrides });
}
/**
 * Render the live section for one conversation: resolve the owner, read
 * that owner's two files (the wiring's per-owner `MemoryFiles` — the same
 * instance the C3 target writes through), render. No owner → the neutral
 * line (an ownerless conversation renders no user memory — never another
 * user's).
 */
async function renderLiveSection(host, filesFor, conversationId) {
    const owner = await host.identity.actingUser(conversationId);
    if (owner === undefined)
        return NO_LONG_TERM_MEMORIES;
    const files = filesFor(owner);
    return renderMemorySection({
        user: await files.read("user"),
        memory: await files.read("memory"),
    });
}
/**
 * The degenerate backend: in-process observe rings + transcript recall.
 * Each `runSettled` delivery records its conversation's transcript reader,
 * so recall answers from the calling conversation and nothing else; a
 * conversation that never settled has no source and reports no matches —
 * never another conversation's history.
 */
export class DegenerateMemoryBackend {
    capacity;
    #rings = new Map();
    // Process-lifetime and intentionally unbounded: entries cover only
    // conversations that ever settled, and core's readers re-read through the
    // harness so retaining them does not pin stale transcript state.
    #sources = new Map();
    constructor(capacity = DEFAULT_RING_CAPACITY) {
        this.capacity = capacity;
    }
    /** Key a run by its owner: `""` is the ownerless (single-user) ring. */
    static ringKey(owner) {
        return owner ?? "";
    }
    observe(record) {
        const key = DegenerateMemoryBackend.ringKey(record.owner);
        let ring = this.#rings.get(key);
        if (ring === undefined) {
            ring = [];
            this.#rings.set(key, ring);
        }
        ring.push(record);
        if (ring.length > this.capacity) {
            ring.splice(0, ring.length - this.capacity);
        }
    }
    async recall(query, conversationId, context) {
        const source = this.#sources.get(conversationId);
        if (source === undefined)
            return [];
        return recallFromEntries(source, query, context);
    }
    section() {
        return MEMORY_PLACEHOLDER;
    }
    /**
     * The recorded entries reader for one conversation. The binding keeps the
     * reader the host handed to that conversation's `runSettled`, so it must
     * stay valid after the delivery returns — core's does (it re-reads through
     * the harness per call, never an invocation-bound handle).
     */
    bindRecallSource(source) {
        this.#sources.set(source.id, source);
    }
    /**
     * The observed records for one owner (`""` = ownerless), oldest first.
     * Test/diagnostic surface; it never reads another owner's ring, and the
     * copy keeps a caller from mutating the ring it was handed.
     */
    records(owner) {
        return [...(this.#rings.get(DegenerateMemoryBackend.ringKey(owner)) ?? [])];
    }
    /**
     * Drop one owner's ring entirely (userDeleted: memory does not
     * survive its user — a recipient's ring must never absorb a deleted
     * user's records). Idempotent; an absent ring is a no-op.
     */
    forget(owner) {
        this.#rings.delete(DegenerateMemoryBackend.ringKey(owner));
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
 * The tool reads the CALLING conversation (`api.conversationId`) and scans
 * that conversation's transcript only — the source its own `runSettled`
 * delivery recorded. A conversation that never settled has no source and
 * therefore answers "No matches found.": it never falls back to another
 * conversation's history, which is the leak this scoping closes.
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
        async execute(args, api, context) {
            // The caller's context reaches the scan so a recall cancelled with its
            // run stops reading, rather than outliving the run that asked.
            const hits = await backend.recall(args.query, api.conversationId, context);
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
/**
 * Build the degenerate memory wiring. THE HOST RULE: the first parameter
 * declares the host, so sigrun's loader (which passes the host only to
 * factories with `factory.length > 0`) lands it here — a zero-arg factory
 * with a defaulted first parameter would consume the host as a real
 * dependency, the regression core's arity gate exists for. The limits
 * override is read ONCE at construction (settings are restart-required in
 * the sigrun convention) and merged over the defaults for every
 * `MemoryFiles` the wiring creates. The backend override is for direct
 * programmatic use (the loader passes only the host).
 */
export async function createMemory(host, backend = new DegenerateMemoryBackend()) {
    const limits = mergeLimits(await host.stores.settings.get());
    const byUser = new Map();
    const filesFor = Object.assign((user) => {
        let files = byUser.get(user);
        if (files === undefined) {
            files = new MemoryFiles({
                dir: host.stores.user(user).paths.data,
                limits,
            });
            byUser.set(user, files);
        }
        return files;
    }, { limits });
    const extension = defineExtension({
        name: "sigrun.memory",
        tools: [recallTool(backend), memoryWriteTool(host, filesFor)],
        sections: [
            section("long-term-memory", (input) => renderLiveSection(host, filesFor, input.conversationId)),
        ],
    });
    const curationTargets = [createMemoryTarget(filesFor)];
    return {
        backend,
        extension,
        files: filesFor,
        curationTargets,
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
        userDeleted: async (event, _api, _context) => {
            // Memory is deleted with its user (the 2026-10-26 ruling's
            // reversal): the ring drops, the per-user files and their
            // versions are removed, and the cached MemoryFiles is evicted
            // so a recreated same-name user starts over a fresh directory
            // (C2 review carry). The recipient is untouched — USER.md
            // describes the departed user and must never merge into theirs.
            backend.forget(event.user);
            byUser.delete(event.user);
            await rm(host.stores.user(event.user).paths.data, {
                recursive: true,
                force: true,
            });
        },
    };
}

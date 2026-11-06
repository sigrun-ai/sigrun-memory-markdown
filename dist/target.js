/**
 * The `memory` curation target (Task C3, curator spec §6.4): the
 * `memory_write` tool plus the target declaration the wiring carries on
 * the factory result's `curationTargets` — the package's entire
 * curator-contract surface.
 *
 * - `memory_write` writes for `host.identity.actingUser(api
 *   .conversationId)` — inside a curator run that resolves to the run's
 * user. Writes are batched operations over one named file, applied
 * atomically through the SAME per-user {@link MemoryFiles} the live
 * section renders (one serialized queue per user). A batch that would
 * land the file over its limit is an ERROR RESULT — text the model
 * reads and recovers from in its own retry — carrying the exact
 * overage and the file's current entries, because the rejected batch
 * wrote nothing and a retry must free space in the same call.
 * - Every accepted write reports `details.curation = {changeId,
 *   summary}` (the A6/A8 convention): the change id the curator's undo
 *   surface hands back to {@link CurationTarget.undo}.
 * - `maintain` merges duplicates and drops superseded facts through a
 *   toolless digest run per non-empty file. The model returns
 * OPERATIONS, not a rewritten file; a result that would remove more
 * than a quarter of the existing entries is discarded (openclaw's
 * `maxPriorEntryLossFraction` default, 0.25) — maintenance tightens,
 * it never guts.
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-durable";
import { MemoryOverLimit, memoryFileName, } from "./files.js";
/**
 * The target's routing guidance, shown to the curator when deciding
 * where a lesson goes (exact lines — the routing rule the spec pins).
 */
export const MEMORY_GUIDANCE = [
    'USER.md (file "user"): who the user is — preferences, communication and work style, expectations of the agent.',
    'MEMORY.md (file "memory"): facts about their environment and projects — tool quirks, paths, endpoints, decisions.',
    "One fact goes in one file, never both. Procedures belong in skills. Facts about one codebase belong in its AGENTS.md, not memory. Never store secrets.",
];
/** One `ops` element's schema (the MemoryOp union, model-facing). */
const opSchema = Type.Union([
    Type.Object({
        op: Type.Literal("add"),
        text: Type.String({ description: "The entry text to append." }),
    }),
    Type.Object({
        op: Type.Literal("replace"),
        match: Type.String({
            description: "A unique substring of exactly one current entry.",
        }),
        text: Type.String({ description: "The entry's rewritten text." }),
    }),
    Type.Object({
        op: Type.Literal("remove"),
        match: Type.String({
            description: 'A unique substring of exactly one current entry, or "*" for every entry.',
        }),
    }),
]);
/** An explicit tool error: text the model reads and recovers from. */
function error(message) {
    return { output: [{ type: "text", text: message }], isError: true };
}
/**
 * The over-limit error text: the exact headline (file, would-be chars,
 * limit, overage, the retry instruction) plus the entries the file
 * still holds — the rejected batch wrote nothing, so those are what a
 * retry removes or shortens in the same batch.
 */
function overLimitText(over) {
    const head = `${memoryFileName(over.file)} at ${over.chars}/${over.limit} chars; ` +
        `this batch is ${over.overBy} over. ` +
        "Retry as one batch that removes or shortens entries and adds the new one.";
    const body = over.entries.length === 0
        ? "Current entries: (none)"
        : `Current entries:\n${over.entries.map((entry) => `- ${entry}`).join("\n")}`;
    return `${head}\n\n${body}`;
}
/**
 * Build the `memory_write` tool. Registered by the wiring's extension
 * (the loader's registered-tool check and A8's wrapping both key off
 * the registration), writing through the per-user {@link MemoryFiles}.
 */
export function memoryWriteTool(host, filesFor) {
    return defineTool({
        name: "memory_write",
        description: "Write to the acting user's long-term memory (USER.md or MEMORY.md) " +
            "as one atomic batch of add/replace/remove operations. A batch that " +
            "would land the file over its char limit is rejected with the current " +
            "entries; retry as ONE batch that frees space and adds the new entry.",
        parameters: Type.Object({
            file: Type.Union([Type.Literal("user"), Type.Literal("memory")], {
                description: 'Which memory file: "user" (who the user is) or "memory" (environment and project facts).',
            }),
            ops: Type.Array(opSchema, {
                description: "The batch, applied atomically: all ops land or none do.",
            }),
            reason: Type.Optional(Type.String({ description: "Why this change is made." })),
        }),
        async execute(args, api, _context) {
            const user = await host.identity.actingUser(api.conversationId);
            if (user === undefined) {
                return error("This conversation has no owner, so there is no user memory to write.");
            }
            try {
                const change = await filesFor(user).apply(args.file, args.ops, args.reason === undefined ? {} : { reviewId: args.reason });
                return {
                    output: [{ type: "text", text: change.summary }],
                    details: {
                        curation: {
                            changeId: change.changeId,
                            summary: change.summary,
                        },
                    },
                };
            }
            catch (cause) {
                if (cause instanceof MemoryOverLimit) {
                    return error(overLimitText(cause));
                }
                // Ambiguous/missing matches and delimiter-bearing text are
                // batch rejections, not crashes: the model reads and retries.
                return error(cause instanceof Error ? cause.message : String(cause));
            }
        },
    });
}
/**
 * Entries the batch REMOVES: each remove op's matches against the
 * CURRENT entries (`"*"` matches all). A replace substitutes one entry
 * in place — count-neutral, so only removals count toward the loss
 * bound (the brief is silent on replaces; this is the conservative
 * reading of "the ops remove ≤ … entries", recorded in the task
 * report).
 */
function removedEntries(entries, ops) {
    let removed = 0;
    for (const op of ops) {
        if (op.op !== "remove")
            continue;
        if (op.match === "*") {
            removed += entries.length;
            continue;
        }
        removed += entries.filter((entry) => entry.includes(op.match)).length;
    }
    return removed;
}
/** The digest-run input for one file: its entries plus the ask. */
function maintainInput(user, file, read) {
    return [
        `Maintain ${memoryFileName(file)} — the long-term memory file for user ${user} ` +
            `(${read.chars}/${read.limit} chars, ${read.entries.length} entries).`,
        "",
        "Current entries:",
        ...read.entries.map((entry, index) => `${index + 1}. ${entry}`),
        "",
        "Merge duplicate entries and drop superseded facts; keep every other fact " +
            "word-for-word. Reply with ONLY a JSON array of operations, no prose:",
        '- {"op":"replace","match":"<unique substring of one entry>","text":"<rewritten entry>"} rewrites one entry',
        '- {"op":"remove","match":"<unique substring of one entry>"} deletes one entry',
        '- {"op":"add","text":"<new entry>"} appends an entry',
    ].join("\n");
}
/**
 * Validate one parsed item as a {@link MemoryOp}; `undefined` on any
 * other shape (the whole array is then discarded — one bad op would
 * land the file somewhere the model never saw).
 */
function asOp(value) {
    const op = value;
    if (op === null || typeof op !== "object")
        return undefined;
    if (op.op === "add" && typeof op.text === "string") {
        return { op: "add", text: op.text };
    }
    if (op.op === "replace" &&
        typeof op.match === "string" &&
        typeof op.text === "string") {
        return { op: "replace", match: op.match, text: op.text };
    }
    if (op.op === "remove" && typeof op.match === "string") {
        return { op: "remove", match: op.match };
    }
    return undefined;
}
/**
 * Parse a digest run's final text into a MemoryOp array. Only a
 * COMPLETED run counts, and the text must be (or contain) one JSON
 * array whose every element is a valid op — anything else is
 * unparseable, and unparseable means no change.
 */
function parseMaintenanceOps(result) {
    if (result.status !== "completed")
        return undefined;
    const trimmed = result.text.trim();
    const candidates = [trimmed];
    const first = trimmed.indexOf("[");
    const last = trimmed.lastIndexOf("]");
    if (first !== -1 && last > first) {
        candidates.push(trimmed.slice(first, last + 1));
    }
    for (const candidate of candidates) {
        let parsed;
        try {
            parsed = JSON.parse(candidate);
        }
        catch {
            continue;
        }
        if (!Array.isArray(parsed))
            continue;
        const ops = [];
        let valid = true;
        for (const item of parsed) {
            const op = asOp(item);
            if (op === undefined) {
                valid = false;
                break;
            }
            ops.push(op);
        }
        if (valid)
            return ops;
    }
    return undefined;
}
/**
 * Build the `memory` curation target. `undo` restores through the
 * same per-user {@link MemoryFiles} (which saves the current state
 * first, so an undo is itself undoable); `maintain` bounds its loss
 * and reports every applied change for the undo surface.
 */
export function createMemoryTarget(filesFor) {
    return {
        name: "memory",
        tools: ["memory_write"],
        guidance: () => [...MEMORY_GUIDANCE],
        async undo(user, changeId, _ctx) {
            await filesFor(user).undo(changeId);
        },
        async maintain(user, _ctx, budget) {
            const changes = [];
            let runs = budget.runs;
            for (const file of ["user", "memory"]) {
                if (runs < 1 || Date.now() >= budget.deadline)
                    break;
                const read = await filesFor(user).read(file);
                // An empty file has nothing to merge or drop — spending a
                // digest run on it buys nothing.
                if (read.entries.length === 0)
                    continue;
                runs -= 1;
                const result = await budget.run(maintainInput(user, file, read), []);
                const ops = parseMaintenanceOps(result);
                if (ops === undefined)
                    continue;
                if (removedEntries(read.entries, ops) >
                    Math.floor(read.entries.length * 0.25)) {
                    continue;
                }
                try {
                    const change = await filesFor(user).apply(file, ops);
                    changes.push({
                        changeId: change.changeId,
                        summary: change.summary,
                    });
                }
                catch {
                    // A batch that no longer folds (a missing or ambiguous match
                    // against the entries the run saw) lands nothing — a
                    // no-change, never a failed maintenance pass.
                }
            }
            return { changes, more: false };
        },
    };
}

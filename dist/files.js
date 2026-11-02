/**
 * Per-user memory files (Task C1, curator spec §6): USER.md and MEMORY.md
 * under one user's data directory — the storage layer the live section
 * (C2) renders and the memory curation target (C3) writes.
 *
 * The file format is deliberately degenerate markdown: entries joined by
 * {@link ENTRY_DELIMITER} (`\n§\n`), nothing else. One fact is one entry;
 * the curator is the only writer, so the format never has to survive a
 * human editor's reformatting, and the hard char limit is checked on the
 * BATCH RESULT — a batch that removes or shortens enough to fit is one
 * atomic step, never a rejected intermediate state.
 *
 * Every accepted change first saves the previous bytes as
 * `versions/<file>/<changeId>.md` (newest ten kept), so `undo` restores
 * exactly what was there — including malformed bytes — and is itself
 * undoable because undo saves the current state first.
 */
var _a;
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
/** One file's on-disk name. */
export const FILE_NAMES = {
    user: "USER.md",
    memory: "MEMORY.md",
};
/** One file's on-disk name (the display form error text uses). */
export function memoryFileName(file) {
    return FILE_NAMES[file];
}
/** Default per-file char limits (the `limits` setting overrides). */
export const DEFAULT_LIMITS = {
    user: 1375,
    memory: 2200,
};
/** How entries are joined in the file (and split on read). */
export const ENTRY_DELIMITER = "\n§\n";
/** Versions kept per file (newest ten). */
const VERSIONS_KEPT = 10;
/** A batch that would land the file over its limit. Nothing is written. */
export class MemoryOverLimit extends Error {
    file;
    chars;
    limit;
    overBy;
    entries;
    constructor(
    /** The file the batch targeted. */
    file, 
    /** Chars the batch result would reach. */
    chars, 
    /** The file's limit. */
    limit, 
    /** How far over: `chars - limit`. */
    overBy, 
    /** The entries the file still holds — the rejected batch wrote nothing. */
    entries) {
        super(`${FILE_NAMES[file]} would reach ${chars}/${limit} chars (${overBy} over)`);
        this.file = file;
        this.chars = chars;
        this.limit = limit;
        this.overBy = overBy;
        this.entries = entries;
        this.name = "MemoryOverLimit";
    }
}
/** One user's memory files on disk. Never touches another user's dir. */
export class MemoryFiles {
    #dir;
    #limits;
    #sequence = 0;
    #lock = Promise.resolve();
    constructor(options) {
        this.#dir = options.dir;
        this.#limits = Object.freeze({ ...DEFAULT_LIMITS, ...options.limits });
    }
    /** The joined file content (the number the limit bounds). */
    static contentOf(entries) {
        return entries.join(ENTRY_DELIMITER);
    }
    /**
     * Split file text into entries. A file whose every segment is empty
     * (hand-written bytes that are only delimiters — this layer can no
     * longer produce them, see the add/replace guard) reads as the EMPTY
     * state, a fresh-file equivalent, not a row of phantom empty entries;
     * the bytes themselves are never rewritten.
     */
    static splitEntries(text) {
        const entries = text.split(ENTRY_DELIMITER);
        return entries.every((entry) => entry === "") ? [] : entries;
    }
    /** The file's path under this user's data dir. */
    path(file) {
        return join(this.#dir, FILE_NAMES[file]);
    }
    /** The versions directory for one file. */
    #versionsDir(file) {
        return join(this.#dir, "versions", file);
    }
    /**
     * Read one file. NEVER rewrites — a malformed or unreadable file is
     * reported, not repaired. An absent file is the empty state (not
     * malformed); invalid UTF-8 or a read error reads as malformed with
     * empty entries.
     */
    async read(file) {
        const raw = await this.#readRaw(file);
        if (raw.malformed !== undefined) {
            return {
                entries: [],
                chars: 0,
                limit: this.#limits[file],
                malformed: raw.malformed,
            };
        }
        const entries = _a.splitEntries(raw.bytes.length === 0 ? "" : new TextDecoder().decode(raw.bytes));
        return {
            entries,
            chars: _a.contentOf(entries).length,
            limit: this.#limits[file],
        };
    }
    /**
     * Apply one batch atomically: all ops land or none do. The limit is
     * checked on the BATCH RESULT — a batch that removes or shortens
     * enough to fit is accepted even when its adds alone would overflow.
     * Over the limit throws {@link MemoryOverLimit} and writes nothing.
     *
     * On a malformed file only a batch STARTING with a `{op: "remove",
     * match: "*"}` op is accepted (the curator's escape hatch: clear the
     * unreadable file and rebuild); anything else throws so the broken
     * bytes are never silently layered on.
     */
    async apply(file, ops, _meta = {}) {
        return this.#serialized(async () => {
            const current = await this.#readRaw(file);
            if (current.malformed !== undefined) {
                const clears = ops.length > 0 &&
                    ops[0].op === "remove" &&
                    ops[0].match === "*";
                if (!clears) {
                    throw new Error(`${FILE_NAMES[file]} is malformed (${current.malformed}); only a ` +
                        `batch starting with {op: "remove", match: "*"} is accepted`);
                }
            }
            const entries = this.#entriesOf(current);
            const next = this.#fold(file, entries, ops);
            this.#checkLimit(file, next, entries);
            const changeId = this.#nextChangeId();
            await this.#saveVersion(file, changeId, current.bytes);
            await mkdir(this.#dir, { recursive: true });
            await writeFile(this.path(file), _a.contentOf(next), "utf8");
            return {
                changeId,
                summary: summarize(file, ops, entries.length, next.length),
            };
        });
    }
    /**
     * Undo one change: the CURRENT bytes are saved as a new version first
     * (so the undo is itself undoable through its returned changeId),
     * then the named version's bytes are restored verbatim — including
     * malformed bytes.
     */
    async undo(changeId) {
        return this.#serialized(async () => {
            const file = await this.#findVersionFile(changeId);
            const versionBytes = await readFile(join(this.#versionsDir(file), `${changeId}.md`));
            const current = await this.#readRaw(file);
            const currentEntries = this.#entriesOf(current);
            const savedId = this.#nextChangeId();
            await this.#saveVersion(file, savedId, current.bytes);
            await mkdir(this.#dir, { recursive: true });
            await writeFile(this.path(file), versionBytes);
            const restoredRaw = new Uint8Array(versionBytes);
            const restored = _a.splitEntries(new TextDecoder().decode(restoredRaw));
            return {
                file,
                changeId: savedId,
                summary: `undo ${changeId.slice(-8)}: ${FILE_NAMES[file]} ` +
                    `${currentEntries.length} → ${restored.length} entries`,
            };
        });
    }
    /** Run one exclusive step of the apply/undo read-modify-write cycle. */
    #serialized(step) {
        const run = this.#lock.then(step, step);
        this.#lock = run.then(() => undefined, () => undefined);
        return run;
    }
    /** Read the file's bytes; absent reads as empty, errors read as malformed. */
    async #readRaw(file) {
        let bytes;
        try {
            bytes = new Uint8Array(await readFile(this.path(file)));
        }
        catch (error) {
            const code = error.code;
            if (code === "ENOENT")
                return { bytes: new Uint8Array() };
            return {
                bytes: new Uint8Array(),
                malformed: `read error: ${code ?? String(error)}`,
            };
        }
        if (bytes.length === 0)
            return { bytes };
        try {
            new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        }
        catch {
            return { bytes, malformed: "invalid UTF-8" };
        }
        return { bytes };
    }
    /** Decode raw bytes to entries (malformed bytes already rejected). */
    #entriesOf(raw) {
        if (raw.malformed !== undefined)
            return [];
        if (raw.bytes.length === 0)
            return [];
        return _a.splitEntries(new TextDecoder().decode(raw.bytes));
    }
    /** Fold ops over entries; an ambiguous or missing match throws. */
    #fold(file, entries, ops) {
        const next = [...entries];
        for (const op of ops) {
            if ((op.op === "add" || op.op === "replace") &&
                op.text.includes(ENTRY_DELIMITER)) {
                // Delimiter-bearing text would embed the separator inside one
                // entry, so a later read re-segments the file — entry counts
                // and match uniqueness shift under this layer's own contract.
                // Reject before anything is written; the batch stays atomic.
                throw new Error(`${FILE_NAMES[file]}: ${op.op} text contains the entry delimiter ` +
                    `${JSON.stringify(ENTRY_DELIMITER)} and would re-segment the file`);
            }
            if (op.op === "add") {
                next.push(op.text);
                continue;
            }
            if (op.match === "*" && op.op === "remove") {
                next.length = 0;
                continue;
            }
            const hits = next
                .map((entry, index) => (entry.includes(op.match) ? index : -1))
                .filter((index) => index !== -1);
            if (hits.length === 0) {
                throw new Error(`${FILE_NAMES[file]}: no entry matches "${op.match}" (${op.op})`);
            }
            if (hits.length > 1) {
                throw new Error(`${FILE_NAMES[file]}: ambiguous match "${op.match}" (${op.op}): ` +
                    `${hits.length} entries match it; a match must be unique`);
            }
            if (op.op === "replace")
                next[hits[0]] = op.text;
            else
                next.splice(hits[0], 1);
        }
        return next;
    }
    /**
     * Throw {@link MemoryOverLimit} when the batch result exceeds the limit.
     * `entries` carries the file's CURRENT entries — the rejected batch
     * wrote nothing, so those are what a retry removes or shortens.
     */
    #checkLimit(file, entries, current) {
        const chars = _a.contentOf(entries).length;
        const limit = this.#limits[file];
        if (chars > limit) {
            throw new MemoryOverLimit(file, chars, limit, chars - limit, current);
        }
    }
    /** A sortable, collision-free change id (timestamp + sequence + uuid). */
    #nextChangeId() {
        const stamp = Date.now().toString(36);
        const sequence = this.#sequence.toString(36).padStart(6, "0");
        this.#sequence += 1;
        return `${stamp}-${sequence}-${randomUUID().slice(0, 8)}`;
    }
    /** Save one version (bytes verbatim) and prune to the newest ten. */
    async #saveVersion(file, changeId, bytes) {
        const dir = this.#versionsDir(file);
        await mkdir(dir, { recursive: true });
        // Rename-into-place: a reader never sees a half-written version.
        const staging = join(dir, `.${changeId}.tmp`);
        await writeFile(staging, bytes);
        await rename(staging, join(dir, `${changeId}.md`));
        const names = (await readdir(dir)).filter((name) => name.endsWith(".md"));
        const kept = names.sort().slice(-VERSIONS_KEPT);
        const remove = names.filter((name) => !kept.includes(name));
        await Promise.all(remove.map((name) => rm(join(dir, name), { force: true })));
    }
    /** Locate which file a changeId's version belongs to. */
    async #findVersionFile(changeId) {
        const files = ["user", "memory"];
        for (const file of files) {
            const names = await readdir(this.#versionsDir(file)).catch(() => []);
            if (names.includes(`${changeId}.md`))
                return file;
        }
        throw new Error(`unknown or pruned changeId "${changeId}"`);
    }
}
_a = MemoryFiles;
/** The human-readable apply summary. */
function summarize(file, ops, from, to) {
    const counts = new Map();
    for (const op of ops)
        counts.set(op.op, (counts.get(op.op) ?? 0) + 1);
    const parts = [...counts.entries()].map(([op, count]) => `${op} ${count}`);
    const body = parts.length === 0 ? "no ops" : parts.join(", ");
    return `${FILE_NAMES[file]}: ${body} (${from} → ${to} entries)`;
}

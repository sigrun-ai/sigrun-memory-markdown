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
/** The two per-user memory files. */
export type MemoryFile = "user" | "memory";
/** One file's on-disk name. */
export declare const FILE_NAMES: Readonly<Record<MemoryFile, string>>;
/** One file's on-disk name (the display form error text uses). */
export declare function memoryFileName(file: MemoryFile): string;
/** Default per-file char limits (the `limits` setting overrides). */
export declare const DEFAULT_LIMITS: Readonly<Record<MemoryFile, number>>;
/** How entries are joined in the file (and split on read). */
export declare const ENTRY_DELIMITER = "\n\u00A7\n";
/**
 * One curation operation. `match` is a unique substring of exactly one
 * entry — ambiguous or missing matches throw rather than guess. `"*"` in
 * a remove means every entry. `add`/`replace` `text` must not contain
 * {@link ENTRY_DELIMITER}: such a write would re-segment the file on the
 * next read, so it throws and the batch lands nothing.
 */
export type MemoryOp = {
    readonly op: "add";
    readonly text: string;
} | {
    readonly op: "replace";
    readonly match: string;
    readonly text: string;
} | {
    readonly op: "remove";
    readonly match: string;
};
/** What one memory file holds right now. */
export interface ReadResult {
    /** Entries in file order; empty when the file is absent or malformed. */
    readonly entries: readonly string[];
    /** Chars of the joined file content (the number the limit bounds). */
    readonly chars: number;
    /** The file's char limit. */
    readonly limit: number;
    /** Why the file could not be read (invalid UTF-8 or a read error). */
    readonly malformed?: string;
}
/** A batch that would land the file over its limit. Nothing is written. */
export declare class MemoryOverLimit extends Error {
    /** The file the batch targeted. */
    readonly file: MemoryFile;
    /** Chars the batch result would reach. */
    readonly chars: number;
    /** The file's limit. */
    readonly limit: number;
    /** How far over: `chars - limit`. */
    readonly overBy: number;
    /** The entries the file still holds — the rejected batch wrote nothing. */
    readonly entries: readonly string[];
    constructor(
    /** The file the batch targeted. */
    file: MemoryFile, 
    /** Chars the batch result would reach. */
    chars: number, 
    /** The file's limit. */
    limit: number, 
    /** How far over: `chars - limit`. */
    overBy: number, 
    /** The entries the file still holds — the rejected batch wrote nothing. */
    entries: readonly string[]);
}
/** Constructor options: the per-user data dir and limit overrides. */
export interface MemoryFilesOptions {
    /** The user's data directory (`host.stores.user(user).paths.data`). */
    readonly dir: string;
    /** Per-file char limit overrides; unset files fall back to defaults. */
    readonly limits?: Readonly<Partial<Record<MemoryFile, number>>>;
}
/** Metadata an apply caller attaches (the curator's review id, C3). */
export interface ApplyMeta {
    /** The curation review that produced the batch, when known. */
    readonly reviewId?: string;
}
/** What one accepted change returned. */
export interface ChangeResult {
    /** Names the saved version (hand to `undo` to restore the before-state). */
    readonly changeId: string;
    /** Human-readable op counts. */
    readonly summary: string;
}
/** What an undo returned (undo is undoable via its own changeId). */
export interface UndoResult {
    /** The file that was restored. */
    readonly file: MemoryFile;
    /** Names the version saved from the CURRENT state before restoring. */
    readonly changeId: string;
    /** Human-readable summary. */
    readonly summary: string;
}
/** One user's memory files on disk. Never touches another user's dir. */
export declare class MemoryFiles {
    #private;
    constructor(options: MemoryFilesOptions);
    /** The joined file content (the number the limit bounds). */
    static contentOf(entries: readonly string[]): string;
    /**
     * Split file text into entries. A file whose every segment is empty
     * (hand-written bytes that are only delimiters — this layer can no
     * longer produce them, see the add/replace guard) reads as the EMPTY
     * state, a fresh-file equivalent, not a row of phantom empty entries;
     * the bytes themselves are never rewritten.
     */
    static splitEntries(text: string): string[];
    /** The file's path under this user's data dir. */
    path(file: MemoryFile): string;
    /**
     * Read one file. NEVER rewrites — a malformed or unreadable file is
     * reported, not repaired. An absent file is the empty state (not
     * malformed); invalid UTF-8 or a read error reads as malformed with
     * empty entries.
     */
    read(file: MemoryFile): Promise<ReadResult>;
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
    apply(file: MemoryFile, ops: readonly MemoryOp[], _meta?: ApplyMeta): Promise<ChangeResult>;
    /**
     * Undo one change: the CURRENT bytes are saved as a new version first
     * (so the undo is itself undoable through its returned changeId),
     * then the named version's bytes are restored verbatim — including
     * malformed bytes.
     */
    undo(changeId: string): Promise<UndoResult>;
}

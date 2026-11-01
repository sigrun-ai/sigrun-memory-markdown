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

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The two per-user memory files. */
export type MemoryFile = "user" | "memory";

/** One file's on-disk name. */
const FILE_NAMES: Readonly<Record<MemoryFile, string>> = {
	user: "USER.md",
	memory: "MEMORY.md",
};

/** Default per-file char limits (the `limits` setting overrides). */
export const DEFAULT_LIMITS: Readonly<Record<MemoryFile, number>> = {
	user: 1375,
	memory: 2200,
};

/** How entries are joined in the file (and split on read). */
export const ENTRY_DELIMITER = "\n§\n";

/** Versions kept per file (newest ten). */
const VERSIONS_KEPT = 10;

/**
 * One curation operation. `match` is a unique substring of exactly one
 * entry — ambiguous or missing matches throw rather than guess. `"*"` in
 * a remove means every entry.
 */
export type MemoryOp =
	| { readonly op: "add"; readonly text: string }
	| { readonly op: "replace"; readonly match: string; readonly text: string }
	| { readonly op: "remove"; readonly match: string };

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
export class MemoryOverLimit extends Error {
	constructor(
		/** The file the batch targeted. */
		readonly file: MemoryFile,
		/** Chars the batch result would reach. */
		readonly chars: number,
		/** The file's limit. */
		readonly limit: number,
		/** How far over: `chars - limit`. */
		readonly overBy: number,
		/** The entries the file still holds — the rejected batch wrote nothing. */
		readonly entries: readonly string[],
	) {
		super(
			`${FILE_NAMES[file]} would reach ${chars}/${limit} chars (${overBy} over)`,
		);
		this.name = "MemoryOverLimit";
	}
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
export class MemoryFiles {
	readonly #dir: string;
	readonly #limits: Readonly<Record<MemoryFile, number>>;
	#sequence = 0;
	#lock: Promise<unknown> = Promise.resolve();

	constructor(options: MemoryFilesOptions) {
		this.#dir = options.dir;
		this.#limits = Object.freeze({ ...DEFAULT_LIMITS, ...options.limits });
	}

	/** The joined file content (the number the limit bounds). */
	static contentOf(entries: readonly string[]): string {
		return entries.join(ENTRY_DELIMITER);
	}

	/** The file's path under this user's data dir. */
	path(file: MemoryFile): string {
		return join(this.#dir, FILE_NAMES[file]);
	}

	/** The versions directory for one file. */
	#versionsDir(file: MemoryFile): string {
		return join(this.#dir, "versions", file);
	}

	/**
	 * Read one file. NEVER rewrites — a malformed or unreadable file is
	 * reported, not repaired. An absent file is the empty state (not
	 * malformed); invalid UTF-8 or a read error reads as malformed with
	 * empty entries.
	 */
	async read(file: MemoryFile): Promise<ReadResult> {
		const raw = await this.#readRaw(file);
		if (raw.malformed !== undefined) {
			return {
				entries: [],
				chars: 0,
				limit: this.#limits[file],
				malformed: raw.malformed,
			};
		}
			const text =
				raw.bytes.length === 0 ? "" : new TextDecoder().decode(raw.bytes);
		const entries = text === "" ? [] : text.split(ENTRY_DELIMITER);
		return {
			entries,
			chars: MemoryFiles.contentOf(entries).length,
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
	async apply(
		file: MemoryFile,
		ops: readonly MemoryOp[],
		_meta: ApplyMeta = {},
	): Promise<ChangeResult> {
		return this.#serialized(async () => {
			const current = await this.#readRaw(file);
			if (current.malformed !== undefined) {
				const clears =
					ops.length > 0 &&
					ops[0].op === "remove" &&
					ops[0].match === "*";
				if (!clears) {
					throw new Error(
						`${FILE_NAMES[file]} is malformed (${current.malformed}); only a ` +
							`batch starting with {op: "remove", match: "*"} is accepted`,
					);
				}
			}
			const entries = this.#entriesOf(current);
			const next = this.#fold(file, entries, ops);
			this.#checkLimit(file, next, entries);

			const changeId = this.#nextChangeId();
			await this.#saveVersion(file, changeId, current.bytes);
			await mkdir(this.#dir, { recursive: true });
			await writeFile(this.path(file), MemoryFiles.contentOf(next), "utf8");
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
	async undo(changeId: string): Promise<UndoResult> {
		return this.#serialized(async () => {
			const file = await this.#findVersionFile(changeId);
			const versionBytes = await readFile(
				join(this.#versionsDir(file), `${changeId}.md`),
			);
			const current = await this.#readRaw(file);
			const currentEntries = this.#entriesOf(current);
			const savedId = this.#nextChangeId();
			await this.#saveVersion(file, savedId, current.bytes);
			await mkdir(this.#dir, { recursive: true });
			await writeFile(this.path(file), versionBytes);
			const restoredRaw = new Uint8Array(versionBytes);
			const restored =
				restoredRaw.length === 0
					? []
					: new TextDecoder().decode(restoredRaw).split(ENTRY_DELIMITER);
			return {
				file,
				changeId: savedId,
				summary: `undo ${changeId.slice(-8)}: ${FILE_NAMES[file]} ` +
					`${currentEntries.length} → ${restored.length} entries`,
			};
		});
	}

	/** Run one exclusive step of the apply/undo read-modify-write cycle. */
	#serialized<T>(step: () => Promise<T>): Promise<T> {
		const run = this.#lock.then(step, step);
		this.#lock = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/** Read the file's bytes; absent reads as empty, errors read as malformed. */
	async #readRaw(
		file: MemoryFile,
	): Promise<{ bytes: Uint8Array; malformed?: string }> {
		let bytes: Uint8Array;
		try {
			bytes = new Uint8Array(await readFile(this.path(file)));
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return { bytes: new Uint8Array() };
			return {
					bytes: new Uint8Array(),
					malformed: `read error: ${code ?? String(error)}`,
				};
		}
		if (bytes.length === 0) return { bytes };
		try {
			new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			return { bytes, malformed: "invalid UTF-8" };
		}
		return { bytes };
	}

	/** Decode raw bytes to entries (malformed bytes already rejected). */
	#entriesOf(raw: { bytes: Uint8Array; malformed?: string }): string[] {
		if (raw.malformed !== undefined) return [];
		if (raw.bytes.length === 0) return [];
		return new TextDecoder().decode(raw.bytes).split(ENTRY_DELIMITER);
	}

	/** Fold ops over entries; an ambiguous or missing match throws. */
	#fold(
		file: MemoryFile,
		entries: readonly string[],
		ops: readonly MemoryOp[],
	): string[] {
		const next = [...entries];
		for (const op of ops) {
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
				throw new Error(
					`${FILE_NAMES[file]}: no entry matches "${op.match}" (${op.op})`,
				);
			}
			if (hits.length > 1) {
				throw new Error(
					`${FILE_NAMES[file]}: ambiguous match "${op.match}" (${op.op}): ` +
						`${hits.length} entries match it; a match must be unique`,
				);
			}
			if (op.op === "replace") next[hits[0]] = op.text;
			else next.splice(hits[0], 1);
		}
		return next;
	}

	/**
	 * Throw {@link MemoryOverLimit} when the batch result exceeds the limit.
	 * `entries` carries the file's CURRENT entries — the rejected batch
	 * wrote nothing, so those are what a retry removes or shortens.
	 */
	#checkLimit(
		file: MemoryFile,
		entries: readonly string[],
		current: readonly string[],
	): void {
		const chars = MemoryFiles.contentOf(entries).length;
		const limit = this.#limits[file];
		if (chars > limit) {
			throw new MemoryOverLimit(file, chars, limit, chars - limit, current);
		}
	}

	/** A sortable, collision-free change id (timestamp + sequence + uuid). */
	#nextChangeId(): string {
		const stamp = Date.now().toString(36);
		const sequence = this.#sequence.toString(36).padStart(6, "0");
		this.#sequence += 1;
		return `${stamp}-${sequence}-${randomUUID().slice(0, 8)}`;
	}

	/** Save one version (bytes verbatim) and prune to the newest ten. */
	async #saveVersion(
		file: MemoryFile,
		changeId: string,
		bytes: Uint8Array,
	): Promise<void> {
		const dir = this.#versionsDir(file);
		await mkdir(dir, { recursive: true });
		// Rename-into-place: a reader never sees a half-written version.
		const staging = join(dir, `.${changeId}.tmp`);
		await writeFile(staging, bytes);
		await rename(staging, join(dir, `${changeId}.md`));
		const names = (await readdir(dir)).filter((name) => name.endsWith(".md"));
		const kept = names.sort().slice(-VERSIONS_KEPT);
		const remove = names.filter((name) => !kept.includes(name));
		await Promise.all(
			remove.map((name) => rm(join(dir, name), { force: true })),
		);
	}

	/** Locate which file a changeId's version belongs to. */
	async #findVersionFile(changeId: string): Promise<MemoryFile> {
		const files: MemoryFile[] = ["user", "memory"];
		for (const file of files) {
			const names = await readdir(this.#versionsDir(file)).catch(
				(): string[] => [],
			);
			if (names.includes(`${changeId}.md`)) return file;
		}
		throw new Error(`unknown or pruned changeId "${changeId}"`);
	}
}

/** The human-readable apply summary. */
function summarize(
	file: MemoryFile,
	ops: readonly MemoryOp[],
	from: number,
	to: number,
): string {
	const counts = new Map<string, number>();
	for (const op of ops) counts.set(op.op, (counts.get(op.op) ?? 0) + 1);
	const parts = [...counts.entries()].map(([op, count]) => `${op} ${count}`);
	const body = parts.length === 0 ? "no ops" : parts.join(", ");
	return `${FILE_NAMES[file]}: ${body} (${from} → ${to} entries)`;
}

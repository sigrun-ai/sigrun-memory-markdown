/**
 * Task C1: per-user memory files (USER.md / MEMORY.md) with hard char
 * limits, entry ops, versions, and undo — the storage layer the memory
 * curation target (C3) and the live section (C2) build on.
 *
 * The fake host (Part C preamble) supplies the per-user data directories
 * and the deployment settings JSON; every literal is synthetic
 * (alice/bob, acme/) and every directory is a temp dir.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createFakeHost, type FakeHost } from "./fake-host.js";
import {
	DEFAULT_LIMITS,
	ENTRY_DELIMITER,
	MemoryFiles,
	MemoryOverLimit,
} from "../src/files.js";

let host: FakeHost;

beforeEach(async () => {
	host = await createFakeHost();
});

afterEach(async () => {
	await host.close();
});

/** A MemoryFiles rooted at the host's data dir for one user. */
function filesFor(user: string): MemoryFiles {
	return new MemoryFiles({ dir: host.stores.user(user).paths.data });
}

/** The on-disk path of one user's memory file. */
function pathOf(user: string, file: "user" | "memory"): string {
	return join(host.stores.user(user).paths.data, `${file.toUpperCase()}.md`);
}

/** A distinct entry text (never a substring of another fixture entry). */
function entry(n: number, tag = "acme"): string {
	return `${tag} fact number ${n}: the build stays green.`;
}

test("add, replace, and remove ops apply and read back", async () => {
	const files = filesFor("alice");

	const added = await files.apply("user", [
		{ op: "add", text: entry(1) },
		{ op: "add", text: entry(2) },
	]);
	expect(typeof added.changeId).toBe("string");
	expect(added.changeId).not.toBe("");
	expect(added.summary).toMatch(/add/);

	let read = await files.read("user");
	expect(read.entries).toEqual([entry(1), entry(2)]);
	expect(read.chars).toBe(entry(1).length + ENTRY_DELIMITER.length + entry(2).length);
	// The on-disk format is the delimiter-joined entries.
	expect(await readFile(pathOf("alice", "user"), "utf8")).toBe(
		entry(1) + ENTRY_DELIMITER + entry(2),
	);
	expect(read.limit).toBe(DEFAULT_LIMITS.user);
	expect(read.malformed).toBeUndefined();

	await files.apply("user", [
		{ op: "replace", match: "fact number 1", text: entry(3) },
	]);
	read = await files.read("user");
	expect(read.entries).toEqual([entry(3), entry(2)]);

	await files.apply("user", [{ op: "remove", match: "number 2" }]);
	read = await files.read("user");
	expect(read.entries).toEqual([entry(3)]);
});

test("ambiguous or missing match throws", async () => {
	const files = filesFor("alice");
	await files.apply("memory", [
		{ op: "add", text: "acme fact number 1: the build stays green." },
		{ op: "add", text: "acme deploys on fridays" },
	]);
	// "acme" matches both entries.
	await expect(
		files.apply("memory", [{ op: "remove", match: "acme" }]),
	).rejects.toThrow(/ambiguous/i);
	await expect(
		files.apply("memory", [{ op: "remove", match: "no such entry" }]),
	).rejects.toThrow(/no entr|missing|not found/i);
	// replace is equally strict.
	await expect(
		files.apply("memory", [
			{ op: "replace", match: "acme", text: "new text" },
		]),
	).rejects.toThrow(/ambiguous/i);
});

test("add or replace text containing the entry delimiter throws and writes nothing", async () => {
	const files = filesFor("alice");

	// A delimiter-bearing add on an ABSENT file: rejected, file stays absent.
	await expect(
		files.apply("memory", [{ op: "add", text: `a${ENTRY_DELIMITER}b` }]),
	).rejects.toThrow(/add.*delimiter|delimiter.*add/);
	await expect(readFile(pathOf("alice", "memory"))).rejects.toMatchObject({
		code: "ENOENT",
	});

	// Seed one entry so "unchanged" is observable, then a delimiter-bearing
	// replace: rejected, the file's bytes untouched.
	await files.apply("user", [{ op: "add", text: entry(1) }]);
	const before = await readFile(pathOf("alice", "user"), "utf8");
	await expect(
		files.apply("user", [
			{ op: "replace", match: "fact number 1", text: `x${ENTRY_DELIMITER}y` },
		]),
	).rejects.toThrow(/replace.*delimiter|delimiter.*replace/);
	expect(await readFile(pathOf("alice", "user"), "utf8")).toBe(before);

	// The delimiter anywhere in the text (leading here) is equally rejected.
	await expect(
		files.apply("user", [{ op: "add", text: `${ENTRY_DELIMITER}lead` }]),
	).rejects.toThrow(/delimiter/);
	expect(await readFile(pathOf("alice", "user"), "utf8")).toBe(before);
});

test("text containing the bare section mark (not the delimiter) applies normally", async () => {
	const files = filesFor("alice");
	const text = "acme uses the § mark alone: one entry, no re-segmentation.";
	await files.apply("user", [{ op: "add", text }]);
	expect((await files.read("user")).entries).toEqual([text]);
});

test("batch limit is checked on the result (remove+add fits when add alone would not)", async () => {
	const files = filesFor("alice");
	// A near-limit file: four DISTINCT ~500-char fillers (distinct so a
	// remove match stays unique), sized so one more 500-char add overflows.
	const filler = (n: number) => `filler-${n}:${"x".repeat(492)}`;
	await files.apply("memory", [
		{ op: "add", text: filler(1) },
		{ op: "add", text: filler(2) },
		{ op: "add", text: filler(3) },
		{ op: "add", text: filler(4) },
	]);
	const before = await files.read("memory");
	expect(before.chars).toBeGreaterThan(0);
	// An add alone would exceed the 2200-char memory limit.
	await expect(
		files.apply("memory", [{ op: "add", text: "y".repeat(500) }]),
	).rejects.toBeInstanceOf(MemoryOverLimit);
	// The same add WITH a removal of one filler entry fits.
	const merged = await files.apply("memory", [
		{ op: "remove", match: "filler-2:" },
		{ op: "add", text: "y".repeat(500) },
	]);
	expect(typeof merged.changeId).toBe("string");
	const after = await files.read("memory");
	expect(after.entries).toHaveLength(4);
	expect(after.entries).not.toContain(filler(2));
	expect(after.chars).toBeLessThanOrEqual(after.limit);
});

test("over limit reports overBy and the current entries", async () => {
	const files = filesFor("alice");
	const seed = await files.apply("user", [
		{ op: "add", text: entry(1) },
	]);
	expect(seed.changeId).toBeTruthy();
	// A batch whose RESULT would exceed the 1375-char user limit.
	const error = await files
		.apply("user", [{ op: "add", text: "z".repeat(DEFAULT_LIMITS.user + 10) }])
		.then(
			() => undefined,
			(e: unknown) => e,
		);
	expect(error).toBeInstanceOf(MemoryOverLimit);
	const over = error as MemoryOverLimit;
	expect(over.file).toBe("user");
	expect(over.limit).toBe(DEFAULT_LIMITS.user);
	expect(over.overBy).toBeGreaterThan(0);
	expect(over.chars).toBeGreaterThan(over.limit);
	// The file was NOT written — the rejected batch leaves it as it was.
	const read = await files.read("user");
	expect(read.entries).toEqual([entry(1)]);
	// The thrown entries are the CURRENT entries (what a retry builds on),
	// not the rejected batch's result.
	expect(over.entries).toEqual([entry(1)]);
});

test("undo restores and is itself undoable", async () => {
	const files = filesFor("alice");
	const first = await files.apply("user", [{ op: "add", text: entry(1) }]);
	const second = await files.apply("user", [{ op: "add", text: entry(2) }]);
	expect((await files.read("user")).entries).toEqual([entry(1), entry(2)]);

	await files.undo(second.changeId);
	expect((await files.read("user")).entries).toEqual([entry(1)]);

	await files.undo(first.changeId);
	expect((await files.read("user")).entries).toEqual([]);

	// Undoing again restores the second state: the undo saved current first.
	const versions = await readdir(
		join(host.stores.user("alice").paths.data, "versions", "user"),
	);
	expect(versions.length).toBeGreaterThanOrEqual(3);
	const undoIds = versions.filter((name) => name !== `${first.changeId}.md` && name !== `${second.changeId}.md`);
	expect(undoIds.length).toBeGreaterThanOrEqual(1);
	const latest = undoIds[0].replace(/\.md$/, "");
	await files.undo(latest);
	const read = await files.read("user");
	expect(read.entries).toContain(entry(2));
});

test("limits come from settings when set", async () => {
	// The class takes `limits` in its constructor; a later task wires the
	// deployment settings key. Here the settings-shaped object overrides
	// one limit and the other falls back to the default.
	await host.stores.settings.set({ limits: { user: 50 } });
	const settings = await host.stores.settings.get();
	const limits = {
		...DEFAULT_LIMITS,
		...(settings.limits as { user?: number; memory?: number }),
	};
	const files = new MemoryFiles({
		dir: host.stores.user("alice").paths.data,
		limits,
	});
	expect((await files.read("user")).limit).toBe(50);
	expect((await files.read("memory")).limit).toBe(DEFAULT_LIMITS.memory);
	const error = await files
		.apply("user", [{ op: "add", text: "a".repeat(80) }])
		.then(
			() => undefined,
			(e: unknown) => e,
		);
	expect(error).toBeInstanceOf(MemoryOverLimit);
});

test("malformed file: read reports malformed, bytes unchanged; only a remove-all batch is accepted", async () => {
	const files = filesFor("alice");
	const raw = new Uint8Array([0xff, 0xfe, 0x00, 0xfd, 0x81]); // invalid UTF-8
	await mkdir(host.stores.user("alice").paths.data, { recursive: true });
	await writeFile(pathOf("alice", "memory"), raw);

	const read = await files.read("memory");
	expect(read.entries).toEqual([]);
	expect(read.malformed).toBeTruthy();
	expect(read.chars).toBe(0);

	// Bytes unchanged: a read never rewrites the file.
	expect(new Uint8Array(await readFile(pathOf("alice", "memory")))).toEqual(raw);

	// A normal batch is refused on a malformed file.
	await expect(
		files.apply("memory", [{ op: "add", text: entry(1) }]),
	).rejects.toThrow(/malformed/i);
	await expect(
		files.apply("memory", [{ op: "remove", match: "anything" }]),
	).rejects.toThrow(/malformed/i);
	// Even a wildcard remove that does not START the batch is refused.
	await expect(
		files.apply("memory", [
			{ op: "add", text: entry(1) },
			{ op: "remove", match: "*" },
		]),
	).rejects.toThrow(/malformed/i);

	// The remove-all batch IS accepted and replaces the unreadable file.
	const cleared = await files.apply("memory", [
		{ op: "remove", match: "*" },
		{ op: "add", text: entry(1) },
	]);
	expect(typeof cleared.changeId).toBe("string");
	const after = await files.read("memory");
	expect(after.malformed).toBeUndefined();
	expect(after.entries).toEqual([entry(1)]);
});

test("a file of only delimiters reads as the empty state, not phantom entries", async () => {
	const files = filesFor("alice");
	await mkdir(host.stores.user("alice").paths.data, { recursive: true });
	// Hand-written bytes the layer itself can no longer produce (the guard
	// rejects delimiter-bearing text): every split segment is empty.
	await writeFile(
		pathOf("alice", "memory"),
		`${ENTRY_DELIMITER}${ENTRY_DELIMITER}`,
	);
	const read = await files.read("memory");
	expect(read.entries).toEqual([]);
	expect(read.chars).toBe(0);
	// Not malformed — byte preservation stands; only the entry view collapses.
	expect(read.malformed).toBeUndefined();
});

test("alice and bob directories never cross", async () => {
	const alice = filesFor("alice");
	const bob = filesFor("bob");

	await alice.apply("user", [{ op: "add", text: entry(1, "alice") }]);
	await bob.apply("user", [
		{ op: "add", text: entry(2, "bob") },
		{ op: "add", text: entry(3, "bob") },
	]);

	expect((await alice.read("user")).entries).toEqual([entry(1, "alice")]);
	expect((await bob.read("user")).entries).toEqual([
		entry(2, "bob"),
		entry(3, "bob"),
	]);

	// A bob-side removal never touches alice's file, and a match unique in
	// BOTH files resolves against bob's entries only (per-instance state).
	await bob.apply("user", [{ op: "remove", match: "fact number 2" }]);
	expect((await alice.read("user")).entries).toEqual([entry(1, "alice")]);
	expect((await bob.read("user")).entries).toHaveLength(1);

	// Independent versions: alice's undo history never names bob's file.
	const aliceVersions = await readdir(
		join(host.stores.user("alice").paths.data, "versions", "user"),
	);
	const bobVersions = await readdir(
		join(host.stores.user("bob").paths.data, "versions", "user"),
	);
	// One version per accepted change, each only in its own user's dir.
	expect(aliceVersions).toHaveLength(1);
	expect(bobVersions).toHaveLength(2);
});

test("per-user locking serializes concurrent applies", async () => {
	// One MemoryFiles instance shared across two users: the per-user lock
	// keeps interleaved applies from losing entries.
	const files = new MemoryFiles({ dir: host.stores.user("alice").paths.data });
	const other = new MemoryFiles({
		dir: host.stores.user("bob").paths.data,
	});
	await Promise.all([
		files.apply("memory", [{ op: "add", text: entry(1) }]),
		files.apply("memory", [{ op: "add", text: entry(2) }]),
		other.apply("memory", [{ op: "add", text: entry(3) }]),
	]);
	expect((await files.read("memory")).entries).toHaveLength(2);
	expect((await other.read("memory")).entries).toHaveLength(1);
});

test("newest 10 versions are kept", async () => {
	const files = filesFor("alice");
	const changeIds: string[] = [];
	for (let i = 0; i < 12; i++) {
		const change = await files.apply("memory", [
			{ op: "add", text: `acme fact ${i}: version churn.` },
		]);
		changeIds.push(change.changeId);
	}
	const versions = await readdir(
		join(host.stores.user("alice").paths.data, "versions", "memory"),
	);
	expect(versions).toHaveLength(10);
	// The two OLDEST change ids dropped; the newest ten survive.
	expect(versions).not.toContain(`${changeIds[0]}.md`);
	expect(versions).not.toContain(`${changeIds[1]}.md`);
	expect(versions).toContain(`${changeIds[11]}.md`);
});

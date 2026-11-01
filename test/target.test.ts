/**
 * Task C3: the `memory` curation target — `memory_write` (batched ops,
 * over-limit error results, `details.curation` change reporting), `undo`,
 * `maintain` (the ≤25% entry-loss guard, unparseable-text no-ops), the
 * exact guidance lines, and `userDeleted` as ring-drop + file deletion
 * (transferOwner removed — a departed user's memory must never merge
 * into the recipient's, 2026-10-26 ruling's reversal).
 *
 * End-to-end registration (P9 interception, fork-review writes) is
 * pinned in core (Task D1); these tests drive the registered tool and
 * target through the wiring over the fake host, with synthetic literals
 * only (alice/bob, acme/).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { EntryId, ToolExecutionApi } from "@earendil-works/pi-durable";
import type {
	CurationTarget,
	CurationRunResult,
	MaintenanceBudget,
} from "@sigrun/sigrun/extension";
import { createFakeHost, type FakeHost } from "./fake-host.js";
import {
	createMemory,
	type MemoryEventApi,
	type MemoryWiring,
} from "../src/degenerate.js";
import { ENTRY_DELIMITER, type MemoryOp } from "../src/files.js";

let host: FakeHost;

beforeEach(async () => {
	host = await createFakeHost();
});

afterEach(async () => {
	await host.close();
});

/** One user's memory file path in the fake host's stores. */
function pathFor(user: string, file: "USER.md" | "MEMORY.md"): string {
	return join(host.stores.user(user).paths.data, file);
}

/** Write one user's memory file verbatim (the bytes `apply` produces). */
async function writeMemory(
	user: string,
	file: "USER.md" | "MEMORY.md",
	content: string,
): Promise<void> {
	await mkdir(host.stores.user(user).paths.data, { recursive: true });
	await writeFile(pathFor(user, file), content, "utf8");
}

/** The empty event api (nothing here reads the transcript). */
const EMPTY_API: MemoryEventApi = {
	entry: async () => undefined,
	entries: async () => ({ items: [] }),
	document: async () => undefined,
};

/** A fabricated settled-run event (the host's delivery shape). */
function settled(
	conversationId: number,
	owner: string,
	inputText: string,
	answer: string,
): Parameters<MemoryWiring["runSettled"]>[0] {
	return {
		conversationId,
		owner,
		inputs: [1 as never],
		inputTexts: [inputText],
		outcome: {
			status: "answered",
			answerEntryId: 42 as EntryId,
			answer: fauxAssistantMessage(answer),
		},
	};
}

/** Call the registered `memory_write` tool as one conversation. */
async function callWrite(
	wiring: MemoryWiring,
	conversationId: number,
	args: { file: "user" | "memory"; ops: readonly MemoryOp[]; reason?: string },
): Promise<{
	text: string;
	isError: boolean;
	changeId?: string;
	summary?: string;
}> {
	const found = (wiring.extension.tools ?? []).find(
		(tool) => tool.name === "memory_write",
	);
	if (found === undefined) throw new Error("memory_write is not registered");
	// The tool reaches the host only through ToolExecutionApi.conversationId
	// (the same stub shape memory-degenerate.test.ts pins for memory_recall).
	const api = {
		conversationId,
		now: () => Date.now(),
	} as unknown as ToolExecutionApi;
	const result = await found.execute(args as never, api, BACKGROUND_CONTEXT);
	const blocks = result.output ?? [];
	const text = blocks
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("\n");
	const details = result.details as
		| { readonly curation?: { readonly changeId?: string; readonly summary?: string } }
		| undefined;
	return {
		text,
		isError: result.isError === true,
		changeId: details?.curation?.changeId,
		summary: details?.curation?.summary,
	};
}

/** The wiring's `memory` curation target. */
function targetOf(wiring: MemoryWiring): CurationTarget {
	const found = (wiring.curationTargets ?? []).find(
		(target) => target.name === "memory",
	);
	if (found === undefined) {
		throw new Error("the memory curation target is not declared");
	}
	return found;
}

/** A scripted maintenance budget: completed runs with fixed text. */
function scriptedBudget(
	text: string,
): { budget: MaintenanceBudget; inputs: string[] } {
	const inputs: string[] = [];
	return {
		inputs,
		budget: {
			deadline: Date.now() + 60_000,
			runs: 2,
			async run(input, tools): Promise<CurationRunResult> {
				inputs.push(input);
				if (tools.length > 0) {
					throw new Error("maintain must run its digest run toolless");
				}
				return { status: "completed", text, changes: [] };
			},
		},
	};
}

test("memory_write applies ops for the acting user and reports the change", async () => {
	host.setActingUser(1, "alice");
	const wiring = await createMemory(host);

	const result = await callWrite(wiring, 1, {
		file: "user",
		ops: [{ op: "add", text: "prefers concise answers" }],
		reason: "acme review",
	});

	expect(result.isError).toBe(false);
	expect(result.changeId).toBeTypeOf("string");
	expect(result.summary).toBe("USER.md: add 1 (0 → 1 entries)");
	expect(result.text).toBe("USER.md: add 1 (0 → 1 entries)");

	// The op landed in ALICE's file — and nowhere else.
	const read = await wiring.files("alice").read("user");
	expect(read.entries).toEqual(["prefers concise answers"]);
	await expect(readFile(pathFor("bob", "USER.md"))).rejects.toMatchObject({
		code: "ENOENT",
	});
});

test("memory_write in an ownerless conversation is an error result", async () => {
	const wiring = await createMemory(host);
	const result = await callWrite(wiring, 99, {
		file: "user",
		ops: [{ op: "add", text: "nowhere to land" }],
	});
	expect(result.isError).toBe(true);
	expect(result.text).toBe(
		"This conversation has no owner, so there is no user memory to write.",
	);
});

test("over-limit batches return the exact error text and the current entries", async () => {
	await host.stores.settings.set({ limits: { user: 40 } });
	host.setActingUser(2, "alice");
	// 14 + 3 ("\n§\n") + 13 = 30 chars; the add (16) would reach 30 + 3 + 16 = 49.
	const current = ["alpha fact one", "beta fact two"].join(ENTRY_DELIMITER);
	await writeMemory("alice", "USER.md", current);

	const wiring = await createMemory(host);
	const result = await callWrite(wiring, 2, {
		file: "user",
		ops: [{ op: "add", text: "gamma fact three" }],
	});

	expect(result.isError).toBe(true);
	expect(result.changeId).toBeUndefined();
	expect(result.text).toBe(
		"USER.md at 49/40 chars; this batch is 9 over. " +
			"Retry as one batch that removes or shortens entries and adds the new one." +
			"\n\nCurrent entries:\n- alpha fact one\n- beta fact two",
	);
	// The rejected batch wrote nothing.
	expect(await readFile(pathFor("alice", "USER.md"), "utf8")).toBe(current);
});

test("undo restores the file to the change's before-state", async () => {
	host.setActingUser(3, "alice");
	const wiring = await createMemory(host);

	await callWrite(wiring, 3, {
		file: "memory",
		ops: [{ op: "add", text: "acme cluster runs talos" }],
	});
	const second = await callWrite(wiring, 3, {
		file: "memory",
		ops: [{ op: "add", text: "deploys via flux" }],
	});
	expect((await wiring.files("alice").read("memory")).entries).toEqual([
		"acme cluster runs talos",
		"deploys via flux",
	]);

	await targetOf(wiring).undo("alice", second.changeId as string, {
		abortSignal: undefined,
	});

	expect((await wiring.files("alice").read("memory")).entries).toEqual([
		"acme cluster runs talos",
	]);
});

test("maintain rejecting a >25% loss changes nothing", async () => {
	host.setActingUser(4, "alice");
	const entries = [
		"editor is helix",
		"editor is helix (preferred)",
		"acme cluster runs talos",
		"deploys via flux",
	];
	await writeMemory("alice", "MEMORY.md", entries.join(ENTRY_DELIMITER));
	const wiring = await createMemory(host);

	// Four entries allow floor(4 × 0.25) = 1 removal; this removes 2.
	const { budget, inputs } = scriptedBudget(
		JSON.stringify([
			{ op: "remove", match: "helix (" },
			{ op: "remove", match: "talos" },
		]),
	);
	const report = await targetOf(wiring).maintain?.(
		"alice",
		{ abortSignal: undefined },
		budget,
	);

	expect(report).toEqual({ changes: [], more: false });
	expect((await wiring.files("alice").read("memory")).entries).toEqual(entries);
	// The digest ran once (the empty USER.md is skipped) and saw the entries.
	expect(inputs).toHaveLength(1);
	expect(inputs[0]).toContain("acme cluster runs talos");
});

test("maintain within the limit applies the merged result", async () => {
	host.setActingUser(5, "alice");
	await writeMemory(
		"alice",
		"MEMORY.md",
		[
			"editor is helix",
			"editor is helix (preferred)",
			"acme cluster runs talos",
			"deploys via flux",
		].join(ENTRY_DELIMITER),
	);
	const wiring = await createMemory(host);

	const { budget } = scriptedBudget(
		JSON.stringify([
			{ op: "remove", match: "helix (" },
			{ op: "replace", match: "editor is helix", text: "editor is helix on all hosts" },
		]),
	);
	const report = await targetOf(wiring).maintain?.(
		"alice",
		{ abortSignal: undefined },
		budget,
	);

	// One removal (≤ the 1 allowed) plus a merge replace → applied.
	expect(report?.more).toBe(false);
	expect(report?.changes).toHaveLength(1);
	expect(report?.changes[0]?.summary).toBe(
		"MEMORY.md: remove 1, replace 1 (4 → 3 entries)",
	);
	expect((await wiring.files("alice").read("memory")).entries).toEqual([
		"editor is helix on all hosts",
		"acme cluster runs talos",
		"deploys via flux",
	]);
});

test("unparseable maintain text changes nothing", async () => {
	host.setActingUser(6, "alice");
	const entries = ["acme cluster runs talos", "deploys via flux"];
	await writeMemory("alice", "MEMORY.md", entries.join(ENTRY_DELIMITER));
	const wiring = await createMemory(host);

	const { budget } = scriptedBudget(
		"Sorry — I could not summarize those entries.",
	);
	const report = await targetOf(wiring).maintain?.(
		"alice",
		{ abortSignal: undefined },
		budget,
	);

	expect(report).toEqual({ changes: [], more: false });
	expect((await wiring.files("alice").read("memory")).entries).toEqual(entries);
});

test("guidance is the exact three routing lines", async () => {
	const wiring = await createMemory(host);
	expect(await targetOf(wiring).guidance("alice")).toEqual([
		'USER.md (file "user"): who the user is — preferences, communication and work style, expectations of the agent.',
		'MEMORY.md (file "memory"): facts about their environment and projects — tool quirks, paths, endpoints, decisions.',
		"One fact goes in one file, never both. Procedures belong in skills. Facts about one codebase belong in its AGENTS.md, not memory. Never store secrets.",
	]);
});

test("userDeleted deletes alice's files and ring; bob's are untouched", async () => {
	host.setActingUser(7, "alice");
	host.setActingUser(8, "bob");
	const wiring = await createMemory(host);
	await callWrite(wiring, 7, {
		file: "user",
		ops: [{ op: "add", text: "alice profile marker" }],
	});
	await callWrite(wiring, 8, {
		file: "user",
		ops: [{ op: "add", text: "bob profile marker" }],
	});
	await wiring.runSettled(
		settled(7, "alice", "alice input", "alice answer"),
		EMPTY_API,
		BACKGROUND_CONTEXT,
	);
	await wiring.runSettled(
		settled(8, "bob", "bob input", "bob answer"),
		EMPTY_API,
		BACKGROUND_CONTEXT,
	);
	const aliceFiles = wiring.files("alice");

	await wiring.userDeleted(
		{ user: "alice", transferTo: "bob" },
		EMPTY_API,
		BACKGROUND_CONTEXT,
	);

	// Alice's files are deleted, not transferred.
	await expect(readFile(pathFor("alice", "USER.md"))).rejects.toMatchObject({
		code: "ENOENT",
	});
	await expect(readFile(pathFor("alice", "MEMORY.md"))).rejects.toMatchObject({
		code: "ENOENT",
	});
	// Her ring dropped; nothing merged into bob's.
	expect(wiring.backend.records("alice")).toEqual([]);
	expect(wiring.backend.records("bob").map((record) => record.text)).toEqual([
		"bob input",
		"bob answer",
	]);
	// Bob's files and ring are untouched.
	expect(await readFile(pathFor("bob", "USER.md"), "utf8")).toContain(
		"bob profile marker",
	);
	// The cached files instance is evicted: a recreated same-name user
	// gets a fresh instance over a fresh directory (C2 review carry).
	expect(wiring.files("alice")).not.toBe(aliceFiles);
});

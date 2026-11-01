/**
 * Task C2: the `long-term-memory` section renders the per-user memory
 * files (USER.md / MEMORY.md — Task C1's layer) live. Usage headers carry
 * a percentage, entries join by `§` lines, the owner resolves through
 * `host.identity.actingUser`, and empty memory renders the neutral line
 * — never the old placeholder, which stays exported but unused. An
 * ownerless conversation renders no user memory; a malformed file is
 * reported in its own block and the other block still renders.
 *
 * Every test renders through the wiring's REGISTERED section (the exact
 * object a host installs), with the fake host's stores on temp dirs and
 * synthetic literals only (alice/bob, acme/).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createFakeHost, type FakeHost } from "./fake-host.js";
import {
	createMemory,
	MEMORY_PLACEHOLDER,
	type MemoryWiring,
} from "../src/degenerate.js";
import { DEFAULT_LIMITS, ENTRY_DELIMITER } from "../src/files.js";

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

/** Render the wiring's registered long-term-memory section for one conversation. */
async function renderSection(
	wiring: MemoryWiring,
	conversationId: number,
): Promise<string> {
	const found = (wiring.extension.sections ?? []).find(
		(entry) => entry.key === "long-term-memory",
	);
	if (found === undefined) {
		throw new Error("the long-term-memory section is not registered");
	}
	const text = await found.render(
		{
			conversationId: conversationId as never,
			agent: null as never,
			env: undefined,
			shown: {},
			read: null as never,
		},
		BACKGROUND_CONTEXT,
	);
	if (text === undefined) throw new Error("the section rendered undefined");
	return text;
}

/** The expected usage header line for one file's numbers (nearest integer). */
function header(
	label: "USER PROFILE" | "MEMORY",
	chars: number,
	limit: number,
): string {
	const pct = Math.round((chars / limit) * 100);
	return `${label} [${pct}% — ${chars}/${limit} chars]`;
}

test("renders both files with usage headers", async () => {
	host.setActingUser(7, "alice");
	const userContent = [
		"prefers concise answers",
		"reviews PRs on acme/*",
	].join(ENTRY_DELIMITER);
	const memoryContent = [
		"acme cluster runs talos",
		"deploys via flux",
	].join(ENTRY_DELIMITER);
	await writeMemory("alice", "USER.md", userContent);
	await writeMemory("alice", "MEMORY.md", memoryContent);

	const wiring = await createMemory(host);
	expect(await renderSection(wiring, 7)).toBe(
		[
			`${header("USER PROFILE", userContent.length, DEFAULT_LIMITS.user)}\n${userContent}`,
			`${header("MEMORY", memoryContent.length, DEFAULT_LIMITS.memory)}\n${memoryContent}`,
		].join("\n\n"),
	);
});

test("empty memory renders the neutral line, not the old placeholder", async () => {
	host.setActingUser(8, "alice");
	const wiring = await createMemory(host);
	const text = await renderSection(wiring, 8);
	expect(text).toBe("No long-term memories yet.");
	expect(text).not.toBe(MEMORY_PLACEHOLDER);
	expect(text).not.toContain("not configured");
});

test("ownerless conversation renders the neutral line", async () => {
	// Alice HAS memory on disk; the unscripted (ownerless) conversation
	// still renders none of it — no owner, no user memory.
	await writeMemory("alice", "MEMORY.md", "acme cluster runs talos");
	const wiring = await createMemory(host);
	expect(await renderSection(wiring, 9)).toBe("No long-term memories yet.");
});

test("bob's conversation never shows alice's memory", async () => {
	host.setActingUser(1, "alice");
	host.setActingUser(2, "bob");
	await writeMemory("alice", "USER.md", "alice-only profile marker");
	await writeMemory("alice", "MEMORY.md", "alice-only memory marker");

	const wiring = await createMemory(host);
	const bobs = await renderSection(wiring, 2);
	expect(bobs).toBe("No long-term memories yet.");
	expect(bobs).not.toContain("alice-only");

	// Control: alice's own conversation does see her entries.
	const alices = await renderSection(wiring, 1);
	expect(alices).toContain("alice-only profile marker");
	expect(alices).toContain("alice-only memory marker");
});

test("deployment limits reach the usage header (read once at construction)", async () => {
	host.setActingUser(3, "alice");
	await host.stores.settings.set({ limits: { user: 100, memory: 40 } });
	const userContent = "x".repeat(50);
	const memoryContent = "y".repeat(20);
	await writeMemory("alice", "USER.md", userContent);
	await writeMemory("alice", "MEMORY.md", memoryContent);

	const wiring = await createMemory(host);
	// Settings are restart-required: a later edit must not reach the section.
	await host.stores.settings.set({ limits: { user: 999, memory: 999 } });

	expect(await renderSection(wiring, 3)).toBe(
		[
			`${header("USER PROFILE", 50, 100)}\n${userContent}`,
			`${header("MEMORY", 20, 40)}\n${memoryContent}`,
		].join("\n\n"),
	);
});

test("an empty file renders its bare header beside the other's entries", async () => {
	host.setActingUser(4, "alice");
	const memoryEntry = "acme cluster runs talos";
	await writeMemory("alice", "MEMORY.md", memoryEntry);

	const wiring = await createMemory(host);
	expect(await renderSection(wiring, 4)).toBe(
		[
			header("USER PROFILE", 0, DEFAULT_LIMITS.user),
			`${header("MEMORY", memoryEntry.length, DEFAULT_LIMITS.memory)}\n${memoryEntry}`,
		].join("\n\n"),
	);
});

test("a malformed MEMORY.md renders its note in its own block; USER.md still renders", async () => {
	host.setActingUser(5, "alice");
	const userEntry = "prefers concise answers";
	await writeMemory("alice", "USER.md", userEntry);
	await writeFile(
		pathFor("alice", "MEMORY.md"),
		new Uint8Array([0xff, 0xfe, 0x00, 0xfd, 0x81]), // invalid UTF-8
	);

	const wiring = await createMemory(host);
	expect(await renderSection(wiring, 5)).toBe(
		[
			`${header("USER PROFILE", userEntry.length, DEFAULT_LIMITS.user)}\n${userEntry}`,
			`${header("MEMORY", 0, DEFAULT_LIMITS.memory)}\n` +
				"(MEMORY.md could not be read; it is left unchanged)",
		].join("\n\n"),
	);
});

test("a malformed USER.md names USER.md in its note (MEMORY.md still renders)", async () => {
	host.setActingUser(6, "alice");
	const memoryEntry = "acme cluster runs talos";
	await writeMemory("alice", "MEMORY.md", memoryEntry);
	await writeFile(pathFor("alice", "USER.md"), new Uint8Array([0xff]));

	const wiring = await createMemory(host);
	expect(await renderSection(wiring, 6)).toBe(
		[
			`${header("USER PROFILE", 0, DEFAULT_LIMITS.user)}\n` +
				"(USER.md could not be read; it is left unchanged)",
			`${header("MEMORY", memoryEntry.length, DEFAULT_LIMITS.memory)}\n${memoryEntry}`,
		].join("\n\n"),
	);
});

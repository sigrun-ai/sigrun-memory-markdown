/**
 * The memory extension's declared settings (settings rework, Task 6): the
 * shared `limits` group, read once when the wiring is constructed. The
 * schema is the single source of the deleted `mergeLimits` parser's
 * contract — each file's budget is any finite number above zero, and
 * everything else (an absent block, a non-object block, a non-numeric or
 * non-positive per-file value) falls back to `DEFAULT_LIMITS` — and the
 * factory reads through the declared handle instead of
 * `host.stores.settings.get()`.
 */

import { describe, expect, test } from "vitest";
import { assertDrawable, checkStoredSettings } from "@sigrun/sigrun/settings-schema";

import { createMemory } from "../src/degenerate.js";
import { MEMORY_MARKDOWN_SETTINGS_SCHEMA } from "../src/settings-schema.js";
import { createFakeHost, type FakeHost } from "./fake-host.js";

/** Run `body` with a fresh fake host, closing its temp root afterwards. */
async function withHost(body: (host: FakeHost) => Promise<void>): Promise<void> {
	const host = await createFakeHost();
	try {
		await body(host);
	} finally {
		await host.close();
	}
}

describe("memory-markdown settings schema", () => {
	test("schema is drawable", () => {
		assertDrawable(MEMORY_MARKDOWN_SETTINGS_SCHEMA);
	});

	test("defaults match the old parser", async () => {
		// The old mergeLimits: an absent block is DEFAULT_LIMITS — 1375 chars
		// for USER.md, 2200 for MEMORY.md.
		expect(checkStoredSettings(MEMORY_MARKDOWN_SETTINGS_SCHEMA, {}).value).toEqual({
			limits: { user: 1375, memory: 2200 },
		});
		await withHost(async (host) => {
			expect(await (await createMemory(host)).files.limits()).toEqual({ user: 1375, memory: 2200 });
		});
	});

	test("an old settings file still loads", async () => {
		// The shape README.md documents, and the one section.test.ts and
		// target.test.ts write today.
		await withHost(async (host) => {
			await host.stores.settings.set({ limits: { user: 100, memory: 40 } });
			expect(await (await createMemory(host)).files.limits()).toEqual({ user: 100, memory: 40 });
			// A partial block keeps the other file's default (the old merge).
			await host.stores.settings.set({ limits: { user: 40 } });
			expect(await (await createMemory(host)).files.limits()).toEqual({ user: 40, memory: 2200 });
		});
	});

	test("a malformed limit falls back to its default (the old leniency)", async () => {
		for (const limits of ["big", 5, null, { user: 0, memory: -2 }, { user: "50" }, { user: null }]) {
			expect(checkStoredSettings(MEMORY_MARKDOWN_SETTINGS_SCHEMA, { limits }).value).toEqual({
				limits: { user: 1375, memory: 2200 },
			});
		}
		// The old parser honoured any finite positive number, fractions included.
		expect(
			checkStoredSettings(MEMORY_MARKDOWN_SETTINGS_SCHEMA, { limits: { user: 50.5 } }).value,
		).toEqual({ limits: { user: 50.5, memory: 2200 } });
	});

	test("a limit under the extension's final slug reaches MemoryFiles", async () => {
		// The regression this task fixes. This extension declares
		// `name: "sigrun.memory"` → final slug `sigrun-memory`, while its
		// package is `@sigrun/memory-markdown` → the loader's provisional slug
		// `memory-markdown`. The factory used to read settings DURING its body,
		// i.e. under the provisional slug, while the settings page writes the
		// final one — so a `limits` value edited on the page never reached the
		// files. The read now happens on first USE, after core's re-key.
		const host = await createFakeHost({ settingsSlug: "memory-markdown" });
		try {
			// A decoy under the provisional slug: the old factory-time read
			// resolved THIS file, which the settings page never writes.
			await host.stores.settings.set({ limits: { user: 11, memory: 22 } });
			// The factory runs under the provisional slug, as core does…
			const wiring = await createMemory(host);
			// …then the loader re-keys, and the settings page writes THAT slug.
			host.rekey("sigrun-memory");
			await host.stores.settings.set({ limits: { user: 100, memory: 40 } });

			expect(await wiring.files.limits()).toEqual({ user: 100, memory: 40 });
			expect((await (await wiring.files("alice")).read("user")).limit).toBe(100);
		} finally {
			await host.close();
		}
	});

	test("the factory declares the shared schema and no user schema", async () => {
		await withHost(async (host) => {
			await createMemory(host);
			expect(host.declaration).toEqual({ schema: MEMORY_MARKDOWN_SETTINGS_SCHEMA });
		});
	});
});

/**
 * Task 7 (memory-seam port): the degenerate MemoryBackend captures through
 * the host's `runSettled` delivery — the factory result carries NO `submit`
 * pass-through, no pending-inputs map, no afterResponse hook. The wiring
 * observes the run's user inputs from the host-resolved `inputTexts` and
 * the assistant answer from an answered outcome; an unanswered run observes
 * nothing. The same delivery attaches the settled conversation's transcript
 * as the recall source — recall keeps reading the durable transcript
 * (`entries()`, NOT the observe buffer), reaching history the live window
 * compacted away. The section is a stable placeholder until spec B.
 *
 * Harness-backed tests run against a faux provider (no network, no
 * credentials), proving the extension works against upstream pi-durable
 * alone, with zero sigrun-core dependency: this file opens a raw pi-durable
 * Harness directly and simulates the host's runSettled delivery itself.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	createRegistry,
	Harness,
	type Conversation,
	type ConversationId,
	type EntryId,
	type HarnessSettings,
	type ModelRef,
	type Registry,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
	createMemory,
	DegenerateMemoryBackend,
	MEMORY_PLACEHOLDER,
	type MemoryEventApi,
	type MemoryWiring,
	type RunSettledEvent,
} from "../src/degenerate.js";

type CompactionSettings = NonNullable<HarnessSettings["compaction"]>;

/** A live pi-durable Harness plus the registry and default model it uses. */
interface OpenedMemoryHarness {
	readonly harness: Harness;
	readonly registry: Registry;
	readonly defaultModel: ModelRef;
}

/**
 * Open a hermetic raw pi-durable Harness whose root conversation answers
 * through a faux provider, with the memory extension installed before
 * `Harness.open`. `compaction` forces pi-durable's threshold-compaction
 * thresholds (the compacted-recall test); omitted leaves the default policy.
 */
async function openMemoryHarness(
	dir: string,
	compaction?: CompactionSettings,
): Promise<{ opened: OpenedMemoryHarness; memory: MemoryWiring; faux: ReturnType<typeof fauxProvider> }> {
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([fauxAssistantMessage("faux answer one")]);
	const models = createModels();
	models.setProvider(faux.provider);
	const defaultModel: ModelRef = { provider: "faux", modelId: "m" };

	const memory = createMemory();
	const registry = createRegistry();
	registry.install(memory.extension);

	const harness = await Harness.open(
		await openNodeSqliteStorage(join(dir, "sigrun.db")),
		{
			models,
			registry,
			...(compaction === undefined ? {} : { settings: { compaction } }),
		},
		BACKGROUND_CONTEXT,
	);
	harness.resume();
	return { opened: { harness, registry, defaultModel }, memory, faux };
}

/** Submit one user input directly (no wiring submit — the seam retired it) and wait for settlement. */
async function ask(
	opened: OpenedMemoryHarness,
	text: string,
	context: Context,
) {
	const root = await opened.harness.root(context, {
		agent: { model: opened.defaultModel },
	});
	const submission = await root.submit(
		{ type: "input", content: text },
		context,
	);
	await submission.wait(context);
	return { root, submission };
}

/** The empty event api (unit tests that never read the transcript). */
const EMPTY_API: MemoryEventApi = {
	entry: async () => undefined,
	entries: async () => ({ items: [] }),
	document: async () => undefined,
};

/**
 * Run the registered `memory_recall` tool as a call from `conversationId`,
 * returning the text the model would see. The tool reaches the host only
 * through `ToolExecutionApi.conversationId`, so that field is the whole
 * stub — a tool that reads anything else here fails loudly.
 */
async function callRecallTool(
	opened: OpenedMemoryHarness,
	conversationId: ConversationId,
	query: string,
): Promise<{ text: string; isError: boolean }> {
	const found = opened.registry
		.snapshot()
		.tools()
		.find((entry) => entry.tool.name === "memory_recall");
	if (found === undefined) throw new Error("memory_recall is not registered");
	const api = { conversationId } as unknown as ToolExecutionApi;
	const result = await found.tool.execute(
		{ query } as never,
		api,
		BACKGROUND_CONTEXT,
	);
	const blocks = result.output ?? [];
	const text = blocks
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("\n");
	return { text, isError: result.isError === true };
}

/** Create one ownerless conversation whose runs answer through the faux provider. */
async function openConversation(
	opened: OpenedMemoryHarness,
): Promise<Conversation> {
	const conversation = await opened.harness.createConversation(
		{ ownership: { kind: "ownerless" }, agent: { model: opened.defaultModel } },
		BACKGROUND_CONTEXT,
	);
	return conversation;
}

/** The event api rooted at one conversation's transcript scan. */
function apiFor(root: { entries: MemoryEventApi["entries"] }): MemoryEventApi {
	return {
		entry: async () => undefined,
		entries: (query, limit, cursor, context) =>
			root.entries(query, limit, cursor, context),
		document: async () => undefined,
	};
}

/** A fabricated settled-run event (the host's delivery shape). */
function fakeEvent(options: {
	inputTexts: readonly string[];
	status: "answered" | "unanswered";
	answer?: string;
	reason?: string;
	conversationId?: number;
	owner?: string;
}): RunSettledEvent {
	const base = {
		conversationId: options.conversationId ?? 1,
		...(options.owner === undefined ? {} : { owner: options.owner }),
		inputs: options.inputTexts.map(
			(_, index) => (index + 1) as RunSettledEvent["inputs"][number],
		),
		inputTexts: options.inputTexts,
	};
	if (options.status === "answered") {
		return {
			...base,
			outcome: {
				status: "answered",
				answerEntryId: 42 as EntryId,
				answer: fauxAssistantMessage(options.answer ?? "faux answer one"),
			},
		};
	}
	return {
		...base,
		outcome: { status: "unanswered", reason: options.reason ?? "model_error" },
	};
}

test("createMemory() wiring carries NO submit; capture rides runSettled", async () => {
	const wiring = createMemory();
	// The seam retired the submit pass-through — the field is gone.
	expect((wiring as { submit?: unknown }).submit).toBeUndefined();
	// Simulate the host delivering a settled run:
	await wiring.runSettled(
		fakeEvent({ inputTexts: ["hello"], status: "answered", answer: "hi there" }),
		EMPTY_API,
		BACKGROUND_CONTEXT,
	);
	// The observe ring carries user "hello" + the answer.
	expect(wiring.backend.records().map((record) => record.role)).toEqual([
		"user",
		"assistant",
	]);
	expect(wiring.backend.records()[0]?.text).toBe("hello");
	expect(wiring.backend.records()[1]?.text).toBe("hi there");
});

test("an unanswered run observes nothing (no orphan user record)", async () => {
	const wiring = createMemory();
	await wiring.runSettled(
		fakeEvent({ inputTexts: ["doomed input"], status: "unanswered" }),
		EMPTY_API,
		BACKGROUND_CONTEXT,
	);
	// The delivery still bound the conversation's transcript as its recall
	// source (recall works after a failed turn too — the transcript exists
	// regardless), while observing nothing into it.
	expect(wiring.backend.records()).toHaveLength(0);
	const hits = await wiring.backend.recall("anything", 1);
	expect(hits).toEqual([]);
});

test("unresolvable inputs (\"\" at their position) record nothing", async () => {
	const wiring = createMemory();
	await wiring.runSettled(
		fakeEvent({
			inputTexts: ["first", ""],
			status: "answered",
			answer: "answered both",
		}),
		EMPTY_API,
		BACKGROUND_CONTEXT,
	);
	// One user record (the resolvable input) + the shared answer.
	expect(wiring.backend.records().map((record) => record.role)).toEqual([
		"user",
		"assistant",
	]);
	expect(wiring.backend.records()[0]?.text).toBe("first");
});

test("recall works without any submit binding (reads the durable transcript)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-memory-"));
	try {
		const { opened, memory } = await openMemoryHarness(dir);
		try {
			const { root } = await ask(opened, "hello from the user", BACKGROUND_CONTEXT);

			// The host's delivery: no wiring submit ever ran — the recall source
			// arrives with the event, through the event's entries surface.
			await memory.runSettled(
				fakeEvent({
					inputTexts: ["hello from the user"],
					status: "answered",
				}),
				apiFor(root),
				BACKGROUND_CONTEXT,
			);

			const records = memory.backend.records();
			expect(records.map((record) => record.role)).toEqual([
				"user",
				"assistant",
			]);

			// Recall reads the durable transcript and finds the turn — with real
			// entry ids, proof the scan is transcript-backed, not ring-backed.
			const hits = await memory.backend.recall("hello from the user", root.id);
			expect(hits.length).toBeGreaterThanOrEqual(1);
			expect(hits[0]?.role).toBe("user");
			expect(hits[0]?.text).toContain("hello from the user");

			// The extension registered the recall tool and the placeholder section.
			const snapshot = opened.registry.snapshot();
			expect(snapshot.tools().map((entry) => entry.tool.name)).toContain(
				"memory_recall",
			);
			expect(snapshot.sections().map((entry) => entry.section.key)).toContain(
				"long-term-memory",
			);
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("recall reaches an entry the live window compacted away", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-memory-"));
	try {
		// Forced thresholds: the blocking threshold is
		// `contextWindow - reserveTokens` = 400 tokens, so turn two's transcript
		// (two ~300-token user messages plus the answer) overflows it while turn
		// one's does not, and `keepRecentTokens: 1` cuts everything before the
		// newest user message. `backgroundTokens: 0` keeps compaction blocking-
		// only so the faux response queue stays deterministic.
		const { opened, memory, faux } = await openMemoryHarness(dir, {
			reserveTokens: 127_600,
			keepRecentTokens: 1,
			backgroundTokens: 0,
		});
		try {
			const secret = "the secret passphrase is sigrun-memorable";
			const longUser1 = `${secret}. ${"filler ".repeat(180)}`;
			const { root } = await ask(opened, longUser1, BACKGROUND_CONTEXT);

			// Turn two: the compaction summary consumes one faux response, the
			// generation's answer the next.
			faux.appendResponses([
				fauxAssistantMessage("compacted history summary"),
				fauxAssistantMessage("faux answer two"),
			]);
			const second = await root.submit(
				{ type: "input", content: `second question ${"context ".repeat(160)}` },
				BACKGROUND_CONTEXT,
			);
			const settled = await second.wait(BACKGROUND_CONTEXT);
			expect(settled.status).toBe("done");

			// The live context no longer contains the first user message: the
			// threshold compaction cut it. (This also proves the compaction ran —
			// without it the recall assertion below would pass vacuously.)
			const view = await root.context(BACKGROUND_CONTEXT);
			const liveUserText = view.messages
				.filter((message) => message.role === "user")
				.map((message) =>
					typeof message.content === "string"
						? message.content
						: message.content
								.map((block) => (block.type === "text" ? block.text : ""))
								.join(""),
				)
				.join("\n");
			expect(liveUserText).not.toContain("sigrun-memorable");

			// Recall reads the durable transcript and still finds the compacted-out
			// entry — the App C `entries()`-reachability verification. A *fresh*
			// backend that observes nothing containing the secret (its one delivery
			// carries only turn two's input) makes the read independent of the
			// in-process observe ring: only the transcript scan can hold the history.
			const fresh = new DegenerateMemoryBackend();
			const freshWiring = createMemory(fresh);
			await freshWiring.runSettled(
				fakeEvent({
					conversationId: root.id,
					inputTexts: ["second question"],
					status: "answered",
				}),
				apiFor(root),
				BACKGROUND_CONTEXT,
			);
			expect(
				fresh.records().some((record) => record.text.includes("sigrun-memorable")),
			).toBe(false);
			const hits = await fresh.recall("sigrun-memorable", root.id);
			expect(hits.length).toBeGreaterThanOrEqual(1);
			expect(hits.some((hit) => hit.text.includes("sigrun-memorable"))).toBe(
				true,
			);
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("section() returns the stable placeholder and the section renders it", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-memory-"));
	try {
		const { opened, memory } = await openMemoryHarness(dir);
		try {
			expect(memory.backend.section()).toBe(MEMORY_PLACEHOLDER);
			const found = opened.registry
				.snapshot()
				.sections()
				.find((entry) => entry.section.key === "long-term-memory");
			expect(found).toBeDefined();
			// The degenerate section ignores its input; the minimal PromptInput
			// keeps this test independent of the other render fields.
			expect(
				await found?.section.render(
					{
						conversationId: 1 as never,
						agent: null as never,
						env: undefined,
						shown: {},
						read: null as never,
					},
					BACKGROUND_CONTEXT,
				),
			).toBe(MEMORY_PLACEHOLDER);
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("recall in conversation A finds A's text only, even after B settled last", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-memory-"));
	try {
		const { opened, memory, faux } = await openMemoryHarness(dir);
		try {
			const conversationA = await openConversation(opened);
			faux.setResponses([fauxAssistantMessage("answer for A")]);
			const firstA = await conversationA.submit(
				{ type: "input", content: "alice-only marker alpha" },
				BACKGROUND_CONTEXT,
			);
			await firstA.wait(BACKGROUND_CONTEXT);
			await memory.runSettled(
				fakeEvent({
					conversationId: conversationA.id,
					inputTexts: ["alice-only marker alpha"],
					status: "answered",
					answer: "answer for A",
				}),
				apiFor(conversationA),
				BACKGROUND_CONTEXT,
			);

			// B settles LAST: with a single global source it becomes the one
			// every later recall reads, which is exactly the leak.
			const conversationB = await openConversation(opened);
			faux.setResponses([fauxAssistantMessage("answer for B")]);
			const firstB = await conversationB.submit(
				{ type: "input", content: "bob-only marker beta" },
				BACKGROUND_CONTEXT,
			);
			await firstB.wait(BACKGROUND_CONTEXT);
			await memory.runSettled(
				fakeEvent({
					conversationId: conversationB.id,
					inputTexts: ["bob-only marker beta"],
					status: "answered",
					answer: "answer for B",
				}),
				apiFor(conversationB),
				BACKGROUND_CONTEXT,
			);

			// The tool, as A's agent calls it: A's text answers the query, B's does not.
			const inA = await callRecallTool(
				opened,
				conversationA.id,
				"marker alpha",
			);
			expect(inA.isError).toBe(false);
			expect(inA.text).toContain("alice-only marker alpha");
			expect(inA.text).not.toContain("bob-only marker beta");

			// And the same query about B's text finds nothing in A.
			const bTextInA = await callRecallTool(
				opened,
				conversationA.id,
				"marker beta",
			);
			expect(bTextInA.isError).toBe(false);
			expect(bTextInA.text).toBe("No matches found.");

			// B still recalls its own text — scoping is not "latest wins either way".
			const inB = await callRecallTool(opened, conversationB.id, "marker beta");
			expect(inB.text).toContain("bob-only marker beta");
			expect(inB.text).not.toContain("alice-only marker alpha");
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("recall in a conversation that never settled returns No matches found", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-memory-"));
	try {
		const { opened, memory, faux } = await openMemoryHarness(dir);
		try {
			// One conversation settles, so a global source WOULD have content.
			const settled = await openConversation(opened);
			faux.setResponses([fauxAssistantMessage("settled answer")]);
			const submission = await settled.submit(
				{ type: "input", content: "settled marker gamma" },
				BACKGROUND_CONTEXT,
			);
			await submission.wait(BACKGROUND_CONTEXT);
			await memory.runSettled(
				fakeEvent({
					conversationId: settled.id,
					inputTexts: ["settled marker gamma"],
					status: "answered",
					answer: "settled answer",
				}),
				apiFor(settled),
				BACKGROUND_CONTEXT,
			);

			// A conversation that has never settled a run: empty, never another's.
			const fresh = await openConversation(opened);
			const result = await callRecallTool(
				opened,
				fresh.id,
				"settled marker gamma",
			);
			expect(result.isError).toBe(false);
			expect(result.text).toBe("No matches found.");
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("observe records land in per-owner rings, not one shared ring", async () => {
	const wiring = createMemory();
	await wiring.runSettled(
		fakeEvent({
			conversationId: 1,
			owner: "alice",
			inputTexts: ["alice input"],
			status: "answered",
			answer: "alice answer",
		}),
		EMPTY_API,
		BACKGROUND_CONTEXT,
	);
	await wiring.runSettled(
		fakeEvent({
			conversationId: 2,
			owner: "bob",
			inputTexts: ["bob input"],
			status: "answered",
			answer: "bob answer",
		}),
		EMPTY_API,
		BACKGROUND_CONTEXT,
	);
	await wiring.runSettled(
		fakeEvent({
			conversationId: 3,
			inputTexts: ["ownerless input"],
			status: "answered",
			answer: "ownerless answer",
		}),
		EMPTY_API,
		BACKGROUND_CONTEXT,
	);

	expect(wiring.backend.records("alice").map((record) => record.text)).toEqual([
		"alice input",
		"alice answer",
	]);
	expect(wiring.backend.records("bob").map((record) => record.text)).toEqual([
		"bob input",
		"bob answer",
	]);
	// Ownerless runs key on "", never on a named user's ring.
	expect(wiring.backend.records("").map((record) => record.text)).toEqual([
		"ownerless input",
		"ownerless answer",
	]);
});

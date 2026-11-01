/**
 * The minimal fake host for the curation-target tests (Part C preamble).
 *
 * The gateway extension's fake host implements the whole `SigrunHost`;
 * memory-markdown needs only the two members the curation surface
 * touches, so this fake stays minimal and curation-free:
 *
 * - `stores`: per-user `data`/`state`/`cache` directories plus the
 *   deployment-level `settings` JSON — all under one root (a temp dir
 *   unless the test supplies one), mirroring the real host's
 *   `host.stores.user(user).paths` shape.
 * - `identity.actingUser`: scriptable per conversation id, so tests pin
 *   whose memory a write lands in without booting a harness.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The stores + identity surface these tests program against. */
export interface FakeHost {
	/** The scoped extension-stores shape (paths only, per user). */
	readonly stores: {
		/** One directory user's paths, still scoped to the fake root. */
		user(user: string): {
			readonly paths: {
				readonly data: string;
				readonly state: string;
				readonly cache: string;
			};
		};
		/** The deployment-level settings JSON (absent reads as `{}`). */
		readonly settings: {
			get(): Promise<Record<string, unknown>>;
			set(value: Record<string, unknown>): Promise<void>;
		};
	};
	/** The conversation-owner resolver, backed by the scriptable map. */
	readonly identity: {
		actingUser(conversationId: number): Promise<string | undefined>;
	};
	/** Script the owner one conversation resolves to (undefined = ownerless). */
	setActingUser(conversationId: number, user: string | undefined): void;
	/** Tear down the stores root when the fake owned it (a temp dir). */
	readonly close: () => Promise<void>;
}

/** Fake host options: the stores root (a temp dir when absent). */
export interface FakeHostOptions {
	/** Directory the stores root at; a temp dir when absent. */
	readonly storesDir?: string;
}

/**
 * Build the fake host. ASYNC: the temp root is created before the host is
 * usable. Per-user directories are created eagerly on first `user()` call
 * so tests can hand `paths.data` straight to file-owning code.
 */
export async function createFakeHost(
	options: FakeHostOptions = {},
): Promise<FakeHost> {
	const owned = options.storesDir === undefined;
	const root = options.storesDir ?? (await mkdtemp(join(tmpdir(), "mm-host-")));
	const settingsPath = join(root, "settings.json");
	const owners = new Map<number, string>();

	const userStores = (user: string) => {
		const userRoot = join(root, "users", user);
		return {
			paths: {
				get data() {
					return join(userRoot, "data");
				},
				get state() {
					return join(userRoot, "state");
				},
				get cache() {
					return join(userRoot, "cache");
				},
			},
		};
	};

	return {
		stores: {
			user: userStores,
			settings: {
				async get(): Promise<Record<string, unknown>> {
					try {
						return JSON.parse(await readFile(settingsPath, "utf8")) as Record<
							string,
							unknown
						>;
					} catch {
						return {};
					}
				},
				async set(value: Record<string, unknown>): Promise<void> {
					await mkdir(dirname(settingsPath), { recursive: true });
					await writeFile(settingsPath, JSON.stringify(value, null, "\t"));
				},
			},
		},
		identity: {
			actingUser(conversationId: number) {
				return Promise.resolve(owners.get(conversationId));
			},
		},
		setActingUser(conversationId: number, user: string | undefined) {
			if (user === undefined) owners.delete(conversationId);
			else owners.set(conversationId, user);
		},
		close: owned
			? () => rm(root, { recursive: true, force: true })
			: () => Promise.resolve(),
	};
}

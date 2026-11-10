/**
 * The minimal fake host for the curation-target and settings tests (Part C
 * preamble, settings rework).
 *
 * The gateway extension's fake host implements the whole `SigrunHost`;
 * memory-markdown needs only three members, so this fake stays minimal and
 * curation-free:
 *
 * - `settings.declare`: core's declared-settings handle, implemented with
 *   the real `checkStoredSettings`, so a test sees exactly the defaults and
 *   repairs core applies. Settings live per SLUG (`settings/<slug>.json`),
 *   and `rekey` models the loader's re-key to the extension's declared
 *   slug — the ordering this repo's lazy limit read depends on.
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

import type {
	DeclaredSettings,
	SettingsDeclaration,
} from "@sigrun/sigrun/extension";
import { checkStoredSettings } from "@sigrun/sigrun/settings-schema";

/** The stores + identity surface these tests program against. */
export interface FakeHost {
	/** The declaration the factory passed to `settings.declare`. */
	readonly declaration: SettingsDeclaration | undefined;
	/** The declared-settings read (defaults applied, malformed values repaired). */
	readonly settings: {
		declare<S, U = Record<string, never>>(
			declaration: SettingsDeclaration,
		): DeclaredSettings<S, U>;
	};
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
	/**
	 * Model the loader's post-resolution re-key: settings reads move from the
	 * package-derived provisional slug to the extension's declared slug, the
	 * scope the settings page writes.
	 */
	rekey(slug: string): void;
	/** The slug settings currently resolve under (the settings page's scope). */
	readonly settingsSlug: string;
	/** Tear down the stores root when the fake owned it (a temp dir). */
	readonly close: () => Promise<void>;
}

/** Fake host options: the stores root (a temp dir when absent). */
export interface FakeHostOptions {
	/** Directory the stores root at; a temp dir when absent. */
	readonly storesDir?: string;
	/**
	 * The slug settings resolve under at construction — the loader's
	 * provisional, package-derived slug. `rekey` moves it to the declared
	 * slug, as core does once the factory has returned.
	 */
	readonly settingsSlug?: string;
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
	const settingsDir = join(root, "settings");
	let settingsSlug = options.settingsSlug ?? "memory-markdown";
	const settingsPath = () => join(settingsDir, `${settingsSlug}.json`);
	const owners = new Map<number, string>();
	const declared: { declaration: SettingsDeclaration | undefined } = {
		declaration: undefined,
	};
	/** The settings JSON as stored (an absent or unreadable file reads `{}`). */
	const readSettings = async (): Promise<Record<string, unknown>> => {
		try {
			return JSON.parse(await readFile(settingsPath(), "utf8")) as Record<string, unknown>;
		} catch {
			return {};
		}
	};

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
		get declaration() {
			return declared.declaration;
		},
		settings: {
			declare: <S, U = Record<string, never>>(
				declaration: SettingsDeclaration,
			): DeclaredSettings<S, U> => {
				declared.declaration = declaration;
				return {
					get: async () =>
						checkStoredSettings(declaration.schema, await readSettings()).value as S,
					user: () => {
						throw new Error("the fake host declares no per-user settings schema");
					},
				};
			},
		},
		get settingsSlug() {
			return settingsSlug;
		},
		rekey(slug: string) {
			settingsSlug = slug;
		},
		stores: {
			user: userStores,
			settings: {
				get: readSettings,
				async set(value: Record<string, unknown>): Promise<void> {
					await mkdir(dirname(settingsPath()), { recursive: true });
					await writeFile(settingsPath(), JSON.stringify(value, null, "\t"));
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

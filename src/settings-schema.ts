/**
 * The memory extension's shared (operator) settings schema (settings
 * rework, Task 6): `limits` is the whole surface — the per-file character
 * budgets `USER.md` and `MEMORY.md` are held to. The declared checked read
 * applies `DEFAULT_LIMITS` and repairs malformed stored values to them,
 * which is the deleted `mergeLimits` parser's gentle-parse posture.
 */

import { Type, type Static } from "typebox";

import { DEFAULT_LIMITS } from "./files.js";

/**
 * Widen a TypeBox schema to the host's structural JSON-Schema contract
 * (`SettingsJsonSchema = Readonly<Record<string, unknown>>`): TypeBox's
 * TObject carries no string index signature, but every schema it builds
 * IS a plain JSON object. The `Static` type stays on the original.
 */
function asJsonSchema<T>(schema: T): T & Readonly<Record<string, unknown>> {
	return schema as T & Readonly<Record<string, unknown>>;
}

/**
 * One file's budget. The old parser honoured any finite number above zero
 * (a fraction included) and fell back to the default for everything else,
 * so the bound is the same strict `> 0` and the default carries the
 * fallback.
 */
function budget(title: string, description: string, defaultValue: number) {
	return Type.Number({
		title,
		description,
		exclusiveMinimum: 0,
		default: defaultValue,
		// Read once at first use, memoized for the boot.
		"x-sigrun-apply": "restart",
	});
}

export const MEMORY_MARKDOWN_SETTINGS_SCHEMA = asJsonSchema(Type.Object({
	limits: Type.Object(
		{
			user: budget("USER", "Character budget for USER.md.", DEFAULT_LIMITS.user),
			memory: budget("MEMORY", "Character budget for MEMORY.md.", DEFAULT_LIMITS.memory),
		},
		{
			title: "Limits",
			description:
				"Hard character budget per memory file; a malformed or non-positive value falls back to its default.",
			// A malformed block as a whole is replaced by the defaults, the
			// same whole-block fallback the old parser had.
			default: { user: DEFAULT_LIMITS.user, memory: DEFAULT_LIMITS.memory },
		},
	),
}));

export type MemoryMarkdownSettings = Static<typeof MEMORY_MARKDOWN_SETTINGS_SCHEMA>;

/**
 * The memory extension's shared (operator) settings schema (settings
 * rework, Task 6): `limits` is the whole surface — the per-file character
 * budgets `USER.md` and `MEMORY.md` are held to. The declared checked read
 * applies `DEFAULT_LIMITS` and repairs malformed stored values to them,
 * which is the deleted `mergeLimits` parser's gentle-parse posture.
 */
import { Type, type Static } from "typebox";
export declare const MEMORY_MARKDOWN_SETTINGS_SCHEMA: Type.TObject<{
    limits: Type.TObject<{
        user: Type.TNumber;
        memory: Type.TNumber;
    }>;
}> & Readonly<Record<string, unknown>>;
export type MemoryMarkdownSettings = Static<typeof MEMORY_MARKDOWN_SETTINGS_SCHEMA>;

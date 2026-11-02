/**
 * The `memory` curation target (Task C3, curator spec §6.4): the
 * `memory_write` tool plus the target declaration the wiring carries on
 * the factory result's `curationTargets` — the package's entire
 * curator-contract surface.
 *
 * - `memory_write` writes for `host.identity.actingUser(api
 *   .conversationId)` — inside a curator run that resolves to the run's
 * user. Writes are batched operations over one named file, applied
 * atomically through the SAME per-user {@link MemoryFiles} the live
 * section renders (one serialized queue per user). A batch that would
 * land the file over its limit is an ERROR RESULT — text the model
 * reads and recovers from in its own retry — carrying the exact
 * overage and the file's current entries, because the rejected batch
 * wrote nothing and a retry must free space in the same call.
 * - Every accepted write reports `details.curation = {changeId,
 *   summary}` (the A6/A8 convention): the change id the curator's undo
 *   surface hands back to {@link CurationTarget.undo}.
 * - `maintain` merges duplicates and drops superseded facts through a
 *   toolless digest run per non-empty file. The model returns
 * OPERATIONS, not a rewritten file; a result that would remove more
 * than a quarter of the existing entries is discarded (openclaw's
 * `maxPriorEntryLossFraction` default, 0.25) — maintenance tightens,
 * it never guts.
 */
import { Type } from "@earendil-works/pi-ai";
import type { CurationTarget } from "@sigrun/sigrun/extension";
import type { MemoryFilesFor, MemoryHost } from "./degenerate.js";
/**
 * The target's routing guidance, shown to the curator when deciding
 * where a lesson goes (exact lines — the routing rule the spec pins).
 */
export declare const MEMORY_GUIDANCE: readonly string[];
/**
 * Build the `memory_write` tool. Registered by the wiring's extension
 * (the loader's registered-tool check and A8's wrapping both key off
 * the registration), writing through the per-user {@link MemoryFiles}.
 */
export declare function memoryWriteTool(host: MemoryHost, filesFor: MemoryFilesFor): import("@earendil-works/pi-durable").ToolRegistration<Type.TObject<{
    file: Type.TUnion<[Type.TLiteral<"user">, Type.TLiteral<"memory">]>;
    ops: Type.TArray<Type.TUnion<[Type.TObject<{
        op: Type.TLiteral<"add">;
        text: Type.TString;
    }>, Type.TObject<{
        op: Type.TLiteral<"replace">;
        match: Type.TString;
        text: Type.TString;
    }>, Type.TObject<{
        op: Type.TLiteral<"remove">;
        match: Type.TString;
    }>]>>;
    reason: Type.TOptional<Type.TString>;
}>, import("@earendil-works/chord").JsonValue>;
/**
 * Build the `memory` curation target. `undo` restores through the
 * same per-user {@link MemoryFiles} (which saves the current state
 * first, so an undo is itself undoable); `maintain` bounds its loss
 * and reports every applied change for the undo surface.
 */
export declare function createMemoryTarget(filesFor: MemoryFilesFor): CurationTarget;

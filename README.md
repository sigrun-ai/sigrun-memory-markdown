# @sigrun/memory-markdown

Long-term memory for [sigrun](https://github.com/sigrun-ai/sigrun) (pi-durable). Each user gets two markdown files — `USER.md` for who they are, `MEMORY.md` for their environment and projects — rendered live into the `long-term-memory` prompt section and written exclusively by the sigrun curator through this package's `memory` curation target.

The factory takes the host as its first declared parameter (the sigrun loader's arity rule) and returns `{ backend, extension, files, curationTargets, runSettled, userDeleted }`. The extension installs the `memory_recall` tool and the live section; `curationTargets` carries the `memory` target; the host's memory seam delivers settled runs to `runSettled`.

## What it stores

`USER.md` and `MEMORY.md` live under the owner's data directory. One fact is one entry; entries are joined by `§` separators, and nothing else touches the files:

```markdown
# USER.md
prefers short answers with links to sources
§
works in CET; schedule deep-dive calls after 14:00
```

Each file has a hard character budget — by default **1375 chars for `USER.md`, 2200 for `MEMORY.md`** — enforced on every write's *result*: a batch that removes or shortens enough to fit lands in one atomic step, never as a rejected intermediate state. The deployment `limits` settings block overrides the budgets per file:

```json
{ "limits": { "user": 2000, "memory": 3000 } }
```

Limits are read once at startup (settings are restart-required in the sigrun convention); a malformed or non-positive override falls back to its default.

Every accepted change saves the previous bytes as a version (newest ten kept per file), so any change can be undone — including through malformed bytes — and an undo is itself undoable.

## The live section

`long-term-memory` renders the conversation owner's memory: one block per file under a usage header (`USER PROFILE [63% — 867/1375 chars]`, then `MEMORY [...]`), entries separated by `§` lines. Ownerless conversations and empty memory render a neutral line (`No long-term memories yet.`) — never another user's memory. **Existing installs start empty**: this release replaces the old static placeholder. A file that cannot be read is reported in place and left unchanged, never repaired.

## memory_recall

The extension also registers `memory_recall`, which searches the **calling conversation's** durable transcript — including history compacted out of the live window — and nothing else: one user's agent can never read another conversation's history through it.

## The curator is the only writer

`memory_write` is declared on the `memory` curation target, so every write comes from a curator run — not from the live conversation. That is deliberate: the budgets are small, which makes direct writes from a chat an anti-pattern — a model writing mid-conversation has a narrow view of the file and every incentive to hoard. Instead, a call marks "remember this" and the curator reviews candidates with the whole file in view, routing each fact to the right file, merging duplicates, and keeping the budget honest.

When a user is deleted, their memory goes with them: `userDeleted` deletes the departing owner's files, versions, and observe ring rather than transferring them — a recipient must never absorb the departed user's records.

## The `memory` curation target — a worked example

This target is a complete, minimal example of sigrun's `CurationTarget` contract, and third-party authors are encouraged to copy its shape:

```ts
import createMemory from "@sigrun/memory-markdown";

const memory = await createMemory(host);
registry.install(memory.extension);
// memory.curationTargets === [{ name: "memory", tools: ["memory_write"], ... }]
```

- **`name: "memory"`** — the id core qualifies as `<extension-slug>:memory`.
- **`tools: ["memory_write"]`** — the registered tool the target claims. Core wraps claimed tools so that inside a curator run they act for the run's user, and every accepted write reports `details.curation = { changeId, summary }` — the change id the curator's undo surface hands back to `undo`.
- **`guidance(user)`** — the routing lines the curator sees when deciding where a fact goes: which file holds what, one fact never in both, procedures belong in skills, codebase facts in that codebase's AGENTS.md, never secrets.
- **`undo(user, changeId)`** — restores the named version through the same per-user files, saving the current state first so the undo is itself undoable.
- **`maintain(user, budget)`** — the toolless maintenance pass: one digest run per non-empty file that returns *operations* (merge duplicates, drop superseded facts), applied only if it would remove no more than a quarter of the entries — maintenance tightens, it never guts.

The write tool itself is worth copying too: batches are atomic (`add`/`replace`/`remove`, all or none); the limit is checked on the batch result; and an over-limit batch is an ERROR RESULT — text the model reads and recovers from — carrying the exact overage and the file's current entries, because the rejected batch wrote nothing and a retry must free space in the same call.

### A direct "remember" tool

Nothing in the target contract forbids a direct write tool — a host or fork of this package could register one. But such a tool sits **outside** the target declaration: it would not be wrapped for curator runs, its changes would not flow through the curator's undo surface, and it would own its own undo path. This package ships none (see above for why).

## Requirements

- A sigrun core build that ships the curation-targets contract (P7). The curation-targets support is unreleased at the time of this package's version bump, so the minimum core version is deliberately not stated as a number — it gets pinned here at release time.
- Host modules are peers (`@earendil-works/pi-durable`, `@earendil-works/pi-ai`, `@earendil-works/chord` at `1.3.0 || 1.4.0`). This package adds **no** `@sigrun/sigrun` runtime dependency: the core types are a devDependency only, so nothing pins the host's core version from the extension side.

## Install

```sh
npm install @sigrun/memory-markdown
```

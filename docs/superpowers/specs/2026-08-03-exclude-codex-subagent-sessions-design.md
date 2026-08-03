# Exclude Codex subagent sessions — design

- **Date:** 2026-08-03
- **Branch:** `main`
- **Status:** Design (awaiting review)

## Problem

Codex Desktop persists every delegated worker as an independent rollout under
`CODEX_HOME`. The gateway currently treats every rollout with a valid `id` and
`cwd` as a user conversation. Consequently, Codex subagent sessions appear in
`/history`, `/history/discovered`, and `/history/search`, and the Web and native
clients render them alongside top-level conversations.

This is not duplicate execution: each row has a distinct session id and records
real delegated work. It is a history-enumeration problem. Subagent rollouts are
implementation details of a parent task and should not occupy user-facing
conversation lists or search results.

## Goals

- Exclude Codex subagent sessions from:
  - `GET /history`
  - `GET /history/discovered`
  - `GET /history/search`
- Detect subagents from rollout metadata, never from titles or transcript text.
- Apply the same behavior to active and archived Codex rollouts.
- Preserve direct access by explicit session id for diagnostics and cleanup:
  `/history/messages`, rename, and delete continue to work.
- Preserve all rollout files; filtering must not delete or rewrite user data.
- Keep legacy and malformed-but-otherwise-readable top-level rollouts visible
  unless they contain an explicit subagent marker.

## Non-goals

- Deleting, archiving, or rewriting existing subagent rollouts.
- Grouping subagents under their parent or adding a UI toggle to show them.
- Changing Claude or opencode history behavior.
- Repairing synthetic titles such as `<recommended_plugins>`; once subagent
  rows are hidden, title cleanup is a separate concern.
- Preventing Codex Desktop from creating subagent sessions.

## Observed Codex metadata

`codexMetaFromLine` currently reads only `payload.id`, `payload.cwd`, and
`payload.timestamp` from the first rollout line. The local corpus contains these
relevant variants:

```jsonc
// Top-level and legacy sessions
{ "source": "cli" }
{ "source": "vscode", "thread_source": "user" }
{ /* source missing */ }

// Older subagent form
{ "source": { "subagent": "review" } }

// Current subagent form
{
  "source": {
    "subagent": {
      "thread_spawn": {
        "parent_thread_id": "019fc4fa-...",
        "depth": 1
      }
    }
  },
  "thread_source": "subagent"
}
```

The `subagent` value is not stable: it may be a string or an object, and older
child rollouts may not carry a parent id. Classification therefore depends only
on the explicit marker, not its value or nested shape.

## Design

### Metadata classification

Extend the internal `CodexSessionFile` metadata with `isSubagent: boolean`.
`codexMetaFromLine` classifies a rollout as a subagent when either condition is
true:

1. `payload.source` is a non-array object with an own `subagent` property; or
2. `payload.thread_source === "subagent"`.

All other shapes are treated as top-level sessions. In particular, a missing
source, a string source, `null`, an array, or an object without an explicit
marker remains visible. This fail-open rule preserves legacy compatibility and
avoids silently hiding a legitimate conversation because Codex added an unknown
source shape.

The first-line parser still requires a valid string `id` and `cwd`. Its existing
behavior for malformed JSON or missing required fields remains unchanged.

### Active/archived deduplication

`listCodexSessionFiles` continues to enumerate both
`CODEX_HOME/sessions/**/*.jsonl` and `CODEX_HOME/archived_sessions/*.jsonl` and
select the newer file for duplicate session ids.

Classification is conservative across duplicates: if any copy with the same id
has an explicit subagent marker, the merged session remains `isSubagent: true`,
even when the newer copy lacks that marker. The newer copy still supplies the
file path, cwd, and recency fields. This prevents an incomplete archived or
active copy from making a known child session visible.

### Filtering boundary

Keep `listCodexSessionFiles` unfiltered. Direct lookup, message reading, repair,
and deletion depend on seeing every rollout.

Add one shared predicate/helper for user-visible Codex sessions and apply it at
the two enumeration producers:

- `listCodexHistory` filters the session files before cwd matching, sorting,
  limiting, and title derivation. This removes subagents from `/history` and
  ensures hidden rows do not consume the requested limit.
- `codexTranscriptCandidates` filters before producing candidates. Both
  `discoverCodexHistory` and `searchCandidates` consume this function, so
  `/history/discovered` and `/history/search` inherit the same rule. Search never
  opens or scans a hidden subagent transcript.

No route or client-side filtering is added. The API contract itself excludes
subagents, which keeps Web, iOS, and future clients consistent.

### Direct operations

These paths continue to use the unfiltered session-file walk:

- `/history/messages` can read a subagent rollout when the caller knows its
  session id and cwd.
- `DELETE /history/session` can remove a subagent rollout explicitly.
- `/history/rename` remains unchanged; it writes the existing per-cwd title
  sidecar and does not enumerate sessions.
- Codex interrupted-rollout repair can still find subagent files by id.

This separation makes subagents absent from discovery while retaining recovery
and cleanup capabilities.

## Data flow

```text
Codex rollout head
  -> parse id / cwd / timestamp / explicit subagent markers
  -> merge active + archived copies by session id
     -> visible enumeration filter
        -> /history
        -> /history/discovered
        -> /history/search candidate scan
     -> unfiltered direct lookup
        -> /history/messages
        -> delete / rollout repair
```

## Error and compatibility behavior

- Unknown metadata fails open: only explicit subagent markers hide a session.
- A malformed `source` does not invalidate a rollout whose required `id` and
  `cwd` remain valid.
- An unreadable or malformed first JSON line retains the existing behavior and
  is not listed or directly resolved.
- Filtering occurs before limits and search scanning, so hidden sessions neither
  displace top-level results nor consume search budget.
- No response schema changes are required.

## Testing

Implementation follows TDD: add and run the regression cases first, confirm each
fails because subagent filtering is absent, then write the minimal production
change.

Extend the Codex rollout fixture in `src/history.test.ts` so metadata can include
`source` and `thread_source`, and so a fixture may live under either the active
or archived directory.

Required coverage:

- `/history` behavior through `listAgentHistory`: retain top-level sessions with
  string, missing, and unrecognized object sources; exclude legacy string-valued
  and current object-valued `source.subagent` forms.
- `/history/discovered` behavior through `discoverCodexHistory`: exclude active
  and archived subagents before sorting and limiting.
- `/history/search` behavior through `searchCandidates` and
  `searchTranscripts`: a unique term present only in a subagent produces no
  result and its file is not scanned; a top-level match remains visible.
- Duplicate id behavior: a subagent marker on either the active or archived copy
  keeps the merged session hidden.
- Direct access regression: `readAgentHistoryMessages` still reads a hidden
  subagent by explicit id/cwd, and `deleteHistorySession` can explicitly delete
  one.
- Existing Codex discovery, search, deletion, and full server suites remain
  green.

No Web or native-client tests are required because their response shapes and
rendering do not change; server tests establish the shared API behavior.

## Files

- `src/gateway.ts` — parse the metadata marker, preserve it through active and
  archived deduplication, and filter the two user-facing enumeration producers.
- `src/history.test.ts` — fixtures and regression coverage for history,
  discovery, search, deduplication, and direct access.
- `src/gateway.e2e.test.ts` — unchanged; exported history-function tests cover
  the shared server policy without duplicating route plumbing assertions.
- `web/` and the native console repository — unchanged.

## Alternatives considered

### Filter in routes or clients

Rejected. It duplicates policy across `/history`, `/history/discovered`, Web,
and native clients. More importantly, `/history/search` would still enumerate
and scan subagent transcripts unless the same policy were independently added
inside the search pipeline.

### Filter inside `listCodexSessionFiles`

Rejected. This is the common storage walk for both enumeration and direct
operations. Removing subagents there would make explicit message reads,
deletion, and rollout repair unable to locate them.

### Add `includeSubagents` to the storage walk

Not selected. It can preserve direct operations, but introduces a caller option
for behavior that currently has one product rule: subagents are never
user-visible. Keeping the storage walk complete and filtering at the two
enumeration producers expresses that rule with less API surface.

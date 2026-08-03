# Exclude Codex Subagent Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove explicitly marked Codex subagent rollouts from `/history`, `/history/discovered`, and `/history/search` while preserving direct read, delete, rename, and repair behavior.

**Architecture:** Parse subagent markers from each rollout's `session_meta.payload`, preserve the classification while active and archived copies are deduplicated, and filter only at the two user-visible enumeration producers. The underlying Codex session-file walk stays complete so explicit session-id operations retain access to hidden rollouts.

**Tech Stack:** TypeScript, Node.js 24, `node:test`, JSONL Codex rollouts, existing gateway history/search pipeline.

---

## Reference

- Approved design: `docs/superpowers/specs/2026-08-03-exclude-codex-subagent-sessions-design.md`
- Repository: `/Users/george.c/git/my-apps/cloud-acp-gateway`
- Starting commit: `d2b323521b59fb514c41752cd63524f7f00a848b`
- Existing unrelated worktree state: untracked `.claude/`; do not add, edit, or remove it.
- Do not create a worktree. The repository instruction requires explicit user
  authorization for worktree creation, and none was given.

## File map

| File | Responsibility |
|---|---|
| `src/gateway.ts` | Parse Codex rollout metadata, merge active/archived copies, and enforce the user-visible enumeration boundary. |
| `src/history.test.ts` | Exercise Codex history, discovery, search, duplicate-id handling, and direct operations with isolated `CODEX_HOME` fixtures. |

No Web or native-console files change. Both clients already consume the three
server endpoints whose behavior changes.

## Task 1: Classify Codex rollouts and hide subagents from folder history

**Files:**

- Modify: `src/history.test.ts:127-153, 545, 617-649`
- Modify: `src/gateway.ts:1008-1098, 1166-1178`

- [ ] **Step 1: Extend the Codex rollout fixture without changing production code**

In `src/history.test.ts`, move `CODEX_CMD` from the deletion section to the
Codex fixture section and replace `writeCodexRollout` with this source-aware,
active/archived-aware fixture:

```ts
const CODEX_CMD = "/opt/acp-gateway/node_modules/.bin/codex-acp";

type CodexRolloutMeta = {
  id: string;
  cwd: string;
  timestamp: string;
  source?: unknown;
  thread_source?: unknown;
};

function writeCodexRollout(
  home: string,
  name: string,
  meta: CodexRolloutMeta,
  userText: string,
  location: "active" | "archived" = "active",
): string {
  const dir = location === "archived"
    ? path.join(home, "archived_sessions")
    : path.join(home, "sessions", "2026", "07", "20");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${name}.jsonl`);
  fs.writeFileSync(file, [
    { type: "session_meta", payload: meta },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: userText }] } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}
```

Delete the later duplicate declaration:

```ts
const CODEX_CMD = "/opt/acp-gateway/node_modules/.bin/codex-acp";
```

- [ ] **Step 2: Add the failing folder-history and direct-read regression test**

Append this test after `withCodexHome` in `src/history.test.ts`:

```ts
test("Codex history excludes explicit subagents but keeps direct access", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-codexhome-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-repo-"));
  const at = "2026-07-20T10:00:00.000Z";

  writeCodexRollout(home, "ROOT-CLI", { id: "CDX-ROOT-CLI", cwd, timestamp: at, source: "cli" }, "root cli");
  writeCodexRollout(home, "ROOT-LEGACY", { id: "CDX-ROOT-LEGACY", cwd, timestamp: at }, "root legacy");
  writeCodexRollout(home, "ROOT-OBJECT", { id: "CDX-ROOT-OBJECT", cwd, timestamp: at, source: { desktop: true } }, "root object");
  writeCodexRollout(home, "SUB-LEGACY", { id: "CDX-SUB-LEGACY", cwd, timestamp: at, source: { subagent: "review" } }, "legacy child");
  writeCodexRollout(home, "SUB-NESTED", {
    id: "CDX-SUB-NESTED", cwd, timestamp: at,
    source: { subagent: { thread_spawn: { parent_thread_id: "PARENT", depth: 1 } } },
  }, "nested child", "archived");
  writeCodexRollout(home, "SUB-THREAD-SOURCE", {
    id: "CDX-SUB-THREAD-SOURCE", cwd, timestamp: at,
    source: "cli", thread_source: "subagent",
  }, "thread-source child");

  const archivedDuplicate = writeCodexRollout(home, "DUP-ARCHIVED", {
    id: "CDX-DUP", cwd, timestamp: at, source: { subagent: "review" },
  }, "archived child marker", "archived");
  const activeDuplicate = writeCodexRollout(home, "DUP-ACTIVE", {
    id: "CDX-DUP", cwd, timestamp: at,
  }, "newer incomplete copy");
  fs.utimesSync(archivedDuplicate, new Date(1000), new Date(1000));
  fs.utimesSync(activeDuplicate, new Date(2000), new Date(2000));

  const listed = await withCodexHome(home, () => listAgentHistory(CODEX_CMD, cwd, 20));
  assert.deepEqual(listed.map((s) => s.sessionId).sort(), [
    "CDX-ROOT-CLI",
    "CDX-ROOT-LEGACY",
    "CDX-ROOT-OBJECT",
  ]);

  const direct = await withCodexHome(home, () =>
    readAgentHistoryMessages(CODEX_CMD, cwd, "CDX-SUB-NESTED", 20));
  const directTexts = direct?.messages.flatMap((message) =>
    message.blocks.filter((block) => block.type === "text").map((block) => block.text));
  assert.deepEqual(directTexts, ["nested child"], "an explicit id/cwd can still read a hidden subagent");
});
```

This one test locks in all classification inputs, both rollout locations,
duplicate-id marker preservation, list filtering, and the direct-read exception.

- [ ] **Step 3: Make the existing explicit-delete test protect subagent deletion**

In `deleting a codex conversation unlinks its rollout and leaves the index
alone`, change only the `session_meta` payload to mark the fixture as a child:

```ts
{ type: "session_meta", payload: {
  id: "CDX-1",
  cwd,
  timestamp: "2026-07-20T10:00:00Z",
  source: { subagent: "review" },
} },
```

The existing assertions already prove an explicit delete still finds and
unlinks the rollout, leaves `session_index.jsonl` untouched, and becomes a no-op
on a second request.

- [ ] **Step 4: Run the RED test and verify the failure reason**

Run:

```bash
ACPG_NO_LISTEN=1 \
ACPG_AUTH_USER=test-user \
ACPG_AUTH_TOKEN=test-token \
ACPG_LEDGER_DIR="$(mktemp -d)" \
CLAUDE_CONFIG_DIR="$(mktemp -d)" \
CODEX_HOME="$(mktemp -d)" \
node --import tsx --test \
  --test-name-pattern="Codex history excludes explicit subagents|deleting a codex conversation" \
  src/history.test.ts
```

Expected: `Codex history excludes explicit subagents but keeps direct access`
fails because `listed` still contains `CDX-SUB-*` and `CDX-DUP`. The delete test
passes, proving direct deletion already works and must remain intact.

- [ ] **Step 5: Parse explicit subagent markers into `CodexSessionFile`**

In `src/gateway.ts`, replace the Codex metadata types and
`codexMetaFromLine` with:

```ts
type CodexIndexEntry = { id: string; thread_name?: string; updated_at?: string };
type CodexSessionFile = {
  id: string;
  cwd: string;
  file: string;
  updatedAt: string;
  isSubagent: boolean;
};
type CodexSessionMeta = {
  id: string;
  cwd: string;
  timestamp?: string;
  isSubagent: boolean;
};

function codexMetaFromLine(line: Record<string, unknown> | null): CodexSessionMeta | null {
  const payload = line?.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.id !== "string" || typeof p.cwd !== "string") return null;
  const source = p.source;
  const sourceMarksSubagent = !!source && typeof source === "object" && !Array.isArray(source)
    && Object.prototype.hasOwnProperty.call(source, "subagent");
  return {
    id: p.id,
    cwd: p.cwd,
    timestamp: typeof p.timestamp === "string" ? p.timestamp : undefined,
    isSubagent: sourceMarksSubagent || p.thread_source === "subagent",
  };
}
```

Update `codexSessionFileFromPath` so the parsed marker reaches the file record:

```ts
return {
  id: meta.id,
  cwd: meta.cwd,
  file,
  updatedAt: mtime || meta.timestamp || "",
  isSubagent: meta.isSubagent,
};
```

- [ ] **Step 6: Preserve the marker while duplicate ids are merged**

Replace the loop body in `listCodexSessionFiles` with:

```ts
for (const session of [...archived, ...active]) {
  const existing = byId.get(session.id);
  if (!existing) {
    byId.set(session.id, session);
    continue;
  }
  const newer = dateValue(session.updatedAt) >= dateValue(existing.updatedAt)
    ? session
    : existing;
  byId.set(session.id, {
    ...newer,
    isSubagent: existing.isSubagent || session.isSubagent,
  });
}
```

This keeps the existing newest-file semantics while preventing an incomplete
copy from losing a known child classification.

- [ ] **Step 7: Filter only the `/history` producer**

Add this shared predicate immediately after `listCodexSessionFiles`:

```ts
function isUserVisibleCodexSession(session: CodexSessionFile): boolean {
  return !session.isSubagent;
}
```

In `listCodexHistory`, add it before cwd matching and before the limit:

```ts
const matching = sessions
  .filter(isUserVisibleCodexSession)
  .filter((s) => sameCwd(s.cwd, cwd))
  .map((s) => ({ ...s, index: index.get(s.id) }))
  .sort((a, b) => dateValue(b.index?.updated_at || b.updatedAt) - dateValue(a.index?.updated_at || a.updatedAt))
  .slice(0, limit);
```

Do not filter `listCodexSessionFiles` itself. `findCodexSessionFile`,
`findCodexSessionFileById`, direct reads, delete, and repair must continue using
the complete list.

- [ ] **Step 8: Run GREEN verification for Task 1**

Run:

```bash
ACPG_NO_LISTEN=1 \
ACPG_AUTH_USER=test-user \
ACPG_AUTH_TOKEN=test-token \
ACPG_LEDGER_DIR="$(mktemp -d)" \
CLAUDE_CONFIG_DIR="$(mktemp -d)" \
CODEX_HOME="$(mktemp -d)" \
node --import tsx --test \
  --test-name-pattern="Codex history excludes explicit subagents|deleting a codex conversation" \
  src/history.test.ts
npm run typecheck
```

Expected: both selected tests pass; typecheck exits `0` with no diagnostics.

- [ ] **Step 9: Commit Task 1**

```bash
git add src/gateway.ts src/history.test.ts
git diff --cached --check
git commit -m "fix(history): hide Codex subagents from folder history"
```

Expected: one commit containing only the Task 1 parser, deduplication,
`/history` filter, and regression tests.

## Task 2: Exclude subagents from discovery and content search

**Files:**

- Modify: `src/history.test.ts:155-181, 1117-1150`
- Modify: `src/gateway.ts:1186-1194`

- [ ] **Step 1: Make the existing Codex discovery test fail for active and archived children**

In `Codex discovery spans folders and filters outside the filesystem root`, add
these fixtures after the existing `CDX-A`, `CDX-B`, and `CDX-C` rollouts:

```ts
writeCodexRollout(home, "SUB-ACTIVE", {
  id: "CDX-SUB-ACTIVE",
  cwd: inCwd,
  timestamp: "2026-07-20T15:00:00.000Z",
  source: { subagent: "review" },
}, "hidden active child");
writeCodexRollout(home, "SUB-ARCHIVED", {
  id: "CDX-SUB-ARCHIVED",
  cwd: otherCwd,
  timestamp: "2026-07-20T16:00:00.000Z",
  source: { subagent: { thread_spawn: { parent_thread_id: "PARENT", depth: 1 } } },
}, "hidden archived child", "archived");
```

Leave the existing expected array unchanged: only `CDX-B` and `CDX-A` belong in
discovery.

- [ ] **Step 2: Add a failing search-candidate and scan-budget regression test**

Append this test after the existing Codex search test in `src/history.test.ts`:

```ts
test("search excludes Codex subagents before scanning their transcripts", async () => {
  const fsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-root-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-codexhome-"));
  const cwd = path.join(fsRoot, "repo");
  fs.mkdirSync(cwd, { recursive: true });
  const at = "2026-07-20T10:00:00.000Z";
  const marker = "subagentfiltermarker";

  const root = writeCodexRollout(home, "SEARCH-ROOT", {
    id: "CDX-SEARCH-ROOT", cwd, timestamp: at, source: "cli",
  }, "visible root opener");
  fs.appendFileSync(root, JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: marker }] },
  }) + "\n");

  const child = writeCodexRollout(home, "SEARCH-CHILD", {
    id: "CDX-SEARCH-CHILD", cwd, timestamp: at, source: { subagent: "review" },
  }, "hidden child opener");
  fs.appendFileSync(child, JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: marker }] },
  }) + "\n");

  const params = searchParams(`q=${marker}&all=1`);
  const { candidates } = await withCodexHome(home, () =>
    searchCandidates([{ name: "codex", cmd: CODEX_CMD }], params, { fsRoot, store: memStore() }));
  assert.deepEqual(candidates.map((candidate) => candidate.sessionId), ["CDX-SEARCH-ROOT"]);

  const result = await withCodexHome(home, () =>
    searchTranscripts([{ name: "codex", cmd: CODEX_CMD }], params, { fsRoot, store: memStore() }));
  assert.deepEqual(result.results.map((session) => session.sessionId), ["CDX-SEARCH-ROOT"]);
  assert.equal(result.scanned.files, 1, "the hidden child never consumes the stage-B scan budget");
});
```

- [ ] **Step 3: Run both RED cases and verify their failure reasons**

Run:

```bash
ACPG_NO_LISTEN=1 \
ACPG_AUTH_USER=test-user \
ACPG_AUTH_TOKEN=test-token \
ACPG_LEDGER_DIR="$(mktemp -d)" \
CLAUDE_CONFIG_DIR="$(mktemp -d)" \
CODEX_HOME="$(mktemp -d)" \
node --import tsx --test \
  --test-name-pattern="Codex discovery spans folders|search excludes Codex subagents" \
  src/history.test.ts
```

Expected:

- Discovery fails because `CDX-SUB-ACTIVE` and `CDX-SUB-ARCHIVED` appear.
- Search fails because `candidates` contains `CDX-SEARCH-CHILD`; without the
  first assertion it would also report two results and scan two files.

- [ ] **Step 4: Apply the shared visibility predicate to transcript candidates**

In `codexTranscriptCandidates`, filter before mapping:

```ts
async function codexTranscriptCandidates(): Promise<TranscriptCandidate[]> {
  const [index, sessions] = await Promise.all([readCodexIndex(), listCodexSessionFiles()]);
  return sessions
    .filter(isUserVisibleCodexSession)
    .map((s) => ({
      sessionId: s.id,
      file: s.file,
      cwd: s.cwd,
      title: index.get(s.id)?.thread_name ?? null,
      recencyAt: index.get(s.id)?.updated_at ?? null,
      mtime: dateValue(s.updatedAt),
      source: "codex-cli" as const,
    }));
}
```

This single boundary feeds both `discoverCodexHistory` and `searchCandidates`.
Do not add route or client filters.

- [ ] **Step 5: Run GREEN verification for Task 2**

Run:

```bash
ACPG_NO_LISTEN=1 \
ACPG_AUTH_USER=test-user \
ACPG_AUTH_TOKEN=test-token \
ACPG_LEDGER_DIR="$(mktemp -d)" \
CLAUDE_CONFIG_DIR="$(mktemp -d)" \
CODEX_HOME="$(mktemp -d)" \
node --import tsx --test src/history.test.ts
npm run typecheck
```

Expected: every `src/history.test.ts` test passes and typecheck exits `0` with
no diagnostics.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/gateway.ts src/history.test.ts
git diff --cached --check
git commit -m "fix(search): exclude Codex subagent transcripts"
```

Expected: one commit containing the discovery/search regression fixtures and
the shared transcript-candidate filter.

## Task 3: Full verification and local gateway deployment

**Files:**

- Verify: `src/gateway.ts`
- Verify: `src/history.test.ts`
- Generated and ignored: `dist/gateway.js`, `web/dist/`

- [ ] **Step 1: Run the complete automated verification suite**

Run:

```bash
npm test
npm run typecheck
npm run build
```

Expected:

- `npm test`: exit `0`, zero failed tests.
- `npm run typecheck`: exit `0`, no TypeScript diagnostics.
- `npm run build`: exit `0`, refreshed ignored bundles under `dist/` and
  `web/dist/`.

- [ ] **Step 2: Re-read the approved scope and inspect the complete diff**

Run:

```bash
git diff --check d2b323521b59fb514c41752cd63524f7f00a848b..HEAD
git diff --stat d2b323521b59fb514c41752cd63524f7f00a848b..HEAD
git diff d2b323521b59fb514c41752cd63524f7f00a848b..HEAD -- src/gateway.ts src/history.test.ts
git status --short
```

Confirm all of the following from the actual diff and test output:

- Explicit `source.subagent` and `thread_source: "subagent"` markers are hidden.
- Missing, string, and unknown object sources remain visible.
- Duplicate active/archived ids retain a child marker from either copy.
- `/history`, `/history/discovered`, and `/history/search` filter before limits
  or scanning.
- Direct message reads, delete, and repair still use the unfiltered walk; rename
  remains sidecar-only and does not enumerate rollouts.
- No Web/native code or unrelated `.claude/` state changed.

- [ ] **Step 3: Restart the installed macOS gateway using the verified bundle**

Run:

```bash
make restart-mac
```

Expected: `restarted 'com.acp-gateway'`. The command reloads the existing
launchd service and does not reinstall its plist or alter ledger data.

- [ ] **Step 4: Verify the live API hides a known child and retains its parent**

Use the known 2026-08-03 parent/child pair discovered during diagnosis. The
credentials stay in curl's stdin config rather than its process arguments.

Run for `/history`:

```bash
set -a
source .env
set +a
printf 'silent\nshow-error\ninsecure\nuser = "%s:%s"\nurl = "https://127.0.0.1:8080/history?agent=codex&cwd=%%2FUsers%%2Fgeorge.c%%2Fgit%%2Fmy-apps%%2Fcloud-acp-gateway-console&limit=200"\n' \
  "$ACPG_AUTH_USER" "$ACPG_AUTH_TOKEN" \
  | curl --config - \
  | jq -e --arg child "019fc4fe-f1b5-72b0-abda-d9016f797abb" \
          --arg parent "019fc4fa-c7c4-73e0-8242-40d4e1c19a63" \
      '([.sessions[].sessionId] | index($child)) == null and ([.sessions[].sessionId] | index($parent)) != null'
```

Run for `/history/discovered`:

```bash
printf 'silent\nshow-error\ninsecure\nuser = "%s:%s"\nurl = "https://127.0.0.1:8080/history/discovered?agent=codex&limit=200"\n' \
  "$ACPG_AUTH_USER" "$ACPG_AUTH_TOKEN" \
  | curl --config - \
  | jq -e --arg child "019fc4fe-f1b5-72b0-abda-d9016f797abb" \
          --arg parent "019fc4fa-c7c4-73e0-8242-40d4e1c19a63" \
      '([.sessions[].sessionId] | index($child)) == null and ([.sessions[].sessionId] | index($parent)) != null'
```

Finally run:

```bash
lsof -nP -iTCP:8080 -sTCP:LISTEN
```

Expected: both `jq -e` commands print `true` and exit `0`; exactly one gateway
process listens on port 8080.

- [ ] **Step 5: Record final repository state**

Run:

```bash
git log -4 --oneline
git status --short
```

Expected: the plan commit and two implementation commits sit above the design
commit; the only unrelated status remains the pre-existing untracked `.claude/`.

## Completion checklist

- [ ] Re-read the user's original requirement: exclude subagent sessions from
  history, discovery, and search together.
- [ ] Re-read the approved design spec and compare every goal/non-goal to the
  final diff.
- [ ] Confirm RED evidence was observed before each production change.
- [ ] Confirm focused tests, full tests, typecheck, and build all passed.
- [ ] Confirm live `/history` and `/history/discovered` hide a real subagent and
  retain its top-level parent.
- [ ] Confirm no rollout data was deleted or rewritten.
- [ ] Report what was verified and any remaining unverified behavior.

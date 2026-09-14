# Rust-Based Java Code Intelligence for cloud-acp-gateway

**Research date:** 2026-09-12 · **Measured and revised:** 2026-09-14
**Related proposal:** [Issue #283 — Review-first workspace with code trace and an agent review companion](https://github.com/bamoo456/cloud-acp-gateway/issues/283)

## Executive summary

One Rust engine can answer go-to-definition for Java today with IDE-grade latency and no JVM: **[Brokk Bifrost](https://github.com/BrokkAi/bifrost)** (0.11.3, Apache-2.0, prebuilt binaries for six platforms, published as `@brokkai/bifrost` on npm).

This revision replaces the desk research the first draft carried. Bifrost was driven as a real language server against a private multi-module Maven monorepo — 8,936 tracked files, 4.1 GB of working tree, Spring and Jackson throughout. The numbers are in [§4](#4-measured-bifrost-on-a-real-multi-module-repo). Three of them decide the design:

| Measurement | Result | Consequence |
|---|---|---|
| Definition, cross-module, warm | **6–9 ms** | Fast enough to sit behind Cmd/Ctrl-click |
| References, 953 hits | **14.2 s** | Cannot sit behind a click; stays an agent Trace request |
| Resident set, `--lsp` on 9k files | **1.06 GB** | Rust buys no memory advantage over JDTLS at this size |

So the recommendation is narrower, and more concrete, than "run a shadow pilot behind a provider-neutral broker":

1. **Ship go-to-definition only.** It is the one operation whose measured latency justifies a deterministic backend. References, callers and callees stay with the agent Trace that already ships.
2. **One provider, no broker.** A `CodeIntelProvider` abstraction with a single implementation is an interface with one implementor. Add the seam when a second engine earns it.
3. **No JDTLS fallback in the first cut.** Fall back to what already exists — the Trace request at `web/src/lib/reviewPrompt.ts:113-116`. Reconsider JDTLS only if the correctness check in [§7](#7-integration-plan) finds a real gap.
4. **Treat a miss as a timeout, not an answer.** A definition Bifrost cannot resolve took 15.4 s to return zero results. A hard budget of ~2 s, then fall through, is the whole confidence gate.
5. **Pin the analyzer offline.** Bifrost's default path reaches GitHub for semantic packs and stalled for minutes when it could not complete. `BIFROST_SEMANTIC_PACK_DOWNLOAD=off` is a trust-boundary requirement for a gateway serving company code, not a tuning option.

The division of responsibility stays as #283 drew it, with one line moved:

```text
Bifrost    -> go to definition, deterministic, ~10 ms warm
ACP agent  -> references, callers, callees, explanation, review guides, diagrams
```

---

## 1. What changed from the first draft

The first draft of this note was written from repository descriptions and architecture documents. Verifying each claim against the actual repositories, and then running the leading candidate, moved several conclusions:

| First draft said | Verified state |
|---|---|
| Project Nova is the "leading architecture reference", a PoC candidate | **Has no LICENSE file at all** (`/LICENSE` returns 404), last push 2026-02-12, zero releases, zero tags. Not adoptable on licensing grounds alone |
| Nova "has LSP and DAP binaries", Maven/Gradle integration | The binaries are aspirational — the cargo-dist section describes a build that has never been released. `nova-ide` and `nova-resolve` are rated **prototype** in its own architecture map |
| Bifrost is a comparison shape, "not a drop-in replacement" | It is the only candidate with all five navigation capabilities answering, prebuilt binaries everywhere, an npm package, and Apache-2.0. It is the recommendation |
| Caffeine-LS is "early" | Understated — commits land daily, with a classfile stub index and real Maven/Gradle sync. Overstated elsewhere: it is **GPL-3.0** and ships only a `.vsix`, no standalone binary |
| Pegon "lacks semantic navigation" | Correct in effect, but it does ship file-local `textDocument/definition` and workspace symbols; its own README FAQ is stale |
| Rust buys "per-worktree resource density" | Not at this scale. 1.06 GB resident on a 9k-file repo is JDTLS-class |
| The pilot should build a broker, telemetry schema and an 11-corpus benchmark first | Those precede any usage signal. The `CodeRef` primitive it proposed already ships at `web/src/lib/codeRef.ts:6-13`, and the Trace contract already returns definition/callers/callees/references |

---

## 2. Candidate inventory

Two sweeps were run. The first evaluated the four projects named in the original note plus JDTLS. The second was an exhaustive search for anything missed: GitHub repository search across 15 Rust-filtered queries in both sort orders, three topics, crates.io across seven queries, and web search for vendor work published in 2025–2026.

### Rust projects with real cross-file Java semantics

| Project | ★ | License | Last commit | def / refs / impl / callHier / wsSym | Classpath and JARs | Distribution |
|---|---:|---|---|---|---|---|
| **[BrokkAi/bifrost](https://github.com/BrokkAi/bifrost)** | 11 | Apache-2.0 | 2026-09-13 | ✅ ✅ ✅ ✅ ✅ | Workspace source; JAR facts through opt-in semantic packs, never by invoking a build tool | 6 platforms, `npm i @brokkai/bifrost` |
| [Hessesian/kmp-lsp](https://github.com/Hessesian/kmp-lsp) | 188 | MIT | 2026-09-11 | ✅ ⚠️ ✅ ❌ ✅ | JAR indexer sidecar with source extraction | 6 platforms, crates.io, one-shot CLI |
| [emilycares/java_lsp](https://github.com/emilycares/java_lsp) | 14 | GPL-3.0 | 2026-09-13 | ✅ ✅ ❌ ❌ ❌ | Deepest model: `~/.m2`, Gradle, JDK jimage, classfile parser in one class map | None — source build only |

kmp-lsp's `references` is `rg --word-regexp` textual matching, not resolution, which is what the ⚠️ marks. It is the only credible fallback if Bifrost's single-vendor risk becomes a problem: MIT, prebuilt, and its one-shot CLI (`find`, `refs`, `hover`, `index`) lets a Node host skip the LSP handshake entirely. java_lsp has the best classpath model of the three and a genuine reference index, but is missing three of the five operations, ships no binary, and its GPL-3.0 licence needs a decision even across a subprocess boundary.

### Evaluated and rejected

| Project | Reason |
|---|---|
| [wilson-anysphere/indonesia](https://github.com/wilson-anysphere/indonesia) (Project Nova) | No LICENSE, dormant since 2026-02-12, zero releases. Interesting architecture, unusable artifact |
| [cubewhy/caffeine-ls](https://github.com/cubewhy/caffeine-ls) | GPL-3.0, no standalone binary, no implementations or call hierarchy. Best classpath story among the lightweight engines — worth re-checking in two quarters |
| [rmuir/pegon](https://github.com/rmuir/pegon) | A linter. Definition is file-local over tree-sitter scopes |
| [sourcegraph/scip-semantic](https://github.com/sourcegraph/scip-semantic) | Tagging by enclosing scope, not cross-file resolution |
| [BloopAI/bloop](https://github.com/BloopAI/bloop), [github/stack-graphs](https://github.com/github/stack-graphs) | Both archived |
| [agentic-labs/lsproxy](https://github.com/agentic-labs/lsproxy) | Runs `jdtls` underneath; a containerised wrapper, not an engine |
| codeseek, codanna, knot, gossiphs, infigraph | Tree-sitter call graphs matched by name, no type or classpath resolution. knot additionally requires Neo4j and Qdrant |
| [TabbyML/tabby](https://github.com/TabbyML/tabby) | `tree-sitter-java` appears only as an indexing and chunking dependency |
| [zed-extensions/java](https://github.com/zed-extensions/java) | Downloads and proxies JDTLS. No Rust Java engine exists in Zed or Helix |
| cafebabe, noak, classfile-parser, rjvm, mokapot | Every JVM crate on crates.io is bytecode-level. None offers source-level resolution |
| scip-java, Kythe, Joern, Semgrep, Serena | Not Rust, and each needs a JVM or a successful build at index time. Joern's `javasrc2cpg` is the strongest build-free option if the Rust constraint is dropped |

No Rust Java analyzer from Anysphere, Cognition, Amazon or Google surfaced in 2025–2026 beyond Nova. JetBrains' Fleet and Kotlin LSP backends are JVM, not Rust.

### Baseline

[Eclipse JDT LS](https://github.com/eclipse-jdtls/eclipse.jdt.ls) 1.61.0 (2026-09-03) remains the correctness oracle: compiler-backed, authoritative on Lombok, Spring, inherited members and dependency JARs. It requires a Java 21+ runtime, launches at `-Xmx1G`, and needs a per-workspace data directory and a Maven or Gradle import. It is not in the first cut, and the measurements below are why that costs less than it sounds.

---

## 3. What the review workspace actually needs

#283 ranks the deterministic operations. Measured latency re-ranks them:

| Priority in #283 | Operation | Measured | Verdict |
|---|---|---|---|
| P0 | Go to definition | 6–9 ms warm | **Ship it** |
| P0 | Find references | 14.2 s | Agent Trace |
| P0 | Go to implementation | not measured | Later, if definition proves out |
| P0 | Workspace symbols | 1.4 s | Later; Project search already covers the need |
| P1 | Call hierarchy | 4.3 s | Agent Trace |
| P2 | Hover | not measured | Not needed for review |
| P3 | Completion, rename, debugging | — | Out of scope, the IDE escape hatch covers these |

Only definition clears the bar for a click gesture. This is exactly the boundary #283 drew between an agent round trip and an IDE gesture — the difference is that we can now put a number on it.

---

## 4. Measured: Bifrost on a real multi-module repo

Corpus: a private multi-module Maven monorepo, 8,936 tracked files, 4.1 GB of working tree, Spring and Jackson throughout. Host: Apple Silicon, macOS 25.6. Bifrost 0.11.3 via `npx @brokkai/bifrost`, `BIFROST_SEMANTIC_PACK_DOWNLOAD=off`.

### Startup and indexing

| Phase | Time | Notes |
|---|---|---|
| Cold one-shot `scan_usages_by_location` | 109.9 s | Builds the on-disk cache from nothing |
| Warm one-shot, same query | 37.3 s | One-shot mode rebuilds in-memory state every run — unusable interactively |
| `--lsp` `initialize` with a warm cache | 1.3 s | Capabilities advertised: `definitionProvider`, `referencesProvider`, `implementationProvider`, `callHierarchyProvider`, `typeHierarchyProvider`, `workspaceSymbolProvider` |

The one-shot and long-lived modes are not interchangeable. Every interactive number below comes from `--lsp`.

### Query latency, long-lived server

| Request | Result | Latency |
|---|---|---|
| `definition` on a cross-module type, first request | 1 correct hit in another Maven module | 2,647 ms |
| `definition` on a static method, same file | 1 correct hit | 9 ms |
| `definition` repeated after other traffic | 1 correct hit | 6 ms |
| `definition` on a dependency-JAR method (Jackson `readValue`) | **0 hits** | **15,438 ms** |
| `references` on a widely used class | 953 hits | 14,248 ms |
| `workspace/symbol` | 140 hits | 1,398 ms |
| `prepareCallHierarchy` + `incomingCalls` | 361 callers | 4,335 ms |

The first request pays for lazy per-file work; subsequent ones are single-digit milliseconds. **The dangerous row is the fourth**: an unresolvable symbol is not fast-and-empty, it is slow-and-empty. Without a timeout every click on a library symbol hangs the UI for fifteen seconds.

### Resources

| Metric | Value |
|---|---|
| Resident set, `--lsp`, after the queries above | 1.06 GB |
| CPU during indexing | 144% |
| On-disk cache | 336 MB SQLite + 79 MB WAL + 31 MB semantic-pack catalog, written to `.bifrost/cache` inside the repository |

Bifrost writes its own `.gitignore` into that directory, and the docs state the cache is shared with linked worktrees — which suits one review per worktree. It relocates through `BIFROST_CACHE_ROOT` / `BIFROST_CACHE_DIR`, and the pack catalog separately through `BIFROST_SEMANTIC_PACK_CACHE_ROOT`.

### Network behaviour

Run without `BIFROST_SEMANTIC_PACK_DOWNLOAD=off`, a second invocation sat for 3 minutes 42 seconds at 0.3% CPU holding an open HTTPS socket to a GitHub CDN before it was killed. The [semantic pack documentation](https://bifrost.brokk.ai/semantic-model-packs/) confirms the facade downloads a bundle for the running release. Dependency discovery itself is offline and opt-in — Bifrost never invokes Maven or Gradle and never downloads artifacts.

### Precision caveat

Three probes — two correct cross-module definitions and one external-JAR miss — are a smoke test, not a precision figure. [§7](#7-integration-plan) carries a 20-site correctness check against IntelliJ as an explicit step.

### Not yet measured

A second private monorepo of roughly 95,000 Java files was not touched. A cold index there is minutes at best, and it decides whether a provider starts eagerly or lazily. That measurement is step one of the plan.

---

## 5. Why this is worth doing now

#283 put LSP in Phase 4, "only if real usage justifies it". That gate was written when the alternative cost was a JVM, a build import per repository, and a multi-week integration. The measured cost is now: one pinned npm dependency, one lazily spawned subprocess, one HTTP route, and one click handler.

The 3.0 work has also been split onto its own integration branch, so this can land without holding up the review-first workspace already in flight.

What stays true from #283: the gateway optimises the human review loop, and should not grow into a browser IDE. Shipping definition and leaving references to the agent keeps that boundary.

---

## 6. Architecture

One provider, no broker, no abstraction layer:

```text
Cmd/Ctrl-click in the code canvas
        |
        v
GET /workspace/definition?cwd&path&line&column      2 s budget
        |
        +-- hit  --> CodeRef[] --> existing open-at-line navigation
        |
        +-- miss or timeout --> existing agent Trace request
```

Bifrost is one process per repository, keyed by git common dir — the same identity Phase 2 already stores for reviews. It is spawned on first request, not on session start, and evicted when idle. The supervisor pattern at `src/gateway.ts:2813` (spawn, backoff respawn, process-group kill) is reused as-is.

Results normalise into the `CodeRef` shape that already exists at `web/src/lib/codeRef.ts:6-13`. No new primitive, no new renderer: a definition result opens through the same path a Trace card's reference does.

Deliberately skipped:

- **A `CodeIntelProvider` interface.** One implementation. The seam costs more than it saves until a second engine exists.
- **A JDTLS fallback tier.** The fallback is the agent Trace that already ships.
- **Telemetry schema, benchmark harness, disagreement tracking.** A timeout counter and a miss counter answer the only question the first cut asks: does this resolve often enough to be worth keeping.

---

## 7. Integration plan

1. **Measure the large corpus cold.** `--lsp` index time and resident set on ~95k Java files. Decides lazy versus eager start, and whether a per-host process cap is needed.
2. **Provider lifecycle.** One Bifrost process per git common dir, spawned on first request, idle-evicted. Reuse `src/gateway.ts:2813`. Environment fixed by the gateway: `BIFROST_SEMANTIC_PACK_DOWNLOAD=off`, and `BIFROST_CACHE_ROOT` pointed at the gateway's own data directory so nothing is written into the user's checkout.
3. **`GET /workspace/definition?cwd&path&line&column`.** A sibling of `/workspace/resolve` at `src/gateway.ts:5312`. The request path and every returned URI clamp through `allowedPreviewPath`, so a result outside the root is refused rather than opened. Hard 2 s timeout. Responds with `CodeRef[]`.
4. **Cmd/Ctrl-click in the file view.** The column comes from the same selection offsets `rangeFromOffsets` already uses at `web/src/lib/lineRange.ts:25`; `AskFixRequest` gains an optional `column`. A miss or a timeout falls through to the Trace action that the same selection already offers at `web/src/components/FilePanel.tsx:672`.
5. **Feature flag `ACPG_LSP_JAVA=off|bifrost`.** `@brokkai/bifrost` pinned in `package.json`; its platform binaries are optional dependencies and it declares `engines.node >= 18`, so the Node 20 twin is unaffected.
6. **Correctness check.** 20 call sites across at least three modules, definition compared against IntelliJ, recorded here. Includes the cases clean-room analyzers are known to miss: Lombok-generated accessors, Spring injection points, and inherited members.
7. **Revisit.** If the check finds a class of miss that matters, the options in order are a Bifrost semantic pack for the dependency, then kmp-lsp, then JDTLS as a second tier.

---

## 8. Security and operational boundaries

Bifrost never invokes a build tool and never downloads artifacts, which removes the largest risk a Java language server usually carries: annotation processors, Gradle plugins and Maven extensions executing repository-controlled code during project import. Analysis is static reads of source and, where a pack is explicitly provided, bytecode.

Two requirements follow:

- **No egress from the analyzer.** `BIFROST_SEMANTIC_PACK_DOWNLOAD=off` is set by the gateway, not left to the environment. Company source is being analysed; the process should not talk to the network.
- **The path clamp is not optional.** Definition results arrive as `file://` URIs chosen by the analyzer. They pass through `allowedPreviewPath` exactly like `/workspace/file` requests do, so an unexpected URI is refused rather than opened.

If JDTLS is ever added as a second tier, it does not inherit these properties — its project import executes repository code and must be sandboxed like an agent-run build.

---

## 9. Open questions

- **Scope.** Definition only, or definition plus references as an explicit asynchronous action with a spinner, alongside Trace?
- **Default.** Enabled when the Bifrost binary resolves, or opt-in behind the flag until the correctness check is recorded?
- **Single-vendor risk.** The GitHub repository is an open-core mirror — every commit reads `chore: update Bifrost open-core projection`, and development happens elsewhere. Apache-2.0 and a pinned version limit the exposure; kmp-lsp is the named alternative if that changes.

---

## Primary references

- Issue #283: <https://github.com/bamoo456/cloud-acp-gateway/issues/283>
- Brokk Bifrost: <https://github.com/BrokkAi/bifrost> · docs <https://bifrost.brokk.ai/lsp/> · semantic packs <https://bifrost.brokk.ai/semantic-model-packs/>
- kmp-lsp: <https://github.com/Hessesian/kmp-lsp>
- java_lsp: <https://github.com/emilycares/java_lsp>
- Caffeine-LS: <https://github.com/cubewhy/caffeine-ls>
- Pegon: <https://github.com/rmuir/pegon>
- Project Nova: <https://github.com/wilson-anysphere/indonesia>
- Eclipse JDT LS: <https://github.com/eclipse-jdtls/eclipse.jdt.ls>

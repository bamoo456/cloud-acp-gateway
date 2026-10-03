# Rust-Based Java Code Intelligence for cloud-acp-gateway

**Research date:** 2026-09-12 · **Measured and revised:** 2026-09-14
**Related proposal:** [Issue #283 — Review-first workspace with code trace and an agent review companion](https://github.com/bamoo456/cloud-acp-gateway/issues/283)

## Executive summary

One Rust engine can answer go-to-definition for Java today with IDE-grade latency and no JVM: **[Brokk Bifrost](https://github.com/BrokkAi/bifrost)** (0.11.3, Apache-2.0, prebuilt binaries for six platforms, published as `@brokkai/bifrost` on npm).

This revision replaces the desk research the first draft carried. Bifrost was driven as a real language server against two private repositories: a multi-module Maven monorepo of 8,936 tracked files, and one 6,429-file module of a second monorepo roughly fifteen times that size. The numbers are in [§4](#4-measured-bifrost-on-two-real-repositories). Three of them decide the design:

| Measurement | Result | Consequence |
|---|---|---|
| Definition, cross-module, warm | **6–9 ms** | Fast enough to sit behind Cmd/Ctrl-click |
| References, 953 hits | **14.2 s** | Cannot sit behind a click; stays an agent Trace request |
| Resident set, `--lsp` on 9k files | **1.06 GB** | Rust buys no memory advantage over JDTLS at this size |
| Cold index, paid inside the first query | **2.6 s – 16.8 s** | Warm the provider when a review opens, not on the first click |

So the recommendation is narrower, and more concrete, than "run a shadow pilot behind a provider-neutral broker":

1. **Ship go-to-definition only.** It is the one operation whose measured latency justifies a deterministic backend. References, callers and callees stay with the agent Trace that already ships.
2. **One provider, no broker.** A `CodeIntelProvider` abstraction with a single implementation is an interface with one implementor. Add the seam when a second engine earns it.
3. **No JDTLS fallback in the first cut.** Fall back to what already exists — the Trace request at `web/src/lib/reviewPrompt.ts:113-116`. Reconsider JDTLS only if the correctness check in [§7](#7-integration-plan) finds a real gap.
4. **Treat a miss as a timeout, not an answer.** A definition Bifrost cannot resolve took 15.4 s to return zero results. A hard budget of ~2 s, then fall through, is the whole confidence gate.
5. **Warm the provider when a Java file is first shown, not on the first click.** `initialize` returns in under two seconds against an unindexed repository, but the index is then built inside the first query — 16.8 s on a 6,429-file module. Sending a no-match `workspace/symbol` as soon as a Java diff or file opens builds it while the reviewer reads.
6. **Pin the analyzer offline.** Bifrost's default path reaches GitHub for semantic packs and stalled for minutes when it could not complete. `BIFROST_SEMANTIC_PACK_DOWNLOAD=off` is a trust-boundary requirement for a gateway serving company code, not a tuning option.

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

## 4. Measured: Bifrost on two real repositories

Host for both: Apple Silicon, macOS 25.6, Bifrost 0.11.3 via `npx @brokkai/bifrost`.

| | Corpus A | Corpus B |
|---|---|---|
| Shape | Private multi-module Maven monorepo | One module of a second, much larger private monorepo |
| Size | 8,936 tracked files, 4.1 GB working tree | 6,429 source Java files |
| Content | Spring and Jackson throughout | Domain model classes across many packages |

Corpus B is the interesting one for sizing, because its parent monorepo holds roughly 95,000 Java
files. Measuring one module gave a per-file rate; [The whole monorepo](#the-whole-monorepo) later
indexed all of it.

### Startup and indexing

| Phase | Corpus A | Corpus B | Notes |
|---|---|---|---|
| Cold one-shot `scan_usages_by_location` | 109.9 s | — | Network left on; part of this is the semantic-pack fetch |
| Warm one-shot, same query | 37.3 s | — | One-shot mode rebuilds in-memory state every run — unusable interactively |
| `--lsp` `initialize` | 1.3 s (warm cache) | 1.7 s (no cache) | `initialize` returns before indexing; capabilities advertised: `definitionProvider`, `referencesProvider`, `implementationProvider`, `callHierarchyProvider`, `typeHierarchyProvider`, `workspaceSymbolProvider` |
| First `definition` — the cold index, paid in-request | 2.6 s | 16.8 s | Correct cross-package hit in both cases |

The one-shot and long-lived modes are not interchangeable. Every interactive number below comes from
`--lsp`.

**`initialize` is not readiness.** It returns in under two seconds against an unindexed repository,
and the index is then built inside the first query — 16.8 s on Corpus B. A provider that only spawns
and initializes when the review workspace opens has built nothing by the first click; it has to be
sent a query to start indexing. This is the one measurement that changed the lifecycle design in
[§6](#6-architecture).

### Readiness, re-measured on 0.11.4

Corpus A again, `--lsp` on Bifrost 0.11.4, driven the way the gateway drives it.

| Step | Latency | Notes |
|---|---|---|
| `initialize` | < 50 ms | Builds no index |
| First `definition`, cold | 6.96 s | The index build, paid in-request |
| First `workspace/symbol`, cold | 7.5–8.5 s | Same with a no-match query (`zzz_nomatch`, returns `[]`) or an empty one |
| `definition` after that | 5–9 ms | |
| First query after a restart on a complete on-disk cache | 1.5–2.2 s | Straddles a 2 s budget |
| `definition` on Jackson `readValue` | 12.6–14.2 s | Returns `null` |
| The same site asked again | 13 ms | The miss is cached |
| Good `definition` sent 100 ms after it | 13.4 s | Queued behind it |

**A no-match `workspace/symbol` is the warm-up.** It builds the same index the first definition would,
and has no result to read.

**Requests are served one at a time, `$/cancelRequest` is ignored, and a miss is cached.** A slow miss
holds up every click behind it, but killing it throws away the work the next click needs. So a lookup
past its click's 2 s budget is left to finish while the click falls through to Trace, and a click that
arrives meanwhile answers "indexing" instead of queueing behind it. Only past a 60 s ceiling is the
process treated as jammed and replaced. Through the gateway's own code path on Corpus A: a Lombok getter
missed at the 2 s budget, the next click answered "indexing" for 8 s and then resolved, and the getter
asked again answered in 39 ms — all on one process.

**Killing before the index is ready throws it away.** With warm meaning `initialize` only and a 2 s
budget per click, definition never succeeded on Corpus A: 6 of 6 consecutive attempts timed out, and
each kill discarded the half-built index, so the next attempt started over. Until the warm-up settles,
a click has to answer "indexing" and leave the process alone.

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

| Metric | Corpus A (8,936 files) | Corpus B (6,429 Java files) |
|---|---|---|
| Peak resident set, `--lsp` | 1.06 GB | 535 MB |
| CPU during indexing | 144% | — |
| On-disk cache | 517 MB total — 336 MB SQLite, 79 MB WAL, 31 MB pack catalog | 231 MB |
| Cache location | `.bifrost/cache` inside the repository | Relocated out of the checkout |

**Cache relocation works, and it was verified rather than assumed.** With `BIFROST_CACHE_ROOT` and
`BIFROST_CACHE_DIR` both pointed at a scratch directory, the Corpus B run created no `.bifrost`
directory in the checkout at all. Left at its default the cache lands in `.bifrost/cache` inside the
repository, where Bifrost writes its own `.gitignore`; the docs add that it is shared with linked
worktrees, which suits one review per worktree. The pack catalog relocates separately through
`BIFROST_SEMANTIC_PACK_CACHE_ROOT`.

Corpus B gives the rate that matters for sizing: **roughly 36 KB of cache and 85 KB of resident set
per Java file**, with the caveat that both are single measurements on one module.

### Network behaviour

Run without `BIFROST_SEMANTIC_PACK_DOWNLOAD=off`, a second invocation sat for 3 minutes 42 seconds at 0.3% CPU holding an open HTTPS socket to a GitHub CDN before it was killed. The [semantic pack documentation](https://bifrost.brokk.ai/semantic-model-packs/) confirms the facade downloads a bundle for the running release. Dependency discovery itself is offline and opt-in — Bifrost never invokes Maven or Gradle and never downloads artifacts.

### Correctness: 20 call sites

Corpus A, 20 sites across four Maven modules, Bifrost 0.11.4 on a warm index. IntelliJ was not
reachable, so the expected answer is the declaring source, found by reading the code.

| Category | Sites | Correct | What went wrong |
|---|---:|---:|---|
| Spring injection — method through an injected field, injected field's type | 4 | 4 | |
| Cross-module type or constructor | 3 | 3 | |
| Inherited member, call through an interface | 3 | 2 | `super.getInstant()` resolved to the caller's own override |
| Static or overloaded method | 3 | 1 | Overloaded statics return **every** overload; the click opens the first |
| Ordinary same-module call | 2 | 2 | |
| Lombok `builder()`, builder setter, `@Data` getter | 3 | 0 | No answer — the getter after 12.5 s |
| JDK / third-party library | 2 | — | No answer, as expected (5–7 ms on a warm process) |

**12 of 18 in-repo sites correct (67%); 12 of 15 outside Lombok.** Median latency 6 ms. Lombok is the
class of miss that matters: 2,508 files in Corpus A import it. A miss falls through to the agent Trace,
so it costs a round trip, not a wrong answer.

### The whole monorepo

Corpus B's parent monorepo, 92,512 tracked Java files, indexed whole on the same host with 74 GB free:

| | Cold | Restart on its cache |
|---|---|---|
| Warm-up (no-match `workspace/symbol`) | 254 s | 63–71 s |
| `definition` after it | 12–51 ms | 10–25 ms |
| Peak resident set | 4.3 GB | 4.9 GB |
| On-disk cache | 3.5 GB | 3.4 GB |
| Library-symbol miss (Jackson `readValue`) | — | 40 ms, then 2 ms |

Indexing stays linear at Corpus B's rate (2.7 ms per Java file against 2.6 ms; Corpus A ran at 1.3 ms).
The cache matches the 36 KB-per-file extrapolation; the resident set is about 47 KB per file. One
process per monorepo is viable on a 36 GB host, but the restart cost shapes the lifecycle: a kill costs
over a minute of "indexing" here, so the gateway never kills a ready process for being slow, gives the
warm-up 30 minutes, and keeps an idle process for 30 minutes rather than 5. Four live processes cap the
worst case near 20 GB.

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
        |
        +-- still indexing, or an earlier lookup still running --> 503, no Trace
```

Bifrost is one process per repository, keyed by git common dir — the same identity Phase 2 already stores for reviews. It is spawned and warmed when a Java file is first shown in the file view or the review canvas, as a diff or as a file, rather than on the first click: warming means `initialize` followed by a no-match `workspace/symbol`, because `initialize` builds nothing and the cold index is paid inside the first query — up to 16.8 s — which is time the reviewer can spend reading the diff instead of waiting. A click before the warm-up settles answers "indexing" and leaves the process alone. Once it is ready, a lookup past the 2 s budget falls through to Trace but is left to finish, and a click behind it answers "indexing"; only a lookup past a 60 s ceiling kills the process, which is replaced and warmed at once. It is evicted after 30 idle minutes, never while warming. The supervisor pattern at `src/gateway.ts:2813` (spawn, backoff respawn, process-group kill) is reused as-is.

Results normalise into the `CodeRef` shape that already exists at `web/src/lib/codeRef.ts:6-13`. No new primitive, no new renderer: a definition result opens through the same path a Trace card's reference does.

Deliberately skipped:

- **A `CodeIntelProvider` interface.** One implementation. The seam costs more than it saves until a second engine exists.
- **A JDTLS fallback tier.** The fallback is the agent Trace that already ships.
- **Telemetry schema, benchmark harness, disagreement tracking.** A timeout counter and a miss counter answer the only question the first cut asks: does this resolve often enough to be worth keeping.

---

## 7. Integration plan

1. **Measure the large corpus cold.** Done — [The whole monorepo](#the-whole-monorepo): 254 s, 4.3 GB resident, 3.5 GB of cache for 92,512 Java files. One process per monorepo is viable; its restart cost set the lifecycle in step 2.
2. **Provider lifecycle.** One Bifrost process per git common dir, spawned and warmed (`initialize`, then a no-match `workspace/symbol` that builds the index) when a Java file is first shown, idle-evicted. Reuse `src/gateway.ts:2813`. Environment fixed by the gateway: `BIFROST_SEMANTIC_PACK_DOWNLOAD=off`, and `BIFROST_CACHE_ROOT` pointed at the gateway's own data directory so nothing is written into the user's checkout.
3. **`GET /workspace/definition?cwd&path&line&column`.** A sibling of `/workspace/resolve` at `src/gateway.ts:5312`. The request path and every returned URI clamp through `allowedPreviewPath`, so a result outside the root is refused rather than opened. Hard 2 s timeout. Responds with `CodeRef[]`, or 503 `indexing` while the warm-up runs.
4. **Cmd/Ctrl-click in the file view.** The column comes from the same selection offsets `rangeFromOffsets` already uses at `web/src/lib/lineRange.ts:25`; `AskFixRequest` gains an optional `column`. A miss or a timeout falls through to the Trace action that the same selection already offers at `web/src/components/FilePanel.tsx:672`.
5. **Feature flag `ACPG_LSP_JAVA=off|bifrost`.** `@brokkai/bifrost` pinned in `package.json`; its platform binaries are optional dependencies and it declares `engines.node >= 18`, so the Node 20 twin is unaffected.
6. **Correctness check.** Done — [Correctness: 20 call sites](#correctness-20-call-sites): 12 of 18 in-repo sites, every Lombok-generated member missed.
7. **Revisit.** Lombok is the class of miss that matters. A semantic pack covers dependency JARs, not members generated from the repository's own source, so the order for Lombok is kmp-lsp if it models them, then JDTLS with the Lombok agent as a second tier. Until then a Lombok click costs an agent Trace.

---

## 8. Security and operational boundaries

Bifrost never invokes a build tool and never downloads artifacts, which removes the largest risk a Java language server usually carries: annotation processors, Gradle plugins and Maven extensions executing repository-controlled code during project import. Analysis is static reads of source and, where a pack is explicitly provided, bytecode.

Two requirements follow:

- **No egress from the analyzer.** `BIFROST_SEMANTIC_PACK_DOWNLOAD=off` is set by the gateway, not left to the environment. Company source is being analysed; the process should not talk to the network.
- **The path clamp is not optional.** Definition results arrive as `file://` URIs chosen by the analyzer. They pass through `allowedPreviewPath` exactly like `/workspace/file` requests do, so an unexpected URI is refused rather than opened.

The analyzer does not outlive the gateway: it exits on stdin EOF, so neither a SIGTERM'd nor a SIGKILL'd gateway leaves one holding gigabytes behind (both checked).

If JDTLS is ever added as a second tier, it does not inherit these properties — its project import executes repository code and must be sandboxed like an agent-run build.

---

## 9. Open questions

- **Scope.** Definition only, or definition plus references as an explicit asynchronous action with a spinner, alongside Trace?
- **Default.** Enabled when the Bifrost binary resolves, or opt-in behind the flag? The correctness check is recorded: 67% on in-repo sites, misses falling through to Trace.
- **Overloads.** Bifrost answers an overloaded static call with every overload, and the click opens the first. A chooser is the IDE answer; the overloads usually sit a few lines apart, which is why it is not in the first cut.
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

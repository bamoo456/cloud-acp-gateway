# Rust-Based Java Language Server Research for cloud-acp-gateway Phase 3

**Research date:** 2026-09-12  
**Related proposal:** [Issue #283 — Review-first workspace with code trace and an agent review companion](https://github.com/bamoo456/cloud-acp-gateway/issues/283)

## Executive summary

As of 2026-09-12, there is no Rust-based Java language server that is mature enough to replace Eclipse JDT LS as the authoritative Java semantic engine for `cloud-acp-gateway`.

That does **not** mean Rust-based Java code intelligence is a dead end for the project. The requirements in #283 are narrower than “build a browser IDE” or “replace IntelliJ.” The review workflow primarily needs fast deterministic navigation — definition, implementation, references, workspace symbols, and eventually call/type hierarchy — while the ACP agent remains responsible for explanation, review guidance, request-flow tracing, and diagrams.

For this use case, the strongest target architecture is a **hybrid**:

```text
Rust fast path
    -> low-latency definition / implementation / references / symbols

JDTLS fallback
    -> authoritative Java semantics for ambiguous or complex cases

ACP Agent
    -> explanation, review guidance, request-flow tracing, diagrams
```

Recommended decision:

1. **Do not make a Java LSP a Phase 3 prerequisite.** Phase 3 should continue to ship explicit Agent Trace, structured `CodeRef`s, review guides, and navigable diagrams.
2. **Run a non-blocking Rust shadow pilot.** The purpose is to measure whether a native Java code-intelligence process can materially improve startup, latency, and per-worktree resource density.
3. **Keep JDTLS as the semantic oracle/fallback.** A Rust engine should not be treated as compiler-grade semantic authority until the data proves otherwise.
4. **Treat Project Nova as an architecture/fork reference, not a production dependency today.** Its design is the most ambitious, but maturity and maintenance risk are still high.
5. **Watch lightweight Rust projects such as Pegon and Caffeine-LS, but do not put them on the critical path.** Their current feature completeness is not sufficient for reliable production navigation.

The important architectural principle is:

> **Rust engine = low-cost navigation accelerator.**  
> **JDTLS = semantic correctness fallback.**  
> **ACP Agent = review/comprehension layer.**

---

## 1. Why this matters to Issue #283

Issue #283 is intentionally not proposing another full IDE. Its goal is to collapse the current review loop:

```text
IntelliJ
   <->
Claude/Codex terminal
   <->
review guide / diagram
   <->
IntelliJ
```

into a browser-native review workflow centered on:

```text
Changed Files | Code Canvas | Review Companion
```

That product boundary changes how Java language-server options should be evaluated. A traditional IDE evaluation gives high weight to completion, quick fixes, refactoring, formatting, diagnostics, debugger integration, and annotation-processor behavior. Those capabilities matter for an editor, but they are not all on the critical path for a review-first workspace.

For `cloud-acp-gateway`, the initial deterministic code-intelligence needs are narrower:

| Priority | Capability | Why it matters |
|---|---|---|
| P0 | Go to definition | Clickable symbol navigation |
| P0 | Find references | Understand impact and usage |
| P0 | Go to implementation | Interface -> concrete implementation |
| P0 | Workspace symbols | Fast symbol lookup for reviewer/agent |
| P1 | Call hierarchy | Deterministic callers/callees for Trace |
| P1 | Type hierarchy | Service/interface navigation |
| P2 | Hover / type information | Review comprehension |
| P3 | Completion | Review Workspace is not editing-first |
| P3 | Rename/refactor | Heavy IDE work remains an escape hatch |
| P3 | DAP/debugging | Not required for normal review |

This is why a Rust implementation may still be useful even if it cannot replace JDTLS.

### Agent Trace vs deterministic navigation

The distinction in #283 should remain explicit:

```text
Agent Trace
= comprehension / explanation / review guidance

LSP / code intelligence
= deterministic, low-latency semantic navigation
```

For example, “Explain how this request reaches Redis” is naturally an agent task. By contrast, `Cmd/Ctrl-click foo()` implies exact and low-latency navigation and is a better fit for a language server or code-intelligence engine.

Phase 3 can therefore ship without an LSP dependency. Rust-LSP work should run in parallel and provide evidence for a later deterministic-navigation phase.

---

## 2. Candidate inventory

The Rust-native Java language-intelligence projects currently worth evaluating include:

1. [`wilson-anysphere/indonesia`](https://github.com/wilson-anysphere/indonesia) — Project Nova
2. [`rmuir/pegon`](https://github.com/rmuir/pegon)
3. [`cubewhy/caffeine-ls`](https://github.com/cubewhy/caffeine-ls)
4. Other lightweight/tree-sitter-based Java LSPs that may emerge, provided they can pass the same benchmark and correctness gates

For comparison, the production semantic baseline remains:

5. [`eclipse-jdtls/eclipse.jdt.ls`](https://github.com/eclipse-jdtls/eclipse.jdt.ls)

A second useful reference point is Brokk Bifrost, a Rust/tree-sitter-backed code-analysis engine with LSP/MCP-oriented use cases. It is not a drop-in JDTLS replacement, but its shape is relevant to AI-oriented code intelligence.

### High-level summary

| Project | Implementation | Positioning | Phase 3 decision |
|---|---|---|---|
| **Project Nova** | Rust, custom Java analysis stack | Ambitious Java rust-analyzer-style architecture | **PoC / Watch** |
| **Pegon** | Rust | Lightweight Java diagnostics/LSP | **Watch** |
| **Caffeine-LS** | Rust | Early Java parser/type-checking LSP | **Watch** |
| **Brokk Bifrost** | Rust + Tree-sitter | AI/code-analysis oriented engine | **Evaluate as code-intel component** |
| **Eclipse JDT LS** | Java/JVM | Mature compiler-backed Java language server | **Keep as oracle/fallback** |

No Rust candidate currently earns an unconditional “Adopt as authoritative Java semantic engine” recommendation.

---

## 3. Project Nova

Repository: <https://github.com/wilson-anysphere/indonesia>

Nova is the most architecturally interesting Rust Java implementation in this review and is the closest to the idea of a “Java rust-analyzer.”

Its repository and architecture documentation describe or contain work around:

- native Java parser infrastructure
- classfile reading
- classpath modeling
- Maven/Gradle integration
- persistent project/dependency caches
- Salsa-style incremental analysis
- symbol search/indexing
- LSP and DAP binaries
- framework-aware analysis
- refactoring infrastructure
- performance/observability tooling

This is broadly the architecture we would want if the long-term goal were a fully independent native Java semantic engine.

### Strengths

- Native Rust process and attractive headless/server deployment model.
- Incremental-analysis design is a better conceptual fit for long-lived code-intelligence services than repeatedly doing full project imports.
- Persistent symbol/index cache work is directly relevant to repeated agent worktrees.
- More ambitious semantic scope than simple Tree-sitter LSPs.
- Good architecture reference even if not adopted directly.

### Risks

The main issue is maturity. The project is still young and parts of its indexing/semantic pipeline are evolving. The most important production questions for `cloud-acp-gateway` are not whether the architecture is promising, but whether it can correctly handle real Java backend workloads:

- overload resolution
- generics
- inheritance and implementation resolution
- multi-module Maven/Gradle projects
- dependency JAR symbols
- generated sources
- Lombok
- annotation processors
- Spring-heavy code

The available evidence is not yet strong enough to treat Nova as a compiler-grade semantic authority.

### Recommendation

**PoC / Watch.** Use Nova as the leading architecture reference and, if engineering time permits, include it in the benchmark harness. Do not make the product dependent on it until correctness and maintenance risk are much better understood.

---

## 4. Pegon

Repository: <https://github.com/rmuir/pegon>

Pegon is attractive operationally because it is a small native Rust Java language server. The deployment story — a standalone binary with low JVM-free overhead — is exactly what makes Rust interesting for cloud worktrees.

However, operational simplicity is not enough. The current feature surface is more focused on parsing/diagnostics than on the semantic navigation set required by #283. Definition/references/implementation/call hierarchy need to be considered hard requirements before it can be a serious Phase 3 code-intelligence provider.

### Recommendation

**Watch.** Re-evaluate when semantic navigation is complete enough to run the same correctness benchmark as JDTLS.

---

## 5. Caffeine-LS

Repository: <https://github.com/cubewhy/caffeine-ls>

Caffeine-LS is another Rust Java language-server effort with hand-written parsing/Rowan-style infrastructure and native classfile work. It is technically interesting because it is trying to move beyond a pure text/syntax index toward type-aware analysis.

The project is still early. Current functionality is not broad enough to justify production integration for `cloud-acp-gateway`.

### Recommendation

**Watch.** It is worth tracking because its architecture may become relevant, but it is not a production candidate today.

---

## 6. Why Rust can help — and what it does not solve

Rust can materially improve several operational characteristics:

- cold process startup
- idle RSS
- binary distribution
- process isolation
- easier headless deployment
- ability to run more worktrees per host
- predictable per-process lifecycle

Those benefits are valuable for a gateway that may supervise many independent Git worktrees.

However, Rust does **not** make Java semantics simple. Correctly resolving a call like:

```java
foo.bar().baz();
```

may require:

- local and imported types
- overload resolution
- generic substitution
- inheritance
- classpath/module path
- dependency bytecode
- generated sources
- annotation processors
- framework conventions

Java backend projects make the problem harder still. Lombok, MapStruct, Spring, generated sources, and build-tool project models are where many clean-room analyzers diverge from IDE/compiler behavior.

Therefore a native Rust implementation should be evaluated as a **fast-path provider**, not assumed to be an automatic semantic replacement for JDTLS.

---

## 7. Architecture options

### Option A — direct Rust-only adoption

```text
Review Workspace
      |
      v
Rust Java LSP
      |
      v
CodeRef
```

**Advantages**

- lowest operational complexity at runtime
- native binary
- potentially excellent startup/RSS

**Risks**

- correctness gaps become user-visible
- difficult Java edge cases become our responsibility
- framework/generated-source failures may be subtle rather than obvious

**Assessment:** too risky for production today.

### Option B — Rust fast path + JDTLS fallback

```text
                 +----------------+
request -------->| CodeIntelBroker |
                 +-------+--------+
                         |
            +------------+-------------+
            |                          |
            v                          v
     Rust fast path                 JDTLS
   fast/common queries        semantic fallback
            |                          |
            +------------+-------------+
                         |
                         v
                    normalized
                      CodeRef
```

This is the recommended architecture if the pilot succeeds.

The broker should make provider choice invisible to the UI. A response should carry enough metadata for observability and confidence decisions, for example:

```text
provider
operation
workspace_revision
index_state
confidence
latency_ms
fallback_reason
```

A Rust result can be returned directly only when it passes explicit confidence rules. Ambiguous or unsupported cases fall back to JDTLS.

### Option C — JDTLS only

This remains the safest correctness-first baseline.

**Advantages**

- mature Java semantics
- Maven/Gradle support
- broad language feature coverage
- existing ecosystem and known behavior

**Costs**

- JVM startup
- larger memory footprint
- more expensive concurrent worktree density
- project import/indexing can be slow

**Assessment:** keep as baseline/oracle even if hybrid work proceeds.

---

## 8. Recommended gateway abstraction

Do not couple the Review Workspace directly to a specific LSP protocol implementation.

Introduce a provider-neutral interface such as:

```text
CodeIntelProvider
  definition(CodePosition)
  implementations(CodePosition)
  references(CodePosition)
  workspaceSymbols(query)
  incomingCalls(CodePosition)
  outgoingCalls(CodePosition)
  typeHierarchy(CodePosition)
```

Normalize results into the same `CodeRef` primitive already proposed by #283:

```text
CodeRef {
  label?
  path
  line?
  column?
  symbol?
}
```

This keeps the product architecture stable even if providers change from:

```text
JDTLS
-> Rust pilot
-> hybrid broker
-> future index service
```

without requiring UI rewrites.

---

## 9. Worktree lifecycle and caching

Issue #283 maps review sessions naturally onto independent Git worktrees:

```text
Review
  |
  v
worktree
  +-- agent
  +-- git diff
  +-- tests
  +-- optional code-intelligence process
```

That makes process lifecycle a first-class design problem.

The gateway should avoid “one permanently hot JDTLS per historical review.” Instead, a broker/pool should supervise providers based on activity:

```text
active review
   -> warm provider process

idle review
   -> retain reusable index/cache
   -> evict process after timeout

review reopened
   -> reload warm cache / restart provider
```

A Rust provider is particularly attractive if warm-cache reactivation is cheap enough to avoid keeping many processes resident.

Repository/worktree identity must remain gateway-local and revision-aware. Code-intelligence results must never be reused across the wrong worktree or revision.

---

## 10. Security and operational boundaries

Running a Java language server against an untrusted repository can involve more than parsing text. Build import, annotation processors, Gradle plugins, Maven extensions, and generated-source steps can execute repository-controlled code.

The gateway should distinguish between:

```text
safe static analysis
```

and:

```text
build-tool / annotation-processor execution
```

The Rust fast path should default to static source/bytecode analysis where possible. Any JDTLS/build-tool integration that may execute repository code should inherit the same sandboxing and trust rules as tests/builds run by agents.

---

## 11. Observability requirements

Every code-intelligence request should emit structured telemetry such as:

```text
provider
operation
language
workspace_size_bucket
index_state
cache_hit
latency_ms
result_count
confidence
fallback_reason
fallback_provider
rss_bytes
revision_match
process_restart_count
```

Avoid collecting source code, raw symbol names, or raw local paths when not necessary.

The most useful operational metrics are:

```text
definition p50 / p95 / p99
references p50 / p95 / p99
fast-path fallback %
Rust <-> JDTLS disagreement %
stale-result %
cold-to-ready time
RSS per active worktree
cache hit %
process restart %
```

---

## 12. Proposed pilot

The pilot should be non-blocking for Phase 3 product work.

### Stage A — baseline and provider abstraction

- Build a representative Java semantic-query corpus.
- Establish JDTLS as the comparison oracle.
- Introduce a provider-neutral `CodeIntelProvider` / broker abstraction.
- Add `CodeRef` normalization and strict revision/worktree validation.

### Stage B — Rust shadow mode

- Start/supervise the selected Rust candidate for selected worktrees.
- Send the same eligible navigation queries to the Rust engine and JDTLS.
- Record latency, result agreement, RSS, indexing time, and fallback reason.
- Do not expose Rust-only results to users yet.

### Stage C — confidence gate and fallback

- Define exact vs heuristic result categories.
- Route low-confidence reference results to JDTLS.
- Add process lifecycle/eviction policy.
- Add cache and repeated-worktree benchmarks.

### Stage D — opt-in Review Workspace pilot

- Enable deterministic definition/implementation/references for opt-in reviews.
- Keep Agent Trace as the explanatory layer.
- Measure whether reviewers actually use deterministic navigation enough to justify further investment.

---

## 13. Benchmark corpus

Do not benchmark only on a toy project.

At minimum include:

| Corpus type | Failure mode to exercise |
|---|---|
| Plain Maven Java | Basic symbol correctness |
| Plain Gradle Java | Source roots/dependencies |
| Multi-module Maven | Cross-module references |
| Multi-module Gradle | Project boundaries |
| Spring Boot | Annotation/framework-heavy code |
| Lombok | Generated getters/builders |
| Generic-heavy library | Type/method resolution |
| Interface-heavy service | Implementation navigation |
| Generated source / MapStruct | Source-generation behavior |
| Large monorepo | Startup/index/RSS |
| Multiple concurrent worktrees | Gateway resource density |

The benchmark should run on identical hardware with pinned provider versions.

---

## 14. Benchmark measurements

For each corpus, measure both cold and warm states.

### Startup/indexing

- process spawn -> initialize complete
- process spawn -> first useful definition response
- cold/full index wall time
- warm cache load time
- CPU time
- peak and steady RSS
- cache size and disk I/O

### Query latency

Measure p50/p95/p99 for:

- definition
- implementation
- references
- workspace symbol
- call hierarchy where available

### Correctness

Compare provider results against a curated expected-answer set and against JDTLS.

Record:

- exact top-definition agreement
- missing results
- false-positive references
- false-negative references
- cross-module failures
- dependency-source failures
- Lombok/generated-symbol failures
- disagreement requiring fallback

### Concurrency

Repeat at:

```text
1 active worktree
4 active worktrees
8 active worktrees
16 active worktrees
```

Measure aggregate RSS, CPU, startup contention, index wall time, eviction/restart behavior, and cache reuse.

---

## 15. Suggested acceptance criteria

These are product/engineering targets to validate, not upstream guarantees.

### Correctness

For query categories explicitly marked eligible for the Rust fast path:

- **>=95% top-definition agreement** with curated/JDTLS expected results
- zero cross-revision/worktree stale navigation defects
- references false-positive rate explicitly measured and confidence-gated

A stale result that jumps into another worktree/revision is a critical correctness bug, not an ordinary miss.

### Fast-path coverage

A reasonable promotion target is:

- approximately **>=80% of eligible navigation queries** answered without requiring JDTLS

### Latency

For explicit review navigation actions:

- fast-path **p95 < 500 ms** is a reasonable initial SLO

For future IDE-like `Cmd/Ctrl-click`:

- only promote when end-to-end p95 is around **200 ms or better** and semantic precision is high enough to feel deterministic

### Resource density

Do not choose a fixed per-process memory budget before measuring. Derive pool size, idle timeout, eviction policy, cache strategy, and maximum concurrent JDTLS fallbacks from observed data.

---

## 16. Decision matrix

The following ratings are engineering judgments for the #283 review-first use case, not project-supplied benchmark scores.

| Option | Correctness | Latency/startup | Resource density | Java/build semantics | Maturity | Decision |
|---|---:|---:|---:|---:|---:|---|
| **Rust fast path + JDTLS fallback** | High | High | Medium/High | High | Medium | **Target architecture if pilot passes** |
| **Rust-only current candidates** | Medium/Low | Potentially high | High | Medium/Low | Low/Medium | **PoC / Watch** |
| **JDTLS only** | Very high | Medium/Low | Low/Medium | Very high | Very high | **Keep as baseline/oracle** |
| **Project Nova specifically** | Medium | Potentially high | High | Medium/High ambition | Low/Medium | **PoC / Watch** |
| **Pegon / Caffeine-LS** | Low/Medium today | Potentially high | High | Low/Medium | Low | **Watch** |

### Adopt / PoC / Watch / Reject

| Option | Decision | Reason |
|---|---|---|
| **Hybrid broker** | **Adopt as target architecture if pilot gates pass** | Best balance of low-cost navigation and semantic correctness |
| **Project Nova** | **PoC / Watch** | Strongest architecture direction, not yet proven enough for production authority |
| **JDTLS** | **Keep** | Required semantic oracle/fallback |
| **Pegon** | **Watch** | Native deployment is attractive; semantic navigation is not mature enough |
| **Caffeine-LS** | **Watch** | Interesting early design, insufficient production maturity |
| **Rust-only authoritative semantics today** | **Reject** | No current candidate has enough evidence to replace JDTLS safely |

---

## 17. Recommended roadmap adjustment for #283

Do **not** move LSP into the Phase 3 critical path.

Keep the product roadmap approximately:

```text
Phase 0
  clickable CodeRef + selection Ask/Fix

Phase 1
  focused Review Workspace

Phase 2
  durable code-attached review state/discussions

Phase 3
  explicit Agent Trace
  review guide
  navigable diagrams

Parallel shadow work
  CodeIntelProvider abstraction
  Rust candidate vs JDTLS benchmark
  cache/lifecycle experiments

Later deterministic-navigation phase
  promote LSP-backed definition/references/implementation
  only when correctness + latency + real usage justify it
```

This preserves the most important product insight in #283: the gateway should optimize the human review/comprehension loop, not accidentally grow into a full browser IDE.

A Rust code-intelligence provider is valuable when it reduces the cost of deterministic navigation. It should not become an architecture goal by itself.

---

## Final recommendation

For `cloud-acp-gateway`, the best current decision is:

> **Run a Rust Java code-intelligence shadow pilot behind a provider-neutral broker, and retain JDTLS as the authoritative fallback. Do not block Phase 3 on LSP adoption.**

Project Nova is the most useful architecture reference among current Rust Java efforts, while Pegon and Caffeine-LS should be monitored as lighter-weight alternatives. None currently has enough production evidence to replace JDTLS outright.

The target division of responsibility should remain simple:

```text
Rust engine -> fast deterministic navigation
JDTLS       -> semantic correctness fallback
ACP agent   -> explanation and review comprehension
```

That gives #283 a path to IDE-like navigation later without turning Phase 3 into a Java language-server project today.

## Primary references

- Issue #283: <https://github.com/bamoo456/cloud-acp-gateway/issues/283>
- Project Nova / indonesia: <https://github.com/wilson-anysphere/indonesia>
- Nova architecture map: <https://github.com/wilson-anysphere/indonesia/blob/main/docs/architecture-map.md>
- Pegon: <https://github.com/rmuir/pegon>
- Caffeine-LS: <https://github.com/cubewhy/caffeine-ls>
- Eclipse JDT LS: <https://github.com/eclipse-jdtls/eclipse.jdt.ls>
- Brokk Bifrost: <https://github.com/BrokkAi/brokk-bifrost>

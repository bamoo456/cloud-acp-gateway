// Visual-verification harness for the "Quiet Console" UI refactor.
//
// docs/ui-refactor-plan.md §5 requires every stage to be looked at on a real
// browser, in both themes and for all three agents — jsdom cannot judge colour,
// contrast or hairlines. Driving a live gateway for that is neither repeatable
// nor offline-safe, so this mounts the REAL <App /> (real components, real
// styles.css) over a canned store and a stubbed fetch.
//
// Not part of the shipped bundle: index.html is the app's entry, this file is
// only reachable via /preview.html in `vite dev`.
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { useStore } from "./store/store.ts";
import type { Session, SessionEngine } from "./types.ts";
import "./styles.css";

// Read before anything touches the store: the store's own URL-sync subscriber
// rewrites location on the first state change and would eat the fragment.
const SCENE = new Set(location.hash.replace(/^#/, "").split(",").filter(Boolean));

const CWD = "/Users/dev/git/my-apps/cloud-acp-gateway";
const iso = (minsAgo: number) => new Date(Date.UTC(2026, 7, 14, 12, 0) - minsAgo * 60_000).toISOString();

// ---- canned gateway ---------------------------------------------------------
const ROUTES: Record<string, unknown> = {
  "/prefs": {
    textSize: null, lock: null, recentFolders: [],
    recentSessions: [
      { agentName: "claude", sessionId: "s-usage", cwd: CWD, title: "Usage gauge caching", lastActiveAt: iso(2) },
      { agentName: "claude", sessionId: "s-rename", cwd: CWD, title: "Sidebar rename affordance", lastActiveAt: iso(64) },
      { agentName: "opencode", sessionId: "s-term", cwd: CWD, title: "Terminal height memory", lastActiveAt: iso(240) },
      { agentName: "codex", sessionId: "s-gutter", cwd: CWD, title: "Review panel gutters", lastActiveAt: iso(1500) },
      { agentName: "codex", sessionId: "s-sse", cwd: "/Users/dev/git/my-apps/acp-bridge", title: "SSE reconnect on iOS", lastActiveAt: iso(180) },
      { agentName: "claude", sessionId: "s-ledger", cwd: "/Users/dev/git/tools/deploy-tools", title: "Ledger dir migration", lastActiveAt: iso(1600) },
      { agentName: "claude", sessionId: "s-wiki", cwd: "/Users/dev/Obsidian/taboola-wiki", title: "Vault ingest pass", lastActiveAt: iso(2600) },
      { agentName: "claude", sessionId: "s-quota", cwd: "/Users/dev/git/work/trs-llm-gateway", title: "Quota window rollover", lastActiveAt: iso(3400) },
    ],
  },
  "/history": {
    sessions: [
      { sessionId: "s-usage", title: "Usage gauge caching", updatedAt: iso(2) },
      { sessionId: "s-rename", title: "Sidebar rename affordance", updatedAt: iso(64) },
      { sessionId: "s-term", title: "Terminal height memory", updatedAt: iso(240) },
      { sessionId: "s-gutter", title: "Review panel gutters", updatedAt: iso(1500) },
    ],
  },
  "/history/discovered": {
    sessions: [
      { sessionId: "s-sse", title: "SSE reconnect on iOS", updatedAt: iso(180), cwd: "/Users/dev/git/my-apps/acp-bridge", source: "claude-cli" },
      { sessionId: "s-ledger", title: "Ledger dir migration", updatedAt: iso(1600), cwd: "/Users/dev/git/tools/deploy-tools", source: "claude-cli" },
      { sessionId: "s-wiki", title: "Vault ingest pass", updatedAt: iso(2600), cwd: "/Users/dev/Obsidian/taboola-wiki", source: "claude-cli" },
      { sessionId: "s-quota", title: "Quota window rollover", updatedAt: iso(3400), cwd: "/Users/dev/git/work/trs-llm-gateway", source: "claude-cli" },
    ],
  },
  "/running": { tasks: [{ agentName: "claude", sessionId: "s-usage", state: "active", title: "Usage gauge caching", cwd: CWD }] },
  // The gateway's inbox is authoritative: a prompt missing from it is marked
  // "answered on another device", so the thread's live permission has to be
  // listed here too. Wire shape is the gateway's — { items } with bodyJson.
  "/inbox": {
    items: [
      {
        id: 1, type: "permission", status: "pending", createdAt: iso(1),
        agentName: "claude", sessionId: "s-usage", reqId: "7", title: "Run `npm --prefix web run build` to verify?",
        bodyJson: JSON.stringify([
          { optionId: "once", name: "Allow", kind: "allow_once" },
          { optionId: "always", name: "Allow always", kind: "allow_always" },
          { optionId: "no", name: "Deny", kind: "reject_once" },
        ]),
      },
      // A turn that finished while nobody was looking — no reqId, nothing to
      // answer, just a row that has something new in it (the unread dot).
      {
        id: 3, type: "task_done", status: "pending", createdAt: iso(9),
        agentName: "opencode", sessionId: "s-term", reqId: null, title: "Terminal height memory",
        bodyJson: null,
      },
      {
        id: 2, type: "permission", status: "pending", createdAt: iso(180),
        agentName: "codex", sessionId: "s-sse", reqId: "42", title: "Edit src/gateway.ts",
        bodyJson: JSON.stringify([{ optionId: "a", name: "Allow", kind: "allow_once" }, { optionId: "d", name: "Deny", kind: "reject_once" }]),
      },
    ],
  },
  "/usage/limits": {
    status: "ok",
    windows: {
      five_hour: { rateLimitType: "five_hour", utilization: 0.84, resetsAt: Math.floor(Date.UTC(2026, 7, 14, 13, 0) / 1000) },
      seven_day: { rateLimitType: "seven_day", utilization: 0.57, resetsAt: Math.floor(Date.UTC(2026, 7, 19) / 1000) },
    },
  },
  "/workspace/changes": {
    repo: CWD,
    // `abs` is what the panel keys and addresses every row by (see
    // src/workspace.test.ts:466 for the real shape) — without it React sees a
    // list of undefined keys.
    files: [
      { path: "src/gateway.ts", status: "modified", additions: 12, deletions: 4 },
      { path: "web/src/components/UsageStrip.tsx", status: "modified", additions: 8, deletions: 2 },
      { path: "web/src/App.tsx", status: "modified", additions: 3, deletions: 1 },
      { path: "src/usageCache.ts", status: "added", additions: 41, deletions: 0 },
      { path: "src/usageCache.test.ts", status: "added", additions: 58, deletions: 0 },
      { path: "web/src/store/store.ts", status: "modified", additions: 6, deletions: 6 },
      { path: "web/src/lib/usagePoll.ts", status: "deleted", additions: 0, deletions: 22 },
    ].map((f) => ({ ...f, abs: CWD + "/" + f.path })),
    truncated: false,
  },
  "/workspace/outputs": { folders: [] },
  "/review/draft": { comments: [], base: null },
  "/folders/pinned": [],
};

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  if (url.origin !== location.origin) return realFetch(input as RequestInfo, init);
  const body = ROUTES[url.pathname] ?? {};
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

// ---- canned conversation ----------------------------------------------------
// The engine lists this conversation runs on. On the session, not on the store:
// they are per conversation (types.ts's SessionEngine).
const ENGINE: SessionEngine = {
  models: [
    { modelId: "opus", name: "Opus 4.8", description: "Most capable" },
    { modelId: "sonnet", name: "Sonnet 4.8", description: "Fast" },
  ],
  modes: [
    { id: "default", name: "Default", description: "Standard behavior, prompts for dangerous operations" },
    { id: "acceptEdits", name: "Accept Edits", description: "Auto-accept file edit operations" },
    { id: "plan", name: "Plan Mode", description: "Planning mode, no actual tool execution" },
  ],
  commands: [],
  configOptions: [
    {
      id: "model", name: "Model", category: "model", type: "select", currentValue: "opus",
      options: [{ value: "opus", name: "Opus 4.8" }, { value: "sonnet", name: "Sonnet 4.8" }],
    },
    {
      id: "thinking", name: "Thinking", category: "reasoning", type: "select", currentValue: "high",
      options: [{ value: "off", name: "Off" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }],
    },
    // Claude reports the permission mode as an option plainly named "Mode" —
    // the shape that has to keep working, since "Model" contains the same four
    // letters and a loose match would swallow it.
    {
      id: "mode", name: "Mode", description: "Session permission mode", type: "select", currentValue: "acceptEdits",
      options: [
        { value: "auto", name: "Auto", description: "Use a model classifier to approve/deny permission prompts" },
        { value: "default", name: "Default", description: "Standard behavior, prompts for dangerous operations" },
        { value: "acceptEdits", name: "Accept Edits", description: "Auto-accept file edit operations" },
        { value: "plan", name: "Plan Mode", description: "Planning mode, no actual tool execution" },
      ],
    },
  ],
};

const session: Session = {
  engine: ENGINE,
  id: "s-usage", title: "Usage gauge caching", createdAt: Date.now() - 900_000,
  agentName: "claude", cwd: CWD, lastActiveAt: Date.now(),
  hasContent: true, working: true, modelId: "opus", mode: "acceptEdits",
  contextUsed: 34_000, contextSize: 200_000,
  curAssistantId: null, curThoughtId: null, toolItemId: {}, planItemId: null,
  seq: 20, historyStart: 12, loadingOlder: false,
  items: [
    {
      id: "i1", kind: "user",
      text: "usage gauge 只在有資料時顯示，並讓 quota 查詢走 5 分鐘 cache。順便確認背景 tab 不要繼續 poll。",
      files: [{ name: "web/src/components/UsageStrip.tsx" }, { name: "store.ts:1420-1468" }],
    },
    {
      id: "i2", kind: "thought",
      text: "rateLimits 只在 poll 回來後才有值 → 首次載入會閃一下空白。cache 應該放在 gateway 端，client 的 60s interval 只是打同一份快取。",
    },
    {
      id: "i3", kind: "assistant",
      text: "兩個問題其實是同一個：**可見性由資料驅動，而資料到得太晚**。\n\n"
        + "- gateway 對 `/usage/limits` 加 5 分鐘 TTL，client 輪詢不再放大成後端請求\n"
        + "- `hasUsage` 改成「有 contextSize *或* 有 rateLimits」，首次 render 不閃\n",
    },
    {
      id: "i4", kind: "tool", toolCallId: "t1", title: "web/src/components/UsageStrip.tsx",
      toolKind: "read", status: "completed", locations: ["file://" + CWD + "/web/src/components/UsageStrip.tsx"],
      content: [{ type: "content", content: { type: "text", text: "export function UsageStrip() {\n  const limits = useStore((s) => s.rateLimits);" } }],
    },
    {
      id: "i5", kind: "tool", toolCallId: "t2", title: "src/gateway.ts",
      toolKind: "edit", status: "in_progress", locations: [],
      content: [{
        type: "diff", path: "file://" + CWD + "/src/gateway.ts",
        oldText: "async function usageLimits(req: Req) {\n  const w = await fetchUsageWindows();\n  return json(w);\n}\n",
        newText: "async function usageLimits(req: Req) {\n  const w = usageCache.get() ?? await fetchUsageWindows();\n  usageCache.set(w, 5 * 60_000);\n  return json(w);\n}\n",
      }],
    },
    {
      id: "i6", kind: "permission", reqId: 7, title: "Run `npm --prefix web run build` to verify?",
      resolved: false,
      options: [
        { optionId: "once", name: "Allow", kind: "allow_once" },
        { optionId: "always", name: "Allow always", kind: "allow_always" },
        { optionId: "no", name: "Deny", kind: "reject_once" },
      ],
    },
  ],
};

const s0 = useStore.getState();
useStore.setState({
  // No live gateway here: neutralise the two actions App fires on mount so the
  // canned state below is never raced by a real bootstrap.
  bootstrap: () => {}, ensureConnected: () => {},
  agentName: "claude", cwd: CWD, conn: "connected", agentReady: true,
  activeId: "s-usage", sessions: { "s-usage": session },
  // On a phone the panels are tabs, so opening one starts the harness on the
  // wrong tab; only the desktop layout wants the changes column open.
  sidebarOpen: true, filesOpen: window.innerWidth >= 1100,
  promptCapabilities: { image: true, embeddedContext: true },
  tip: "",
  // bootstrap() is the thing that would normally hydrate these out of /prefs,
  // and it is stubbed out above — so hand them over directly. runningTasks /
  // inboxItems / rateLimits still arrive through App's own polls.
  recentSessions: (ROUTES["/prefs"] as { recentSessions: never[] }).recentSessions,
  cfg: { ...s0.cfg, terminalEnabled: true },
});

// The fragment picks a scenario the screenshots need: "idle" drops the in-flight
// turn, "opencode" is the agent that reports no thinking level.
if (SCENE.has("idle")) {
  useStore.setState({
    sessions: { "s-usage": { ...session, working: false, items: session.items.slice(0, 5) } },
  });
}
if (SCENE.has("codex")) useStore.setState({ agentName: "codex" });
if (SCENE.has("opencode")) {
  useStore.setState((st) => ({
    agentName: "opencode",
    sessions: { "s-usage": { ...st.sessions["s-usage"], engine: {
      ...ENGINE, configOptions: ENGINE.configOptions.filter((o) => o.id !== "thinking"),
    } } },
  }));
}

createRoot(document.getElementById("root")!).render(<App />);

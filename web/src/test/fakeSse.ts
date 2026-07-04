import { vi } from "vitest";

// A fake SSE+POST transport for the store/App tests, replacing the old FakeWebSocket.
// installFakeSse() stubs global.fetch to:
//   (a) serve the SSE downstream GET (/acp/sse) as a stream the test drives,
//   (b) accept upstream POSTs (/acp/rpc) into the matching connection's `sent`, and
//   (c) delegate every other fetch (history / fs / files APIs) to a per-test handler.
// The test-facing surface mirrors the old fake socket: instances[], open(), recv(),
// sent[], close(), url — so a test reads/writes a connection the same way it used to.
export class FakeSse {
  static instances: FakeSse[] = [];
  url: string;
  sent: string[] = [];          // upstream POST bodies (JSON-RPC frames, as strings)
  closed = false;
  private seq = 0;
  private opened = false;
  private _push: (chunk: string) => void = () => {};
  private _end: () => void = () => {};

  constructor(url: string) { this.url = url; FakeSse.instances.push(this); }
  // The conn id this stream advertises in its `ready` event; upstream POSTs carry it.
  get conn(): string { return "c" + FakeSse.instances.indexOf(this); }
  _wire(push: (c: string) => void, end: () => void): void { this._push = push; this._end = end; }

  // Fire the SSE `ready` event → Acp.onopen → the store sees status "connected".
  open(): void {
    if (this.opened) return;
    this.opened = true;
    this._push(`event: ready\ndata:${JSON.stringify({ conn: this.conn })}\n\n`);
  }
  // Deliver one agent->client frame, tagged with a fresh monotonic seq (the SSE id:).
  recv(obj: unknown): void { this.seq++; this._push(`id:${this.seq}\ndata:${JSON.stringify(obj)}\n\n`); }
  // Drop the stream — simulates a network drop or a deliberate close.
  close(): void { if (!this.closed) { this.closed = true; this._end(); } }
}

// Non-transport fetches (history etc.) are delegated to historyHandler; tests override
// it via setHistoryFetch. historyCalls records their URLs for assertions.
export let historyCalls: string[] = [];
let historyHandler: (url: string, init?: RequestInit) => Promise<unknown> =
  async () => ({ ok: true, json: async () => ({}) });
export function setHistoryFetch(h: (url: string, init?: RequestInit) => Promise<unknown>): void {
  historyHandler = h;
}

// The gateway's shared UI prefs (GET /prefs), served from a per-test fixture so a
// test can seed the recents/lock/text-size the store hydrates on bootstrap. Prefs
// traffic is handled here (and kept out of historyCalls) so it doesn't perturb
// tests that assert on history fetch URLs.
interface PrefsFixture { textSize: string | null; lock: unknown; recentSessions: unknown[]; recentFolders: unknown[] }
let prefsFixture: PrefsFixture = { textSize: null, lock: null, recentSessions: [], recentFolders: [] };
export function setPrefs(p: Partial<PrefsFixture>): void {
  prefsFixture = { textSize: null, lock: null, recentSessions: [], recentFolders: [], ...p };
}

export function installFakeSse(): void {
  FakeSse.instances = [];
  historyCalls = [];
  historyHandler = async () => ({ ok: true, json: async () => ({}) });
  prefsFixture = { textSize: null, lock: null, recentSessions: [], recentFolders: [] };
  vi.stubGlobal("fetch", (url: unknown, init?: RequestInit & { signal?: AbortSignal }) => {
    const u = String(url);
    if (init?.method === "POST" && u.includes("/acp/rpc")) {
      const conn = new URL(u, "http://x").searchParams.get("conn");
      const inst = FakeSse.instances.find((i) => i.conn === conn) ?? FakeSse.instances.at(-1);
      inst?.sent.push(typeof init.body === "string" ? init.body : String(init.body));
      return Promise.resolve({ ok: true, status: 202, text: async () => "" });
    }
    if (u.includes("/acp/sse")) {
      const inst = new FakeSse(u);
      const queue: Uint8Array[] = [];
      let pending: ((r: { done: boolean; value?: Uint8Array }) => void) | null = null;
      let done = false;
      const drain = () => {
        if (!pending) return;
        if (queue.length) { const p = pending; pending = null; p({ done: false, value: queue.shift() }); }
        else if (done) { const p = pending; pending = null; p({ done: true }); }
      };
      inst._wire(
        (s) => { queue.push(new TextEncoder().encode(s)); drain(); },
        () => { done = true; drain(); },
      );
      init?.signal?.addEventListener?.("abort", () => { inst.closed = true; done = true; drain(); });
      const reader = { read: () => new Promise<{ done: boolean; value?: Uint8Array }>((res) => { pending = res; drain(); }) };
      return Promise.resolve({ ok: true, status: 200, body: { getReader: () => reader } });
    }
    // Shared UI prefs: GET hydrates from the fixture; the best-effort write-backs
    // (POST/DELETE) just succeed. Kept out of historyCalls (see setPrefs).
    if (u.includes("/prefs")) {
      if (init?.method === "POST" || init?.method === "DELETE") {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => prefsFixture });
    }
    historyCalls.push(u);
    return historyHandler(u, init);
  });
}

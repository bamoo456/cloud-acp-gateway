// The ONLY transport owner. Correlates JSON-RPC requests/responses, routes
// agent->client requests (permission) and notifications, and auto-reconnects.
// UI talks to this, never to the underlying SSE stream. The concrete transport is
// supplied as a Sock factory (see sseFactory below); Acp itself is transport-agnostic.

export interface Sock {
  readyState: number;
  // `onFail` fires when the frame provably did NOT reach the gateway (transport
  // closed, network error, or a non-2xx from the upstream POST). Optional so a
  // transport that cannot tell may omit it; Acp uses it to fail the matching
  // request instead of waiting forever for a response that can never arrive.
  send(data: string, onFail?: () => void): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((data: string) => void) | null;
  onclose: ((code: number) => void) | null;
}

export interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}
type Status = "connecting" | "connected" | "offline";

// Rejection for a frame the transport proved never reached the gateway. Not
// __disconnected: the link was up, so this one IS worth telling the user about.
const NOT_DELIVERED = { code: -32000, message: "not delivered to the gateway — nothing was sent to the agent" };

export class Acp {
  private sock: Sock | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private notifCb: (m: RpcMessage) => void = () => {};
  private reqCb: (m: RpcMessage) => void = () => {};
  private statusCb: (s: Status, closeCode?: number) => void = () => {};

  constructor(
    private url: string,
    private factory: (url: string) => Sock,
  ) {}

  onNotification(cb: (m: RpcMessage) => void) { this.notifCb = cb; }
  onRequest(cb: (m: RpcMessage) => void) { this.reqCb = cb; }
  onStatus(cb: (s: Status, closeCode?: number) => void) { this.statusCb = cb; }

  // True when no socket is live or in-flight — i.e. a fresh connect() is warranted.
  // CONNECTING(0) and OPEN(1) both count as "leave it alone"; CLOSING(2)/CLOSED(3)
  // — or no socket at all — mean the link is gone. Used by the foreground/pageshow
  // resume path: a mobile client whose socket dropped while backgrounded (the
  // reconnect timer may have been suspended) reconnects the moment it returns.
  needsReconnect(): boolean {
    return !this.sock || this.sock.readyState >= 2;
  }

  connect() {
    this.statusCb("connecting");
    let s: Sock;
    try { s = this.factory(this.url); } catch { this.statusCb("offline"); return; }
    this.sock = s;
    s.onopen = () => this.statusCb("connected");
    s.onmessage = (data) => this.handle(data);
    s.onclose = (code) => {
      this.statusCb("offline", code);
      for (const [, p] of this.pending) p.reject({ __disconnected: true });
      this.pending.clear();
    };
  }

  // Deliberate teardown (e.g. switching to another agent): detach the socket
  // handlers BEFORE closing so the close never surfaces as an "offline" status —
  // no auto-reconnect, no "Disconnected" tip. In-flight requests reject as
  // disconnected, same as a real drop.
  close() {
    const s = this.sock;
    this.sock = null;
    if (s) {
      s.onopen = null; s.onmessage = null; s.onclose = null;
      try { s.close(1000); } catch { /* already closed */ }
    }
    for (const [, p] of this.pending) p.reject({ __disconnected: true });
    this.pending.clear();
  }

  private handle(data: string) {
    let m: RpcMessage;
    try { m = JSON.parse(data); } catch { return; }
    if (m.method && m.id != null) return this.reqCb(m);
    if (m.method) return this.notifCb(m);
    if (m.id != null) {
      const p = this.pending.get(Number(m.id));
      if (!p) return;
      this.pending.delete(Number(m.id));
      if (m.error) p.reject(m.error); else p.resolve(m.result);
    }
  }

  // `onFail` is invoked with the error to surface when the frame did not reach the
  // gateway. A closed socket is reported as __disconnected (same shape as the
  // onclose path, so callers keep treating it as "link dropped, not your fault");
  // a rejected/non-2xx POST is a real error worth showing.
  private raw(obj: unknown, onFail?: (e: unknown) => void) {
    if (this.sock && this.sock.readyState === 1) {
      this.sock.send(JSON.stringify(obj), () => onFail?.(NOT_DELIVERED));
    } else {
      onFail?.({ __disconnected: true });
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      // A frame that never reached the gateway gets no response on the SSE stream,
      // so without this the request hangs forever — which is how a lost prompt used
      // to render as a turn stuck on "working" that no agent ever heard about.
      this.raw({ jsonrpc: "2.0", id, method, params }, (e) => {
        if (this.pending.delete(id)) reject(e); // else the response won the race
      });
    });
  }
  notify(method: string, params: unknown) { this.raw({ jsonrpc: "2.0", method, params }); }
  respond(id: number | string, result: unknown) { this.raw({ jsonrpc: "2.0", id, result }); }
  respondErr(id: number | string, code: number, message: string) {
    this.raw({ jsonrpc: "2.0", id, error: { code, message } });
  }
}

// ----------------------------------------------------------- SSE transport ----
// An SSE-downstream + POST-upstream transport that satisfies the Sock surface Acp
// drives — the only transport the gateway speaks. The server streams agent->client frames
// as SSE events whose `id:` is the ledger sequence; the client persists the highest
// seq it has seen and resumes from it via Last-Event-ID (here: ?lastEventId=) on
// reconnect, replacing the old "session/load the whole thing on every drop" recovery.

export interface SseEvent { id: number | null; event: string; data: string }

// Incremental SSE parser: feed it raw chunks, it emits one event per blank-line-
// delimited block. Pure and synchronous so it is unit-testable without any network.
export class SseParser {
  private buf = "";
  constructor(private onEvent: (e: SseEvent) => void) {}
  push(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n\n")) >= 0) {
      this.emit(this.buf.slice(0, i));
      this.buf = this.buf.slice(i + 2);
    }
  }
  private emit(block: string): void {
    let id: number | null = null;
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line[0] === ":") continue; // comment / keepalive
      else if (line.startsWith("id:")) id = Number(line.slice(3));
      else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5);
    }
    this.onEvent({ id, event, data });
  }
}

export interface SseTransport {
  // Build the SSE GET url for a resume point; lastEventId < 0 means "fresh/live".
  sseUrl: (lastEventId: number) => string;
  // Build the POST url for the conn id the SSE stream was issued.
  rpcUrl: (connId: string) => string;
  // Injectable for tests; defaults to the global fetch.
  fetchImpl?: typeof fetch;
}

// fetch's keepalive body limit (64KB per spec); kept a little under it for the
// request line and headers.
const KEEPALIVE_MAX_BYTES = 60_000;

// Whether `data` fits fetch's keepalive body cap, measured in UTF-8 BYTES —
// data.length counts UTF-16 units and undercounts by up to 3x (CJK text, emoji),
// which would push an oversized body into a keepalive fetch that then rejects.
// The length check short-circuits the encode (UTF-8 bytes >= UTF-16 units always),
// so a multi-MB image prompt never gets copied just to be measured.
function keepaliveFits(data: string): boolean {
  return data.length <= KEEPALIVE_MAX_BYTES && new TextEncoder().encode(data).length <= KEEPALIVE_MAX_BYTES;
}

// One Sock backed by a streaming fetch (downstream) + POSTs (upstream). lastSeq is
// owned by sseFactory's closure so it survives reconnects on the same Acp.
function sseSock(t: SseTransport, getSeq: () => number, setSeq: (n: number) => void): Sock {
  const doFetch = t.fetchImpl ?? fetch;
  let readyState = 0; // CONNECTING
  let connId = "";
  const ctrl = new AbortController();

  const sock: Sock = {
    get readyState() { return readyState; },
    send(data: string, onFail?: () => void) {
      if (readyState !== 1) { onFail?.(); return; }
      // The JSON-RPC response (if any) returns on the SSE stream, not here — the
      // only thing this reply tells us is whether the frame ARRIVED, which is worth
      // knowing: a dropped POST otherwise leaves the sender waiting on a turn the
      // gateway never saw.
      void doFetch(t.rpcUrl(connId), {
        method: "POST",
        body: data,
        headers: { "content-type": "application/json" },
        signal: ctrl.signal,
        // keepalive lets the browser finish the POST after the page is closed or
        // navigated away — the window in which a just-sent prompt used to be lost
        // (the request was cancelled mid-body, and the gateway drops a body whose
        // `end` never fires). Spec-capped at 64KB, and a prompt can carry inline
        // base64 images, so a larger body falls back to a plain fetch.
        ...(keepaliveFits(data) ? { keepalive: true } : {}),
      }).then((res) => { if (!res.ok) onFail?.(); }, () => onFail?.());
    },
    close() { if (readyState !== 3) { readyState = 3; ctrl.abort(); } },
    onopen: null,
    onmessage: null,
    onclose: null,
  };

  const fail = (code: number) => { if (readyState !== 3) { readyState = 3; sock.onclose?.(code); } };

  const parser = new SseParser((e) => {
    if (e.id !== null && !Number.isNaN(e.id)) setSeq(e.id);
    if (e.event === "ready") {
      try { connId = (JSON.parse(e.data) as { conn?: string }).conn ?? ""; } catch { /* ignore */ }
      if (readyState === 0) { readyState = 1; sock.onopen?.(); }
      return;
    }
    if (e.data) sock.onmessage?.(e.data);
  });

  void (async () => {
    try {
      const res = await doFetch(t.sseUrl(getSeq()), { headers: { accept: "text/event-stream" }, signal: ctrl.signal });
      if (!res.ok || !res.body) { fail(res.status || 1006); return; }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(typeof value === "string" ? value : dec.decode(value, { stream: true }));
      }
      fail(1006);
    } catch {
      fail(1006);
    }
  })();

  return sock;
}

// A Sock factory for Acp that speaks SSE+POST. By default lastSeq lives in this
// closure (starts at -1 = fresh/live) and tracks the highest seq seen, so a
// reconnect on the SAME Acp resumes after it. An optional external `cursor` store
// lets the resume position survive Acp recreation (e.g. switching agent and back),
// keyed by the caller per agent.
export function sseFactory(
  t: SseTransport,
  cursor?: { get: () => number; set: (n: number) => void },
): (url: string) => Sock {
  let lastSeq = -1;
  const getSeq = cursor ? cursor.get : () => lastSeq;
  const setSeq = cursor
    ? (s: number) => { if (s > cursor.get()) cursor.set(s); }
    : (s: number) => { if (s > lastSeq) lastSeq = s; };
  return () => sseSock(t, getSeq, setSeq);
}

// Transport abstraction for a single client connection. The gateway's routing core
// (idmux / subscriptions / permission gate / pending-permission re-delivery / load
// gating / running tasks) only ever reaches a client through one operation: "send
// these bytes". Hiding the concrete transport behind a ClientSink keeps that core
// independent of how a frame physically reaches the client (today: SSE).
//
// `seq` is the server-assigned ledger sequence id for the frame; the SSE sink emits
// it as the event `id:` so a client can resume via `Last-Event-ID`.
export interface ClientSink {
  send(seq: number, frame: Buffer): void;
  close(code?: number, reason?: string): void;
  // Whether the underlying transport is still open for writes. Routing skips a sink
  // that isn't.
  get alive(): boolean;
}

// The minimal slice of an http.ServerResponse the SSE sink needs. Structural so the
// sink has no hard http dependency and is fakeable in tests.
export interface SseResponse {
  writableEnded: boolean;
  write(chunk: string): boolean;
  end(): void;
  on(event: "close", cb: () => void): void;
}

// Server-Sent-Events transport for one client. Each frame becomes an SSE event whose
// `id:` is the ledger seq, so a reconnecting client resumes via `Last-Event-ID`. ACP
// frames are single-line JSON (the agent emits newline-delimited JSON, so a frame can
// never contain a literal newline), hence one `data:` line per frame is sufficient.
//
// Liveness is driven by the connection's `close` event and write errors — NOT by
// write()'s return value, which only signals backpressure (a full buffer), not a dead
// peer. Treating backpressure as death would wrongly drop a slow client.
export class SseSink implements ClientSink {
  private closed = false;
  constructor(private res: SseResponse) {
    res.on("close", () => { this.closed = true; });
  }
  send(seq: number, frame: Buffer): void {
    this.writeRaw(`id:${seq}\ndata:${frame.toString("utf8")}\n\n`);
  }
  // SSE comment line; keeps proxies/load-balancers from idling the stream out and
  // surfaces a dead peer on the next write.
  keepalive(): void {
    this.writeRaw(`: ka\n\n`);
  }
  private writeRaw(s: string): void {
    if (!this.alive) return;
    try { this.res.write(s); } catch { this.closed = true; }
  }
  close(): void {
    this.closed = true;
    try { this.res.end(); } catch { /* already ended */ }
  }
  get alive(): boolean {
    return !this.closed && !this.res.writableEnded;
  }
}

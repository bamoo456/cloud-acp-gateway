// Client → agent request ids collide (every client numbers from 1). The gateway
// rewrites each to a globally-unique id before forwarding to the single agent,
// and maps the eventual response back to the originating connection.
export interface Origin {
  connId: string;
  clientId: string | number;
  method: string | null;
  // The session this request targets (when known). Lets the gateway tell, on the
  // eventual response, which session's in-flight task just completed.
  sessionId?: string;
  // The working directory this request carried (session/new has no sessionId yet,
  // so its cwd rides along here and is paired to the session on the response).
  cwd?: string;
}

export class IdMux {
  private seq = 0;
  private map = new Map<number, Origin>();

  outbound(connId: string, clientId: string | number, method: string | null, sessionId?: string, cwd?: string): number {
    const gatewayId = ++this.seq;
    this.map.set(gatewayId, { connId, clientId, method, sessionId, cwd });
    return gatewayId;
  }

  inbound(gatewayId: number): Origin | null {
    const o = this.map.get(gatewayId);
    if (o) this.map.delete(gatewayId);
    return o ?? null;
  }

  forgetConn(connId: string): void {
    for (const [k, v] of this.map) if (v.connId === connId) this.map.delete(k);
  }

  // Remove and return every outstanding request. Used when the agent exits: its
  // in-flight client requests will never get a response, so the gateway drains them
  // to settle each one (with a synthesized error) instead of leaving them dangling.
  drain(): Origin[] {
    const out = [...this.map.values()];
    this.map.clear();
    return out;
  }
}

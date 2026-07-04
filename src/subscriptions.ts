// Which connections are "viewing" which session. A connection subscribes when it
// sends session/new (learned from the response), session/load, or session/prompt.
// Used to route agent→client permission requests to the connections viewing the
// relevant session.
export class Subscriptions {
  private bySession = new Map<string, Set<string>>();
  private byConn = new Map<string, Set<string>>();

  subscribe(connId: string, sessionId: string): void {
    (this.bySession.get(sessionId) ?? this.bySession.set(sessionId, new Set()).get(sessionId)!).add(connId);
    (this.byConn.get(connId) ?? this.byConn.set(connId, new Set()).get(connId)!).add(sessionId);
  }
  viewers(sessionId: string): string[] {
    return [...(this.bySession.get(sessionId) ?? [])];
  }
  sessionsOf(connId: string): string[] {
    return [...(this.byConn.get(connId) ?? [])];
  }
  remove(connId: string): void {
    for (const sid of this.byConn.get(connId) ?? []) this.bySession.get(sid)?.delete(connId);
    this.byConn.delete(connId);
  }
}

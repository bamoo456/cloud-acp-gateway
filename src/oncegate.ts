// "First reply wins": when an agent→client request (e.g. a permission prompt) is
// fanned out to several devices, only the first device's response is forwarded
// to the agent; the rest are dropped. claim() returns true once per key.
export class OnceGate {
  private done = new Set<string>();
  claim(key: string | number): boolean {
    const k = String(key);
    if (this.done.has(k)) return false;
    this.done.add(k);
    return true;
  }
  forget(key: string | number): void {
    this.done.delete(String(key));
  }
}

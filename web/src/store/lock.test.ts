import { describe, test, expect, beforeEach, vi } from "vitest";

describe("store screen lock", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = `<script id="acpg-cfg" type="application/json">{
      "wsPath": "/acp",
      "token": "test-token",
      "defaultAgent": "claude",
      "agents": [{ "name": "claude", "cwd": "/repo" }],
      "fsRoot": "/"
    }</script>`;
  });

  test("lock() is a no-op until a PIN is configured", async () => {
    const { useStore } = await import("./store.ts");
    useStore.getState().lock();
    expect(useStore.getState().locked).toBe(false);
  });

  test("lock() severs the connection and shows the lock screen", async () => {
    const { useStore } = await import("./store.ts");
    useStore.setState({ lockEnabled: true, agentReady: true, conn: "connected" });
    useStore.getState().lock();
    const st = useStore.getState();
    expect(st.locked).toBe(true);
    expect(st.conn).toBe("offline");
    expect(st.agentReady).toBe(false);
  });

  test("ensureConnected does nothing while locked", async () => {
    const { useStore } = await import("./store.ts");
    useStore.setState({ lockEnabled: true, conn: "connected" });
    useStore.getState().lock();
    useStore.setState({ conn: "offline" });
    useStore.getState().ensureConnected();
    // still locked, no reconnect attempt flipped us back to connecting
    expect(useStore.getState().locked).toBe(true);
    expect(useStore.getState().conn).toBe("offline");
  });

  test("unlock() clears the lock and starts reconnecting", async () => {
    const { useStore } = await import("./store.ts");
    useStore.setState({ lockEnabled: true });
    useStore.getState().lock();
    useStore.getState().unlock();
    expect(useStore.getState().locked).toBe(false);
    expect(useStore.getState().conn).toBe("connecting");
  });

  test("refreshLockSettings mirrors the persisted PIN config", async () => {
    const { useStore } = await import("./store.ts");
    const { setLockPin, clearLock } = await import("../lib/lock.ts");
    clearLock();
    useStore.getState().refreshLockSettings();
    expect(useStore.getState().lockEnabled).toBe(false);
    await setLockPin("1234");
    useStore.getState().refreshLockSettings();
    expect(useStore.getState().lockEnabled).toBe(true);
  });
});

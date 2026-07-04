import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { installFakeSse, setPrefs, FakeSse } from "../test/fakeSse.ts";

const savedPinLock = { saltB64: "AQ==", hashB64: "Ag==", iterations: 1 };

// End-to-end (store + fake SSE transport) test for the connection-driven lock:
// an involuntary socket drop must engage the lock when it's on. (Lock-off
// reconnect is the pre-existing behaviour and is covered elsewhere; it schedules
// a 1.5s backoff timer we don't want to leave running in a unit test.)
describe("store screen lock — connection-driven", () => {
  beforeEach(() => {
    vi.resetModules();
    installFakeSse();
    document.body.innerHTML = `<script id="acpg-cfg" type="application/json">{
      "token":"t","defaultAgent":"claude",
      "agents":[{"name":"claude","cwd":"/c"}],"fsRoot":"/"}</script>`;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  async function bootstrapUnlockAndConnect() {
    setPrefs({ lock: savedPinLock });
    const { useStore } = await import("./store.ts");
    useStore.getState().bootstrap();
    await vi.waitFor(() => expect(useStore.getState().locked).toBe(true));
    useStore.getState().unlock();
    await vi.waitFor(() => expect(FakeSse.instances.length).toBeGreaterThan(0));
    FakeSse.instances.at(-1)!.open(); // SSE `ready` → status connected
    await vi.waitFor(() => expect(useStore.getState().conn).toBe("connected"));
    return useStore;
  }

  test("an involuntary drop engages the lock when it's on", async () => {
    const useStore = await bootstrapUnlockAndConnect();
    const instances = FakeSse.instances.length;
    FakeSse.instances.at(-1)!.close(); // network drop → onclose(1006)

    await vi.waitFor(() => expect(useStore.getState().locked).toBe(true));
    expect(useStore.getState().conn).toBe("offline");
    // Locked, not auto-reconnecting: no new SSE stream was opened.
    expect(FakeSse.instances.length).toBe(instances);
  });

  test("a server-pushed agent restart engages the lock when it's on", async () => {
    const useStore = await bootstrapUnlockAndConnect();
    const instances = FakeSse.instances.length;
    // The gateway broadcasts _gateway/agent_restart; onAgentRestart() must lock
    // (and NOT reopen the connection) when the lock is on.
    FakeSse.instances.at(-1)!.recv({ jsonrpc: "2.0", method: "_gateway/agent_restart" });

    await vi.waitFor(() => expect(useStore.getState().locked).toBe(true));
    expect(useStore.getState().conn).toBe("offline");
    expect(FakeSse.instances.length).toBe(instances); // locked, not reopened
  });
});

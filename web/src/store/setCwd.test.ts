import { describe, test, expect, beforeEach, vi } from "vitest";

describe("setCwd", () => {
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

  test("records the folder in recent folders", async () => {
    const { useStore } = await import("./store.ts");
    const { readRecentFolders } = await import("../lib/recentFolders.ts");

    useStore.setState({ agentReady: false }); // keep setCwd from opening a session
    useStore.getState().setCwd("/repo-b");

    expect(useStore.getState().cwd).toBe("/repo-b");
    expect(readRecentFolders()[0]?.path).toBe("/repo-b");
  });
});

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

describe("AgentPill", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  function cfg(agents: string) {
    document.body.innerHTML = `<script id="acpg-cfg" type="application/json">{
      "wsPath":"/acp","token":"t","defaultAgent":"codex",
      "agents":${agents},"fsRoot":"/"}</script>`;
  }

  beforeEach(() => {
    vi.resetModules();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) { act(() => root?.unmount()); root = null; }
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  async function render() {
    const { AgentPill } = await import("./AgentPill.tsx");
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(AgentPill));
    });
  }

  test("shows the capitalized active-agent name", async () => {
    cfg(`[{"name":"codex","cwd":"/p","skin":"codex"},{"name":"claude","cwd":"/c"}]`);
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ agentName: "codex", agentReady: true });
    await render();

    expect(container.querySelector(".agent-pill .nm")?.textContent).toBe("Codex");
    expect(container.querySelector(".mark.codex")).not.toBeNull();
  });

  test("clicking opens the picker and selecting calls setAgent", async () => {
    cfg(`[{"name":"codex","cwd":"/p","skin":"codex"},{"name":"claude","cwd":"/c"}]`);
    const { useStore } = await import("../store/store.ts");
    const setAgent = vi.fn();
    useStore.setState({ agentName: "codex", agentReady: true, setAgent });
    await render();

    const pill = container.querySelector<HTMLButtonElement>("button.agent-pill");
    await act(async () => { pill?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    const claude = [...container.querySelectorAll<HTMLButtonElement>(".agent-menu .agent-opt")]
      .find((b) => b.textContent?.includes("Claude"));
    expect(claude).toBeDefined();
    await act(async () => { claude?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(setAgent).toHaveBeenCalledWith("claude");
  });

  test("renders as a non-clickable label when only one agent is configured", async () => {
    cfg(`[{"name":"claude","cwd":"/c"}]`);
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ agentName: "claude", agentReady: true });
    await render();

    expect(container.querySelector("button.agent-pill")).toBeNull();
    const label = container.querySelector("span.agent-pill.label");
    expect(label?.textContent).toContain("Claude");
    expect(container.querySelector(".agent-pill .chev")).toBeNull();
  });

  test("shows the working indicator only when the active session is busy", async () => {
    cfg(`[{"name":"codex","cwd":"/p","skin":"codex"},{"name":"claude","cwd":"/c"}]`);
    const { useStore } = await import("../store/store.ts");
    useStore.setState({ agentName: "codex", agentReady: true, activeId: "s1", busySessionIds: {} });
    await render();
    expect(container.querySelector(".agent-pill .working-dots")).toBeNull();

    await act(async () => { useStore.setState({ busySessionIds: { s1: true } }); });
    expect(container.querySelector(".agent-pill .working-dots")).not.toBeNull();
  });
});

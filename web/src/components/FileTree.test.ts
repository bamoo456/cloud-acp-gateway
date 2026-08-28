import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { TreeEntry } from "../lib/api.ts";

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
// The find box debounces at 60ms; these tests wait it out rather than faking
// timers, because the debounce is the behaviour under test in one of them.
const settle = () => new Promise((r) => setTimeout(r, 120));
// Contents search costs a git process on the gateway, so it waits 300ms.
const settleGrep = () => new Promise((r) => setTimeout(r, 360));

const ROOT: TreeEntry[] = [
  { name: "src", abs: "/repo/src", dir: true },
  { name: "dist", abs: "/repo/dist", dir: true, ignored: true },
  { name: ".env", abs: "/repo/.env", dir: false, size: 40 },
  { name: "README.md", abs: "/repo/README.md", dir: false, size: 1024 },
];
const SRC: TreeEntry[] = [{ name: "app.ts", abs: "/repo/src/app.ts", dir: false, size: 200 }];

describe("FileTree", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;
  let getWorkspaceTree: ReturnType<typeof vi.fn>;
  let findWorkspaceFiles: ReturnType<typeof vi.fn>;
  let grepWorkspace: ReturnType<typeof vi.fn>;
  let onOpenFile: ReturnType<typeof vi.fn>;
  let onMenu: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    onOpenFile = vi.fn();
    onMenu = vi.fn();
    getWorkspaceTree = vi.fn().mockImplementation((_cwd: string, dir?: string) =>
      Promise.resolve({
        abs: dir ?? "/repo", path: dir ? "src" : "", truncated: false,
        entries: dir === "/repo/src" ? SRC : ROOT,
      }));
    findWorkspaceFiles = vi.fn().mockResolvedValue({
      files: [{ path: "src/app.ts", abs: "/repo/src/app.ts" }], truncated: false, fromGit: true, total: 1,
    });
    grepWorkspace = vi.fn().mockResolvedValue({
      files: [{
        path: "src/app.ts", abs: "/repo/src/app.ts", more: 0,
        matches: [{ line: 3, text: "export const a = 1;" }],
      }],
      truncated: false, fromGit: true, total: 1,
    });
    vi.doMock("../lib/api.ts", () => ({ getWorkspaceTree, findWorkspaceFiles, grepWorkspace }));
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    container.remove();
    vi.doUnmock("../lib/api.ts");
  });

  async function render(cwd = "/repo", reloadKey = 0) {
    const { FileTree } = await import("./FileTree.tsx");
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(FileTree, { cwd, reloadKey, onOpenFile, onMenu }));
    });
    await act(async () => { await flush(); });
  }

  const rows = () => [...container.querySelectorAll<HTMLElement>("button.wf-row")];
  const rowNamed = (name: string) => rows().find((r) => r.querySelector(".wf-nm")?.textContent === name);
  const click = async (el: HTMLElement | undefined) => {
    await act(async () => { el?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await flush(); });
  };

  test("lists the conversation's own folder, and dims what git ignores", async () => {
    await render();
    expect(getWorkspaceTree).toHaveBeenCalledWith("/repo", undefined);
    expect(rows().map((r) => r.querySelector(".wf-nm")?.textContent))
      .toEqual(["src", "dist", ".env", "README.md"]);
    // Hidden would leave "where is dist" unanswerable; dimmed says why.
    expect(rowNamed("dist")?.className).toContain("ignored");
    expect(rowNamed("src")?.className).not.toContain("ignored");
    // A dotfile is an ordinary row — the whole point of showing them.
    expect(rowNamed(".env")).toBeDefined();
  });

  test("a folder lists its children only once it is opened", async () => {
    await render();
    expect(getWorkspaceTree).toHaveBeenCalledTimes(1);

    await click(rowNamed("src"));
    expect(getWorkspaceTree).toHaveBeenCalledWith("/repo", "/repo/src");
    expect(rowNamed("app.ts")).toBeDefined();

    // Closing drops the level, and with it anything expanded inside it.
    await click(rowNamed("src"));
    expect(rowNamed("app.ts")).toBeUndefined();
  });

  test("a file row hands the panel the absolute path, not the label", async () => {
    await render();
    await click(rowNamed("README.md"));
    expect(onOpenFile).toHaveBeenCalledWith({ abs: "/repo/README.md", name: "README.md" });
  });

  test("typing searches by name, and one keystroke's results can't land on the next", async () => {
    await render();
    const input = container.querySelector<HTMLInputElement>(".wf-find input")!;
    const type = async (value: string) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };

    await type("ap");
    await type("app");
    await act(async () => { await settle(); });

    // Debounced: the abandoned keystroke never became a request.
    expect(findWorkspaceFiles).toHaveBeenCalledTimes(1);
    expect(findWorkspaceFiles).toHaveBeenCalledWith("/repo", "app");
    expect(rowNamed("app.ts")).toBeDefined();
    // The tree is replaced by results while searching, not appended to.
    expect(rowNamed("README.md")).toBeUndefined();

    await click(rowNamed("app.ts"));
    expect(onOpenFile).toHaveBeenCalledWith({ abs: "/repo/src/app.ts", name: "app.ts" });
  });

  test("a right-click reports the entry it landed on, and whether it is a folder", async () => {
    await render();
    const menu = async (name: string, x: number, y: number) => {
      await act(async () => {
        rowNamed(name)?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: x, clientY: y }));
      });
    };

    await menu("README.md", 12, 34);
    // The panel positions the menu itself, so it needs the pointer as well as
    // the file — and isDir, because a folder is not something to attach.
    expect(onMenu).toHaveBeenCalledWith({ abs: "/repo/README.md", name: "README.md", isDir: false }, 12, 34);

    await menu("src", 40, 60);
    expect(onMenu).toHaveBeenLastCalledWith({ abs: "/repo/src", name: "src", isDir: true }, 40, 60);

    // The row's own action is untouched: the menu is a second gesture, not a
    // replacement for opening the file.
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  test("a find hit has the same menu as a tree row", async () => {
    await render();
    const input = container.querySelector<HTMLInputElement>(".wf-find input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "app");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { await settle(); });

    await act(async () => {
      rowNamed("app.ts")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 6 }));
    });
    expect(onMenu).toHaveBeenCalledWith({ abs: "/repo/src/app.ts", name: "app.ts" }, 5, 6);
  });

  test("says when results are the best slice of a much larger match set", async () => {
    findWorkspaceFiles.mockResolvedValue({
      files: [{ path: "src/app.ts", abs: "/repo/src/app.ts" }],
      truncated: true, fromGit: true, total: 4321,
    });
    await render();
    const input = container.querySelector<HTMLInputElement>(".wf-find input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "app");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { await settle(); });

    // "the first 200" was a lie even when the count was right: the server now
    // ranks the whole corpus before cutting, and the note has to say so or a
    // 32k-match query looks like the box gave up.
    expect(container.textContent).toContain("Showing the best 1 of 4321 matches");
  });

  test("an empty result says why an ignored file wasn't found", async () => {
    findWorkspaceFiles.mockResolvedValue({ files: [], truncated: false, fromGit: true, total: 0 });
    await render();
    const input = container.querySelector<HTMLInputElement>(".wf-find input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "bundle");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { await settle(); });

    // dist is visible in the tree but unsearchable, which reads as a bug
    // unless the panel says which rule is in play.
    expect(container.textContent).toContain("Files git ignores aren't searched");
  });

  // ---- Contents: the same box, searching what is written in the files ----
  const type = async (value: string) => {
    const input = container.querySelector<HTMLInputElement>(".wf-find input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const pickScope = async (label: string) => {
    const btn = [...container.querySelectorAll<HTMLElement>(".wf-find-scope button")]
      .find((b) => b.textContent === label);
    await act(async () => { btn?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  };

  test("Contents searches the files, and shows the lines that matched", async () => {
    await render();
    await pickScope("Contents");
    await type("export const");
    await act(async () => { await settleGrep(); });

    expect(grepWorkspace).toHaveBeenCalledTimes(1);
    expect(grepWorkspace).toHaveBeenCalledWith("/repo", "export const");
    // The name search is not also run — they are two searches, not one blended.
    expect(findWorkspaceFiles).not.toHaveBeenCalled();
    expect(container.textContent).toContain("export const a = 1;");
    expect(container.textContent).toContain("3");

    // The whole block is the button, so a tap anywhere in it opens the file.
    await click(container.querySelector<HTMLElement>("button.wf-hit")!);
    expect(onOpenFile).toHaveBeenCalledWith({ abs: "/repo/src/app.ts", name: "app.ts" });
  });

  test("a one-character term never reaches the gateway", async () => {
    await render();
    await pickScope("Contents");
    await type("e");
    await act(async () => { await settleGrep(); });
    expect(grepWorkspace).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Type at least 2 characters");
  });

  test("a folder git knows nothing about says so rather than reporting no matches", async () => {
    grepWorkspace.mockResolvedValue({ files: [], truncated: false, fromGit: false, total: 0 });
    await render();
    await pickScope("Contents");
    await type("needle");
    await act(async () => { await settleGrep(); });
    expect(container.textContent).toContain("isn't a git checkout");
  });

  test("switching back to Names searches names again, with the term kept", async () => {
    await render();
    await pickScope("Contents");
    await type("app");
    await act(async () => { await settleGrep(); });
    expect(grepWorkspace).toHaveBeenCalledTimes(1);

    await pickScope("Names");
    await act(async () => { await settle(); });
    expect(findWorkspaceFiles).toHaveBeenCalledWith("/repo", "app");
    expect(rowNamed("app.ts")).toBeDefined();
  });

  test("Refresh re-lists the tree; nothing else does", async () => {
    await render("/repo", 0);
    expect(getWorkspaceTree).toHaveBeenCalledTimes(1);

    // A turn ending re-renders the panel — that must not re-walk every open
    // folder. Only a bumped reloadKey (the Refresh button) does.
    await act(async () => {
      const { FileTree } = await import("./FileTree.tsx");
      root!.render(React.createElement(FileTree, { cwd: "/repo", reloadKey: 0, onOpenFile, onMenu }));
    });
    await act(async () => { await flush(); });
    expect(getWorkspaceTree).toHaveBeenCalledTimes(1);

    await act(async () => {
      const { FileTree } = await import("./FileTree.tsx");
      root!.render(React.createElement(FileTree, { cwd: "/repo", reloadKey: 1, onOpenFile, onMenu }));
    });
    await act(async () => { await flush(); });
    expect(getWorkspaceTree).toHaveBeenCalledTimes(2);
  });

  test("an absolute path is opened as itself, not searched for", async () => {
    await render();
    const input = container.querySelector<HTMLInputElement>(".wf-find input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "/tmp/eli5/what-we-fixed.html");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { await settle(); });

    // The index is rooted at /repo, so searching for a /tmp path can only ever
    // come back empty — asking at all is the bug.
    expect(findWorkspaceFiles).not.toHaveBeenCalled();
    expect(rowNamed("what-we-fixed.html")).toBeDefined();

    await click(rowNamed("what-we-fixed.html"));
    expect(onOpenFile).toHaveBeenCalledWith({
      abs: "/tmp/eli5/what-we-fixed.html", name: "what-we-fixed.html",
    });
  });

  test("Contents still greps a term that looks like a path", async () => {
    await render();
    const input = container.querySelector<HTMLInputElement>(".wf-find input")!;
    await act(async () => {
      [...container.querySelectorAll<HTMLElement>(".wf-find-scope button")]
        .find((b) => b.textContent === "Contents")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "/workspace/raw");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { await settleGrep(); });

    // A route string is an ordinary thing to grep for. The scope the reader
    // picked decides, not the shape of what they typed.
    expect(grepWorkspace).toHaveBeenCalledWith("/repo", "/workspace/raw");
    expect(container.textContent).not.toContain("Opens this exact path");
  });

  test("a path typed with a trailing slash still names something", async () => {
    await render();
    const input = container.querySelector<HTMLInputElement>(".wf-find input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "/tmp/eli5/");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { await settle(); });

    await click(rowNamed("eli5"));
    expect(onOpenFile).toHaveBeenCalledWith({ abs: "/tmp/eli5", name: "eli5" });
  });
});

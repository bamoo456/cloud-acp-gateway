import { describe, expect, test } from "vitest";
import { mergePanelFiles } from "./panelFiles.ts";
import type { TouchedFile } from "./touchedFiles.ts";
import type { ChangedFile } from "./api.ts";

const wrote = (path: string): TouchedFile => ({
  path, label: path.split("/").pop()!, role: "output",
});
const dirty = (over: Partial<ChangedFile> & { path: string; abs: string }): ChangedFile => ({
  status: "modified", staged: false, ...over,
});

describe("mergePanelFiles", () => {
  test("a file both sources know about is one row carrying both facts", () => {
    const out = mergePanelFiles(
      [wrote("/repo/src/a.ts")],
      [dirty({ path: "src/a.ts", abs: "/repo/src/a.ts", additions: 12, deletions: 3 })],
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      abs: "/repo/src/a.ts", label: "a.ts", fromThread: true,
      git: { status: "modified", additions: 12, deletions: 3 },
    });
  });

  test("what the conversation wrote leads, the rest of the checkout follows", () => {
    // The file the agent just wrote is what the panel was opened to see; a
    // lockfile someone else touched is not.
    const out = mergePanelFiles(
      [wrote("/repo/src/a.ts")],
      [
        dirty({ path: "package-lock.json", abs: "/repo/package-lock.json" }),
        dirty({ path: "src/a.ts", abs: "/repo/src/a.ts" }),
      ],
    );
    expect(out.map((f) => f.label)).toEqual(["a.ts", "package-lock.json"]);
  });

  test("a file only git knows about is still listed — that's the shell's work", () => {
    // `Bash` reports a command, never a path, so this is the ONLY way a
    // shell-driven edit reaches the panel.
    const out = mergePanelFiles([], [dirty({ path: "dist/bundle.js", abs: "/repo/dist/bundle.js", status: "untracked" })]);
    expect(out).toEqual([{
      abs: "/repo/dist/bundle.js", label: "bundle.js", fromThread: false,
      git: { status: "untracked", staged: false, additions: undefined, deletions: undefined, binary: undefined },
    }]);
  });

  test("a file only the thread knows about has no git facts at all", () => {
    // Written to /tmp, written and reverted, or written and committed.
    const out = mergePanelFiles([wrote("/tmp/shot.png")], []);
    expect(out[0].git).toBeUndefined();
    expect(out[0].fromThread).toBe(true);
  });

  test("nothing anywhere is an empty list, not a row of nothing", () => {
    expect(mergePanelFiles([], [])).toEqual([]);
  });
});

import { describe, expect, test } from "vitest";
import { mergePanelFiles, outputFolderCandidates, MAX_OUTPUT_FOLDER_CANDIDATES } from "./panelFiles.ts";
import type { TouchedFile } from "./touchedFiles.ts";
import type { ChangedFile, OutputFile } from "./api.ts";

const wrote = (path: string): TouchedFile => ({
  path, label: path.split("/").pop()!, role: "output",
});
const read = (path: string): TouchedFile => ({
  path, label: path.split("/").pop()!, role: "context",
});
// A row from the folder listing: `path` is folder-relative, the way the gateway
// walks it.
const inFolder = (dir: string, rel: string): OutputFile => ({
  path: rel, abs: dir + "/" + rel, size: 1,
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

  test("a file only the folder listing found is listed, marked as the weaker claim", () => {
    // The case that has no other route into the panel at all: a shell wrote it
    // (so no tool call names it) outside the checkout (so git can't see it).
    const out = mergePanelFiles([], [], [inFolder("/tmp/icons", "generated.html")]);
    expect(out).toEqual([{
      abs: "/tmp/icons/generated.html", label: "generated.html",
      fromThread: false, inWrittenFolder: true,
    }]);
  });

  test("the folder listing never overrides what the thread or git already said", () => {
    // Both know this file; "it is in a folder this conversation wrote to" is the
    // weakest of the three claims and must not replace either of the others.
    const out = mergePanelFiles(
      [wrote("/tmp/icons/mockup.html")],
      [dirty({ path: "src/a.ts", abs: "/repo/src/a.ts" })],
      [inFolder("/tmp/icons", "mockup.html"), inFolder("/repo", "src/a.ts")],
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ abs: "/tmp/icons/mockup.html", fromThread: true });
    expect(out[0].inWrittenFolder).toBeUndefined();
    expect(out[1]).toMatchObject({ abs: "/repo/src/a.ts", fromThread: false });
    expect(out[1].inWrittenFolder).toBeUndefined();
  });

  test("the three sources keep their order: thread, then git, then folders", () => {
    const out = mergePanelFiles(
      [wrote("/tmp/icons/mockup.html")],
      [dirty({ path: "src/a.ts", abs: "/repo/src/a.ts" })],
      [inFolder("/tmp/icons", "png/shot.png")],
    );
    expect(out.map((f) => f.label)).toEqual(["mockup.html", "a.ts", "shot.png"]);
  });

  test("a folder row's label is the filename, not the path the walk reported", () => {
    const out = mergePanelFiles([], [], [inFolder("/tmp/icons", "png/shot.png")]);
    expect(out[0].label).toBe("shot.png");
    expect(out[0].abs).toBe("/tmp/icons/png/shot.png");
  });
});

describe("outputFolderCandidates", () => {
  test("the folders of files the conversation wrote, newest first, deduped", () => {
    expect(outputFolderCandidates([
      wrote("/tmp/icons/mockup.html"),
      wrote("/tmp/icons/concept.svg"),
      wrote("/repo/src/a.ts"),
    ])).toEqual(["/tmp/icons", "/repo/src"]);
  });

  test("a bare filename names no folder — cwd itself is never an output folder", () => {
    expect(outputFolderCandidates([wrote("notes.md")])).toEqual([]);
  });

  test("capped, because the gateway caps too and refusing costs both sides", () => {
    const many = Array.from({ length: MAX_OUTPUT_FOLDER_CANDIDATES + 5 },
      (_, i) => wrote("/tmp/d" + i + "/f.txt"));
    expect(outputFolderCandidates(many)).toHaveLength(MAX_OUTPUT_FOLDER_CANDIDATES);
  });

  test("takes only what the caller passed — a folder merely read is not one written to", () => {
    // The caller filters by role; this documents that nothing here re-derives it,
    // so passing context files in would list the project the agent was reading.
    expect(outputFolderCandidates([read("/repo/src/a.ts")].filter((f) => f.role === "output"))).toEqual([]);
  });
});

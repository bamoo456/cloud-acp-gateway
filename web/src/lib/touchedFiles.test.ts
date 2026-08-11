import { describe, expect, test } from "vitest";
import { touchedFiles, toLocalPath } from "./touchedFiles.ts";
import type { ThreadItem } from "../types.ts";

function tool(id: string, locations: string[], content: ThreadItem extends never ? never : any[] = [], toolKind = "edit"): ThreadItem {
  return { id, kind: "tool", toolCallId: id, title: "Edit", toolKind, status: "completed", locations, content };
}

describe("toLocalPath", () => {
  test("unwraps a file:// URI, including percent-escaped spaces", () => {
    expect(toLocalPath("file:///repo/src/a.ts")).toBe("/repo/src/a.ts");
    expect(toLocalPath("file:///repo/my%20notes.md")).toBe("/repo/my notes.md");
  });

  test("passes plain paths through, absolute or relative", () => {
    expect(toLocalPath("/repo/src/a.ts")).toBe("/repo/src/a.ts");
    expect(toLocalPath("src/a.ts")).toBe("src/a.ts");
  });

  test("rejects remote URIs and empty values — there is no local file to open", () => {
    expect(toLocalPath("https://example.com/a.ts")).toBeNull();
    expect(toLocalPath("")).toBeNull();
    expect(toLocalPath("   ")).toBeNull();
  });
});

describe("touchedFiles", () => {
  test("collects tool locations and diff paths, most recent first", () => {
    const items: ThreadItem[] = [
      tool("t1", ["/repo/src/a.ts"]),
      tool("t2", [], [{ type: "diff", path: "/repo/src/b.ts", oldText: "x", newText: "y" }]),
      { id: "m1", kind: "assistant", text: "done" },
    ];
    expect(touchedFiles(items).map((f) => f.path)).toEqual(["/repo/src/b.ts", "/repo/src/a.ts"]);
  });

  test("labels each row with the trailing path segment", () => {
    expect(touchedFiles([tool("t1", ["/repo/web/src/App.tsx"])])[0].label).toBe("App.tsx");
  });

  test("a file touched twice sorts with its latest mention, listed once", () => {
    const items: ThreadItem[] = [
      tool("t1", ["/repo/a.ts"]),
      tool("t2", ["/repo/b.ts"]),
      tool("t3", ["/repo/a.ts"]),
    ];
    expect(touchedFiles(items).map((f) => f.path)).toEqual(["/repo/a.ts", "/repo/b.ts"]);
  });

  test("skips remote URIs and non-tool items", () => {
    const items: ThreadItem[] = [
      { id: "u1", kind: "user", text: "check https://example.com" },
      tool("t1", ["https://example.com/x.ts", "file:///repo/ok.ts"]),
    ];
    expect(touchedFiles(items).map((f) => f.path)).toEqual(["/repo/ok.ts"]);
  });

  test("splits what the agent wrote from what it only consulted", () => {
    const items: ThreadItem[] = [
      tool("t1", ["/repo/read.ts"], [], "read"),
      tool("t2", ["/repo/found.ts"], [], "search"),
      tool("t3", ["/repo/gone.ts"], [], "delete"),
      tool("t4", ["/repo/written.ts"], [], "edit"),
    ];
    expect(touchedFiles(items).map((f) => [f.label, f.role])).toEqual([
      ["written.ts", "output"],
      ["gone.ts", "output"],
      ["found.ts", "context"],
      ["read.ts", "context"],
    ]);
  });

  test("a file read and later edited is an output, not context", () => {
    const items: ThreadItem[] = [
      tool("t1", ["/repo/a.ts"], [], "read"),
      tool("t2", ["/repo/a.ts"], [], "edit"),
    ];
    expect(touchedFiles(items).map((f) => f.role)).toEqual(["output"]);
  });

  test("an edit re-read afterwards stays an output", () => {
    const items: ThreadItem[] = [
      tool("t1", ["/repo/a.ts"], [], "edit"),
      tool("t2", ["/repo/a.ts"], [], "read"),
    ];
    expect(touchedFiles(items).map((f) => f.role)).toEqual(["output"]);
  });

  test("a diff block makes the file an output whatever the tool kind claims", () => {
    const items: ThreadItem[] = [
      tool("t1", [], [{ type: "diff", path: "/repo/b.ts", oldText: "x", newText: "y" }], "other"),
    ];
    expect(touchedFiles(items).map((f) => f.role)).toEqual(["output"]);
  });

  test("a shell call contributes nothing — it names a command, not a file", () => {
    expect(touchedFiles([tool("t1", [], [], "execute")])).toEqual([]);
  });
});

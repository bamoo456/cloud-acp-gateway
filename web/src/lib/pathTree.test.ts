import { describe, expect, test } from "vitest";
import { buildPathTree, type PathTreeNode } from "./pathTree.ts";

const tree = (paths: string[]) => buildPathTree(paths, (p) => p);

// "dir/ [children]" for a folder, "name" for a file — the shape of the list,
// without the item payloads.
function shape<T>(nodes: PathTreeNode<T>[]): string[] {
  return nodes.map((n) => (n.dir ? n.name + "/ [" + shape(n.children).join(" ") + "]" : n.name));
}

describe("buildPathTree", () => {
  test("folders come before files, each side alphabetical", () => {
    expect(shape(tree(["z.ts", "src/b.ts", "a.ts", "src/a.ts", "lib/x.ts"])))
      .toEqual(["lib/ [x.ts]", "src/ [a.ts b.ts]", "a.ts", "z.ts"]);
  });

  test("a chain of single-child folders is one row", () => {
    // The click that reveals nothing: web, then src, then components.
    expect(shape(tree(["web/src/components/App.tsx"])))
      .toEqual(["web/src/components/ [App.tsx]"]);
  });

  test("the chain stops where the folder has something of its own to show", () => {
    expect(shape(tree(["web/src/lib/a.ts", "web/src/components/b.tsx"])))
      .toEqual(["web/src/ [components/ [b.tsx] lib/ [a.ts]]"]);
    // "web" still folds into "src" — it is "src" that has a file beside its
    // only subfolder, and that is where the chain stops.
    expect(shape(tree(["web/src/a.ts", "web/src/lib/b.ts"])))
      .toEqual(["web/src/ [lib/ [b.ts] a.ts]"]);
  });

  test("an absolute path keeps its leading slash, so /tmp is not a repo folder", () => {
    const nodes = tree(["/tmp/icons/out.html", "src/a.ts"]);
    expect(shape(nodes)).toEqual(["/tmp/icons/ [out.html]", "src/ [a.ts]"]);
    expect(nodes[0].path).toBe("/tmp/icons");
  });

  test("a file node carries its own item and full path", () => {
    const items = [{ path: "src/a.ts", n: 1 }];
    const nodes = buildPathTree(items, (i) => i.path);
    const dir = nodes[0];
    if (!dir.dir) throw new Error("expected a folder");
    expect(dir.children[0]).toMatchObject({ dir: false, name: "a.ts", path: "src/a.ts", item: items[0] });
  });

  test("an empty list, and a path that is nothing but slashes, produce no rows", () => {
    expect(tree([])).toEqual([]);
    expect(tree(["/"])).toEqual([]);
  });
});

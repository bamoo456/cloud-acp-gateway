import { describe, expect, test } from "vitest";
import { fileKind, fileKindLabel } from "./fileKind.ts";

describe("fileKind", () => {
  test("names the language behind a code file", () => {
    expect(fileKindLabel("report.sql")).toBe("Code · SQL");
    expect(fileKindLabel("src/store/store.ts")).toBe("Code · TypeScript");
    expect(fileKindLabel("/repo/run.sh")).toBe("Code · Shell");
  });

  test("groups data, docs and images by what they are", () => {
    expect(fileKindLabel("agents.json")).toBe("Data · JSON");
    expect(fileKindLabel("README.md")).toBe("Doc · Markdown");
    expect(fileKindLabel("shot.PNG")).toBe("Image · PNG");
    expect(fileKindLabel("bundle.tgz")).toBe("Archive · TAR");
  });

  test("an unknown extension is still shown rather than flattened away", () => {
    expect(fileKindLabel("build/out.wasm")).toBe("File · WASM");
  });

  test("a file with no extension gets no invented language", () => {
    expect(fileKindLabel("LICENSE")).toBe("File");
    expect(fileKind("LICENSE").language).toBeUndefined();
  });

  test("a dotfile's name is its type, not an empty extension", () => {
    expect(fileKindLabel(".env")).toBe("Data · ENV");
    expect(fileKindLabel("deploy/Dockerfile")).toBe("Code · Docker");
  });

  test("the icon follows the category", () => {
    expect(fileKind("a.sql").icon).toBe("code");
    expect(fileKind("a.png").icon).toBe("image");
    expect(fileKind("a.json").icon).toBe("data");
    expect(fileKind("a.md").icon).toBe("doc");
    expect(fileKind("a.zip").icon).toBe("archive");
    expect(fileKind("a.unknown").icon).toBe("file");
    expect(fileKind("notes.txt").icon).toBe("file");
  });
});

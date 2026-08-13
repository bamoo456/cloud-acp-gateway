import { describe, expect, test } from "vitest";
import { folderKey, folderLabel } from "./folderKey.ts";

// The strings below are the ones the four merged sources actually produce:
// the gateway's own cwd, a recents-cache row (a snapshot taken on whatever
// device recorded it), a /history/discovered row read out of a CLI transcript,
// and the folder picker. Grouping by the raw cwd splits one folder into
// several groups — that is risk §4.1, and this is the function that closes it.
const HOME = "/Users/dev";

describe("folderKey", () => {
  test("the same folder spelled four ways is one key", () => {
    const spellings = [
      "/Users/dev/git/my-apps/cloud-acp-gateway",   // gateway cwd
      "/Users/dev/git/my-apps/cloud-acp-gateway/",  // recents row, trailing slash
      "~/git/my-apps/cloud-acp-gateway",            // discovered row, tilde
      "/Users/dev/git/my-apps//cloud-acp-gateway",  // doubled separator
      "/Users/dev/git/my-apps/./cloud-acp-gateway", // "." segment
      "/Users/dev/git/other/../my-apps/cloud-acp-gateway", // ".." segment
      "$HOME/git/my-apps/cloud-acp-gateway",        // shell-style home
      "/Users/dev/git/my-apps/Cloud-ACP-Gateway",   // case drift (macOS)
    ];

    expect(new Set(spellings.map((p) => folderKey(p, HOME))).size).toBe(1);
  });

  test("different folders stay different", () => {
    expect(folderKey("/Users/dev/a", HOME)).not.toBe(folderKey("/Users/dev/b", HOME));
    // A prefix is not the same folder as what it is a prefix of.
    expect(folderKey("/Users/dev/app", HOME)).not.toBe(folderKey("/Users/dev/app2", HOME));
  });

  test("a relative path keeps its leading .. rather than collapsing", () => {
    expect(folderKey("../a")).not.toBe(folderKey("a"));
    expect(folderKey("../a")).toBe("../a");
  });

  test("root and empties are handled rather than producing junk keys", () => {
    expect(folderKey("/")).toBe("/");
    expect(folderKey("/..")).toBe("/");
    expect(folderKey("")).toBe("");
    expect(folderKey(null)).toBe("");
    expect(folderKey(undefined)).toBe("");
  });

  test("without a known home, a tilde path is left alone rather than mangled", () => {
    // No home to expand against: keep it distinct instead of silently claiming
    // it is the filesystem root.
    expect(folderKey("~/git/repo")).toBe("~/git/repo");
  });
});

describe("folderLabel", () => {
  test("names the folder as it is actually spelled, not as it is keyed", () => {
    expect(folderLabel("/Users/dev/git/my-apps/Cloud-ACP-Gateway")).toBe("Cloud-ACP-Gateway");
    expect(folderLabel("/Users/dev/git/repo/")).toBe("repo");
    expect(folderLabel("~/git/repo")).toBe("repo");
    expect(folderLabel("/")).toBe("/");
    expect(folderLabel("")).toBe("");
  });
});

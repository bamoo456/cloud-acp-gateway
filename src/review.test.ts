import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readDraft, readDrafts, writeDraft, parseComments, reviewScopeKey,
  REVIEW_DIR, MAX_COMMENTS, MAX_COMMENT_BYTES, DRAFT_TTL_MS,
} from "./review.ts";

function tmpRepo(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acpg-rv-")));
}

const comment = (over: Partial<Parameters<typeof writeDraft>[2][number]> = {}) => ({
  path: "src/a.ts", side: "new" as const, line: 12, code: "+ const x = 1;", body: "leaks", ...over,
});

describe("reviewScopeKey", () => {
  test("names the three scopes distinctly", () => {
    assert.equal(reviewScopeKey(null), "working");
    assert.equal(reviewScopeKey({ commit: "abc123" }), "commit:abc123");
    assert.equal(reviewScopeKey({ base: "origin/main" }), "branch:origin/main");
  });

  test("a ref with a slash is a key, not a path — no escaping needed", () => {
    // The whole reason drafts live in ONE json file: `origin/feat/x` as a
    // filename would need escaping, and as an object key needs none.
    assert.equal(reviewScopeKey({ base: "origin/feat/x" }), "branch:origin/feat/x");
  });
});

describe("writeDraft / readDraft", () => {
  test("a saved comment comes back", () => {
    const repo = tmpRepo();
    assert.equal(writeDraft(repo, "working", [comment()]), true);
    assert.deepEqual(readDraft(repo, "working"), [comment()]);
  });

  test("the draft directory ignores itself, so git never reports it", () => {
    const repo = tmpRepo();
    writeDraft(repo, "working", [comment()]);
    // A directory whose every entry is ignored is itself absent from
    // `git status --untracked-files=all` — which is the point: the draft must
    // not appear in the list of changes it is commenting on.
    assert.equal(fs.readFileSync(path.join(repo, REVIEW_DIR, ".gitignore"), "utf8"), "*\n");
  });

  test("scopes don't clobber each other", () => {
    const repo = tmpRepo();
    writeDraft(repo, "working", [comment({ body: "on the worktree" })]);
    writeDraft(repo, "commit:abc", [comment({ body: "on a commit" })]);
    assert.equal(readDraft(repo, "working")[0].body, "on the worktree");
    assert.equal(readDraft(repo, "commit:abc")[0].body, "on a commit");
  });

  test("an empty list deletes the scope rather than storing an empty draft", () => {
    const repo = tmpRepo();
    writeDraft(repo, "working", [comment()]);
    writeDraft(repo, "working", []);
    assert.deepEqual(readDrafts(repo), {});
  });

  test("a stale draft is invisible and dropped on the next write", () => {
    const repo = tmpRepo();
    const old = Date.now() - DRAFT_TTL_MS - 1000;
    writeDraft(repo, "commit:old", [comment()], old);
    assert.deepEqual(readDrafts(repo), {}, "stale scope should not be read back");
    writeDraft(repo, "working", [comment()]);
    const raw = JSON.parse(fs.readFileSync(path.join(repo, REVIEW_DIR, "drafts.json"), "utf8"));
    assert.deepEqual(Object.keys(raw.scopes), ["working"], "stale scope should be pruned");
  });

  test("a symlinked .acp-review is refused, not written through", () => {
    // A checkout is untrusted input. Without the lstat, a committed
    // `.acp-review -> /elsewhere` would redirect this write out of the repo.
    const repo = tmpRepo();
    const elsewhere = tmpRepo();
    fs.symlinkSync(elsewhere, path.join(repo, REVIEW_DIR));
    assert.equal(writeDraft(repo, "working", [comment()]), false);
    assert.deepEqual(fs.readdirSync(elsewhere), [], "nothing should have been written through the link");
  });

  test("a corrupt drafts.json reads as no drafts and is replaced by the next write", () => {
    const repo = tmpRepo();
    fs.mkdirSync(path.join(repo, REVIEW_DIR));
    fs.writeFileSync(path.join(repo, REVIEW_DIR, "drafts.json"), "{not json");
    assert.deepEqual(readDrafts(repo), {});
    assert.equal(writeDraft(repo, "working", [comment()]), true);
    assert.equal(readDraft(repo, "working").length, 1);
  });

  test("counts are per scope, for the tab badge", () => {
    const repo = tmpRepo();
    writeDraft(repo, "working", [comment(), comment({ line: 20 })]);
    writeDraft(repo, "branch:origin/main", [comment({ line: 5 })]);
    const counts = Object.fromEntries(
      Object.entries(readDrafts(repo)).map(([k, d]) => [k, d.comments.length]),
    );
    assert.deepEqual(counts, { "working": 2, "branch:origin/main": 1 });
  });
});

describe("parseComments", () => {
  test("accepts the shape the panel sends, including a range anchor", () => {
    const input = [{ path: "src/a.ts", side: "old", line: 4, endLine: 9, code: "- x", body: "why?", id: "c1" }];
    assert.deepEqual(parseComments(input), input);
  });

  test("drops an absent code field to an empty string rather than refusing", () => {
    // A comment on a line the client couldn't quote is still a comment.
    assert.equal(parseComments([{ path: "a.ts", side: "new", line: 1, body: "hm" }])?.[0].code, "");
  });

  test("refuses everything malformed", () => {
    const bad: unknown[] = [
      "not an array",
      [{ path: "", side: "new", line: 1, body: "x" }],                    // no path
      [{ path: "a.ts", side: "both", line: 1, body: "x" }],               // not a side
      [{ path: "a.ts", side: "new", line: 0, body: "x" }],                // lines are 1-based
      [{ path: "a.ts", side: "new", line: 1.5, body: "x" }],              // not an integer
      [{ path: "a.ts", side: "new", line: 1, body: "   " }],              // whitespace only
      [{ path: "a.ts", side: "new", line: 9, endLine: 4, body: "x" }],    // range runs backwards
      [{ path: "a.ts", side: "new", line: 1, body: "x", id: "x".repeat(65) }],
      [{ path: "a.ts", side: "new", line: 1, body: "x".repeat(MAX_COMMENT_BYTES + 1) }],
      Array.from({ length: MAX_COMMENTS + 1 }, () => comment()),
    ];
    for (const input of bad) assert.equal(parseComments(input), null, JSON.stringify(input).slice(0, 60));
  });

  test("a multi-byte body is capped in bytes, not characters", () => {
    // 8192 CJK characters is 24KB on the wire; the cap exists to bound what
    // reaches the disk and the prompt, so it has to count what is sent.
    const body = "字".repeat(MAX_COMMENT_BYTES);
    assert.equal(parseComments([{ path: "a.ts", side: "new", line: 1, body }]), null);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeLimits, parseCredential, normalizeCodexLimits, parseCodexCredential, readCredential } from "./usage-limits.ts";

const AT = 1_700_000_000_000;

describe("normalizeLimits", () => {
  it("reads utilization as a percent, not a fraction", () => {
    // The whole feature hinges on this. The OAuth endpoint sends 12.5 to mean
    // 12.5%, while the ACP rate_limit_info field of the same name sends 0.125.
    // CodexBar's decoder test pins this shape.
    const out = normalizeLimits({
      five_hour: { utilization: 12.5, resets_at: "2025-12-25T12:00:00.000Z" },
      seven_day: { utilization: 30, resets_at: "2025-12-31T00:00:00.000Z" },
    }, AT);
    assert.equal(out.status, "ok");
    assert.ok(out.status === "ok");
    assert.equal(out.windows.five_hour.utilization, 0.125);
    assert.equal(out.windows.seven_day.utilization, 0.3);
  });

  it("converts resets_at to Unix seconds", () => {
    const out = normalizeLimits({ five_hour: { utilization: 1, resets_at: "2025-12-25T12:00:00.000Z" } }, AT);
    assert.ok(out.status === "ok");
    assert.equal(out.windows.five_hour.resetsAt, Date.parse("2025-12-25T12:00:00.000Z") / 1000);
  });

  it("drops a window the account doesn't have instead of calling it 0%", () => {
    // This endpoint answers `{}` or `null` for a window that doesn't apply — showing
    // as a full-width 0% bar would claim a quota the user doesn't have.
    const out = normalizeLimits({
      five_hour: { utilization: 4 },
      seven_day_opus: {},
      seven_day_sonnet: null,
    }, AT);
    assert.ok(out.status === "ok");
    assert.deepEqual(Object.keys(out.windows), ["five_hour"]);
  });

  it("takes model-scoped weekly caps from limits[], labelled by the model", () => {
    // The newer shape, and the only source for a per-model segment on a current
    // account — the flat seven_day_opus/sonnet fields come back empty.
    const out = normalizeLimits({
      five_hour: { utilization: 10 },
      limits: [
        { kind: "weekly_scoped", group: "weekly", percent: 10, resets_at: "2025-12-31T00:00:00.000Z",
          scope: { model: { id: "fable-1", display_name: "Fable" } }, is_active: true },
        { kind: "weekly", group: "weekly", percent: 55 },
      ],
    }, AT);
    assert.ok(out.status === "ok");
    assert.deepEqual(out.windows["weekly_scoped:Fable"], {
      utilization: 0.1,
      resetsAt: Date.parse("2025-12-31T00:00:00.000Z") / 1000,
      label: "Fable",
    });
    assert.deepEqual(Object.keys(out.windows).sort(), ["five_hour", "weekly_scoped:Fable"]);
  });

  it("keeps an inactive scoped limit, and skips one that names no model", () => {
    // `is_active` marks the window currently binding, not the ones that apply:
    // a live response has the session entry active at 41% while `weekly_all`
    // reads false next to a flat `seven_day` of a real 15%. Skipping inactive
    // entries hid the Fable cap entirely, which is why it isn't a filter.
    const out = normalizeLimits({
      limits: [
        { kind: "weekly_scoped", percent: 27, scope: { model: { id: null, display_name: "Fable" } }, is_active: false },
        { kind: "weekly_scoped", percent: 20 },
      ],
    }, AT);
    assert.ok(out.status === "ok");
    assert.deepEqual(out.windows, { "weekly_scoped:Fable": { utilization: 0.27, resetsAt: undefined, label: "Fable" } });
  });

  it("clamps out-of-range percentages", () => {
    const out = normalizeLimits({ five_hour: { utilization: 140 }, seven_day: { utilization: -3 } }, AT);
    assert.ok(out.status === "ok");
    assert.equal(out.windows.five_hour.utilization, 1);
    assert.equal(out.windows.seven_day.utilization, 0);
  });

  it("a non-object body is unavailable, not an empty set of windows", () => {
    assert.deepEqual(normalizeLimits(null, AT), { status: "unavailable", reason: "http-error" });
  });
});

describe("parseCredential", () => {
  it("reads the access token out of claudeAiOauth", () => {
    const out = parseCredential(JSON.stringify({
      claudeAiOauth: { accessToken: "tok", expiresAt: Date.now() + 3_600_000 },
    }));
    assert.deepEqual(out, { accessToken: "tok", expiresAt: (out as { expiresAt: number }).expiresAt });
  });

  it("an MCP-only credential is a re-auth, not something to retry", () => {
    // Claude Code 2.1.x can leave the item holding only MCP server OAuth state.
    // Treating it as expiry is what drives a background refresh loop — and
    // Claude Code's own repair path can launch a browser from a daemon.
    assert.equal(parseCredential(JSON.stringify({ mcpOAuth: { some: "state" } })), "reauth");
  });

  it("an expired token fails closed", () => {
    assert.equal(
      parseCredential(JSON.stringify({ claudeAiOauth: { accessToken: "tok", expiresAt: Date.now() - 1000 } })),
      "expired",
    );
  });

  it("a credential with no token at all is a re-auth", () => {
    assert.equal(parseCredential(JSON.stringify({ claudeAiOauth: { refreshToken: "r" } })), "reauth");
  });

  it("unparseable content is simply no credential", () => {
    assert.equal(parseCredential("not json"), "no-credential");
  });
});

describe("readCredential", () => {
  // Writes ~/.claude/.credentials.json into a throwaway dir and returns the dir.
  function claudeDir(oauth: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-cred-"));
    fs.writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: oauth }));
    return dir;
  }
  const live = { accessToken: "live", expiresAt: Date.now() + 3_600_000 };
  const stale = { accessToken: "stale", expiresAt: Date.now() - 1_000 };

  it("prefers the file, and never touches the keychain while it is live", () => {
    let asked = false;
    const out = readCredential(claudeDir(live), () => { asked = true; return "no-credential"; });
    assert.deepEqual(out, live);
    assert.equal(asked, false, "a live file must not provoke a Keychain ACL prompt");
  });

  // The bug this test exists for: Claude Code writes the keychain and can leave
  // the file behind at an older expiry. A stale file that short-circuits here
  // shadows a live keychain entry, and the quota reads "expired" forever.
  it("falls back to the keychain when the file is stale", () => {
    assert.deepEqual(readCredential(claudeDir(stale), () => live), live);
  });

  it("keeps the file's reason when the keychain is no help either", () => {
    assert.equal(readCredential(claudeDir(stale), () => "no-credential"), "expired");
  });

  it("reports the keychain's own reason when there is no file", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-cred-"));
    assert.equal(readCredential(empty, () => "reauth"), "reauth");
  });
});

describe("normalizeCodexLimits", () => {
  it("maps the 5h and weekly window_seconds to Claude's own keys", () => {
    const out = normalizeCodexLimits({
      rate_limit: {
        primary_window: { used_percent: 12.5, reset_at: 1_700_003_600, limit_window_seconds: 18000 },
        secondary_window: { used_percent: 30, reset_at: 1_700_600_000, limit_window_seconds: 604800 },
      },
    }, AT);
    assert.ok(out.status === "ok");
    assert.deepEqual(out.windows.five_hour, { utilization: 0.125, resetsAt: 1_700_003_600 });
    assert.deepEqual(out.windows.seven_day, { utilization: 0.3, resetsAt: 1_700_600_000 });
  });

  it("primary/secondary are positional, not named — a swapped order still lands on the right key", () => {
    const out = normalizeCodexLimits({
      rate_limit: {
        primary_window: { used_percent: 30, limit_window_seconds: 604800 },
        secondary_window: { used_percent: 12.5, limit_window_seconds: 18000 },
      },
    }, AT);
    assert.ok(out.status === "ok");
    assert.equal(out.windows.five_hour.utilization, 0.125);
    assert.equal(out.windows.seven_day.utilization, 0.3);
  });

  it("drops a window whose duration isn't one this gateway aligns to Claude's", () => {
    const out = normalizeCodexLimits({
      rate_limit: { primary_window: { used_percent: 50, limit_window_seconds: 86400 } },
    }, AT);
    assert.ok(out.status === "ok");
    assert.deepEqual(out.windows, {});
  });

  it("a non-object body is unavailable, not an empty set of windows", () => {
    assert.deepEqual(normalizeCodexLimits(null, AT), { status: "unavailable", reason: "http-error" });
  });

  it("a Business/enterprise seat with no rate_limit is flagged unlimited", () => {
    // The real shape seen from a business-plan ChatGPT account: rate_limit is
    // null outright, and credits.unlimited is the one fact worth surfacing.
    const out = normalizeCodexLimits({
      rate_limit: null,
      credits: { has_credits: true, unlimited: true },
    }, AT);
    assert.ok(out.status === "ok");
    assert.deepEqual(out.windows, {});
    assert.equal(out.unlimited, true);
  });

  it("a metered account with real windows is not marked unlimited", () => {
    const out = normalizeCodexLimits({
      rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } },
      credits: { has_credits: true, unlimited: false },
    }, AT);
    assert.ok(out.status === "ok");
    assert.equal(out.unlimited, undefined);
  });
});

describe("parseCodexCredential", () => {
  it("reads the access token and account id out of tokens", () => {
    assert.deepEqual(
      parseCodexCredential(JSON.stringify({ tokens: { access_token: "tok", account_id: "acc" } })),
      { accessToken: "tok", accountId: "acc" },
    );
  });

  it("a credential with no access token is a re-auth", () => {
    assert.equal(parseCodexCredential(JSON.stringify({ tokens: { refresh_token: "r" } })), "reauth");
  });

  it("unparseable content is simply no credential", () => {
    assert.equal(parseCodexCredential("not json"), "no-credential");
  });
});

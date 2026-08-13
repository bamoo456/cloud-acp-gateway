import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeLimits, parseCredential } from "./usage-limits.ts";

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
    // This endpoint answers `{}` for a window that doesn't apply — showing that
    // as a full-width 0% bar would claim a quota the user doesn't have.
    const out = normalizeLimits({
      five_hour: { utilization: 4 },
      seven_day_opus: {},
      seven_day_sonnet: {},
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

  it("skips an inactive scoped limit and one that names no model", () => {
    const out = normalizeLimits({
      limits: [
        { kind: "weekly_scoped", percent: 10, scope: { model: { display_name: "Fable" } }, is_active: false },
        { kind: "weekly_scoped", percent: 20 },
      ],
    }, AT);
    assert.ok(out.status === "ok");
    assert.deepEqual(out.windows, {});
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

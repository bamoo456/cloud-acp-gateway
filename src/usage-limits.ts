// Live Claude subscription quota (5h / weekly windows), read from the same OAuth
// endpoint Claude Code's own usage display uses.
//
// Why not ACP: the adapter only forwards rate limits attached to a usage_update
// after a turn has produced tokens, and the one real event captured on this
// gateway carried no `utilization` at all. A gauge fed from ACP is therefore
// blank until you prompt, and usually blank afterwards too. This path is
// independent of any session.
//
// The access token is read locally and never leaves the gateway: only the
// normalized windows below are serialized to a client.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const BETA_HEADER = "oauth-2025-04-20";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
// Matches the cadence Claude Code's own statusline refreshes at. One fetch per
// window feeds every attached device, however many are polling.
const TTL_MS = 300_000;

// A window as a client consumes it. `utilization` is a 0..1 fraction and
// `resetsAt` Unix seconds — deliberately the shape the ACP rate-limit path
// already produces, so the UI has one thing to render either way.
export interface UsageWindow {
  utilization: number;
  resetsAt?: number;
  // Set only for a model-scoped weekly window, whose name the endpoint supplies
  // (e.g. "Fable"). The fixed windows are labelled by the client.
  label?: string;
}

export type UsageLimits =
  | { status: "ok"; windows: Record<string, UsageWindow>; fetchedAt: number; unlimited?: boolean }
  | { status: "unavailable"; reason: UnavailableReason };

// `reauth` covers every "the credential can't authorize this" case, including
// Claude Code 2.1.x writing a keychain item that holds only MCP OAuth state.
export type UnavailableReason = "no-credential" | "reauth" | "expired" | "rate-limited" | "http-error" | "network";

interface Credential { accessToken: string; expiresAt?: number }

// The endpoint reports `utilization` as a PERCENT (0-100): CodexBar's decoder
// test pins `"utilization": 12.5` to 12.5%. Note this is the opposite scale from
// the ACP `rate_limit_info.utilization`, which is a 0..1 fraction the Claude CLI
// multiplies by 100 — same field name, different scale, and getting it backwards
// renders 13% as either 1300% or 0.13%.
function fraction(percent: unknown): number | null {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
  return Math.min(1, Math.max(0, percent / 100));
}

// `resets_at` is an ISO-8601 instant; the UI counts down from Unix seconds.
function resetSeconds(isoOrEpoch: unknown): number | undefined {
  if (typeof isoOrEpoch === "number") return isoOrEpoch > 1e11 ? Math.round(isoOrEpoch / 1000) : isoOrEpoch;
  if (typeof isoOrEpoch !== "string" || !isoOrEpoch.trim()) return undefined;
  const ms = Date.parse(isoOrEpoch);
  return Number.isNaN(ms) ? undefined : Math.round(ms / 1000);
}

// Windows the endpoint still reports as flat top-level fields. Model-scoped
// weekly caps have moved into `limits[]`, but older accounts keep answering here.
const FLAT_WINDOWS = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"] as const;

export function normalizeLimits(body: unknown, fetchedAt: number): UsageLimits {
  const root = body as Record<string, unknown> | null;
  const windows: Record<string, UsageWindow> = {};
  if (!root || typeof root !== "object") return { status: "unavailable", reason: "http-error" };

  for (const key of FLAT_WINDOWS) {
    const w = root[key] as Record<string, unknown> | undefined;
    const util = fraction(w?.utilization);
    // An empty object is what this endpoint returns for a window that doesn't
    // apply to the account (or has moved into `limits[]`). Unknown, not zero.
    if (util === null) continue;
    windows[key] = { utilization: util, resetsAt: resetSeconds(w?.resets_at) };
  }

  // The newer shape: a flat list in which a weekly cap can name the model it
  // scopes to. This is where a promotional per-model window shows up, so it is
  // the only source for that segment on a current account.
  const limits = Array.isArray(root.limits) ? root.limits : [];
  for (const entry of limits as Array<Record<string, unknown>>) {
    if (entry?.kind !== "weekly_scoped" || entry.is_active === false) continue;
    const util = fraction(entry.percent);
    if (util === null) continue;
    const model = (entry.scope as { model?: { id?: string; display_name?: string } } | undefined)?.model;
    const label = model?.display_name || model?.id;
    if (!label) continue;
    windows[`weekly_scoped:${label}`] = { utilization: util, resetsAt: resetSeconds(entry.resets_at), label };
  }

  return { status: "ok", windows, fetchedAt };
}

// Claude Code's credential file, and the shape it degrades to. Exported for the
// tests because every branch here is a silent-failure risk.
export function parseCredential(raw: string): Credential | UnavailableReason {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return "no-credential";
  }
  const oauth = (json.claudeAiOauth ?? null) as Record<string, unknown> | null;
  if (!oauth) {
    // Claude Code 2.1.x can write an item holding only MCP server OAuth state.
    // That is a configuration problem, not an expiry — retrying, or "repairing"
    // it by shelling out to the CLI, is what we must not do (see below).
    return "reauth";
  }
  const accessToken = oauth.accessToken;
  if (typeof accessToken !== "string" || !accessToken) return "reauth";
  const expiresAt = typeof oauth.expiresAt === "number" ? oauth.expiresAt : undefined;
  if (expiresAt !== undefined && expiresAt <= Date.now()) return "expired";
  return { accessToken, expiresAt };
}

// File first, keychain second. The file needs no Keychain ACL, which matters
// because this process runs under launchd rather than in the user's terminal
// session.
//
// There is deliberately no refresh path. Claude Code's own recovery is to run
// `claude /status`, which from a background process can launch the user's
// default browser via /usr/bin/open (CodexBar issue #1844). A headless gateway
// must fail closed and let the user re-auth in their own terminal instead.
function readCredential(claudeDir: string): Credential | UnavailableReason {
  const file = path.join(claudeDir, ".credentials.json");
  if (fs.existsSync(file)) {
    try {
      return parseCredential(fs.readFileSync(file, "utf8"));
    } catch {
      // fall through to the keychain
    }
  }
  if (process.platform !== "darwin") return "no-credential";
  try {
    const raw = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", os.userInfo().username, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return parseCredential(raw);
  } catch {
    return "no-credential";
  }
}

let cache: { at: number; value: UsageLimits } | null = null;
let inFlight: Promise<UsageLimits> | null = null;

// Exported for tests: the module-level cache would otherwise leak between them.
export function resetUsageLimitsCache(): void {
  cache = null;
  inFlight = null;
  codexCache = null;
  codexInFlight = null;
}

async function fetchLimits(claudeDir: string, now: number): Promise<UsageLimits> {
  const credential = readCredential(claudeDir);
  if (typeof credential === "string") return { status: "unavailable", reason: credential };
  try {
    const res = await fetch(ENDPOINT, {
      headers: {
        authorization: `Bearer ${credential.accessToken}`,
        "anthropic-beta": BETA_HEADER,
        accept: "application/json",
        "user-agent": "acp-gateway",
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (res.status === 401 || res.status === 403) return { status: "unavailable", reason: "reauth" };
    if (res.status === 429) return { status: "unavailable", reason: "rate-limited" };
    if (!res.ok) return { status: "unavailable", reason: "http-error" };
    return normalizeLimits(await res.json(), now);
  } catch {
    return { status: "unavailable", reason: "network" };
  }
}

// TTL-cached and single-flight: several devices polling at once share one call,
// and an unavailable answer is cached too so a missing credential doesn't mean a
// request to Anthropic per poll per device.
export function usageLimits(
  opts: { claudeDir: string; now?: number },
): Promise<UsageLimits> {
  const now = opts.now ?? Date.now();
  if (cache && now - cache.at < TTL_MS) return Promise.resolve(cache.value);
  if (inFlight) return inFlight;
  inFlight = fetchLimits(opts.claudeDir, now)
    .then((value) => {
      cache = { at: now, value };
      return value;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

// Codex's counterpart, read from the same ChatGPT backend CodexBar's Codex
// provider uses. `auth.json` under $CODEX_HOME is a plain file (no Keychain
// fallback — the CLI never puts it there), holding `tokens.access_token`
// alongside an optional `tokens.account_id` the endpoint wants as a header.
const CODEX_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";

interface CodexCredential { accessToken: string; accountId?: string }

export function parseCodexCredential(raw: string): CodexCredential | UnavailableReason {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return "no-credential";
  }
  const tokens = json.tokens as Record<string, unknown> | undefined;
  const accessToken = tokens?.access_token;
  if (typeof accessToken !== "string" || !accessToken) return "reauth";
  const accountId = typeof tokens?.account_id === "string" ? tokens.account_id : undefined;
  return { accessToken, accountId };
}

function readCodexCredential(codexHome: string): CodexCredential | UnavailableReason {
  const file = path.join(codexHome, "auth.json");
  if (!fs.existsSync(file)) return "no-credential";
  try {
    return parseCodexCredential(fs.readFileSync(file, "utf8"));
  } catch {
    return "no-credential";
  }
}

// Only the two windows that carry the same meaning as Claude's `five_hour` /
// `seven_day`: the raw response names neither window, it only says how long
// it lasts (`limit_window_seconds`), and these are the two durations that
// line up. Everything else the endpoint reports — credits, spend controls,
// per-model `additional_rate_limits` — has no Claude-side equivalent to align
// to, so it's left unread for now.
const CODEX_WINDOW_KEY: Record<number, string> = { 18000: "five_hour", 604800: "seven_day" };

export function normalizeCodexLimits(body: unknown, fetchedAt: number): UsageLimits {
  const root = body as Record<string, unknown> | null;
  if (!root || typeof root !== "object") return { status: "unavailable", reason: "http-error" };
  const rateLimit = root.rate_limit as Record<string, unknown> | undefined;
  const windows: Record<string, UsageWindow> = {};
  for (const raw of [rateLimit?.primary_window, rateLimit?.secondary_window]) {
    const w = raw as Record<string, unknown> | undefined;
    const key = typeof w?.limit_window_seconds === "number" ? CODEX_WINDOW_KEY[w.limit_window_seconds] : undefined;
    if (!key) continue;
    const util = fraction(w?.used_percent);
    if (util === null) continue;
    windows[key] = { utilization: util, resetsAt: resetSeconds(w?.reset_at) };
  }
  // A Business/enterprise seat reports `rate_limit: null` — metered by credits
  // instead of a window, so there is nothing above to align. `unlimited` is the
  // one fact of that path this gateway surfaces; the credit balance and
  // spend-control detail stay unread.
  const credits = root.credits as Record<string, unknown> | undefined;
  const unlimited = credits?.unlimited === true || undefined;
  return { status: "ok", windows, fetchedAt, unlimited };
}

async function fetchCodexLimits(codexHome: string, now: number): Promise<UsageLimits> {
  const credential = readCodexCredential(codexHome);
  if (typeof credential === "string") return { status: "unavailable", reason: credential };
  try {
    const res = await fetch(CODEX_ENDPOINT, {
      headers: {
        authorization: `Bearer ${credential.accessToken}`,
        accept: "application/json",
        "user-agent": "acp-gateway",
        ...(credential.accountId ? { "chatgpt-account-id": credential.accountId } : {}),
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (res.status === 401 || res.status === 403) return { status: "unavailable", reason: "reauth" };
    if (res.status === 429) return { status: "unavailable", reason: "rate-limited" };
    if (!res.ok) return { status: "unavailable", reason: "http-error" };
    return normalizeCodexLimits(await res.json(), now);
  } catch {
    return { status: "unavailable", reason: "network" };
  }
}

let codexCache: { at: number; value: UsageLimits } | null = null;
let codexInFlight: Promise<UsageLimits> | null = null;

export function codexUsageLimits(
  opts: { codexHome: string; now?: number },
): Promise<UsageLimits> {
  const now = opts.now ?? Date.now();
  if (codexCache && now - codexCache.at < TTL_MS) return Promise.resolve(codexCache.value);
  if (codexInFlight) return codexInFlight;
  codexInFlight = fetchCodexLimits(opts.codexHome, now)
    .then((value) => {
      codexCache = { at: now, value };
      return value;
    })
    .finally(() => { codexInFlight = null; });
  return codexInFlight;
}

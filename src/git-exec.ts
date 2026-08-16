import { execFile, spawn } from "node:child_process";

// One `git status` on a cold cache in a large monorepo is seconds, not
// milliseconds, and the panel polls on demand — so cap the wait rather than
// letting a request pile up behind a slow filesystem.
export const GIT_TIMEOUT_MS = 10_000;
// Enough headroom for a big refactor's diff without letting a pathological one
// (a regenerated lockfile, a vendored blob) buffer unbounded in the gateway.
export const GIT_MAX_BUFFER = 16 * 1024 * 1024;

export interface GitResult { code: number; stdout: string; stderr: string; failed: boolean }

// One place that shells out to git, so every invocation shares the same
// hardening. Notably:
//   --no-optional-locks   never take the index lock — a status read must not
//                         race (or block) the agent's own git in the same repo
//   -c core.fsmonitor=    a repo-local config can name a *command* for git to
//                         run; this read is triggered by a browser, so it must
//                         not become a way to execute whatever the checkout
//                         says. Same reasoning for --no-ext-diff at call sites.
//   GIT_TERMINAL_PROMPT=0 never block waiting on a credential prompt nobody
//                         can answer from an HTTP handler
// Non-zero exits are returned, not thrown: `git diff --no-index` uses exit 1 to
// mean "there is a difference", which is the success case for us.
export function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["--no-optional-locks", "-c", "core.fsmonitor=", ...args],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        encoding: "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C" },
      },
      (err, stdout, stderr) => {
        // No git binary, timeout, or an over-maxBuffer read: `failed` tells the
        // caller this is "couldn't run", not "git said no".
        const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? -1 : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "", failed: !!err && code === -1 });
      },
    );
  });
}

// `git`, but with `input` written to the child's stdin. `check-ignore --stdin`
// is the one caller: asking about a whole directory's entries in one process
// beats spawning git per row, but the paths have to get in somehow, and a
// directory of a few hundred names would blow past the argv limit.
export function gitStdin(cwd: string, args: string[], input: string): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      ["--no-optional-locks", "-c", "core.fsmonitor=", ...args],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        encoding: "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C" },
      },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? -1 : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "", failed: !!err && code === -1 });
      },
    );
    // A git that exited before reading (no repo, bad flag) leaves a stdin nobody
    // is draining; the EPIPE that write raises is that, not a failure worth
    // reporting — the callback above still delivers the exit code.
    child.stdin?.on("error", () => { /* see above */ });
    child.stdin?.end(input);
  });
}

// `git`, but with stdout streamed and split on `sep` as it arrives instead of
// buffered whole. execFile's maxBuffer turns a big listing into a silent
// failure — a 147k-file monorepo's ls-files output already sits within 2% of
// the 16MB cap, and blowing it degrades find() to a worse walk without telling
// anyone. A stream has no such cliff; maxTokens is the explicit memory bound
// that replaces it, and hitting it kills the child and reports the cut.
// `sep` is NUL for the -z listings and "\n" for `grep -z -n`, whose records are
// lines (the NULs inside one separate the path and line number).
export function gitTokens(
  cwd: string,
  args: string[],
  maxTokens: number,
  sep = "\0",
): Promise<{ code: number; tokens: string[]; truncated: boolean; failed: boolean }> {
  return new Promise((resolve) => {
    const child = spawn("git", ["--no-optional-locks", "-c", "core.fsmonitor=", ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const tokens: string[] = [];
    let leftover = "";
    let truncated = false;
    let failed = false;
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The tail token has no trailing separator; -z output ends with one, so a
      // non-empty leftover only exists when the stream was cut mid-token.
      if (leftover && !truncated && tokens.length < maxTokens) tokens.push(leftover);
      resolve({ code, tokens, truncated, failed });
    };
    const timer = setTimeout(() => { failed = true; child.kill("SIGKILL"); }, GIT_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (truncated) return;
      const parts = (leftover + chunk).split(sep);
      leftover = parts.pop() ?? "";
      for (const t of parts) {
        if (!t) continue;
        if (tokens.length >= maxTokens) { truncated = true; child.kill("SIGKILL"); return; }
        tokens.push(t);
      }
    });
    // A failed spawn (no git binary) emits "error" and may never emit "close".
    child.on("error", () => { failed = true; finish(-1); });
    // A deliberate kill (cap / timeout) exits via signal with code null; that
    // is our doing, not git failing, so the cap case still reports code 0.
    child.on("close", (code) => finish(truncated ? 0 : code ?? -1));
  });
}

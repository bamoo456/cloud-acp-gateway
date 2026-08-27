import { describe, it, expect, vi, afterEach } from "vitest";
import { newTerminalId, sendTerminalInput, execCommand, shellContext, shellNote } from "./terminal.ts";

// The gateway rejects anything outside this (src/terminal.ts's ID_RE), so an id
// the browser can't produce is a terminal that can't open.
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

describe("newTerminalId", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses randomUUID when it is there", () => {
    expect(newTerminalId()).toMatch(ID_RE);
  });

  it("still yields a usable id without randomUUID", () => {
    // What a plain-HTTP LAN address gets: crypto exists, randomUUID does not,
    // because it is secure-context-only. Calling it would throw.
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const a = newTerminalId();
    expect(a).toMatch(ID_RE);
    expect(a).not.toBe(newTerminalId());
  });
});

describe("sendTerminalInput", () => {
  afterEach(() => vi.unstubAllGlobals());

  // Keystrokes reordered on the wire are what made vim unusable: an
  // independent fetch per keystroke let "vp3.txt" reach the shell as
  // "vp3t.xt". Only one POST may be open at a time per terminal.
  it("serializes and coalesces, so the shell reads what was typed", async () => {
    const bodies: string[] = [];
    let open = 0;
    let maxOpen = 0;
    const release: Array<() => void> = [];
    vi.stubGlobal("fetch", (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      maxOpen = Math.max(maxOpen, ++open);
      return new Promise<void>((r) => release.push(() => { open--; r(); }));
    });

    for (const ch of "vp3.txt") sendTerminalInput("t1", ch);
    while (release.length) {
      release.shift()!();
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(maxOpen).toBe(1);
    expect(bodies.join("")).toBe("vp3.txt");
  });
});

describe("execCommand", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs the command and hands back the gateway's result", async () => {
    let sent: { url: string; body: string } | null = null;
    vi.stubGlobal("fetch", (url: string, init: { body: string }) => {
      sent = { url, body: init.body };
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ code: 0, stdout: "hi\n", stderr: "" }) });
    });
    const res = await execCommand("echo hi", "/repo");
    expect(sent!.url).toContain("/terminal/exec");
    expect(JSON.parse(sent!.body)).toEqual({ cmd: "echo hi", cwd: "/repo" });
    expect(res.stdout).toBe("hi\n");
  });

  it("rejects on a non-OK answer (terminal withheld → 404)", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve({ ok: false, status: 404 }));
    await expect(execCommand("ls")).rejects.toThrow(/404/);
  });
});

describe("shellContext / shellNote", () => {
  it("wraps the run in Claude Code's bash tags, omitting empty streams", () => {
    expect(shellContext("ls", { code: 0, stdout: "a\n", stderr: "" }))
      .toBe("<bash-input>ls</bash-input>\n<bash-stdout>a\n</bash-stdout>");
    expect(shellContext("boom", { code: 2, stdout: "", stderr: "no\n" }))
      .toBe("<bash-input>boom</bash-input>\n<bash-stderr>no\n</bash-stderr>\n<bash-exit-code>2</bash-exit-code>");
  });

  it("renders a silent run and a failing exit legibly", () => {
    expect(shellNote({ code: 0, stdout: "", stderr: "" })).toBe("(no output)");
    expect(shellNote({ code: 1, stdout: "partial\n", stderr: "err\n" })).toBe("partial\nerr\n(exit 1)");
  });
});

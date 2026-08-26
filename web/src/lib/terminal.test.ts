import { describe, it, expect, vi, afterEach } from "vitest";
import { newTerminalId, sendTerminalInput } from "./terminal.ts";

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

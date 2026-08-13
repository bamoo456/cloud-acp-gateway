import { describe, it, expect, vi, afterEach } from "vitest";
import { newTerminalId } from "./terminal.ts";

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

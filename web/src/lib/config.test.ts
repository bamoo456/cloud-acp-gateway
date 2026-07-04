import { describe, test, expect } from "vitest";
import { linkParams, shareUrl, resumeCommand } from "./config.ts";

describe("deep-link url helpers", () => {
  test("linkParams reads agent + session + cwd from the query string", () => {
    expect(linkParams("?agent=codex&session=abc-123&cwd=/home/x")).toEqual({ agent: "codex", session: "abc-123", cwd: "/home/x" });
    expect(linkParams("?session=abc-123")).toEqual({ agent: null, session: "abc-123", cwd: null });
    expect(linkParams("")).toEqual({ agent: null, session: null, cwd: null });
  });

  test("linkParams decodes encoded values", () => {
    expect(linkParams("?session=s1&cwd=%2Fhome%2Fa%20b")).toEqual({ agent: null, session: "s1", cwd: "/home/a b" });
  });

  test("shareUrl builds a deep-link with agent from origin + pathname", () => {
    expect(shareUrl("abc-123", "/home/x", "codex", "http://10.0.0.1:8080", "/")).toBe(
      "http://10.0.0.1:8080/?agent=codex&session=abc-123&cwd=%2Fhome%2Fx",
    );
  });

  test("shareUrl omits agent when empty and cwd when empty", () => {
    expect(shareUrl("abc-123", "", "", "http://h", "/")).toBe("http://h/?session=abc-123");
  });

  test("shareUrl round-trips through linkParams", () => {
    const url = shareUrl("sess-9", "/home/a b", "claude", "http://h", "/");
    const search = url.slice(url.indexOf("?"));
    expect(linkParams(search)).toEqual({ agent: "claude", session: "sess-9", cwd: "/home/a b" });
  });
});

describe("resumeCommand", () => {
  test("Claude uses the --resume flag and cd's into the project dir", () => {
    expect(resumeCommand("abc-123", "/home/x")).toBe("cd /home/x && claude --resume abc-123");
  });

  test("Codex uses the resume subcommand (no leading --)", () => {
    expect(resumeCommand("abc-123", "/home/x", "codex")).toBe("cd /home/x && codex resume abc-123");
  });

  test("opencode uses the --session flag", () => {
    expect(resumeCommand("ses_abc123", "/home/x", "opencode")).toBe("cd /home/x && opencode --session ses_abc123");
  });

  test("omits the cd when no cwd is known", () => {
    expect(resumeCommand("abc-123", "")).toBe("claude --resume abc-123");
    expect(resumeCommand("abc-123", "", "codex")).toBe("codex resume abc-123");
  });

  test("single-quotes a cwd with spaces, leaves clean paths bare", () => {
    expect(resumeCommand("s1", "/home/a b")).toBe("cd '/home/a b' && claude --resume s1");
    expect(resumeCommand("s1", "/Users/me/git/products")).toBe(
      "cd /Users/me/git/products && claude --resume s1",
    );
  });
});

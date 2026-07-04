import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repairInterruptedCodexRollout, repairInterruptedCodexSession } from "./gateway.ts";

// Write a Codex rollout (one response_item-style JSON object per line) to a temp
// file and return its path. `trailingNewline` toggles whether the file ends with
// "\n" so we can exercise the trim's newline handling.
function writeRollout(lines: unknown[], trailingNewline = true): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-codex-"));
  const file = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + (trailingNewline ? "\n" : ""));
  return file;
}

function readLines(file: string): Array<Record<string, unknown>> {
  return fs.readFileSync(file, "utf8").split(/\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
}
function payloads(file: string): Array<Record<string, unknown>> {
  return readLines(file).filter((l) => l.type === "response_item").map((l) => l.payload as Record<string, unknown>);
}

const meta = { type: "session_meta", payload: { id: "S", cwd: "/work" } };
const userMsg = (text: string) => ({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
const asstMsg = (text: string) => ({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
const reasoning = (text: string) => ({ type: "response_item", payload: { type: "reasoning", content: [{ type: "reasoning_text", text }] } });
const toolCall = (type: string, callId: string, name = "tool") => ({ type: "response_item", payload: { type, call_id: callId, name } });
const toolOutput = (type: string, callId: string) => ({ type: "response_item", payload: { type: `${type}_output`, call_id: callId, output: "ok" } });
const event = (msg: string) => ({ type: "event_msg", payload: { type: msg } });

test("trims a rollout ending on a dangling apply_patch (custom_tool_call)", async () => {
  const file = writeRollout([
    meta,
    userMsg("apply the patch"),
    toolCall("custom_tool_call", "call_1", "apply_patch"),
  ]);

  assert.equal(await repairInterruptedCodexRollout(file), true);

  const ps = payloads(file);
  assert.ok(!ps.some((p) => p.type === "custom_tool_call"), "the dangling call is removed");
  assert.equal(ps.at(-1)!.type, "message", "rollout now ends on the last settled item");
  assert.equal((ps.at(-1)!.content as Array<{ text: string }>)[0].text, "apply the patch");
});

test("trims a dangling function_call back to the prior settled item", async () => {
  const file = writeRollout([meta, userMsg("run it"), toolCall("function_call", "call_9", "shell")]);

  assert.equal(await repairInterruptedCodexRollout(file), true);

  const ps = payloads(file);
  assert.ok(!ps.some((p) => p.type === "function_call"));
  assert.equal(ps.at(-1)!.type, "message");
});

test("drops trailing reasoning that led into the dead call too", async () => {
  const file = writeRollout([meta, userMsg("go"), reasoning("let me patch"), toolCall("custom_tool_call", "call_1")]);

  assert.equal(await repairInterruptedCodexRollout(file), true);

  const ps = payloads(file);
  assert.deepEqual(ps.map((p) => p.type), ["message"], "reasoning + call are both gone");
});

test("keeps earlier completed calls, dropping only the dangling tail", async () => {
  const file = writeRollout([
    meta,
    userMsg("two steps"),
    toolCall("function_call", "call_1"),
    toolOutput("function_call", "call_1"),
    reasoning("now the second"),
    toolCall("function_call", "call_2"),
  ]);

  assert.equal(await repairInterruptedCodexRollout(file), true);

  const ps = payloads(file);
  // call_1 + its output survive; call_2 + reasoning are trimmed; ends on output.
  assert.deepEqual(ps.map((p) => p.type), ["message", "function_call", "function_call_output"]);
  assert.equal(ps.at(-1)!.call_id, "call_1");
});

test("trims trailing event lines along with the dangling call", async () => {
  const file = writeRollout([
    meta,
    userMsg("go"),
    toolCall("custom_tool_call", "call_1"),
    event("task_started"),
  ]);

  assert.equal(await repairInterruptedCodexRollout(file), true);

  const all = readLines(file);
  assert.ok(!all.some((l) => l.type === "event_msg"), "trailing event line is gone");
  assert.equal((all.at(-1)!.payload as Record<string, unknown>).type, "message");
});

test("leaves a healthy rollout (call already has its output) untouched", async () => {
  const file = writeRollout([meta, userMsg("do it"), toolCall("custom_tool_call", "call_1"), toolOutput("custom_tool_call", "call_1")]);
  const before = fs.readFileSync(file, "utf8");

  assert.equal(await repairInterruptedCodexRollout(file), false);
  assert.equal(fs.readFileSync(file, "utf8"), before, "file is byte-for-byte unchanged");
});

test("leaves a rollout ending on an assistant message untouched", async () => {
  const file = writeRollout([
    meta,
    userMsg("do it"),
    toolCall("function_call", "call_1"),
    toolOutput("function_call", "call_1"),
    asstMsg("done"),
  ]);
  const before = fs.readFileSync(file, "utf8");

  assert.equal(await repairInterruptedCodexRollout(file), false);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("is idempotent — a second repair is a no-op", async () => {
  const file = writeRollout([meta, userMsg("go"), toolCall("custom_tool_call", "call_1")]);

  assert.equal(await repairInterruptedCodexRollout(file), true);
  const afterFirst = fs.readFileSync(file, "utf8");
  assert.equal(await repairInterruptedCodexRollout(file), false);
  assert.equal(fs.readFileSync(file, "utf8"), afterFirst, "nothing is trimmed the second time");
});

test("trims cleanly even when the file has no trailing newline", async () => {
  const file = writeRollout([meta, userMsg("go"), toolCall("custom_tool_call", "call_1")], false);

  assert.equal(await repairInterruptedCodexRollout(file), true);
  const all = readLines(file);
  assert.equal(all.length, 2, "session_meta + user message remain");
  assert.equal(fs.readFileSync(file, "utf8").endsWith("\n"), true, "rewrite ends with a newline");
});

test("returns false for a missing file rather than throwing", async () => {
  assert.equal(await repairInterruptedCodexRollout("/no/such/rollout.jsonl"), false);
});

test("repairInterruptedCodexSession finds the rollout by id under CODEX_HOME", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "acpb-codexhome-"));
  const sessionsDir = path.join(home, "sessions", "2026", "06", "16");
  fs.mkdirSync(sessionsDir, { recursive: true });
  // First line carries the id/cwd Codex uses to index the rollout; the last line
  // is the dangling apply_patch that hangs resume.
  const file = path.join(sessionsDir, "rollout-S.jsonl");
  fs.writeFileSync(file, [
    { type: "session_meta", payload: { id: "SID-123", cwd: "/work", timestamp: "2026-06-16T23:54:17Z" } },
    userMsg("apply the patch"),
    toolCall("custom_tool_call", "call_1", "apply_patch"),
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");

  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    assert.equal(await repairInterruptedCodexSession("SID-123"), true);
    assert.equal(await repairInterruptedCodexSession("nope"), false, "unknown id is a no-op");
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  }

  const ps = payloads(file);
  assert.ok(!ps.some((p) => p.type === "custom_tool_call"), "dangling call trimmed");
  assert.equal(ps.at(-1)!.type, "message");
});

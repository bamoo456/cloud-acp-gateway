import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, isRequest, isResponse, isNotification, sessionIdOf, cwdOf } from "./frames.ts";

test("parse returns null on bad JSON", () => {
  assert.equal(parse("not json"), null);
});

test("classifies a request (id + method)", () => {
  const f = parse('{"jsonrpc":"2.0","id":1,"method":"session/prompt","params":{"sessionId":"s1"}}')!;
  assert.equal(isRequest(f), true);
  assert.equal(isResponse(f), false);
  assert.equal(isNotification(f), false);
  assert.equal(sessionIdOf(f), "s1");
});

test("classifies a response (id, no method)", () => {
  const f = parse('{"jsonrpc":"2.0","id":7,"result":{"sessionId":"s2"}}')!;
  assert.equal(isResponse(f), true);
  assert.equal(isRequest(f), false);
});

test("classifies a notification (method, no id)", () => {
  const f = parse('{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s3","update":{}}}')!;
  assert.equal(isNotification(f), true);
  assert.equal(sessionIdOf(f), "s3");
});

test("sessionIdOf is null when absent", () => {
  const f = parse('{"jsonrpc":"2.0","method":"initialize","params":{}}')!;
  assert.equal(sessionIdOf(f), null);
});

test("cwdOf reads the working directory from session/new (no sessionId yet)", () => {
  const f = parse('{"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":"/proj","mcpServers":[]}}')!;
  assert.equal(cwdOf(f), "/proj");
  assert.equal(sessionIdOf(f), null);
});

test("cwdOf is null when absent or empty", () => {
  assert.equal(cwdOf(parse('{"jsonrpc":"2.0","id":1,"method":"session/prompt","params":{"sessionId":"s1"}}')!), null);
  assert.equal(cwdOf(parse('{"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":"","mcpServers":[]}}')!), null);
});

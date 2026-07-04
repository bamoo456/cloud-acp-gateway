import { test } from "node:test";
import assert from "node:assert/strict";
import { basicAuthOk, credentialsOk, timingSafeEq, wsAuthOk } from "./auth.ts";

const USER = "gateway-user";
const TOKEN = "s3cret-token";
const header = (user: string, pass: string) =>
  "Basic " + Buffer.from(`${user}:${pass}`, "utf8").toString("base64");

test("timingSafeEq matches equal strings and rejects others without throwing", () => {
  assert.equal(timingSafeEq("abc", "abc"), true);
  assert.equal(timingSafeEq("abc", "abd"), false);
  assert.equal(timingSafeEq("abc", "abcd"), false); // length mismatch must not throw
  assert.equal(timingSafeEq("", ""), true);
});

test("basicAuthOk accepts only the configured username and password", () => {
  assert.equal(basicAuthOk(header(USER, TOKEN), USER, TOKEN), true);
  assert.equal(basicAuthOk(header("anyone", TOKEN), USER, TOKEN), false);
  assert.equal(basicAuthOk(header("", TOKEN), USER, TOKEN), false);
});

test("basicAuthOk rejects wrong / missing / malformed credentials", () => {
  assert.equal(basicAuthOk(header(USER, "wrong"), USER, TOKEN), false);
  assert.equal(basicAuthOk(undefined, USER, TOKEN), false);
  assert.equal(basicAuthOk("", USER, TOKEN), false);
  assert.equal(basicAuthOk("Bearer " + TOKEN, USER, TOKEN), false); // wrong scheme
  assert.equal(basicAuthOk("Basic " + Buffer.from("nocolon").toString("base64"), USER, TOKEN), false);
});

test("basicAuthOk never matches when a configured credential is empty", () => {
  // Defensive: the gateway requires non-empty credentials at startup, but an
  // empty setting must never become an accidental blank-credential door.
  assert.equal(basicAuthOk(header("", TOKEN), "", TOKEN), false);
  assert.equal(basicAuthOk(header(USER, ""), USER, ""), false);
});

test("credentialsOk requires both the configured username and password", () => {
  assert.equal(credentialsOk(USER, TOKEN, USER, TOKEN), true);
  assert.equal(credentialsOk("other", TOKEN, USER, TOKEN), false);
  assert.equal(credentialsOk(USER, "wrong", USER, TOKEN), false);
  assert.equal(credentialsOk(null, TOKEN, USER, TOKEN), false);
  assert.equal(credentialsOk(USER, null, USER, TOKEN), false);
});

test("wsAuthOk accepts query credentials or Basic auth credentials", () => {
  assert.equal(wsAuthOk({ user: USER, token: TOKEN, expectedUser: USER, expectedPass: TOKEN }), true);
  assert.equal(wsAuthOk({ authorization: header(USER, TOKEN), expectedUser: USER, expectedPass: TOKEN }), true);
});

test("wsAuthOk rejects token-only and wrong websocket credentials", () => {
  assert.equal(wsAuthOk({ token: TOKEN, expectedUser: USER, expectedPass: TOKEN }), false);
  assert.equal(wsAuthOk({ user: "other", token: TOKEN, expectedUser: USER, expectedPass: TOKEN }), false);
  assert.equal(wsAuthOk({ user: USER, token: "wrong", expectedUser: USER, expectedPass: TOKEN }), false);
  assert.equal(wsAuthOk({ authorization: "Bearer " + TOKEN, expectedUser: USER, expectedPass: TOKEN }), false);
});

test("wsAuthOk accepts an enabled console token without account credentials", () => {
  assert.equal(wsAuthOk({
    token: "console-token",
    expectedUser: USER,
    expectedPass: TOKEN,
    consoleEnabled: true,
    consoleToken: "console-token",
  }), true);
  assert.equal(wsAuthOk({
    token: "console-token",
    expectedUser: USER,
    expectedPass: TOKEN,
    consoleEnabled: false,
    consoleToken: "console-token",
  }), false);
});

/**
 * HTTP Basic auth and WebSocket credential helpers for the gateway.
 *
 * The HTTP endpoints (the SPA at "/", the raw poker at "/raw", and the
 * /fs + /history* JSON APIs) are gated behind Basic auth so that reaching the
 * port is not enough to drive the agent: "/" embeds the ephemeral console token
 * that grants WebSocket access, and /fs + /history* expose the host filesystem
 * and past conversations. Remote /acp clients authenticate with the same
 * configured username and password, either as Basic auth or as query params.
 */
import crypto from "node:crypto";

export type Credentials = { user: string; pass: string };

/**
 * Constant-time string compare. Returns false on a length mismatch (which on
 * its own leaks only the length, as every constant-time comparator does)
 * instead of letting crypto.timingSafeEqual throw on unequal buffer sizes.
 */
export function timingSafeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function credentialsOk(
  user: string | null | undefined,
  pass: string | null | undefined,
  expectedUser: string,
  expectedPass: string,
): boolean {
  if (!expectedUser || !expectedPass || user == null || pass == null) return false;
  const userOk = timingSafeEq(user, expectedUser);
  const passOk = timingSafeEq(pass, expectedPass);
  return userOk && passOk;
}

export function basicAuthCredentials(authHeader: string | undefined): Credentials | null {
  const m = /^Basic\s+(.+)$/i.exec(authHeader ?? "");
  if (!m) return null;
  const decoded = Buffer.from(m[1].trim(), "base64").toString("utf8");
  const i = decoded.indexOf(":");
  if (i < 0) return null; // malformed: Basic credentials are "user:pass"
  return { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
}

/**
 * Validate an HTTP `Authorization: Basic <base64(user:pass)>` header against the
 * configured gateway credentials. Empty configured credentials never match; they
 * must not degrade into a blank-credential backdoor.
 */
export function basicAuthOk(
  authHeader: string | undefined,
  expectedUser: string,
  expectedPass: string,
): boolean {
  const creds = basicAuthCredentials(authHeader);
  return !!creds && credentialsOk(creds.user, creds.pass, expectedUser, expectedPass);
}

export function wsAuthOk(args: {
  authorization?: string;
  user?: string | null;
  token?: string | null;
  expectedUser: string;
  expectedPass: string;
  consoleEnabled?: boolean;
  consoleToken?: string;
}): boolean {
  if (
    args.consoleEnabled &&
    args.consoleToken &&
    args.token != null &&
    timingSafeEq(args.token, args.consoleToken)
  ) {
    return true;
  }

  const basic = basicAuthCredentials(args.authorization);
  if (basic && credentialsOk(basic.user, basic.pass, args.expectedUser, args.expectedPass)) {
    return true;
  }

  return credentialsOk(args.user, args.token, args.expectedUser, args.expectedPass);
}

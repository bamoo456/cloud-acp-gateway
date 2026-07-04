// Client-side screen lock for the web UI. The gateway serves the SPA behind HTTP
// Basic auth and hands the page an ephemeral console token, so once the page is
// open anyone holding the unlocked device can drive the agent. This adds a local
// PIN gate before the agent connection is opened on a fresh page load, and before
// reconnecting after a dropped socket, dead foreground resume, or agent restart.
//
// This is defense in depth layered on the device's own lock screen. The gate is
// enforced in-page: the store severs/refuses the SSE connection until the
// LockScreen verifies the PIN and calls unlock().
//
// The PIN config is persisted on the gateway as an opaque blob shared across
// devices. Hashing and verification stay in-browser; the plaintext PIN is never
// stored or sent to the gateway. Only the live locked/unlocked state stays
// per-device in the store.

import { putLockConfig } from "./api.ts";

const PBKDF2_ITERATIONS = 210_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

export const MIN_PIN_LENGTH = 4;

export interface LockConfig {
  saltB64: string;
  hashB64: string;
  iterations: number;
}

let cache: LockConfig | null = null;

function parseConfig(v: unknown): LockConfig | null {
  if (!v || typeof v !== "object") return null;
  const c = v as Record<string, unknown>;
  if (typeof c.saltB64 !== "string" || typeof c.hashB64 !== "string") return null;
  return {
    saltB64: c.saltB64,
    hashB64: c.hashB64,
    iterations: typeof c.iterations === "number" ? c.iterations : PBKDF2_ITERATIONS,
  };
}

export function hydrateLock(raw: unknown): void {
  cache = parseConfig(raw);
}

export function readConfig(): LockConfig | null {
  return cache;
}

function writeConfig(cfg: LockConfig): void {
  cache = cfg;
  void putLockConfig(JSON.stringify(cfg));
}

export function isLockEnabled(): boolean {
  return cache !== null;
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function derive(pin: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(pin) as BufferSource, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    key,
    HASH_BITS,
  );
  return new Uint8Array(bits);
}

export async function setLockPin(pin: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(pin, salt, PBKDF2_ITERATIONS);
  writeConfig({
    saltB64: toB64(salt),
    hashB64: toB64(hash),
    iterations: PBKDF2_ITERATIONS,
  });
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyLockPin(pin: string): Promise<boolean> {
  const cfg = readConfig();
  if (!cfg) return false;
  try {
    const hash = await derive(pin, fromB64(cfg.saltB64), cfg.iterations);
    return bytesEqual(hash, fromB64(cfg.hashB64));
  } catch {
    return false;
  }
}

export function clearLock(): void {
  cache = null;
  void putLockConfig(null);
}

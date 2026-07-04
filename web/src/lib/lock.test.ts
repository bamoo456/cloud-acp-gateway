import { describe, test, expect, beforeEach } from "vitest";
import { isLockEnabled, setLockPin, verifyLockPin, clearLock, readConfig, hydrateLock } from "./lock.ts";

describe("screen lock storage", () => {
  // The lock config lives on the gateway, mirrored in an in-memory cache.
  // clearLock() resets that cache between tests (the module isn't reloaded).
  beforeEach(() => { clearLock(); });

  test("starts disabled with no PIN", () => {
    expect(isLockEnabled()).toBe(false);
    expect(readConfig()).toBeNull();
  });

  test("setting a PIN enables the lock and verifies round-trip", async () => {
    await setLockPin("1234");
    expect(isLockEnabled()).toBe(true);
    expect(await verifyLockPin("1234")).toBe(true);
    expect(await verifyLockPin("0000")).toBe(false);
  });

  test("never stores the PIN in plaintext", async () => {
    await setLockPin("9182");
    const raw = JSON.stringify(readConfig());
    expect(raw).not.toContain("9182");
    expect(raw).toContain("hashB64");
    expect(raw).toContain("saltB64");
  });

  test("a fresh salt makes the stored hash differ for the same PIN", async () => {
    await setLockPin("4321");
    const first = readConfig()!;
    await setLockPin("4321");
    const second = readConfig()!;
    expect(second.saltB64).not.toBe(first.saltB64);
    expect(second.hashB64).not.toBe(first.hashB64);
    expect(await verifyLockPin("4321")).toBe(true);
  });

  test("clearLock removes the PIN and disables the lock", async () => {
    await setLockPin("2468");
    clearLock();
    expect(isLockEnabled()).toBe(false);
    expect(await verifyLockPin("2468")).toBe(false);
  });

  test("hydrating corrupt or boolean-only blobs leaves the lock disabled", () => {
    hydrateLock("{bad json");
    expect(isLockEnabled()).toBe(false);
    hydrateLock({ enabled: true });
    expect(isLockEnabled()).toBe(false);
  });

  test("hydrating a stored PIN blob enables the lock", async () => {
    await setLockPin("1357");
    const cfg = readConfig();
    clearLock();
    hydrateLock(cfg);
    expect(isLockEnabled()).toBe(true);
    expect(await verifyLockPin("1357")).toBe(true);
  });
});

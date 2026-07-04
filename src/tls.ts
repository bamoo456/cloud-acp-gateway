/**
 * TLS material resolution for the gateway.
 *
 * Precedence:
 *   1. ACPG_TLS=off            -> null (plain HTTP; e.g. local dev or a TLS proxy
 *                                 already terminates in front).
 *   2. ACPG_TLS_CERT + KEY set -> use that bring-your-own pair.
 *   3. otherwise               -> a self-signed pair under ACPG_TLS_DIR, generated
 *                                 once via the host `openssl` and reused on later
 *                                 starts (stable so a client trusting it on first
 *                                 use keeps trusting it across restarts).
 *
 * Self-signed encrypts the wire but does NOT establish trust: the swift-acp WS
 * client over wss:// will reject it unless it pins/trusts the cert (or sets
 * rejectUnauthorized:false), and browsers show a warning. That is the cost of
 * skipping a real CA, and it is acceptable for a single-operator VPN tool.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export interface TlsOptions {
  enabled: boolean; // false => plain HTTP (ACPG_TLS=off)
  certPath?: string; // ACPG_TLS_CERT — bring-your-own cert (PEM)
  keyPath?: string; //  ACPG_TLS_KEY  — bring-your-own key  (PEM)
  dir: string; //        ACPG_TLS_DIR — where an auto-generated pair is persisted
  san?: string; //       ACPG_TLS_SAN — extra comma-separated subjectAltNames
}

export interface TlsMaterial {
  cert: Buffer;
  key: Buffer;
  generated: boolean; // true if this call had to mint the self-signed pair
  certFile: string;
  keyFile: string;
}

/** Resolve TLS material, or null when TLS is disabled. */
export function resolveTls(opts: TlsOptions): TlsMaterial | null {
  if (!opts.enabled) return null;

  if (opts.certPath && opts.keyPath) {
    return {
      cert: fs.readFileSync(opts.certPath),
      key: fs.readFileSync(opts.keyPath),
      generated: false,
      certFile: opts.certPath,
      keyFile: opts.keyPath,
    };
  }
  if (opts.certPath || opts.keyPath) {
    throw new Error(
      "TLS: set BOTH ACPG_TLS_CERT and ACPG_TLS_KEY, or neither (to auto-generate a self-signed pair)",
    );
  }

  const certFile = path.join(opts.dir, "cert.pem");
  const keyFile = path.join(opts.dir, "key.pem");
  let generated = false;
  if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
    generateSelfSigned(certFile, keyFile, opts.san);
    generated = true;
  }
  return {
    cert: fs.readFileSync(certFile),
    key: fs.readFileSync(keyFile),
    generated,
    certFile,
    keyFile,
  };
}

/**
 * Mint a self-signed cert/key pair via the host `openssl` binary. Fails loudly
 * with remediation if openssl is missing — slim/alpine images often ship libssl
 * but not the CLI, so this surfaces the problem at startup instead of cryptically.
 */
export function generateSelfSigned(certFile: string, keyFile: string, san?: string): void {
  fs.mkdirSync(path.dirname(certFile), { recursive: true });
  const sans = ["DNS:localhost", "IP:127.0.0.1"];
  for (const raw of (san ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(raw) || raw.includes(":");
    sans.push(`${isIp ? "IP" : "DNS"}:${raw}`);
  }
  const res = spawnSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyFile, "-out", certFile,
      "-days", "3650", "-subj", "/CN=acp-gateway",
      "-addext", `subjectAltName=${sans.join(",")}`,
    ],
    { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" },
  );
  if (res.error || res.status !== 0) {
    const why = res.error ? String(res.error) : res.stderr?.trim() || `exit ${res.status}`;
    throw new Error(
      `TLS: could not generate a self-signed cert via openssl (${why}).\n` +
        "  Fix one of:\n" +
        "    - install the openssl CLI on this host, or\n" +
        "    - bring your own cert: set ACPG_TLS_CERT and ACPG_TLS_KEY, or\n" +
        "    - disable TLS: set ACPG_TLS=off (plain HTTP; front it with a TLS proxy).",
    );
  }
  try { fs.chmodSync(keyFile, 0o600); } catch { /* best-effort: key should be private */ }
}

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolveTls } from "./tls.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "acpb-tls-"));
const hasOpenssl = (() => {
  try { return spawnSync("openssl", ["version"]).status === 0; } catch { return false; }
})();

test("resolveTls returns null when TLS is disabled", () => {
  assert.equal(resolveTls({ enabled: false, dir: tmp() }), null);
});

test("resolveTls uses a bring-your-own cert/key pair verbatim", () => {
  const dir = tmp();
  const certPath = path.join(dir, "byo-cert.pem");
  const keyPath = path.join(dir, "byo-key.pem");
  fs.writeFileSync(certPath, "CERT-BYTES");
  fs.writeFileSync(keyPath, "KEY-BYTES");
  try {
    const m = resolveTls({ enabled: true, dir, certPath, keyPath });
    assert.ok(m);
    assert.equal(m.generated, false);
    assert.equal(m.cert.toString(), "CERT-BYTES");
    assert.equal(m.key.toString(), "KEY-BYTES");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveTls rejects a half-configured BYO pair", () => {
  assert.throws(
    () => resolveTls({ enabled: true, dir: tmp(), certPath: "/only/cert.pem" }),
    /BOTH ACPG_TLS_CERT and ACPG_TLS_KEY/,
  );
});

test("resolveTls generates a self-signed pair once and reuses it", { skip: !hasOpenssl }, () => {
  const dir = tmp();
  try {
    const first = resolveTls({ enabled: true, dir, san: "acp.example.test" });
    assert.ok(first);
    assert.equal(first.generated, true, "first call mints the pair");
    assert.ok(fs.existsSync(first.certFile) && fs.existsSync(first.keyFile));

    const x509 = new crypto.X509Certificate(first.cert);
    assert.match(x509.subjectAltName ?? "", /localhost/);
    assert.match(x509.subjectAltName ?? "", /acp\.example\.test/, "ACPG_TLS_SAN lands in the cert");

    const second = resolveTls({ enabled: true, dir });
    assert.equal(second!.generated, false, "second call reuses the persisted pair");
    assert.equal(second!.cert.toString(), first.cert.toString());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

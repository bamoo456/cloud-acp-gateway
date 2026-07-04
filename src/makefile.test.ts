import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.join(__dirname, "..");
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function runMakeDev(extraArgs: string[] = []) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "acpg-dev-"));
  const ledgerDir = path.join(tempDir, "ledger");
  const nodeCmd = `${process.execPath} -e "process.stdout.write(process.env.ACPG_LISTEN + '|' + process.env.ACPG_LEDGER_DIR + '|' + process.env.ACPG_TLS + '|' + process.env.ACPG_AUTH_USER + '|' + process.env.ACPG_AUTH_TOKEN + '\\n')"`;
  const result = spawnSync(
    "make",
    [
      "--silent",
      "dev",
      "NPM=true",
      `NODE=${nodeCmd}`,
      "ACPG_AUTH_USER=test-user",
      "ACPG_AUTH_TOKEN=test-token",
      "ACPG_LISTEN=0.0.0.0:8080",
      "ACPG_LEDGER_DIR=./data",
      "STAGING_LISTEN=127.0.0.1:9444",
      `STAGING_LEDGER_DIR=${ledgerDir}`,
      ...extraArgs,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: process.env,
    },
  );

  return { ledgerDir, result };
}

test("make dev runs the isolated phone-safe environment", () => {
  const { ledgerDir, result } = runMakeDev(["ACPG_TLS=on"]);

  assert.equal(result.status, 0, `make dev failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, new RegExp(`^127\\.0\\.0\\.1:9444\\|${escapeRegExp(ledgerDir)}\\|off\\|test-user\\|test-token$`, "m"));
});

test("make dev supports HTTPS when STAGING_TLS is enabled", () => {
  const { ledgerDir, result } = runMakeDev(["STAGING_TLS=on"]);

  assert.equal(result.status, 0, `make dev failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, new RegExp(`^127\\.0\\.0\\.1:9444\\|${escapeRegExp(ledgerDir)}\\|on\\|test-user\\|test-token$`, "m"));
});

test("make dev can use fixed dev credentials for browser testing", () => {
  const { ledgerDir, result } = runMakeDev(["DEV_AUTH=1"]);

  assert.equal(result.status, 0, `make dev failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, new RegExp(`^127\\.0\\.0\\.1:9444\\|${escapeRegExp(ledgerDir)}\\|off\\|dev\\|dev$`, "m"));
  assert.match(result.stdout, /\x1b\[1;37;41m WARNING: DEV AUTH ENABLED \x1b\[0m/);
  assert.match(result.stdout, /\x1b\[1;33mtransport: plain HTTP enabled \(STAGING_TLS=off\)\x1b\[0m/);
  assert.match(result.stdout, /\x1b\[33mlogin: default dev auth is active \(username: dev, password: dev\)\x1b\[0m/);
  assert.match(result.stdout, /\x1b\[33mopen: http:\/\/dev:dev@127\.0\.0\.1:9444\/\x1b\[0m/);
});

test("make dev-watch keeps the fast tsx watch loop", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "acpg-dev-watch-"));
  const npm = path.join(tempDir, "npm");
  const log = path.join(tempDir, "calls.log");

  writeFileSync(npm, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$MOCK_NPM_LOG\"\n");
  chmodSync(npm, 0o755);

  const result = spawnSync("make", ["--silent", "dev-watch", `NPM=${npm}`], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, MOCK_NPM_LOG: log },
  });

  assert.equal(result.status, 0, `make dev-watch failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(readFileSync(log, "utf8"), /^run dev$/m);
});

test("make dev-run starts the gateway with TLS disabled for HTTP browser testing", () => {
  const nodeCmd = `${process.execPath} -e "process.stdout.write(String(process.env.ACPG_TLS || '') + '\\n')"`;
  const result = spawnSync(
    "make",
    ["--silent", "dev-run", "NPM=true", `NODE=${nodeCmd}`, "OUT=", "ACPG_TLS=on"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: process.env,
    },
  );

  assert.equal(result.status, 0, `make dev-run failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /^off$/m);
});

test("make help lists dev-run by target name", () => {
  const result = spawnSync("make", ["help"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, `make help failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(stripAnsi(result.stdout), /\bdev-run\b.*plain HTTP/);
});

test("make help documents both make dev HTTP and HTTPS modes", () => {
  const result = spawnSync("make", ["help"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, `make help failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(stripAnsi(result.stdout), /\bdev\b.*HTTP default.*HTTPS.*STAGING_TLS=on/);
});

test("make help documents make dev default browser credentials", () => {
  const result = spawnSync("make", ["help"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, `make help failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(stripAnsi(result.stdout), /\bdev\b.*DEV_AUTH=1/);
});

test("make start-mac falls back when a background launchd session rejects bootstrap", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "acpg-launchctl-"));
  const launchctl = path.join(tempDir, "launchctl");
  const plist = path.join(tempDir, "com.test.plist");
  const loaded = path.join(tempDir, "loaded");

  writeFileSync(plist, "test plist\n");
  writeFileSync(
    launchctl,
    `#!/bin/sh
case "$1" in
  print)
    [ -f "$MOCK_LOADED" ] || exit 113
    printf 'state = running\\npid = 42\\n'
    ;;
  bootstrap)
    echo 'Bootstrap failed: 125: Domain does not support specified action' >&2
    exit 125
    ;;
  load)
    touch "$MOCK_LOADED"
    ;;
esac
`,
  );
  chmodSync(launchctl, 0o755);

  const result = spawnSync(
    "make",
    ["--silent", "start-mac", `LAUNCHCTL=${launchctl}`, "MAC_LABEL=com.test", `MAC_PLIST=${plist}`],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, MOCK_LOADED: loaded },
    },
  );

  assert.equal(result.status, 0, `make start-mac failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /loaded 'com\.test' \(launchctl load compatibility mode\)/);
});

test("make status-mac queries the configured GUI domain directly", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "acpg-launchctl-"));
  const launchctl = path.join(tempDir, "launchctl");
  writeFileSync(launchctl, "#!/bin/sh\nprintf 'state = running\\npid = 42\\n'\n");
  chmodSync(launchctl, 0o755);

  const result = spawnSync(
    "make",
    ["--silent", "status-mac", `LAUNCHCTL=${launchctl}`, "MAC_LABEL=com.test"],
    { cwd: repoRoot, encoding: "utf8", env: process.env },
  );

  assert.equal(result.status, 0, `make status-mac failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /^running: com\.test \(pid 42\)$/m);
});

test("make deploy-mac installs a missing plist, builds, starts, then reloads the mac service", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "acpg-make-"));
  const make = path.join(tempDir, "make");
  const launchctl = path.join(tempDir, "launchctl");
  const loaded = path.join(tempDir, "loaded");
  const log = path.join(tempDir, "calls.log");
  const plist = path.join(tempDir, "com.test.plist");

  writeFileSync(
    make,
    `#!/bin/sh
printf 'make:%s\\n' "$*" >> "$MOCK_CALL_LOG"
[ "$*" = "start-mac" ] && touch "$MOCK_LOADED"
exit 0
`,
  );
  writeFileSync(
    launchctl,
    `#!/bin/sh
printf 'launchctl:%s\\n' "$*" >> "$MOCK_CALL_LOG"
case "$1" in
  print)
    [ -f "$MOCK_LOADED" ] || exit 113
    ;;
  kickstart)
    [ -f "$MOCK_LOADED" ] || exit 113
    ;;
esac
`,
  );
  chmodSync(make, 0o755);
  chmodSync(launchctl, 0o755);

  const result = spawnSync(
    "make",
    [
      "--silent",
      "deploy-mac",
      `MAKE=${make}`,
      `LAUNCHCTL=${launchctl}`,
      "MAC_LABEL=com.test",
      "MAC_DOMAIN=gui/test",
      `MAC_PLIST=${plist}`,
      "NPM=true",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, MOCK_CALL_LOG: log, MOCK_LOADED: loaded },
    },
  );

  assert.equal(result.status, 0, `make deploy-mac failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.deepEqual(
    stripAnsi(readFileSync(log, "utf8")).trim().split("\n"),
    [
      "make:install-mac",
      "make:build",
      "launchctl:print gui/test/com.test",
      "make:start-mac",
      "launchctl:kickstart -k gui/test/com.test",
    ],
  );
});

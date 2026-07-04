#!/usr/bin/env bash
#
# Run on ANY Linux host after copying this directory there and installing deps:
#   npm install --omit=dev      # ws is bundled into dist/gateway.js; this pulls the agent(s)
#
# Then run under something that keeps it alive, e.g. tmux:
#   tmux new -d -s acp-gateway "./start.sh 2>&1 | tee -a /data/acp-gateway.log"
# or a systemd unit, or `kubectl exec ... -- tmux new -d ...` inside a pod.
#
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

if [ -f "$HERE/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$HERE/.env"
  set +a
fi

# Compatibility shim for deployments that still have the pre-rename ACPB_* env
# names in .env / service managers. gateway.ts also aliases these, but start.sh
# performs required-auth validation before exec'ing node, so it must mirror the
# aliasing for variables it checks or exports.
for old_name in ${!ACPB_@}; do
  new_name="ACPG_${old_name#ACPB_}"
  if [ -z "${!new_name+x}" ]; then
    export "$new_name=${!old_name}"
  fi
done

# --- auth for claude-agent-acp agents ---------------------------------------
# The host is assumed to have `claude` installed and logged in; claude-agent-acp
# wraps the Claude Agent SDK and reuses those credentials from ~/.claude.

# --- gateway config -----------------------------------------------------------
# ACPG_AUTH_USER / ACPG_AUTH_TOKEN are the HTTP Basic auth credentials and the
# remote /acp account credentials.
: "${ACPG_AUTH_USER:?set ACPG_AUTH_USER (gateway account username)}"
: "${ACPG_AUTH_TOKEN:?set ACPG_AUTH_TOKEN (gateway account password / websocket token)}"
export ACPG_LEDGER_DIR="${ACPG_LEDGER_DIR:-/data}"        # put on persistent storage
export ACPG_LISTEN="${ACPG_LISTEN:-0.0.0.0:8080}"
export ACPG_WS_PATH="${ACPG_WS_PATH:-/acp}"
# TLS is on by default (https/wss). With no ACPG_TLS_CERT/_KEY set, a self-signed
# pair is generated via `openssl` under ACPG_TLS_DIR (default $ACPG_LEDGER_DIR/tls)
# and reused on restart. Needs the openssl CLI on this host; or set ACPG_TLS=off.
# Agents are defined in agents.json next to this script (copy agents.example.json).
# If an agent entry omits cwd, ACPG_AGENT_CWD supplies the default workdir.
# If that file is absent, a single "claude" agent is derived from
# ACPG_AGENT_CMD / ACPG_AGENT_ARGS / ACPG_AGENT_CWD.

echo "starting acp-gateway on ${ACPG_LISTEN}${ACPG_WS_PATH}"
exec node "$HERE/dist/gateway.js"

# Deployment examples

Ready-to-adapt deployment artifacts for acp-gateway. See the
[main README](../README.md#choosing-a-deployment-method) for the decision guide
(Docker vs. native systemd/launchd) and the full walkthroughs.

| File | Use |
|------|-----|
| [`Dockerfile`](Dockerfile) | Container image — bundles the agent adapters; supply login state via volumes. Build from the repo root: `docker build -f deploy/Dockerfile -t acp-gateway .` |
| [`docker-compose.yml`](docker-compose.yml) | Compose deployment with credential/ledger volumes, env, and an HTTPS healthcheck. |
| [`acp-gateway.service`](acp-gateway.service) | Linux **systemd** unit for native deployment (reuses the host's `~/.claude` login). |
| [`local.acp-gateway.plist`](local.acp-gateway.plist) | macOS **launchd** agent for native deployment (the natural choice on a Mac — Docker can't see the host's `claude` login). Readable reference / manual fallback; prefer `make install-mac` (below). |
| [`acp-gateway.plist.template`](acp-gateway.plist.template) | Tokenized plist consumed by `make install-mac` — not installed directly. |

## The one premise behind all of these

The gateway spawns the agent as a **stdio child process** — it does *not* connect
to an agent over the network, and there is **no remote-agent mode**. So the agent
always runs on the **same host / inside the same container** as the gateway. That
single fact drives every choice below:

- **Docker** → the agent runs *in the container*, so the image must contain the
  agent adapter and the container must be given the agent's login state
  (mount the host's `~/.claude` / `~/.codex`).
- **Native (systemd/launchd)** → the agent runs as the same OS user as the
  gateway, so it reuses that user's existing `claude` login directly — nothing to
  mount. On **macOS** this is the natural choice, because Docker Desktop's Linux
  VM can't see the Mac's `claude` install or login.

Each file is commented with its own install steps and the knobs you'll want to
change (paths, user, auth token, TLS).

## macOS quick start (launchd)

`make install-mac` generates the plist for you — it auto-detects the active node
bin dir (the usual hand-edit footgun, since nvm/homebrew node isn't on launchd's
PATH), fills in the repo path and label, and writes
`~/Library/LaunchAgents/$(MAC_LABEL).plist`. The auth token is **not** baked into
the plist; put `ACPG_AUTH_USER` / `ACPG_AUTH_TOKEN` in the repo `.env` (chmod 600)
and `start.sh` sources it.

```sh
make deploy-mac           # generate plist if needed, rebuild, load/reload service
make install-mac          # generate the plist (FORCE=1 to overwrite an existing one)
make start-mac            # load it (RunAtLoad/KeepAlive keep it up)
make status-mac           # is it running?
make logs-mac             # follow the log
make stop-mac             # unload
```

Override the defaults with standard make vars, e.g.
`make install-mac MAC_LABEL=com.acp-gateway MAC_LEDGER_DIR=/path/to/state`.

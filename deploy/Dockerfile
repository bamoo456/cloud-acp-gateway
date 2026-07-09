# acp-gateway — example container image.
#
# Build from the REPO ROOT (this Dockerfile lives in deploy/):
#   docker build -f deploy/Dockerfile -t acp-gateway .
#
# IMPORTANT: the agent runs INSIDE this container as a stdio child of the gateway
# — there is no "remote agent" mode, the gateway never connects to an agent on
# the host. So the image bundles the ACP agent adapters (claude-agent-acp,
# codex-acp, pulled by `npm install`), and you supply the agent's *login state*
# at runtime by mounting it as a volume (see deploy/docker-compose.yml).

FROM node:20-bookworm-slim

# Extra packages the slim base lacks:
# - openssl CLI: slim images ship libssl but NOT the `openssl` binary the gateway
#   uses to generate its self-signed TLS cert on first start. Without it the
#   gateway exits unless you bring ACPG_TLS_CERT/_KEY or set ACPG_TLS=off.
# - git: agent tooling commonly shells out to git.
# - curl: used by the container HEALTHCHECK below.
# - tini: PID 1 init that reaps the agent child processes the gateway spawns.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl git curl tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/acp-gateway

# Copy the repo, then install. `npm install` runs the `prepare` hook which builds
# dist/gateway.js + the web SPA and pulls the agent adapters. Do NOT pass
# --omit=optional: codex-acp's native binary ships as platform-specific optional
# dependencies. After the build, prune dev deps and the web build's node_modules
# to slim the runtime layer (the served SPA lives in web/dist, already built).
COPY . .
RUN npm install \
 && npm prune --omit=dev \
 && rm -rf web/node_modules \
 && npm cache clean --force

# Ledger + auto self-signed cert + sqlite state default to /data; mount a volume
# there so sessions/credentials-derived state survive container recreation.
ENV ACPG_LEDGER_DIR=/data
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8080

# /healthz is the only unauthenticated endpoint. TLS is on by default, so probe
# over HTTPS with -k (self-signed). If you run ACPG_TLS=off (proxy terminates
# TLS), change this to http:// and drop -k.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsk https://127.0.0.1:8080/healthz || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/gateway.js"]

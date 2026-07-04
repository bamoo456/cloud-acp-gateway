# Makefile for acp-gateway — a WebSocket gateway fronting one or more ACP agents.
#
# Two ways to use it:
#
#   LOCAL (your machine)
#     make dev       run isolated dev on :8791 (HTTP default, HTTPS STAGING_TLS=on, auth DEV_AUTH=1)
#     make dev-watch run from source with live reload (tsx watch)
#     make run       build the bundle and run it in the foreground
#     make dev-run   build and run over plain HTTP for local browser testing
#     make build     just produce dist/gateway.js
#     make staging   alias for make dev
#
#   PRODUCTION (a Linux host: VM, bare metal, k8s pod) — detached tmux
#     make deploy    build + launch under a detached tmux session, kept alive
#     make status    is it running?
#     make logs      tail the running deployment's log
#     make attach    attach to the tmux session (detach: Ctrl-b d)
#     make restart   stop + deploy again
#     make stop      stop the deployment
#
#   PRODUCTION (a Mac, native) — launchd agent (see deploy/local.acp-gateway.plist)
#     make deploy-mac   install plist if missing, build, load/reload the service
#     make deploy-mac-latest  pull latest origin/main, then deploy-mac
#     make restart-mac  reload the launchd service without rebuilding
#     make status-mac   is the launchd service loaded / running?
#     make logs-mac     tail the launchd service log
#     make stop-mac     bootout (unload) the launchd service
#     make start-mac    bootstrap (load) the launchd service
#   Override the label/plist if yours differ from the installed defaults:
#     make deploy-mac MAC_LABEL=com.acp-gateway
#
# Config is via env vars (see README.md "Configuration"); override on the command
# line too, e.g.:
#   make run    ACPG_LISTEN=127.0.0.1:9000 ACPG_AUTH_USER=acp ACPG_AUTH_TOKEN=secret
#   make deploy ACPG_AUTH_USER=acp ACPG_AUTH_TOKEN=secret ACPG_LEDGER_DIR=/data

# ---- tooling ---------------------------------------------------------------
NPM  ?= npm
NODE ?= node
TMUX ?= tmux
LAUNCHCTL ?= launchctl

OUT = dist/gateway.js

# Let `make dev/dev-watch/run/deploy` pick up the same local config file as the gateway.
ifneq (,$(wildcard .env))
include .env
endif
# Dev-only local overrides (e.g. ACPG_LISTEN on a different port so `make
# dev-watch/run` don't collide with a launchd/systemd service already on the
# default port). Included AFTER .env so its values win. start.sh and the prod
# gateway only ever read .env, never this file, so it can't move the deployed service.
ifneq (,$(wildcard .env.local))
include .env.local
endif

# ---- runtime config (overridable) ------------------------------------------
# Mirrors the defaults baked into start.sh so the local targets work the same way.
export ACPG_LISTEN     ?= 0.0.0.0:8080
export ACPG_WS_PATH    ?= /acp
export ACPG_LEDGER_DIR ?= ./data
# Pass this through to start.sh (e.g. inside tmux), but ONLY when it is actually
# set — `export`-ing an undefined variable injects an empty ACPG_AUTH_* into the
# child env, which would shadow the value coming from .env (loadEnvFile does not
# override an already-present variable).
ifneq ($(ACPG_AUTH_USER),)
export ACPG_AUTH_USER
endif
ifneq ($(ACPG_AUTH_TOKEN),)
export ACPG_AUTH_TOKEN
endif

# ---- local staging (overridable) -------------------------------------------
# A throwaway gateway for trying the current working tree against your phone,
# fully isolated from the production service (the launchd com.acp-gateway on
# :8080). Override on the command line like any other var.
STAGING_LISTEN     ?= 0.0.0.0:8791
STAGING_LEDGER_DIR ?= ./data-staging
STAGING_TLS        ?= off
DEV_AUTH           ?=

DEV_AUTH_USER  = $(ACPG_AUTH_USER)
DEV_AUTH_TOKEN = $(ACPG_AUTH_TOKEN)
ifeq ($(DEV_AUTH),1)
DEV_AUTH_USER  := dev
DEV_AUTH_TOKEN := dev
endif
ifeq ($(STAGING_TLS),on)
DEV_AUTH_SCHEME = https
DEV_AUTH_TRANSPORT = HTTPS enabled (STAGING_TLS=on)
else
DEV_AUTH_SCHEME = http
DEV_AUTH_TRANSPORT = plain HTTP enabled (STAGING_TLS=off)
endif
DEV_AUTH_URL_HOST = $(patsubst 0.0.0.0:%,127.0.0.1:%,$(STAGING_LISTEN))

# ---- production deployment (tmux) ------------------------------------------
SESSION  ?= acp-gateway
LOG_FILE ?= $(ACPG_LEDGER_DIR)/acp-gateway.log

# ---- macOS launchd deployment (overridable) --------------------------------
# Defaults match the service currently installed on this Mac (label com.acp-gateway,
# WorkingDirectory = this repo, log under ~/Library/Logs). Override on the command
# line if yours differ.
MAC_LABEL ?= com.acp-gateway
MAC_PLIST ?= $(HOME)/Library/LaunchAgents/$(MAC_LABEL).plist
MAC_LOG   ?= $(HOME)/Library/Logs/acp-gateway.log
MAC_DOMAIN = gui/$(shell id -u)

# `install-mac` renders MAC_TEMPLATE into MAC_PLIST. NODE_BIN_DIR is the dir of
# the node on the build PATH (nvm/homebrew/system) — launchd has neither nvm nor
# homebrew on its PATH, so we bake it in. MAC_PATH also adds /opt/homebrew/bin so
# the openssl CLI (self-signed TLS) and `claude` resolve. MAC_LEDGER_DIR holds the
# state.sqlite + permission inbox + self-signed TLS cert across restarts.
MAC_TEMPLATE   ?= deploy/acp-gateway.plist.template
NODE_BIN_DIR   ?= $(shell dirname "$$(command -v node 2>/dev/null)" 2>/dev/null)
MAC_PATH       ?= $(NODE_BIN_DIR):/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
MAC_LEDGER_DIR ?= $(HOME)/Library/Application Support/acp-gateway
MAC_ERRLOG     ?= $(MAC_LOG:.log=.err.log)

.DEFAULT_GOAL := help

# ---- meta ------------------------------------------------------------------
.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

# ---- dependencies ----------------------------------------------------------
node_modules: package.json
	$(NPM) install
	@touch node_modules

.PHONY: install
install: node_modules ## Install all dependencies (incl. dev) for local builds

# ---- build / check ---------------------------------------------------------
.PHONY: build
build: node_modules ## Bundle src/gateway.ts -> dist/gateway.js
	$(NPM) run build

.PHONY: typecheck
typecheck: node_modules ## Type-check without emitting
	$(NPM) run typecheck

.PHONY: check
check: typecheck ## Alias for typecheck

# ---- local run -------------------------------------------------------------
.PHONY: dev-watch
dev-watch: node_modules ## Run src/gateway.ts with live reload (tsx watch, auto-restart)
	@mkdir -p "$(ACPG_LEDGER_DIR)"
	@echo "dev-watch (live reload) on $(ACPG_LISTEN)$(ACPG_WS_PATH)"
	$(NPM) run dev

.PHONY: run
run: build ## Build and run the bundle in the foreground
	@mkdir -p "$(ACPG_LEDGER_DIR)"
	@echo "starting acp-gateway on $(ACPG_LISTEN)$(ACPG_WS_PATH)"
	$(NODE) $(OUT)

.PHONY: dev-run
dev-run: build ## Build and run the bundle in the foreground over plain HTTP
	@mkdir -p "$(ACPG_LEDGER_DIR)"
	@echo "starting acp-gateway (HTTP dev) on $(ACPG_LISTEN)$(ACPG_WS_PATH)"
	ACPG_TLS=off $(NODE) $(OUT)

# ---- isolated local dev ----------------------------------------------------
# Rebuilds web/dist (so UI edits show) then runs src/gateway.ts straight from the
# working tree via tsx — no bundle, so you test exactly what's checked out. It is
# isolated from the prod service on two axes:
#   * port — STAGING_LISTEN (:8791), so it can't collide with prod's :8080
#   * data — STAGING_LEDGER_DIR (./data-staging): its own state.sqlite,
#            permission inbox, and optional TLS cert, so it never reads or writes
#            prod's.
# Defaults to plain HTTP to avoid trusting a dev self-signed cert on your phone.
# Auth comes from .env/.env.local like every other target, or use DEV_AUTH=1 for
# fixed dev/dev browser credentials. Foreground; Ctrl-C to
# stop. Set STAGING_TLS=on to exercise HTTPS/self-signed cert behavior.
.PHONY: dev
dev: node_modules ## Run isolated dev (:8791, HTTP default, HTTPS STAGING_TLS=on, auth DEV_AUTH=1)
	@[ "$(DEV_AUTH)" = "" ] || [ "$(DEV_AUTH)" = "1" ] || { echo "error: DEV_AUTH must be empty or '1'"; exit 1; }
	@[ -n "$(DEV_AUTH_USER)" ]  || { echo "error: set ACPG_AUTH_USER (e.g. in .env or .env.local), or run 'make dev DEV_AUTH=1'"; exit 1; }
	@[ -n "$(DEV_AUTH_TOKEN)" ] || { echo "error: set ACPG_AUTH_TOKEN (e.g. in .env or .env.local), or run 'make dev DEV_AUTH=1'"; exit 1; }
	@[ "$(STAGING_LISTEN)" != "$(ACPG_LISTEN)" ] || { echo "error: STAGING_LISTEN ($(STAGING_LISTEN)) collides with the prod ACPG_LISTEN — pick a different port"; exit 1; }
	@[ "$(STAGING_LEDGER_DIR)" != "$(ACPG_LEDGER_DIR)" ] || { echo "error: STAGING_LEDGER_DIR collides with the prod ACPG_LEDGER_DIR — pick a different dir"; exit 1; }
	@[ -d web/node_modules ] || $(NPM) --prefix web ci
	$(NPM) --prefix web run build
	@mkdir -p "$(STAGING_LEDGER_DIR)"
	@echo "dev gateway on $(STAGING_LISTEN)$(ACPG_WS_PATH) — data $(STAGING_LEDGER_DIR), TLS $(STAGING_TLS) (prod $(ACPG_LISTEN) untouched)"
	@if [ "$(DEV_AUTH)" = "1" ]; then \
		printf '\033[1;31m%s\033[0m\n' "================================================================"; \
		printf '\033[1;37;41m%s\033[0m\n' " WARNING: DEV AUTH ENABLED "; \
		printf '\033[1;33m%s\033[0m\n' "transport: $(DEV_AUTH_TRANSPORT)"; \
		printf '\033[33m%s\033[0m\n' "login: default dev auth is active (username: dev, password: dev)"; \
		printf '\033[33m%s\033[0m\n' "open: $(DEV_AUTH_SCHEME)://dev:dev@$(DEV_AUTH_URL_HOST)/"; \
		printf '\033[1;31m%s\033[0m\n' "================================================================"; \
	fi
	env ACPG_LISTEN="$(STAGING_LISTEN)" ACPG_LEDGER_DIR="$(STAGING_LEDGER_DIR)" ACPG_TLS="$(STAGING_TLS)" ACPG_AUTH_USER="$(DEV_AUTH_USER)" ACPG_AUTH_TOKEN="$(DEV_AUTH_TOKEN)" $(NODE) --import tsx src/gateway.ts

.PHONY: staging
staging: ## Alias for dev
	@$(MAKE) dev

# ---- production deployment -------------------------------------------------
# `deploy` builds, sanity-checks the shared auth credentials, then runs start.sh
# detached in tmux so it survives your SSH session. The host is assumed to have
# `claude` installed and logged in, which claude-agent-acp reuses from ~/.claude.
.PHONY: deploy
deploy: build ## Build + launch under a detached tmux session (production)
	@command -v $(TMUX) >/dev/null 2>&1 || { echo "error: tmux not installed — 'apt/yum install tmux', or use 'make run' under your own supervisor"; exit 1; }
	@[ -n "$$ACPG_AUTH_USER" ] || { echo "error: set ACPG_AUTH_USER (the gateway account username)"; exit 1; }
	@[ -n "$$ACPG_AUTH_TOKEN" ] || { echo "error: set ACPG_AUTH_TOKEN (the gateway account password/token); e.g. ACPG_AUTH_TOKEN=\$$(head -c 24 /dev/urandom | base64)"; exit 1; }
	@if $(TMUX) has-session -t $(SESSION) 2>/dev/null; then echo "error: tmux session '$(SESSION)' already running — 'make restart' or 'make logs'"; exit 1; fi
	@mkdir -p "$(ACPG_LEDGER_DIR)"
	$(TMUX) new -d -s $(SESSION) "./start.sh 2>&1 | tee -a $(LOG_FILE)"
	@sleep 1
	@if $(TMUX) has-session -t $(SESSION) 2>/dev/null; then \
		echo "acp-gateway running in tmux '$(SESSION)' on $(ACPG_LISTEN)$(ACPG_WS_PATH)"; \
		echo "  logs: make logs   attach: make attach   stop: make stop"; \
	else \
		echo "error: gateway exited immediately — last log lines:"; \
		tail -n 20 "$(LOG_FILE)" 2>/dev/null; exit 1; \
	fi

.PHONY: status
status: ## Show whether the tmux deployment is running
	@$(TMUX) has-session -t $(SESSION) 2>/dev/null \
		&& echo "running: tmux session '$(SESSION)' (logs: $(LOG_FILE))" \
		|| echo "not running"

.PHONY: logs
logs: ## Follow the deployment log
	@touch "$(LOG_FILE)"; tail -n 100 -f "$(LOG_FILE)"

.PHONY: attach
attach: ## Attach to the tmux session (detach with Ctrl-b d)
	$(TMUX) attach -t $(SESSION)

.PHONY: stop
stop: ## Stop the tmux deployment
	@$(TMUX) kill-session -t $(SESSION) 2>/dev/null && echo "stopped '$(SESSION)'" || echo "no session '$(SESSION)'"

.PHONY: restart
restart: ## Restart the tmux deployment (stop, then deploy)
	@$(MAKE) stop
	@$(MAKE) deploy

# ---- macOS launchd deployment ----------------------------------------------
# The installed launchd agent runs start.sh with WorkingDirectory set to this
# repo, and the gateway re-reads web/dist per request — so a rebuild here updates
# the served UI even before the restart. `kickstart -k` rebuilds nothing; it just
# kills+relaunches the managed process to pick up a changed server bundle.
.PHONY: install-mac
install-mac: ## macOS: generate ~/Library/LaunchAgents/$(MAC_LABEL).plist from the template (no secrets baked in)
	@[ -n "$(NODE_BIN_DIR)" ] || { echo "error: node not found on PATH — install node (e.g. via nvm/homebrew) first"; exit 1; }
	@[ -f "$(MAC_TEMPLATE)" ] || { echo "error: template not found: $(MAC_TEMPLATE)"; exit 1; }
	@if [ -f "$(MAC_PLIST)" ] && [ "$(FORCE)" != "1" ]; then \
		echo "error: $(MAC_PLIST) already exists — re-run with FORCE=1 to overwrite, then 'make restart-mac'"; exit 1; \
	fi
	@mkdir -p "$(HOME)/Library/LaunchAgents" "$(MAC_LEDGER_DIR)" "$(dir $(MAC_LOG))"
	@sed -e 's|@LABEL@|$(MAC_LABEL)|g' \
	     -e 's|@REPO@|$(CURDIR)|g' \
	     -e 's|@PATH@|$(MAC_PATH)|g' \
	     -e 's|@LEDGER@|$(MAC_LEDGER_DIR)|g' \
	     -e 's|@LOG@|$(MAC_LOG)|g' \
	     -e 's|@ERRLOG@|$(MAC_ERRLOG)|g' \
	     "$(MAC_TEMPLATE)" > "$(MAC_PLIST)"
	@echo "wrote $(MAC_PLIST) (label $(MAC_LABEL), node $(NODE_BIN_DIR))"
	@grep -qsE 'ACPG_AUTH_TOKEN|ACPB_AUTH_TOKEN' .env .env.local 2>/dev/null \
		|| echo "warning: no ACPG_AUTH_TOKEN found in .env/.env.local — start.sh will refuse to launch without it"
	@echo "next: make deploy-mac"

.PHONY: deploy-mac
deploy-mac: ## macOS: install plist if missing, build, load/reload the launchd service
	@if [ ! -f "$(MAC_PLIST)" ]; then \
		$(MAKE) install-mac; \
	fi
	@$(MAKE) build
	@if ! $(LAUNCHCTL) print $(MAC_DOMAIN)/$(MAC_LABEL) >/dev/null 2>&1; then \
		$(MAKE) start-mac; \
	fi
	@$(LAUNCHCTL) kickstart -k $(MAC_DOMAIN)/$(MAC_LABEL)
	@echo "redeployed '$(MAC_LABEL)' — logs: make logs-mac"

# Same as deploy-mac, but first switch to $(DEPLOY_BRANCH) and fast-forward it to
# the latest origin so the redeploy serves the newest committed code. Refuses to
# run with a dirty tree — commit/stash first — so switching branches can't clobber
# uncommitted work.
GIT          ?= git
DEPLOY_BRANCH ?= main
.PHONY: deploy-mac-latest
deploy-mac-latest: ## macOS: checkout $(DEPLOY_BRANCH), pull latest origin, then deploy-mac
	@[ -z "$$($(GIT) status --porcelain)" ] || { echo "error: working tree is dirty — commit or stash first"; exit 1; }
	$(GIT) checkout $(DEPLOY_BRANCH)
	$(GIT) pull --ff-only origin $(DEPLOY_BRANCH)
	@$(MAKE) deploy-mac

.PHONY: restart-mac
restart-mac: ## macOS: reload the launchd service without rebuilding
	@$(LAUNCHCTL) kickstart -k $(MAC_DOMAIN)/$(MAC_LABEL) && echo "restarted '$(MAC_LABEL)'"

.PHONY: status-mac
status-mac: ## macOS: is the launchd service loaded / running?
	@output="$$($(LAUNCHCTL) print $(MAC_DOMAIN)/$(MAC_LABEL) 2>/dev/null)"; \
	if [ $$? -ne 0 ]; then \
		echo "not loaded: $(MAC_LABEL)"; \
	else \
		state="$$(printf '%s\n' "$$output" | awk -F ' = ' '/^[[:space:]]*state = / { print $$2; exit }')"; \
		pid="$$(printf '%s\n' "$$output" | awk -F ' = ' '/^[[:space:]]*pid = / { print $$2; exit }')"; \
		if [ -n "$$pid" ]; then echo "running: $(MAC_LABEL) (pid $$pid)"; \
		else echo "loaded: $(MAC_LABEL) (state $${state:-unknown})"; fi; \
	fi

.PHONY: logs-mac
logs-mac: ## macOS: follow the launchd service log
	@touch "$(MAC_LOG)"; tail -n 100 -f "$(MAC_LOG)"

.PHONY: stop-mac
stop-mac: ## macOS: bootout (unload) the launchd service
	@$(LAUNCHCTL) bootout $(MAC_DOMAIN)/$(MAC_LABEL) 2>/dev/null && echo "unloaded '$(MAC_LABEL)'" || echo "not loaded: $(MAC_LABEL)"

.PHONY: start-mac
start-mac: ## macOS: bootstrap (load) the launchd service from its plist
	@[ -f "$(MAC_PLIST)" ] || { echo "error: plist not found: $(MAC_PLIST)"; exit 1; }
	@if $(LAUNCHCTL) print $(MAC_DOMAIN)/$(MAC_LABEL) >/dev/null 2>&1; then \
		echo "already loaded: $(MAC_LABEL)"; \
	else \
		output="$$($(LAUNCHCTL) bootstrap $(MAC_DOMAIN) "$(MAC_PLIST)" 2>&1)"; status=$$?; \
		if [ $$status -eq 0 ]; then \
			echo "loaded '$(MAC_LABEL)'"; \
		elif printf '%s\n' "$$output" | grep -Eq 'Bootstrap failed: 125|Domain does not support specified action'; then \
			legacy_output="$$($(LAUNCHCTL) load -w "$(MAC_PLIST)" 2>&1)"; \
			if $(LAUNCHCTL) print $(MAC_DOMAIN)/$(MAC_LABEL) >/dev/null 2>&1; then \
				echo "loaded '$(MAC_LABEL)' (launchctl load compatibility mode)"; \
			else \
				printf '%s\n%s\n' "$$output" "$$legacy_output" >&2; exit $$status; \
			fi; \
		else \
			printf '%s\n' "$$output" >&2; exit $$status; \
		fi; \
	fi

# ---- housekeeping ----------------------------------------------------------
.PHONY: clean
clean: ## Remove build output
	rm -rf dist

.PHONY: distclean
distclean: clean ## Remove build output and installed dependencies
	rm -rf node_modules

# acp-gateway

Expose local ACP coding agents over a private network with an authenticated web
UI and an SSE/POST transport.

`acp-gateway` runs one or more ACP agents as local stdio child processes, then
serves them through a browser UI or a remote ACP client. It does not host agents
somewhere else: the agent binary, project checkout, and agent login state must be
available on the same host or inside the same container as the gateway.

![acp-gateway architecture](docs/architecture.png)

## Features

- Browser chat UI at `/`, protected by HTTP Basic auth.
- SSE downstream + POST upstream ACP transport for remote clients.
- Multiple named agents via `agents.json`, with runtime agent switching.
- File preview side panel: the agent's plan, every file the work touched (tool
  calls merged with `git status`), what it only read, per-file diffs, and image
  previews.
- Per-agent replay ledger for mobile disconnect/reconnect handling.
- Built-in TLS by default, with self-signed cert generation or bring-your-own certs.
- History browsing for supported agents: Claude Code, Codex, and opencode.

## Requirements

- Node.js 20+ and npm. Server-side state uses `better-sqlite3` on this branch.
  This is the `legacy/node20` branch; `main` requires Node 24+ and uses Node's
  built-in `node:sqlite` instead, and `legacy/node22` targets Node 22 (also
  with `better-sqlite3`).
- `openssl` if using the default generated self-signed TLS certificate.
- At least one ACP agent available on the gateway host:
  - Claude: `claude` installed and logged in.
  - Codex: `OPENAI_API_KEY` / `CODEX_API_KEY`, or `codex login`.
  - opencode: `opencode` installed and authenticated separately.

## Quick Start

```sh
npm install
cp env.example .env
cp agents.example.json agents.json
```

Edit `.env` and set the required gateway account:

```sh
ACPG_AUTH_USER=acp
ACPG_AUTH_TOKEN=change-me-to-a-long-random-secret
```

Edit `agents.json` so each agent's `cwd` points at a real project directory:

```json
{
  "claude": {
    "cmd": "node_modules/.bin/claude-agent-acp",
    "args": [],
    "cwd": "/path/to/project"
  },
  "codex": {
    "cmd": "node_modules/.bin/codex-acp",
    "args": [],
    "cwd": "/path/to/project"
  }
}
```

Start the gateway:

```sh
./start.sh
```

Open the web UI:

```text
https://localhost:8080/
```

The default TLS certificate is self-signed, so your browser or client will ask
you to trust it. For local browser testing without TLS setup:

```sh
make dev DEV_AUTH=1
```

That starts an isolated dev gateway on port `8791` over HTTP with temporary
`dev` / `dev` credentials and prints a colored warning banner.

## Configuration

The gateway reads environment variables from the shell and from `.env`.
`env.example` is the source of truth for available settings.

Required:

| Variable | Purpose |
|---|---|
| `ACPG_AUTH_USER` | Username for HTTP Basic auth and remote ACP clients. |
| `ACPG_AUTH_TOKEN` | Password/token for HTTP Basic auth and remote ACP clients. |

Common optional settings:

| Variable | Default | Purpose |
|---|---:|---|
| `ACPG_LISTEN` | `0.0.0.0:8080` | Gateway listen address. |
| `ACPG_LEDGER_DIR` | `/data` | Ledger, SQLite state, and generated TLS material. Use persistent storage. |
| `ACPG_AGENTS_FILE` | `./agents.json` | Agent definitions. |
| `ACPG_DEFAULT_AGENT` | first agent | Agent selected when a client does not specify one. |
| `ACPG_TLS` | `on` | Set `off` only behind trusted local/dev transport or a TLS-terminating proxy. |
| `ACPG_TLS_CERT` / `ACPG_TLS_KEY` | auto | PEM cert/key paths for bring-your-own TLS. |
| `ACPG_FS_ROOT` | user home | Directory root the web UI may browse for folders and `@` file references. |
| `ACPG_PREVIEW_ROOTS` | _(none)_ | Extra directories the file preview panel may read, colon-separated (e.g. `/tmp`). By default it sees only the conversation's own project — see [What the preview can reach](#what-the-preview-can-reach). |
| `CODEX_HOME` | `~/.codex` | Codex login/session state. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude login/session state and history. |

## Agents

`agents.json` maps agent names to commands:

```json
{
  "claude": { "cmd": "node_modules/.bin/claude-agent-acp", "args": [], "cwd": "/workspace" },
  "codex": { "cmd": "node_modules/.bin/codex-acp", "args": [], "cwd": "/workspace" },
  "opencode": { "cmd": "/usr/local/bin/opencode", "args": ["acp"], "cwd": "/workspace" }
}
```

Relative `cmd` values resolve from the gateway install directory. `cwd` is the
project directory the agent works in. If `cwd` is omitted, `ACPG_AGENT_CWD` is
used, then the gateway user's home directory.

The gateway skips agent entries whose command does not exist, so one shared
`agents.json` can include optional agents. It exits if no usable agents remain.

## File Preview

An agent working through the gateway writes real files on the gateway host —
edited modules, generated reports, screenshots. The **Files** button in the top
bar opens a side panel for reading them back. It has two modes:

**Session** — what this conversation did, as one scrolling column of collapsible
sections. The default.

| Section | What it shows |
|---|---|
| Progress | The agent's current plan, when it has published one. |
| Outputs | Every file this turn's work touched: what the conversation wrote (from its own tool calls) merged with what `git status` reports dirty in the checkout. One row per file. A file git tracks leads with git's status letter (`A`/`M`/`D`/`R`/`U`) and its `+`/`−` line counts; anything git has nothing to say about — a file written to `/tmp`, written and reverted, or already committed — leads with its type icon instead. |
| Context | Files the conversation only consulted — read, searched, fetched. |

**Project** — the folder itself, as a lazily-expanded tree with a pinned **Find
files** box that matches on any part of a path. Every list in Session is built
*from* the conversation, so none of them knows about a file nobody has touched
yet; this is how you open one. Entries `git` ignores are dimmed rather than
hidden, and `.git` is the one thing left out.

Two modes rather than a fourth section, because the tree wants the panel's full
height and answers a question you know you are asking. Within Session the three
lists stay stacked and simultaneously visible — splitting *those* into tabs is
what makes a reader guess which list knows about a given file.

Opening a row shows that file:

| View | What it shows |
|---|---|
| Diff | A file's unified diff against `HEAD`, staged and unstaged work together. A new file diffs as entirely added. |
| File | The file itself: text, or an inline image, or a download for anything binary. |

In the conversation, a file the agent wrote appears as a card — its type and a
download button — instead of a line of monospace; a file it only read stays a
plain path. Both open the panel on that file.

On a wide screen the panel is a column you can drag wider or narrower by its
left edge; the width is remembered per device. Below 1100px it is a sheet.

### What the preview can reach

By default the panel reads **the conversation's own project and nothing else**:

1. anything under the conversation's folder (its `cwd`);
2. anything under the git repository that folder sits in — because Outputs
   includes the whole checkout's `git status`, a conversation opened on a
   subdirectory would otherwise show repo-wide rows it then refused to open;
3. anything under a directory you name in **`ACPG_PREVIEW_ROOTS`**.

The `cwd` itself is still checked against `ACPG_FS_ROOT`, so a client cannot
widen its own reach by asking for `cwd=/`.

Rule 3 is the escape hatch, and it is opt-in on purpose. An agent's output does
not always land in the checkout — "write the screenshot to `/tmp`" is an
ordinary instruction — and a viewer that then refuses to show the file is
reporting its own configuration rather than the work. Making that an explicit
list keeps the panel's reach something a deployment states out loud instead of
turning the gateway credential into a read-any-file capability:

```sh
ACPG_PREVIEW_ROOTS=/tmp:/var/exports   # colon-separated, PATH-style
```

Everything else about the surface: Basic auth on every route, read-only (nothing
here writes, stages, or reverts), `/workspace/raw` serving common raster image
types with their real content type and **everything else** as an opaque
`attachment` with `nosniff` and a deny-everything CSP — so a generated `.html`
or `.svg` can never run as script in the console's origin — plus a 25 MB cap per
raw response and caps on diff and text size.

The two sources are merged because neither subsumes the other, and having to
know which one knew about a given file was the panel's own bookkeeping leaking
into the UI. Tool calls see files that git cannot — written and reverted,
already committed, or outside any checkout. `git status` sees files no tool call
names: **anything an agent writes through a shell** (`Bash`, and every codex or
opencode edit) reports a command, never a path. `git status` runs when the panel
opens and again when a turn finishes; without a git checkout the list falls back
to tool calls alone and says so.

It reads through six authenticated endpoints (`/workspace/changes`,
`/workspace/diff`, `/workspace/file`, `/workspace/raw`, `/workspace/tree`,
`/workspace/find`) — see *What the preview can reach* above for their boundary,
which is deliberately the same one for all six: a tree that listed more than the
viewer can open would offer rows it then refuses. Listing changed files requires
`git` on the gateway host; a folder that isn't a checkout simply shows nothing to
compare.

Find files asks `git` for the file list, so it never walks into `node_modules`
and never misses a dotfile — the same rule that dims a row in the tree decides
whether it is a search candidate. Without a checkout it falls back to a bounded
walk that folds away the usual build and dependency directories by name.

## Deployment

Choose the deployment model based on where the agent login state lives:

| Use case | Recommended path |
|---|---|
| Quick host or VM test | `make deploy` or run `./start.sh` under your own supervisor. |
| Linux service reusing host login state | systemd example in [`deploy/`](deploy/). |
| macOS service reusing local Claude login | `make deploy-mac` or the launchd example in [`deploy/`](deploy/). |
| Containerized deployment | Docker/Compose examples in [`deploy/`](deploy/), with agent login state mounted in. |

Deployment artifacts and notes live in [deploy/README.md](deploy/README.md).

## Remote ACP Clients

Remote clients use SSE for agent-to-client frames and POST for client-to-agent
frames:

```text
GET  https://<host>:8080/acp/sse?user=<user>&token=<token>&agent=claude
POST https://<host>:8080/acp/rpc?user=<user>&token=<token>&agent=claude&conn=<conn>
```

The SSE stream first emits `ready` with a `conn` id. POST requests use that id to
route frames back to the right stream. Clients can resume by sending the last SSE
`id` as `Last-Event-ID` or `?lastEventId=<n>`.

Native clients first call authenticated `GET /client-config`. It returns a
schema-versioned, credential-free description of the transport paths, available
agents, their history/session-load capabilities, and filesystem root. Older
gateways return 404 so clients can use a compatibility UI; clients must treat an
unsupported schema as incompatible rather than guessing its fields.

## Security

- All HTTP surfaces except `GET /healthz` require the shared gateway account.
- TLS is on by default. Without configured certs, the gateway generates and
  reuses a self-signed cert under `ACPG_TLS_DIR`.
- `GET /healthz` is intentionally unauthenticated and returns only status,
  version, and agent names. It does not expose `cwd`, history support, or
  resume details.
- Auth is a single shared account. There is no per-user identity or permission
  model in the gateway.

## Development

```sh
npm run build
npm run typecheck
npm test
npm --prefix web test
```

Useful local targets:

```sh
make dev             # isolated dev gateway, HTTP by default
make dev DEV_AUTH=1  # fixed dev/dev credentials for browser testing
make dev-watch       # live reload
make help            # all make targets
```

## Documentation

- [env.example](env.example): complete environment variable reference.
- [agents.example.json](agents.example.json): starter multi-agent config.
- [deploy/README.md](deploy/README.md): Docker, systemd, and launchd deployment examples.

## License

See [LICENSE](LICENSE).

# cloud-acp-gateway Conventions

## Pull Requests
- PRs are opened on GitHub (`bamoo456/cloud-acp-gateway`).
- Every PR must be opened against **both** `main` and `legacy/node20` — this repo maintains a Node 20-compatible fork of each branch (e.g. `feat/foo` + `feat/foo-node20`).

## Deployment / Task Automation
- Prefer `Makefile` targets over ad-hoc commands for dev, build, and deploy tasks (`make dev`, `make deploy`, `make deploy-mac`, etc. — see `Makefile` header for the full list).

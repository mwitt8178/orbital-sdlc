# Orbital Vault Sync — Obsidian Plugin

[Engineer-Principal · Opus · run-obsidian-vault-sync]

Pulls aggregates (visions, epics, stories, acceptance criteria, retros, memory)
from your Orbital workspace into a local Obsidian vault.

## v1 (this scaffold)

- One command: **Orbital: Sync from Orbital**
- Authenticates via OAuth 2.0 device-code flow against the existing Orbital
  Cognito user pool. The plugin opens the verification URL in the user's
  browser; the user pastes the verification code; the plugin polls until
  the device flow returns a JWT.
- Calls `vault.listForPlugin` against the configured Orbital API URL to get
  a manifest + signed URLs for each markdown file.
- Pulls each file via the signed URL and writes it to the vault preserving
  the `projects/<slug>/<folder>/<file>.md` layout.

## v2 (future)

- Push-back: edits made in Obsidian get round-tripped to Orbital aggregates
  via a confirmation dialog. Out of scope for this PR.

## Setup

1. Build: `npm install && npm run build`
2. Copy `manifest.json` + `main.js` into `<vault>/.obsidian/plugins/orbital-vault-sync/`.
3. Enable the community plugin in Obsidian.
4. Run **Orbital: Configure** to set the API URL + tenant ID.
5. Run **Orbital: Sign in** to walk the device-code flow.
6. Run **Orbital: Sync from Orbital** to pull.

## Why is this in the monorepo?

The plugin shares the markdown frontmatter shape with the server-side
projector (`packages/orchestrator/src/vault-sync/markdown.ts`). Keeping
both in one repo means a single Zod schema is the source of truth for
both ends of the bridge, even though the runtimes are different.

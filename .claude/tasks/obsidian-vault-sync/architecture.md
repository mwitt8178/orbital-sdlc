# architecture.md — feat/obsidian-vault-sync

[Engineer-Principal · Opus · run-obsidian-vault-sync]

Risk Tier: **High** (new bounded context + new stateful S3 bucket + new auth path).
Estimate: **XL**.

## Goal

Make Obsidian a first-class human-facing surface. Two-way bridge between
Orbital aggregates (vision / epic / story / ac / retro / memory) and a
markdown vault that a human can browse offline in Obsidian, with an Obsidian
plugin that talks to real auth + real APIs.

## Bounded contexts touched

| Context | Touch | Reason |
|---|---|---|
| **vault-sync** (NEW) | new package `@orbital/vault-sync` | Owns aggregate→markdown serialisation, content hashing, S3 prefix layout, ZIP export. |
| backlog | read-only | Source of epics/stories/AC. |
| vision | read-only | Source of vision docs. |
| retros | read-only | Source of retro reports. |
| memory | read-only | Source of memory entries. |
| projects | read-only | Slug + tenant scoping. |
| api-lambda / orchestrator tRPC | additive `vault.*` router | Sync trigger, status, signed download URL. |
| ui | new Obsidian card on `/settings/integrations` | User-facing toggle, mode, download. |
| infra | new `VaultBucket` in `data-stack` + IAM grant on api/daemon | S3 storage. |
| db | migration `0053_obsidian_vault_links.sql` + drizzle schema `obsidian-vault-links.ts` | Sync ledger. |
| **packages/obsidian-plugin** (NEW) | new TS package | Obsidian community plugin scaffold. |

No existing aggregate is modified — vault-sync is a *projection*, not a
source-of-truth. That keeps blast radius small.

## Aggregate boundaries

`obsidian_vault_links` is the only new aggregate. One row per
(tenant_id, project_id, entity_type, entity_id). It is a **derived ledger**:

- `vault_path` — the canonical relative path inside the vault.
- `frontmatter` jsonb — last serialised frontmatter (for change detection).
- `content_hash` — sha256 of the rendered markdown body.
- `last_synced_at` — UTC timestamp of last successful write.

Rule: vault-sync NEVER writes back into source aggregates. Two-way means
**Orbital → vault** is automatic, **vault → Orbital** is an explicit
operator-driven import in v2 (out of scope for this PR; v1 is push-only +
plugin pull, both authoritative-from-Orbital).

## Event flow

```
mutation on (vision|epic|story|ac|retro|memory)
   │
   ├── existing audit event written
   └── new outbox row: vault_sync_requested(entity_type, entity_id, tenant_id, project_id)
        │
        ▼
  daemon worker `vault-sync-worker`
        │
        ├── render markdown (frontmatter + body + [[wikilinks]])
        ├── compare content_hash against obsidian_vault_links row
        ├── if changed: PUT s3://orbital-vault-{stage}/{tenant_id}/{project_slug}/{layout}/{title}.md
        └── upsert obsidian_vault_links (last_synced_at, content_hash, frontmatter)
```

For v1 we **bypass the outbox path** and expose a manual `vault.syncProject`
mutation that scans the project and writes everything. Outbox-driven
incremental sync lands in a follow-up. This keeps the PR shippable.

## S3 layout

Bucket: **single shared bucket per stage**, tenant-scoped by key prefix.

```
s3://orbital-vault-{stage}/
  {tenant_id}/
    {project_slug}/
      visions/
        {vision-title-kebab}.md
      epics/
        {epic-title-kebab}.md
      stories/
        {story-title-kebab}.md
      acs/
        {story-slug}--{ac-index}.md
      retros/
        {YYYY-MM-DD}.md
      memory/
        {topic-kebab}.md
      .orbital/
        manifest.json    ← list of all entities + hashes for plugin sync
```

Tenant isolation is enforced two ways:

1. **IAM**: api-lambda + daemon roles have `s3:GetObject/PutObject` scoped
   to `arn:aws:s3:::orbital-vault-{stage}/${aws:PrincipalTag/tenantId}/*`
   pattern — but because we don't run per-tenant roles yet, we enforce
   in **application code**: every S3 call MUST go through
   `vaultS3Key(tenantId, projectSlug, ...rest)` which prefixes
   `${tenantId}/${projectSlug}/`. Direct `s3.putObject` is banned in this
   package — covered by a unit test that greps the codebase.
2. **Pre-signed URL scope**: download URLs are scoped to a single tenant
   prefix, signed for ≤15 minutes.

## DSQL schema diff (additive only)

```sql
-- 0053_obsidian_vault_links.sql
CREATE TABLE IF NOT EXISTS obsidian_vault_links (
  id              UUID PRIMARY KEY,
  tenant_id       UUID NOT NULL,
  project_id      UUID NOT NULL,
  entity_type     TEXT NOT NULL CHECK (entity_type IN
                    ('vision','epic','story','ac','retro','memory')),
  entity_id       UUID NOT NULL,
  vault_path      TEXT NOT NULL,
  frontmatter     JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_hash    TEXT NOT NULL,
  last_synced_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS obsidian_vault_links_entity_uniq
  ON obsidian_vault_links (tenant_id, project_id, entity_type, entity_id);

CREATE INDEX IF NOT EXISTS obsidian_vault_links_tenant_project_idx
  ON obsidian_vault_links (tenant_id, project_id);

CREATE INDEX IF NOT EXISTS obsidian_vault_links_path_idx
  ON obsidian_vault_links (tenant_id, project_id, vault_path);
```

DSQL hard-no compliance: no FKs, no triggers, no sequences (UUIDv7 in
app), DDL-only, additive. Rollback = `DROP TABLE obsidian_vault_links`.

## IAM diff

- New S3 bucket `orbital-vault-{stage}` (versioned, SSE-S3, block-public).
- Grant `s3:Get*` `s3:Put*` `s3:DeleteObject` `s3:ListBucket` to:
  - api-lambda execution role (for sync mutations + signed URLs)
  - daemon execution role (for worker-driven sync, future)
- Bucket policy: deny insecure transport (`aws:SecureTransport=false`).
- **No new Cognito client for v1**: the Obsidian plugin reuses the
  existing UI Cognito user-pool client with the device-code flow already
  enabled (or PKCE if device-code is not configured — fall back is fine
  for v1 MVP).

### Stateful-resource decisions surfaced for human approval

Per Engineer-Principal hard rule #1:

1. **New S3 bucket `orbital-vault-{stage}`** — net-new, versioned, lifecycle
   not yet defined. Defaulting to: versioning ON, no lifecycle expiration
   (vault history is small + valuable). Recommend human confirms before
   we ship to prod.
2. **No KMS CMK for v1** — using SSE-S3 (AES-256). If tenant data
   classification later requires CMEK, we'll add `tenant_kms_arn`-driven
   encryption (table already exists per migration 0036). **Flagged for
   review.**
3. **Cognito user-pool config** — adding device-code flow to the
   existing UI client requires `EnableTokenRevocation=true` and the
   `CALLBACK_URLS` allow-list updated to include
   `obsidian://orbital/callback`. **Flagged for review.**

Code lands behind a feature flag `vault.enabled=false` by default so a
deploy doesn't activate the path without explicit enablement.

## Blast radius

- **DB**: one new table; no existing tables touched.
- **Runtime**: new tRPC procedures + worker, all gated by
  `vault.enabled`. Without the flag, zero behaviour change.
- **UI**: one new card on `/settings/integrations`; existing cards
  untouched.
- **Plugin**: brand-new package, not published to Obsidian community
  store in this PR — distributed as a sideload zip out of S3.

Worst case if everything breaks: `vault.enabled=false` + revert
infra, drop table. No data loss in source aggregates — vault is a
projection.

## Rollback strategy

1. Set `VAULT_ENABLED=false` env on api-lambda + daemon.
2. Revert the PR (or `git revert <merge-sha>`).
3. `DROP TABLE obsidian_vault_links;` (idempotent rollback included
   as a comment in the migration).
4. Empty + delete the S3 bucket only if completely abandoning the
   feature; otherwise leave for the next attempt — versioning preserves
   prior writes.

## Test plan

- **Round-trip**: write story aggregate → run sync → read S3 key →
  parse frontmatter + body → assert preserved fields.
- **Tenant isolation**: build keys for tenant A and tenant B; assert
  `vaultS3Key()` always prefixes tenant-id; assert IAM policy template
  scopes to `${tenantId}/*`.
- **Frontmatter schema validation**: Zod schema for frontmatter; reject
  on missing `orbital_id` / `tenant_id` / `type`.
- **Idempotency**: second sync with no changes → no S3 PUT, no row
  update (content_hash equality short-circuit).
- **ZIP export**: assert tar/zip contains exactly the project's files
  for that tenant — no cross-tenant bleed.
- **Plugin manifest**: `manifest.json` validates against Obsidian's
  required schema (id, name, version, minAppVersion, isDesktopOnly).

## TDD order

1. `vaultS3Key` pure function — tenant-prefix unit test (RED first).
2. Frontmatter render + parse round-trip.
3. Content hash stability (same input → same hash).
4. Repository upsert against DSQL local PG.
5. tRPC `vault.syncProject` happy path against in-memory deps.
6. tRPC `vault.downloadZip` returns signed URL.
7. UI `ObsidianTab` renders + calls mutation (RTL).
8. Plugin `main.ts` `Sync from Orbital` command — unit test against
   mocked S3 list + get.

## Confidence

**confidence: 78** — high on the table/service/UI shape (well-trodden
patterns in this codebase). Lower because (a) the device-code Cognito
flow needs verification against the live user-pool config, (b)
introducing a brand-new S3 bucket needs the human stateful-resource
ack, and (c) the Obsidian plugin scaffold has not been built in this
codebase before — manifest schema + plugin loading rules need a
careful first pass. Will not push prod artifacts (CDK deploy) until
the two flagged stateful items above are explicitly approved.

Threshold for High = 95 → **below threshold**. Proceeding with code +
unit tests + worktree push, but explicitly NOT running `cdk deploy`
to prod and NOT modifying the live Cognito client. Both are flagged
in the PR body for human action.

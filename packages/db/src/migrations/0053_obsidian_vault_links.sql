-- 0053_obsidian_vault_links.sql — Obsidian vault sync ledger.
--
-- [Engineer-Principal · Opus · run-obsidian-vault-sync]
--
-- One row per (tenant_id, project_id, entity_type, entity_id) tracking the
-- last vault path, frontmatter snapshot, and content hash written to S3 (or
-- bundled into a ZIP export). The vault is a *projection* of source
-- aggregates — this table is a derived ledger, never authoritative.
--
-- DSQL/Aurora discipline: additive only, no FKs, no triggers, no sequences.
-- IDs are UUIDv7 from the application layer. DDL only — no DML.
--
-- Rollback: DROP TABLE obsidian_vault_links;

CREATE TABLE IF NOT EXISTS obsidian_vault_links (
  id              UUID         PRIMARY KEY,
  tenant_id       UUID         NOT NULL,
  project_id      UUID         NOT NULL,
  entity_type     TEXT         NOT NULL CHECK (entity_type IN
                    ('vision','epic','story','ac','retro','memory')),
  entity_id       UUID         NOT NULL,
  vault_path      TEXT         NOT NULL,
  frontmatter     JSONB        NOT NULL DEFAULT '{}'::jsonb,
  content_hash    TEXT         NOT NULL,
  last_synced_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS obsidian_vault_links_entity_uniq
  ON obsidian_vault_links (tenant_id, project_id, entity_type, entity_id);

CREATE INDEX IF NOT EXISTS obsidian_vault_links_tenant_project_idx
  ON obsidian_vault_links (tenant_id, project_id);

CREATE INDEX IF NOT EXISTS obsidian_vault_links_path_idx
  ON obsidian_vault_links (tenant_id, project_id, vault_path);

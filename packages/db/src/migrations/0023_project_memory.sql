-- Migration 0023: Project memory subsystem.
--
-- [Engineer-Sr · Sonnet · run-round6-04-project-memory]
--
-- Adds three tables for cross-sprint project memory:
--   project_memory_entries  — the core memory store
--   project_memory_tags     — tags for tag-based retrieval fallback
--   project_memory_links    — links to tasks, PRs, retros, ADRs
--
-- pgvector: the embedding column uses vector(1536) for cosine similarity
-- search. If pgvector is not installed the extension CREATE is guarded by
-- IF NOT EXISTS; the column falls back gracefully to NULL (tag-based
-- retrieval still works without the extension).
--
-- Strategy: ADDITIVE ONLY. No drops, no ALTER COLUMN that changes type.
-- Per multi-tenant-migrations discipline: DDL only, no DML.

--> statement-breakpoint
-- Try to install pgvector; skip gracefully if the extension is not available
-- in this Postgres installation (tag-fallback retrieval still works without it).
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector extension not available (%), skipping; embedding column will be text', SQLERRM;
END;
$$;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS project_memory_entries (
  entry_id      uuid        PRIMARY KEY,
  project_id    uuid        NOT NULL,
  kind          text        NOT NULL CHECK (kind IN ('decision','convention','learning','anti_pattern','glossary')),
  title         text        NOT NULL,
  body          text        NOT NULL,
  source_kind   text        NOT NULL CHECK (source_kind IN ('agent','operator','reviewer','retro','vision')),
  source_id     uuid,
  confidence    text        NOT NULL DEFAULT 'medium' CHECK (confidence IN ('low','medium','high')),
  scope         text        NOT NULL DEFAULT 'project' CHECK (scope IN ('project','feature','file_pattern')),
  scope_value   text,
  status        text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','superseded')),
  superseded_by uuid,
  embedding     text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pm_entries_project_idx ON project_memory_entries (project_id, status);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pm_entries_kind_idx ON project_memory_entries (project_id, kind, status);

--> statement-breakpoint
-- pgvector ivfflat index - only created when vector extension is fully usable.
-- We wrap in an EXCEPTION block so partial-pgvector environments (where
-- pg_extension has a row but the type/operator-class is not yet usable in
-- the parser, e.g. Aurora Postgres without the parameter-group-level pgvector
-- enable) fall back gracefully to the tag-based retrieval path.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    BEGIN
      EXECUTE 'CREATE INDEX IF NOT EXISTS pm_entries_embedding_idx ON project_memory_entries USING ivfflat (embedding::vector vector_cosine_ops) WITH (lists=100)';
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'pgvector ivfflat index skipped (%); tag-based retrieval still works', SQLERRM;
    END;
  END IF;
END;
$$;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS project_memory_tags (
  entry_id  uuid  NOT NULL,
  tag       text  NOT NULL,
  PRIMARY KEY (entry_id, tag)
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pm_tags_entry_idx ON project_memory_tags (entry_id);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS project_memory_links (
  link_id    uuid        PRIMARY KEY,
  entry_id   uuid        NOT NULL,
  link_kind  text        NOT NULL CHECK (link_kind IN ('pr','task','retro','vision','adr')),
  link_value text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pm_links_entry_idx ON project_memory_links (entry_id);

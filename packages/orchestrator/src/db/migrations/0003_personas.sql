-- Migration: 0003_personas
-- Per TRD-03 §4.2: persona library tables.
-- Idempotent (safe to re-run).

-- ============================================================================
-- personas
-- ============================================================================

CREATE TABLE IF NOT EXISTS personas (
  persona_id          uuid         PRIMARY KEY,
  slug                text         NOT NULL UNIQUE,
  origin              text         NOT NULL CHECK (origin IN ('baseline', 'user')),
  current_version_id  uuid,
  is_archived         boolean      NOT NULL DEFAULT false,
  archived_at         timestamptz,
  archived_reason     text,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  created_by_actor    jsonb        NOT NULL
);

CREATE INDEX IF NOT EXISTS personas_archived_idx ON personas (is_archived);

-- ============================================================================
-- persona_versions
-- ============================================================================

CREATE TABLE IF NOT EXISTS persona_versions (
  persona_version_id  uuid         PRIMARY KEY,
  persona_id          uuid         NOT NULL REFERENCES personas (persona_id),
  version_number      integer      NOT NULL,
  role_brief_md       text         NOT NULL,
  definition_json     jsonb        NOT NULL,
  definition_hash     text         NOT NULL,
  escalation_policy   jsonb        NOT NULL,
  published_at        timestamptz  NOT NULL DEFAULT now(),
  published_by_actor  jsonb        NOT NULL,
  justification       text         NOT NULL,
  parent_version_id   uuid,
  retro_proposal_id   uuid,
  schema_version      integer      NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS persona_versions_persona_version_unique
  ON persona_versions (persona_id, version_number);

CREATE INDEX IF NOT EXISTS persona_versions_hash_idx
  ON persona_versions (definition_hash);

-- ============================================================================
-- skills
-- ============================================================================

CREATE TABLE IF NOT EXISTS skills (
  skill_id            uuid         PRIMARY KEY,
  slug                text         NOT NULL UNIQUE,
  origin              text         NOT NULL CHECK (origin IN ('baseline', 'user')),
  current_version_id  uuid,
  is_archived         boolean      NOT NULL DEFAULT false,
  created_at          timestamptz  NOT NULL DEFAULT now()
);

-- ============================================================================
-- skill_versions
-- ============================================================================

CREATE TABLE IF NOT EXISTS skill_versions (
  skill_version_id    uuid         PRIMARY KEY,
  skill_id            uuid         NOT NULL REFERENCES skills (skill_id),
  version_number      integer      NOT NULL,
  frontmatter_json    jsonb        NOT NULL,
  body_md             text         NOT NULL,
  content_hash        text         NOT NULL,
  published_at        timestamptz  NOT NULL DEFAULT now(),
  published_by_actor  jsonb        NOT NULL,
  justification       text         NOT NULL,
  parent_version_id   uuid,
  schema_version      integer      NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS skill_versions_skill_version_unique
  ON skill_versions (skill_id, version_number);

-- ============================================================================
-- persona_skills
-- ============================================================================

CREATE TABLE IF NOT EXISTS persona_skills (
  persona_version_id  uuid         NOT NULL REFERENCES persona_versions (persona_version_id),
  skill_version_id    uuid         NOT NULL REFERENCES skill_versions (skill_version_id),
  required            boolean      NOT NULL DEFAULT true,
  ordering            integer      NOT NULL,
  PRIMARY KEY (persona_version_id, skill_version_id)
);

CREATE INDEX IF NOT EXISTS persona_skills_persona_idx
  ON persona_skills (persona_version_id);

-- ============================================================================
-- persona_capabilities
-- ============================================================================

CREATE TABLE IF NOT EXISTS persona_capabilities (
  persona_version_id  uuid         PRIMARY KEY REFERENCES persona_versions (persona_version_id),
  default_profile_json jsonb       NOT NULL
);

-- ============================================================================
-- persona_model_affinities
-- ============================================================================

CREATE TABLE IF NOT EXISTS persona_model_affinities (
  persona_version_id  uuid         NOT NULL REFERENCES persona_versions (persona_version_id),
  risk_class          text         NOT NULL,
  preferred_model     text         NOT NULL,
  fallback_model      text,
  max_tokens_hint     integer,
  rationale           text         NOT NULL,
  PRIMARY KEY (persona_version_id, risk_class)
);

-- ============================================================================
-- Append-only enforcement via triggers
-- Per TRD-03 §4.2: UPDATE/DELETE rejected on version tables.
-- ============================================================================

CREATE OR REPLACE FUNCTION reject_persona_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_RECORD: % on % is not allowed; records are append-only.',
    TG_OP, TG_TABLE_NAME;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'persona_versions_no_mutate'
  ) THEN
    CREATE TRIGGER persona_versions_no_mutate
      BEFORE UPDATE OR DELETE ON persona_versions
      FOR EACH ROW EXECUTE FUNCTION reject_persona_mutation();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'skill_versions_no_mutate'
  ) THEN
    CREATE TRIGGER skill_versions_no_mutate
      BEFORE UPDATE OR DELETE ON skill_versions
      FOR EACH ROW EXECUTE FUNCTION reject_persona_mutation();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'persona_skills_no_mutate'
  ) THEN
    CREATE TRIGGER persona_skills_no_mutate
      BEFORE UPDATE OR DELETE ON persona_skills
      FOR EACH ROW EXECUTE FUNCTION reject_persona_mutation();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'persona_capabilities_no_mutate'
  ) THEN
    CREATE TRIGGER persona_capabilities_no_mutate
      BEFORE UPDATE OR DELETE ON persona_capabilities
      FOR EACH ROW EXECUTE FUNCTION reject_persona_mutation();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'persona_model_affinities_no_mutate'
  ) THEN
    CREATE TRIGGER persona_model_affinities_no_mutate
      BEFORE UPDATE OR DELETE ON persona_model_affinities
      FOR EACH ROW EXECUTE FUNCTION reject_persona_mutation();
  END IF;
END;
$$;

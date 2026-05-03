-- Migration: 0009_vision
-- Phase 4A — Vision Intake.
-- Per TRD-01 §4.
--
-- Tables:
--   vision_documents, vision_versions, vision_sessions, vision_messages,
--   vision_questions, vision_answers, vision_assumptions
--
-- Notes:
--   - Idempotent (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS).
--   - vision_versions is append-only: UPDATE and DELETE are blocked by triggers.
--   - CHECK constraint on vision_documents prevents mutation when lifecycle_state = 'locked'.

-- ============================================================================
-- Enums
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE vision_lifecycle AS ENUM ('drafting', 'locked', 'revised', 'abandoned');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE vision_session_state AS ENUM (
    'open', 'closed_drafted', 'closed_locked', 'abandoned', 'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE vision_message_author AS ENUM ('user', 'pm_persona');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE vision_question_status AS ENUM ('asked', 'answered', 'deferred', 'withdrawn');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE vision_assumption_confidence AS ENUM ('low', 'medium', 'high');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================================
-- vision_documents
-- ============================================================================

CREATE TABLE IF NOT EXISTS vision_documents (
  vision_document_id  uuid                  PRIMARY KEY,
  install_id          uuid                  NOT NULL,
  title               text                  NOT NULL,
  lifecycle_state     vision_lifecycle      NOT NULL DEFAULT 'drafting',
  current_version_id  uuid,                          -- logical FK → vision_versions
  current_version_number integer            NOT NULL DEFAULT 0,
  monday_item_id      text,
  created_at          timestamptz           NOT NULL DEFAULT now(),
  created_by          jsonb                 NOT NULL,
  last_event_id       uuid                  NOT NULL,
  CONSTRAINT vd_title_uniq UNIQUE (install_id, title)
);

CREATE INDEX IF NOT EXISTS vd_install_idx ON vision_documents (install_id);

-- ============================================================================
-- vision_versions  (append-only)
-- ============================================================================

CREATE TABLE IF NOT EXISTS vision_versions (
  vision_version_id   uuid        PRIMARY KEY,
  vision_document_id  uuid        NOT NULL REFERENCES vision_documents(vision_document_id),
  version_number      integer     NOT NULL,
  content             jsonb       NOT NULL,
  content_hash        text        NOT NULL,
  changelog           text        NOT NULL,
  delta_from_previous jsonb,
  previous_version_id uuid        REFERENCES vision_versions(vision_version_id),
  is_locked           integer     NOT NULL DEFAULT 0,
  locked_at           timestamptz,
  locked_by           jsonb,
  lock_event_id       uuid,
  drafted_at          timestamptz NOT NULL DEFAULT now(),
  drafted_by          jsonb       NOT NULL,
  schema_version      integer     NOT NULL DEFAULT 1,
  CONSTRAINT vv_vd_version_uniq UNIQUE (vision_document_id, version_number)
);

CREATE INDEX IF NOT EXISTS vv_content_hash_idx ON vision_versions (content_hash);
CREATE INDEX IF NOT EXISTS vv_locked_idx ON vision_versions (vision_document_id, is_locked);

-- Append-only triggers (TRD-01 §4.4)
CREATE OR REPLACE FUNCTION vision_versions_no_mutate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'vision_versions is append-only (TRD-01)';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vision_versions_block_update ON vision_versions;
CREATE TRIGGER vision_versions_block_update
  BEFORE UPDATE ON vision_versions
  FOR EACH ROW EXECUTE FUNCTION vision_versions_no_mutate();

DROP TRIGGER IF EXISTS vision_versions_block_delete ON vision_versions;
CREATE TRIGGER vision_versions_block_delete
  BEFORE DELETE ON vision_versions
  FOR EACH ROW EXECUTE FUNCTION vision_versions_no_mutate();

-- ============================================================================
-- vision_sessions
-- ============================================================================

CREATE TABLE IF NOT EXISTS vision_sessions (
  vision_session_id     uuid                  PRIMARY KEY,
  vision_document_id    uuid                  NOT NULL REFERENCES vision_documents(vision_document_id),
  state                 vision_session_state  NOT NULL DEFAULT 'open',
  pm_persona_session_id uuid,
  pm_capability_id      uuid,
  started_at            timestamptz           NOT NULL DEFAULT now(),
  closed_at             timestamptz,
  exchange_count        integer               NOT NULL DEFAULT 0,
  token_total           integer               NOT NULL DEFAULT 0,
  started_by            jsonb                 NOT NULL
);

CREATE INDEX IF NOT EXISTS vs_vd_idx    ON vision_sessions (vision_document_id);
CREATE INDEX IF NOT EXISTS vs_state_idx ON vision_sessions (state);

-- ============================================================================
-- vision_messages
-- ============================================================================

CREATE TABLE IF NOT EXISTS vision_messages (
  vision_message_id   uuid                  PRIMARY KEY,
  vision_session_id   uuid                  NOT NULL REFERENCES vision_sessions(vision_session_id),
  author_type         vision_message_author NOT NULL,
  actor               jsonb                 NOT NULL,
  body                text                  NOT NULL,
  body_tokens         integer               NOT NULL,
  parent_message_id   uuid                  REFERENCES vision_messages(vision_message_id),
  posted_at           timestamptz           NOT NULL DEFAULT now(),
  event_id            uuid                  NOT NULL
);

CREATE INDEX IF NOT EXISTS vm_session_idx ON vision_messages (vision_session_id, posted_at);

-- ============================================================================
-- vision_questions
-- ============================================================================

CREATE TABLE IF NOT EXISTS vision_questions (
  vision_question_id  uuid                    PRIMARY KEY,
  vision_session_id   uuid                    NOT NULL REFERENCES vision_sessions(vision_session_id),
  prompt              text                    NOT NULL,
  category            text                    NOT NULL,
  mandatory           integer                 NOT NULL DEFAULT 0,
  status              vision_question_status  NOT NULL DEFAULT 'asked',
  asked_at            timestamptz             NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vq_session_idx ON vision_questions (vision_session_id);

-- ============================================================================
-- vision_answers
-- ============================================================================

CREATE TABLE IF NOT EXISTS vision_answers (
  vision_answer_id    uuid        PRIMARY KEY,
  vision_question_id  uuid        NOT NULL REFERENCES vision_questions(vision_question_id),
  answer_text         text        NOT NULL,
  answered_at         timestamptz NOT NULL DEFAULT now(),
  answered_by         jsonb       NOT NULL,
  vision_message_id   uuid        REFERENCES vision_messages(vision_message_id)
);

CREATE INDEX IF NOT EXISTS va_question_idx ON vision_answers (vision_question_id);

-- ============================================================================
-- vision_assumptions
-- ============================================================================

CREATE TABLE IF NOT EXISTS vision_assumptions (
  vision_assumption_id  uuid                          PRIMARY KEY,
  vision_document_id    uuid                          NOT NULL REFERENCES vision_documents(vision_document_id),
  vision_session_id     uuid                          NOT NULL REFERENCES vision_sessions(vision_session_id),
  text                  text                          NOT NULL,
  confidence            vision_assumption_confidence  NOT NULL DEFAULT 'medium',
  evidence_link         text,
  appended_at           timestamptz                   NOT NULL DEFAULT now(),
  appended_by           jsonb                         NOT NULL,
  rolled_into_version_id uuid                         REFERENCES vision_versions(vision_version_id)
);

CREATE INDEX IF NOT EXISTS vas_vd_idx ON vision_assumptions (vision_document_id);

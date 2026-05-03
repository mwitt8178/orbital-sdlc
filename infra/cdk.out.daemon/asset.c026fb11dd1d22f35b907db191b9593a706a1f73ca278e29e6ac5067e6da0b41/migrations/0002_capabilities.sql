-- Migration: 0002_capabilities
-- Per TRD-06 §4.1: capability layer tables (grants, denials, revocations,
-- signing keys, key history, policies). All tables are append-only at the
-- trigger level; the only mutable column is `capability_grants.status`,
-- which is updated through a stored procedure registered below.

-- ============================================================================
-- Tables
-- ============================================================================

CREATE TABLE IF NOT EXISTS capability_grants (
  capability_id        uuid         PRIMARY KEY,
  task_id              uuid         NOT NULL,
  session_id           uuid         NOT NULL,
  persona_id           text         NOT NULL,
  sprint_id            uuid         NOT NULL,
  signing_sub_key_id   uuid         NOT NULL,
  scopes               jsonb        NOT NULL,
  parent_capability_id uuid,
  issued_at            timestamptz  NOT NULL,
  expires_at           timestamptz  NOT NULL,
  bundle_hash          text         NOT NULL,
  signature            text         NOT NULL,
  status               text         NOT NULL CHECK (status IN ('issued','active','expired','revoked')),
  schema_version       integer      NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS cg_task_idx    ON capability_grants (task_id);
CREATE INDEX IF NOT EXISTS cg_session_idx ON capability_grants (session_id);
CREATE INDEX IF NOT EXISTS cg_status_idx  ON capability_grants (status, expires_at);
CREATE INDEX IF NOT EXISTS cg_sprint_idx  ON capability_grants (sprint_id);

CREATE TABLE IF NOT EXISTS capability_denials (
  denial_id        uuid         PRIMARY KEY,
  capability_id    uuid,
  task_id          uuid,
  session_id       uuid,
  persona_id       text,
  attempted_tool   text         NOT NULL,
  attempted_target text         NOT NULL,
  reason_code      text         NOT NULL,
  reason_detail    text         NOT NULL,
  prompt_excerpt   text,
  trace_id         text         NOT NULL,
  occurred_at      timestamptz  NOT NULL,
  schema_version   integer      NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS cd_cap_idx  ON capability_denials (capability_id);
CREATE INDEX IF NOT EXISTS cd_time_idx ON capability_denials (occurred_at);
CREATE INDEX IF NOT EXISTS cd_tool_idx ON capability_denials (attempted_tool);

CREATE TABLE IF NOT EXISTS capability_revocations (
  revocation_id   uuid         PRIMARY KEY,
  capability_id   uuid         NOT NULL,
  reason          text         NOT NULL CHECK (reason IN ('task_complete','task_failed','task_cancelled','admin_action','emergency_rotation','sprint_pause')),
  reason_detail   text,
  revoked_by      jsonb        NOT NULL,
  revoked_at      timestamptz  NOT NULL,
  schema_version  integer      NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS cr_cap_idx ON capability_revocations (capability_id);

CREATE TABLE IF NOT EXISTS signing_keys (
  key_id              uuid         PRIMARY KEY,
  key_kind            text         NOT NULL CHECK (key_kind IN ('master','sub')),
  parent_key_id       uuid,
  install_id          uuid         NOT NULL,
  sprint_id           uuid,
  public_key          text         NOT NULL,
  keychain_ref        text,
  parent_signature    text,
  algorithm           text         NOT NULL DEFAULT 'ed25519' CHECK (algorithm IN ('ed25519')),
  created_at          timestamptz  NOT NULL,
  active_from         timestamptz  NOT NULL,
  active_until        timestamptz,
  private_zeroized_at timestamptz,
  status              text         NOT NULL CHECK (status IN ('active','retired','archived','compromised')),
  schema_version      integer      NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS sk_kind_idx   ON signing_keys (key_kind, status);
CREATE INDEX IF NOT EXISTS sk_parent_idx ON signing_keys (parent_key_id);
CREATE INDEX IF NOT EXISTS sk_sprint_idx ON signing_keys (sprint_id);

CREATE TABLE IF NOT EXISTS key_history (
  history_id     uuid         PRIMARY KEY,
  key_id         uuid         NOT NULL,
  transition     text         NOT NULL CHECK (transition IN ('generated','signed_sub','rotated','retired','zeroized','archived','compromised')),
  transition_at  timestamptz  NOT NULL,
  detail         jsonb        NOT NULL,
  actor          jsonb        NOT NULL,
  schema_version integer      NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS kh_key_idx  ON key_history (key_id);
CREATE INDEX IF NOT EXISTS kh_time_idx ON key_history (transition_at);

CREATE TABLE IF NOT EXISTS capability_policies (
  policy_id       uuid         PRIMARY KEY,
  version         integer      NOT NULL,
  source_hash     text         NOT NULL,
  defaults        jsonb        NOT NULL,
  modifiers       jsonb        NOT NULL,
  prohibitions    jsonb        NOT NULL,
  sod_rules       jsonb        NOT NULL,
  activated_at    timestamptz  NOT NULL,
  deactivated_at  timestamptz,
  activated_by    jsonb        NOT NULL,
  schema_version  integer      NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS cp_ver_idx ON capability_policies (version);

-- ============================================================================
-- Append-only triggers
-- Per TRD-06 §8: capability_denials, capability_revocations, key_history
-- reject UPDATE and DELETE. capability_grants permits ONLY status updates
-- via stored procedure (modeled below as a simple status-only constraint —
-- v1 of the trigger blocks any column change other than status).
-- ============================================================================

CREATE OR REPLACE FUNCTION capabilities_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    '% on % is not permitted (table is append-only)',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER capability_denials_reject_update
  BEFORE UPDATE ON capability_denials
  FOR EACH ROW EXECUTE FUNCTION capabilities_reject_mutation();
CREATE TRIGGER capability_denials_reject_delete
  BEFORE DELETE ON capability_denials
  FOR EACH ROW EXECUTE FUNCTION capabilities_reject_mutation();

CREATE TRIGGER capability_revocations_reject_update
  BEFORE UPDATE ON capability_revocations
  FOR EACH ROW EXECUTE FUNCTION capabilities_reject_mutation();
CREATE TRIGGER capability_revocations_reject_delete
  BEFORE DELETE ON capability_revocations
  FOR EACH ROW EXECUTE FUNCTION capabilities_reject_mutation();

CREATE TRIGGER key_history_reject_update
  BEFORE UPDATE ON key_history
  FOR EACH ROW EXECUTE FUNCTION capabilities_reject_mutation();
CREATE TRIGGER key_history_reject_delete
  BEFORE DELETE ON key_history
  FOR EACH ROW EXECUTE FUNCTION capabilities_reject_mutation();

-- capability_grants: only status column may change. Other columns are immutable.
CREATE OR REPLACE FUNCTION capability_grants_only_status_mutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.capability_id        IS DISTINCT FROM OLD.capability_id        OR
     NEW.task_id              IS DISTINCT FROM OLD.task_id              OR
     NEW.session_id           IS DISTINCT FROM OLD.session_id           OR
     NEW.persona_id           IS DISTINCT FROM OLD.persona_id           OR
     NEW.sprint_id            IS DISTINCT FROM OLD.sprint_id            OR
     NEW.signing_sub_key_id   IS DISTINCT FROM OLD.signing_sub_key_id   OR
     NEW.scopes               IS DISTINCT FROM OLD.scopes               OR
     NEW.parent_capability_id IS DISTINCT FROM OLD.parent_capability_id OR
     NEW.issued_at            IS DISTINCT FROM OLD.issued_at            OR
     NEW.expires_at           IS DISTINCT FROM OLD.expires_at           OR
     NEW.bundle_hash          IS DISTINCT FROM OLD.bundle_hash          OR
     NEW.signature            IS DISTINCT FROM OLD.signature            OR
     NEW.schema_version       IS DISTINCT FROM OLD.schema_version
  THEN
    RAISE EXCEPTION 'capability_grants is append-only except for status' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER capability_grants_only_status
  BEFORE UPDATE ON capability_grants
  FOR EACH ROW EXECUTE FUNCTION capability_grants_only_status_mutable();

CREATE TRIGGER capability_grants_reject_delete
  BEFORE DELETE ON capability_grants
  FOR EACH ROW EXECUTE FUNCTION capabilities_reject_mutation();

-- signing_keys: status, active_until, keychain_ref, private_zeroized_at are mutable.
-- All other columns are immutable. Deletes never permitted.
CREATE OR REPLACE FUNCTION signing_keys_immutable_columns()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.key_id            IS DISTINCT FROM OLD.key_id            OR
     NEW.key_kind          IS DISTINCT FROM OLD.key_kind          OR
     NEW.parent_key_id     IS DISTINCT FROM OLD.parent_key_id     OR
     NEW.install_id        IS DISTINCT FROM OLD.install_id        OR
     NEW.sprint_id         IS DISTINCT FROM OLD.sprint_id         OR
     NEW.public_key        IS DISTINCT FROM OLD.public_key        OR
     NEW.parent_signature  IS DISTINCT FROM OLD.parent_signature  OR
     NEW.algorithm         IS DISTINCT FROM OLD.algorithm         OR
     NEW.created_at        IS DISTINCT FROM OLD.created_at        OR
     NEW.active_from       IS DISTINCT FROM OLD.active_from       OR
     NEW.schema_version    IS DISTINCT FROM OLD.schema_version
  THEN
    RAISE EXCEPTION 'signing_keys core columns are immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER signing_keys_immutable
  BEFORE UPDATE ON signing_keys
  FOR EACH ROW EXECUTE FUNCTION signing_keys_immutable_columns();

CREATE TRIGGER signing_keys_reject_delete
  BEFORE DELETE ON signing_keys
  FOR EACH ROW EXECUTE FUNCTION capabilities_reject_mutation();

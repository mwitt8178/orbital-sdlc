-- Migration 0013: Audit Export tables
-- Per TRD-12 §4.2
-- DDL only — no DML, no FK to events (DSQL constraint: no FK to partitioned tables).
-- Append-only enforcement: UPDATE/DELETE triggers on audit_export_chunks and evidence_packages.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS audit.audit_exports (
  export_id        uuid         PRIMARY KEY,
  install_id       uuid         NOT NULL,
  requested_by     jsonb        NOT NULL,
  requested_at     timestamptz  NOT NULL,
  range_start      timestamptz  NOT NULL,
  range_end        timestamptz  NOT NULL,
  scope_filter     jsonb        NOT NULL,
  cutoff_event_id  uuid         NOT NULL,
  status           text         NOT NULL,
  progress_percent integer      NOT NULL DEFAULT 0,
  progress_stage   text,
  package_id       uuid,
  error_code       text,
  error_message    text,
  started_at       timestamptz,
  completed_at     timestamptz,
  cancelled_at     timestamptz,
  capability_id    uuid         NOT NULL,
  justification    text         NOT NULL,
  schema_version   integer      NOT NULL DEFAULT 1
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS audit_exports_install_time ON audit.audit_exports (install_id, requested_at);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS audit_exports_status ON audit.audit_exports (status);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS audit.audit_export_chunks (
  chunk_id      uuid         PRIMARY KEY,
  export_id     uuid         NOT NULL,
  chunk_index   integer      NOT NULL,
  byte_offset   bigint       NOT NULL,
  byte_length   integer      NOT NULL,
  sha256        text         NOT NULL,
  storage_path  text         NOT NULL,
  created_at    timestamptz  NOT NULL
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS audit_export_chunks_export ON audit.audit_export_chunks (export_id, chunk_index);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS audit.evidence_packages (
  package_id          uuid         PRIMARY KEY,
  export_id           uuid         NOT NULL,
  filename            text         NOT NULL,
  total_bytes         bigint       NOT NULL,
  total_chunks        integer      NOT NULL,
  manifest_sha256     text         NOT NULL,
  package_sha256      text         NOT NULL,
  manifest_signature  text         NOT NULL,
  signing_key_id      text         NOT NULL,
  encryption_algo     text         NOT NULL,
  kdf_algo            text         NOT NULL,
  kdf_salt_b64        text         NOT NULL,
  kdf_memory_kib      integer      NOT NULL,
  kdf_iterations      integer      NOT NULL,
  kdf_parallelism     integer      NOT NULL,
  nonce_b64           text         NOT NULL,
  created_at          timestamptz  NOT NULL,
  downloaded_at       timestamptz,
  download_count      integer      NOT NULL DEFAULT 0,
  retained_until      timestamptz  NOT NULL,
  schema_version      integer      NOT NULL DEFAULT 1
);

--> statement-breakpoint
-- Append-only trigger for audit_export_chunks: reject DELETE and UPDATE of
-- all columns except (none are allowed — chunks are immutable once written).
CREATE OR REPLACE FUNCTION audit.reject_chunk_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_export_chunks is append-only; UPDATE/DELETE not permitted';
END;
$$;

--> statement-breakpoint
CREATE TRIGGER audit_export_chunks_no_update
  BEFORE UPDATE ON audit.audit_export_chunks
  FOR EACH ROW EXECUTE FUNCTION audit.reject_chunk_mutation();

--> statement-breakpoint
CREATE TRIGGER audit_export_chunks_no_delete
  BEFORE DELETE ON audit.audit_export_chunks
  FOR EACH ROW EXECUTE FUNCTION audit.reject_chunk_mutation();

--> statement-breakpoint
-- Append-only trigger for evidence_packages: allow UPDATE of downloaded_at
-- and download_count only (auditor download tracking); reject everything else.
CREATE OR REPLACE FUNCTION audit.reject_package_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (
    NEW.package_id        IS DISTINCT FROM OLD.package_id        OR
    NEW.export_id         IS DISTINCT FROM OLD.export_id         OR
    NEW.filename          IS DISTINCT FROM OLD.filename          OR
    NEW.total_bytes       IS DISTINCT FROM OLD.total_bytes       OR
    NEW.total_chunks      IS DISTINCT FROM OLD.total_chunks      OR
    NEW.manifest_sha256   IS DISTINCT FROM OLD.manifest_sha256   OR
    NEW.package_sha256    IS DISTINCT FROM OLD.package_sha256    OR
    NEW.manifest_signature IS DISTINCT FROM OLD.manifest_signature OR
    NEW.signing_key_id    IS DISTINCT FROM OLD.signing_key_id    OR
    NEW.encryption_algo   IS DISTINCT FROM OLD.encryption_algo   OR
    NEW.kdf_algo          IS DISTINCT FROM OLD.kdf_algo          OR
    NEW.kdf_salt_b64      IS DISTINCT FROM OLD.kdf_salt_b64      OR
    NEW.kdf_memory_kib    IS DISTINCT FROM OLD.kdf_memory_kib    OR
    NEW.kdf_iterations    IS DISTINCT FROM OLD.kdf_iterations    OR
    NEW.kdf_parallelism   IS DISTINCT FROM OLD.kdf_parallelism   OR
    NEW.nonce_b64         IS DISTINCT FROM OLD.nonce_b64         OR
    NEW.created_at        IS DISTINCT FROM OLD.created_at        OR
    NEW.retained_until    IS DISTINCT FROM OLD.retained_until    OR
    NEW.schema_version    IS DISTINCT FROM OLD.schema_version
  ) THEN
    RAISE EXCEPTION 'evidence_packages: only downloaded_at and download_count may be updated';
  END IF;
  RETURN NEW;
END;
$$;

--> statement-breakpoint
CREATE TRIGGER evidence_packages_no_immutable_update
  BEFORE UPDATE ON audit.evidence_packages
  FOR EACH ROW EXECUTE FUNCTION audit.reject_package_mutation();

--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit.reject_package_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'evidence_packages is append-only; DELETE not permitted';
END;
$$;

--> statement-breakpoint
CREATE TRIGGER evidence_packages_no_delete
  BEFORE DELETE ON audit.evidence_packages
  FOR EACH ROW EXECUTE FUNCTION audit.reject_package_delete();

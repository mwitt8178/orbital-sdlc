-- Migration 0045: per-project team management
-- [Engineer-Principal · Opus · run-feat-settings-team]
--
-- Strategy: ADDITIVE only. Three new tables. No FKs (DSQL constraint).
-- UUIDv7 minted in app. Append-only discipline for team_audit enforced by
-- service code (DSQL has no triggers).

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS project_members (
  project_id        uuid          NOT NULL,
  user_id           uuid          NOT NULL,
  tenant_id         uuid          NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  email             text          NOT NULL,
  cognito_sub       text,
  role              text          NOT NULL,
  joined_at         timestamptz   NOT NULL DEFAULT now(),
  last_active_at    timestamptz,
  removed_at        timestamptz,
  PRIMARY KEY (project_id, user_id)
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS project_members_project_active_idx
  ON project_members (project_id, removed_at);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS project_members_tenant_idx
  ON project_members (tenant_id);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS project_members_project_email_uniq
  ON project_members (project_id, email);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS project_invites (
  invite_id         uuid          PRIMARY KEY,
  project_id        uuid          NOT NULL,
  tenant_id         uuid          NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  email             text          NOT NULL,
  role              text          NOT NULL,
  status            text          NOT NULL DEFAULT 'sent',
  invited_at        timestamptz   NOT NULL DEFAULT now(),
  invited_by        uuid,
  token             text          NOT NULL,
  expires_at        timestamptz   NOT NULL,
  cognito_sub       text,
  accepted_at       timestamptz,
  revoked_at        timestamptz
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS project_invites_project_status_idx
  ON project_invites (project_id, status);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS project_invites_tenant_idx
  ON project_invites (tenant_id);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS project_invites_token_uniq
  ON project_invites (token);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS team_audit (
  audit_id          uuid          PRIMARY KEY,
  project_id        uuid          NOT NULL,
  tenant_id         uuid          NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  event_type        text          NOT NULL,
  actor_user_id     uuid,
  target_user_id    uuid,
  target_email      text,
  payload           jsonb         NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz   NOT NULL DEFAULT now()
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS team_audit_project_created_idx
  ON team_audit (project_id, created_at DESC);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS team_audit_project_event_idx
  ON team_audit (project_id, event_type, created_at DESC);

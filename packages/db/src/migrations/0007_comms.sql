-- Migration: 0007_comms
-- Phase 3A — Comms Substrate.
-- Per TRD-05 §4.2, §4.3, §4.4, §4.5.
--
-- Owned tables:
--   channels surface (channels.ts):
--     channels, channel_posts, channel_post_types, channel_subscriptions,
--     mentions, cross_references, cross_posts, pinned_posts, reactions,
--     presence_indicators
--   workflow surface (comms-workflow.ts):
--     blockers, ceremony_specifications, ceremonies, ceremony_participants,
--     ceremony_outputs, disagreements, tie_breaker_decisions, adrs
--
-- Notes:
--   - Idempotent (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS).
--   - No FKs into tables in other phases (cross-phase references by id only).
--   - `channel_posts.parent_post_id` is a self-FK added via ALTER TABLE.
--   - `adrs` carries an immutability trigger (TRD-05 §4.5).
--   - Append-only / state-machine enforcement is at the application layer; the
--     `audit.events` REJECT triggers from 0001_events.sql remain authoritative
--     for event integrity.

-- ============================================================================
-- channels
-- ============================================================================

CREATE TABLE IF NOT EXISTS channels (
  channel_id        uuid        PRIMARY KEY,
  name              text        NOT NULL,
  kind              text        NOT NULL
                    CHECK (kind IN ('ticket_durable','ticket_scratch','epic','sprint','topic','ceremony')),
  scope_ref         jsonb       NOT NULL,
  description       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by_actor  jsonb       NOT NULL,
  archived_at       timestamptz,
  schema_version    integer     NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS channels_name_unique ON channels (name);
CREATE INDEX        IF NOT EXISTS channels_kind_idx    ON channels (kind);

-- ============================================================================
-- channel_posts
-- ============================================================================

CREATE TABLE IF NOT EXISTS channel_posts (
  post_id              uuid        PRIMARY KEY,
  channel_id           uuid        NOT NULL REFERENCES channels (channel_id),
  parent_post_id       uuid,
  post_type            text        NOT NULL
                       CHECK (post_type IN (
                         'status_update','decision','blocker','alert',
                         'system_event','cross_post','capability_event','user_guidance',
                         'ceremony_agenda','ceremony_statement','ceremony_vote','ceremony_output_link',
                         'reply'
                       )),
  author_actor         jsonb       NOT NULL,
  payload              jsonb       NOT NULL,
  capability_id        uuid,
  ceremony_id          uuid,
  ceremony_turn_number integer,
  tokens_consumed      integer,
  created_at           timestamptz NOT NULL DEFAULT now(),
  schema_version       integer     NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS channel_posts_channel_idx
  ON channel_posts (channel_id, created_at);
CREATE INDEX IF NOT EXISTS channel_posts_parent_idx
  ON channel_posts (parent_post_id);
CREATE INDEX IF NOT EXISTS channel_posts_ceremony_idx
  ON channel_posts (ceremony_id, ceremony_turn_number);
CREATE INDEX IF NOT EXISTS channel_posts_type_idx
  ON channel_posts (post_type);

-- Self-ref FK (added separately to avoid forward-decl issues).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'channel_posts'
      AND constraint_name = 'channel_posts_parent_fk'
  ) THEN
    ALTER TABLE channel_posts
      ADD CONSTRAINT channel_posts_parent_fk
      FOREIGN KEY (parent_post_id) REFERENCES channel_posts (post_id) ON DELETE SET NULL;
  END IF;
END;
$$;

-- ============================================================================
-- channel_post_types — runtime registry seeded at boot from §7.2 catalog
-- ============================================================================

CREATE TABLE IF NOT EXISTS channel_post_types (
  post_type            text        PRIMARY KEY,
  payload_schema_json  jsonb       NOT NULL,
  schema_version       integer     NOT NULL DEFAULT 1,
  description          text        NOT NULL
);

-- ============================================================================
-- channel_subscriptions
-- ============================================================================

CREATE TABLE IF NOT EXISTS channel_subscriptions (
  subscription_id    uuid        PRIMARY KEY,
  channel_id         uuid        NOT NULL REFERENCES channels (channel_id),
  subscriber_actor   jsonb       NOT NULL,
  task_id            uuid,
  source             text        NOT NULL
                     CHECK (source IN ('default','explicit','capability_grant')),
  capability_id      uuid,
  subscribed_at      timestamptz NOT NULL DEFAULT now(),
  unsubscribed_at    timestamptz,
  schema_version     integer     NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS channel_subs_channel_idx
  ON channel_subscriptions (channel_id) WHERE unsubscribed_at IS NULL;
CREATE INDEX IF NOT EXISTS channel_subs_task_idx
  ON channel_subscriptions (task_id) WHERE unsubscribed_at IS NULL;

-- ============================================================================
-- mentions
-- ============================================================================

CREATE TABLE IF NOT EXISTS mentions (
  mention_id        uuid        PRIMARY KEY,
  post_id           uuid        NOT NULL REFERENCES channel_posts (post_id),
  target_type       text        NOT NULL
                    CHECK (target_type IN ('persona_role','user','persona_session')),
  target_ref        text        NOT NULL,
  delivered_at      timestamptz,
  acknowledged_at   timestamptz,
  priority          integer     NOT NULL DEFAULT 10,
  schema_version    integer     NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS mentions_target_idx
  ON mentions (target_type, target_ref, delivered_at);
CREATE INDEX IF NOT EXISTS mentions_post_idx
  ON mentions (post_id);

-- ============================================================================
-- cross_references
-- ============================================================================

CREATE TABLE IF NOT EXISTS cross_references (
  cross_ref_id      uuid        PRIMARY KEY,
  post_id           uuid        NOT NULL REFERENCES channel_posts (post_id),
  ref_type          text        NOT NULL
                    CHECK (ref_type IN ('ticket','channel','adr','sprint','epic','commit','ceremony','defect')),
  ref_id            text        NOT NULL,
  start_offset      integer     NOT NULL,
  end_offset        integer     NOT NULL
);

CREATE INDEX IF NOT EXISTS cross_refs_ref_idx
  ON cross_references (ref_type, ref_id);

-- ============================================================================
-- cross_posts
-- ============================================================================

CREATE TABLE IF NOT EXISTS cross_posts (
  cross_post_id        uuid        PRIMARY KEY,
  originating_post_id  uuid        NOT NULL REFERENCES channel_posts (post_id),
  derived_post_id      uuid        NOT NULL REFERENCES channel_posts (post_id),
  artifact_ref_type    text        CHECK (artifact_ref_type IN (
                          'adr','sprint_commitment','security_finding',
                          'standup_digest','retro_outcome','ticket_decision'
                        )),
  artifact_ref_id      text,
  badge_label          text        NOT NULL,
  attribution          jsonb       NOT NULL
);

CREATE INDEX IF NOT EXISTS cross_posts_origin_idx
  ON cross_posts (originating_post_id);

-- ============================================================================
-- pinned_posts
-- ============================================================================

CREATE TABLE IF NOT EXISTS pinned_posts (
  pin_id            uuid        PRIMARY KEY,
  channel_id        uuid        NOT NULL REFERENCES channels (channel_id),
  post_id           uuid        NOT NULL REFERENCES channel_posts (post_id),
  pinned_by_actor   jsonb       NOT NULL,
  capability_id     uuid        NOT NULL,
  pinned_at         timestamptz NOT NULL DEFAULT now(),
  unpinned_at       timestamptz,
  reason            text
);

CREATE UNIQUE INDEX IF NOT EXISTS pinned_posts_active_unique
  ON pinned_posts (channel_id, post_id) WHERE unpinned_at IS NULL;

-- ============================================================================
-- reactions
-- ============================================================================

CREATE TABLE IF NOT EXISTS reactions (
  reaction_id       uuid        PRIMARY KEY,
  post_id           uuid        NOT NULL REFERENCES channel_posts (post_id),
  reaction_type     text        NOT NULL
                    CHECK (reaction_type IN ('ack','thumbs_up','concern','eyes','fire')),
  reactor_actor     jsonb       NOT NULL,
  capability_id     uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  removed_at        timestamptz
);

CREATE INDEX IF NOT EXISTS reactions_post_idx
  ON reactions (post_id, reaction_type) WHERE removed_at IS NULL;

-- ============================================================================
-- presence_indicators (mutable)
-- ============================================================================

CREATE TABLE IF NOT EXISTS presence_indicators (
  presence_id        uuid        PRIMARY KEY,
  subscriber_actor   jsonb       NOT NULL,
  channel_id         uuid        NOT NULL REFERENCES channels (channel_id),
  status             text        NOT NULL CHECK (status IN ('active','idle','offline')),
  last_beat_at       timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS presence_channel_idx
  ON presence_indicators (channel_id, status, last_beat_at);

-- ============================================================================
-- blockers
-- ============================================================================

CREATE TABLE IF NOT EXISTS blockers (
  blocker_id                uuid        PRIMARY KEY,
  raising_actor             jsonb       NOT NULL,
  raising_task_id           uuid        NOT NULL,
  ticket_id                 text,
  question                  text        NOT NULL,
  context                   text        NOT NULL,
  requested_resolver_role   text        NOT NULL,
  urgency                   text        NOT NULL DEFAULT 'normal'
                            CHECK (urgency IN ('low','normal','high','critical')),
  state                     text        NOT NULL DEFAULT 'raised'
                            CHECK (state IN ('raised','routed','in_resolution','resolved','escalated','abandoned')),
  routed_to_actor           jsonb,
  routed_to_task_id         uuid,
  routing_attempts          integer     NOT NULL DEFAULT 0,
  max_routing_attempts      integer     NOT NULL DEFAULT 2,
  origin_post_id            uuid,
  resolution_post_id        uuid,
  raised_at                 timestamptz NOT NULL DEFAULT now(),
  resolved_at               timestamptz,
  escalated_at              timestamptz,
  schema_version            integer     NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS blockers_state_idx ON blockers (state, raised_at);
CREATE INDEX IF NOT EXISTS blockers_ticket_idx ON blockers (ticket_id);

-- ============================================================================
-- ceremony_specifications
-- ============================================================================

CREATE TABLE IF NOT EXISTS ceremony_specifications (
  spec_id                          uuid        PRIMARY KEY,
  ceremony_type                    text        NOT NULL
                                   CHECK (ceremony_type IN (
                                     'sprint_planning','backlog_grooming',
                                     'architecture_review','async_standup',
                                     'sprint_retrospective','ad_hoc'
                                   )),
  version                          integer     NOT NULL,
  chair_role                       text        NOT NULL,
  participant_roles                jsonb       NOT NULL,
  agenda_template                  text        NOT NULL,
  output_schema_json               jsonb       NOT NULL,
  default_turns_per_participant    integer     NOT NULL,
  default_tokens_per_turn          integer     NOT NULL,
  default_wall_clock_ms            integer     NOT NULL,
  vote_required                    boolean     NOT NULL DEFAULT true,
  vote_rule                        text        NOT NULL
                                   CHECK (vote_rule IN ('simple_majority','unanimous','chair_decides')),
  schema_version                   integer     NOT NULL DEFAULT 1,
  loaded_at                        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ceremony_specs_type_version_unique
  ON ceremony_specifications (ceremony_type, version);

-- ============================================================================
-- ceremonies
-- ============================================================================

CREATE TABLE IF NOT EXISTS ceremonies (
  ceremony_id              uuid        PRIMARY KEY,
  ceremony_type            text        NOT NULL,
  spec_id                  uuid        NOT NULL,
  channel_id               uuid        NOT NULL,
  state                    text        NOT NULL DEFAULT 'scheduled'
                           CHECK (state IN ('scheduled','in_progress','voting','output_writing','closed','aborted')),
  triggered_by             jsonb       NOT NULL,
  agenda_post_id           uuid,
  scope                    jsonb       NOT NULL,
  turns_per_participant    integer     NOT NULL,
  tokens_per_turn          integer     NOT NULL,
  wall_clock_budget_ms     integer     NOT NULL,
  tokens_consumed_total    integer     NOT NULL DEFAULT 0,
  vote_rule                text        NOT NULL DEFAULT 'simple_majority',
  vote_required            boolean     NOT NULL DEFAULT true,
  scheduled_at             timestamptz NOT NULL DEFAULT now(),
  started_at               timestamptz,
  closed_at                timestamptz,
  aborted_at               timestamptz,
  abort_reason             text,
  schema_version           integer     NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS ceremonies_state_idx ON ceremonies (state, scheduled_at);
CREATE INDEX IF NOT EXISTS ceremonies_type_idx  ON ceremonies (ceremony_type);

-- ============================================================================
-- ceremony_participants
-- ============================================================================

CREATE TABLE IF NOT EXISTS ceremony_participants (
  participant_id    uuid        PRIMARY KEY,
  ceremony_id       uuid        NOT NULL REFERENCES ceremonies (ceremony_id),
  persona_role      text        NOT NULL,
  persona_id        text        NOT NULL,
  session_id        text        NOT NULL,
  ceremony_role     text        NOT NULL
                    CHECK (ceremony_role IN ('chair','participant','observer')),
  turns_used        integer     NOT NULL DEFAULT 0,
  turns_allowed     integer     NOT NULL,
  yielded_at        timestamptz,
  vote_cast         text        CHECK (vote_cast IN ('approve','reject','abstain','approve_with_modifications')),
  vote_cast_at      timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS cer_participant_unique
  ON ceremony_participants (ceremony_id, persona_role, session_id);

-- ============================================================================
-- ceremony_outputs
-- ============================================================================

CREATE TABLE IF NOT EXISTS ceremony_outputs (
  output_id            uuid        PRIMARY KEY,
  ceremony_id          uuid        NOT NULL REFERENCES ceremonies (ceremony_id),
  output_kind          text        NOT NULL
                       CHECK (output_kind IN (
                         'sprint_commitment','refined_backlog','adr',
                         'standup_digest','retro_outcome','partial'
                       )),
  payload              jsonb       NOT NULL,
  authored_by_actor    jsonb       NOT NULL,
  capability_id        uuid        NOT NULL,
  linked_adr_id        uuid,
  is_partial           boolean     NOT NULL DEFAULT false,
  unresolved_items     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  written_at           timestamptz NOT NULL DEFAULT now(),
  schema_version       integer     NOT NULL DEFAULT 1
);

-- ============================================================================
-- disagreements
-- ============================================================================

CREATE TABLE IF NOT EXISTS disagreements (
  disagreement_id            uuid        PRIMARY KEY,
  domain                     text        NOT NULL
                             CHECK (domain IN ('technical','product','security','cross_cutting')),
  state                      text        NOT NULL DEFAULT 'raised'
                             CHECK (state IN ('raised','tie_breaker_assigned','resolved','escalated','abandoned')),
  detection_mode             text        NOT NULL
                             CHECK (detection_mode IN ('explicit_flag','orchestrator_heuristic')),
  artifact_ref               jsonb       NOT NULL,
  positions                  jsonb       NOT NULL,
  raised_at                  timestamptz NOT NULL DEFAULT now(),
  tie_breaker_assigned_at    timestamptz,
  resolved_at                timestamptz,
  escalated_at               timestamptz,
  retro_flagged              boolean     NOT NULL DEFAULT false,
  schema_version             integer     NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS disagreements_state_idx  ON disagreements (state);
CREATE INDEX IF NOT EXISTS disagreements_domain_idx ON disagreements (domain);

-- ============================================================================
-- tie_breaker_decisions
-- ============================================================================

CREATE TABLE IF NOT EXISTS tie_breaker_decisions (
  decision_id          uuid        PRIMARY KEY,
  disagreement_id      uuid        NOT NULL REFERENCES disagreements (disagreement_id),
  tie_breaker_actor    jsonb       NOT NULL,
  tie_breaker_role     text        NOT NULL,
  decision_text        text        NOT NULL,
  rationale            text        NOT NULL,
  adr_id               uuid,
  capability_id        uuid        NOT NULL,
  decided_at           timestamptz NOT NULL DEFAULT now(),
  schema_version       integer     NOT NULL DEFAULT 1
);

-- ============================================================================
-- adrs (with immutability trigger)
-- ============================================================================

CREATE TABLE IF NOT EXISTS adrs (
  adr_id                  uuid        PRIMARY KEY,
  adr_number              integer     NOT NULL,
  title                   text        NOT NULL,
  status                  text        NOT NULL CHECK (status IN ('proposed','accepted','superseded')),
  context                 text        NOT NULL,
  decision                text        NOT NULL,
  rationale               text        NOT NULL,
  consequences            jsonb       NOT NULL,
  alternatives            jsonb       NOT NULL,
  authored_by_actor       jsonb       NOT NULL,
  authored_by_role        text        NOT NULL,
  capability_id           uuid        NOT NULL,
  ceremony_id             uuid,
  disagreement_id         uuid,
  supersedes_adr_id       uuid,
  superseded_by_adr_id    uuid,
  linked_tickets          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  immutable               boolean     NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  schema_version          integer     NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS adrs_number_unique ON adrs (adr_number);
CREATE INDEX        IF NOT EXISTS adrs_status_idx    ON adrs (status);

-- Immutability trigger: only supersession (status='superseded' + superseded_by_adr_id)
-- is permitted as a mutation. Editing context/decision/rationale/consequences/alternatives
-- raises CONFLICT_ADR_IMMUTABLE.
CREATE OR REPLACE FUNCTION enforce_adr_immutability() RETURNS trigger AS $$
BEGIN
  IF (OLD.context, OLD.decision, OLD.rationale, OLD.consequences, OLD.alternatives) IS DISTINCT FROM
     (NEW.context, NEW.decision, NEW.rationale, NEW.consequences, NEW.alternatives) THEN
    RAISE EXCEPTION 'CONFLICT_ADR_IMMUTABLE';
  END IF;
  IF OLD.status = 'superseded' AND NEW.status <> 'superseded' THEN
    RAISE EXCEPTION 'CONFLICT_ADR_STATUS_REVERSAL';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS adrs_immutability_trigger ON adrs;
CREATE TRIGGER adrs_immutability_trigger
  BEFORE UPDATE ON adrs
  FOR EACH ROW EXECUTE FUNCTION enforce_adr_immutability();

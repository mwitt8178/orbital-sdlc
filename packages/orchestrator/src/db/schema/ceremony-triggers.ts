/**
 * ceremony-triggers.ts — Drizzle schema for the agent-native CeremonyScheduler
 * dedupe log.
 *
 * The CeremonyScheduler subscribes to the EventStore and matches each envelope
 * against a registry of CeremonyTriggerRule instances. To make rule firings
 * exactly-once with respect to the trigger envelope, we use the natural-key
 * pair (rule_id, trigger_event_id) as the primary key. INSERT...ON CONFLICT
 * DO NOTHING gives atomic claim semantics: only the first insert succeeds, all
 * others (subscriber redelivery, multi-process boot, retries) become no-ops.
 *
 * No FKs (DSQL constraint compatibility); rule_id is a free-form text id for
 * forward compatibility (rules are code-defined, not row-defined).
 *
 * Table is owned by the comms context. Companion migration: 0017_ceremony_triggers.sql.
 */

import { pgTable, text, uuid, timestamp, primaryKey, index } from 'drizzle-orm/pg-core'

export const ceremonyTriggerFirings = pgTable(
  'ceremony_trigger_firings',
  {
    /** Stable rule identifier, e.g. 'sprint-planning', 'backlog-grooming'. */
    ruleId: text('rule_id').notNull(),
    /** event_id of the EventEnvelope that triggered the firing. */
    triggerEventId: uuid('trigger_event_id').notNull(),
    firedAt: timestamp('fired_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    /** ceremonyId returned from CeremonyService.schedule(). NULL until that call returns. */
    ceremonyId: uuid('ceremony_id'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ruleId, t.triggerEventId] }),
    byCeremony: index('cer_trigger_firings_ceremony_idx').on(t.ceremonyId),
  }),
)

export type CeremonyTriggerFiringRow = typeof ceremonyTriggerFirings.$inferSelect
export type CeremonyTriggerFiringInsert = typeof ceremonyTriggerFirings.$inferInsert

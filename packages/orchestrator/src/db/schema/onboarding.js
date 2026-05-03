/**
 * onboarding.ts — Drizzle schema for the resumable onboarding wizard.
 *
 * Round 9 — Onboarding UX Overhaul
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
 *
 * One row per in-flight or completed onboarding session. Persisting state
 * server-side (rather than in browser local storage) is what makes the wizard
 * resumable: refresh mid-flow returns to the same step with the same data.
 *
 * Multi-tenant-isolation: every row carries `tenant_id`; sentinel
 * '00000000-0000-0000-0000-000000000000' = local-install default.
 *
 * No FKs (DSQL constraint); cross-context references (project_id, install_id)
 * are nullable uuid columns per TRD-01 §4.5.
 */
import { pgTable, uuid, text, jsonb, timestamp, integer, index } from 'drizzle-orm/pg-core';
export const onboardingSessions = pgTable('onboarding_sessions', {
    sessionId: uuid('session_id').primaryKey(),
    tenantId: uuid('tenant_id')
        .notNull()
        .default('00000000-0000-0000-0000-000000000000'),
    installId: uuid('install_id').notNull(),
    /** Which flow the user picked on the welcome screen. */
    flow: text('flow', { enum: ['new_project', 'existing_repo', 'join_hub', 'sample_data'] }).notNull(),
    /** Step ID currently active. Owned by the flow's reducer. */
    currentStep: text('current_step').notNull(),
    status: text('status', { enum: ['active', 'completed', 'abandoned'] })
        .notNull()
        .default('active'),
    /** Free-form per-flow state (form values, intermediate API results, etc.). */
    stateJson: jsonb('state_json').notNull().default({}),
    /** Project this session is creating / importing. Null until known. */
    projectId: uuid('project_id'),
    /** Per-step ms-on-task for OnboardingCompleted telemetry. */
    stepDurations: jsonb('step_durations').notNull().default({}),
    stepStartedAt: timestamp('step_started_at', { withTimezone: true, mode: 'date' }),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' })
        .notNull()
        .defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    abandonedAt: timestamp('abandoned_at', { withTimezone: true, mode: 'date' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
        .notNull()
        .defaultNow(),
    schemaVersion: integer('schema_version').notNull().default(1),
}, (t) => ({
    byInstallStatus: index('onboarding_sessions_install_status_idx').on(t.installId, t.status),
    byTenant: index('onboarding_sessions_tenant_idx').on(t.tenantId, t.status),
}));
//# sourceMappingURL=onboarding.js.map
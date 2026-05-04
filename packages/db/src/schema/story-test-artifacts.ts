/**
 * story-test-artifacts.ts — Drizzle schema for QA-generated failing-test
 * artifacts that are committed before the engineer-sr agent starts.
 *
 * [Engineer-Sr · Sonnet · run-ac-test-generation]
 *
 * Lifecycle:
 *   pending  → reviewer approves  → approved
 *   approved → merged to story branch → merged
 *   pending  → rejected + regenerate → deleted + new pending row
 *
 * Multi-tenant: every read/write filters by tenant_id.
 * No FKs, triggers, sequences (DSQL constraints).
 * IDs: gen_random_uuid() in DB (UUIDv4); Drizzle sets defaultRandom().
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  index,
} from 'drizzle-orm/pg-core'

// ---------------------------------------------------------------------------
// Enum constants
// ---------------------------------------------------------------------------

export const TEST_ARTIFACT_STATUS = ['pending', 'approved', 'merged'] as const
export type TestArtifactStatus = (typeof TEST_ARTIFACT_STATUS)[number]

export const TEST_LANGUAGE = ['typescript', 'python', 'go'] as const
export type TestLanguage = (typeof TEST_LANGUAGE)[number]

export const TEST_FRAMEWORK = ['vitest', 'jest', 'pytest', 'go_test'] as const
export type TestFramework = (typeof TEST_FRAMEWORK)[number]

// ---------------------------------------------------------------------------
// story_test_artifacts
// ---------------------------------------------------------------------------

/**
 * One row per generated test file for a story. A story may have multiple
 * artifacts (one per test file, or one per retry when rejected).
 *
 * `branch` holds the 'orbital/tests-<storyId>' branch name so the UI can link
 * to the generated commit and the engineer agent can check it out.
 */
export const storyTestArtifacts = pgTable(
  'story_test_artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Multi-tenant scoping — mandatory on every row.
     * Sentinel '00000000-0000-0000-0000-000000000000' = local-install default.
     */
    tenantId: uuid('tenant_id').notNull().default('00000000-0000-0000-0000-000000000000'),
    projectId: uuid('project_id').notNull(),
    storyId: uuid('story_id').notNull(),
    /**
     * Relative path within the project repo, e.g.
     *   src/__tests__/UserService.test.ts
     *   user_service_test.go
     *   tests/test_user_service.py
     */
    testPath: text('test_path').notNull(),
    language: text('language', { enum: TEST_LANGUAGE }).notNull(),
    framework: text('framework', { enum: TEST_FRAMEWORK }).notNull(),
    /**
     * Git branch the tests were committed to.
     * Pattern: 'orbital/tests-<storyId>'
     * Null while generation is in-flight.
     */
    branch: text('branch'),
    generatedAt: timestamp('generated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    status: text('status', { enum: TEST_ARTIFACT_STATUS }).notNull().default('pending'),
    schemaVersion: integer('schema_version').notNull().default(1),
  },
  (t) => ({
    byTenant: index('story_test_artifacts_tenant_idx').on(t.tenantId),
    byStory: index('story_test_artifacts_story_idx').on(t.storyId, t.tenantId),
    byStatus: index('story_test_artifacts_status_idx').on(t.status, t.tenantId),
  }),
)

export type StoryTestArtifactRow = typeof storyTestArtifacts.$inferSelect
export type StoryTestArtifactInsert = typeof storyTestArtifacts.$inferInsert

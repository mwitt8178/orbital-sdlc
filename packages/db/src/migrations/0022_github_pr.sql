-- Migration 0022: GitHub PR linkage columns on tasks.
--
-- Strategy: ADDITIVE ONLY.
--   Three nullable columns added to the tasks table so GitHubPROrchestrator
--   can store the PR number, URL, and merge timestamp without any schema
--   incompatibility for existing rows.
--
--   All columns are NULL-able — rows pre-dating this migration simply have
--   NULL PR linkage, which the application correctly treats as "no PR opened".
--
-- Per multi-tenant-migrations discipline: additive DDL only, no drops.
-- Per DSQL constraints: DDL in its own statement block, no mixing with DML.

--> statement-breakpoint
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS github_pr_number integer;

--> statement-breakpoint
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS github_pr_url text;

--> statement-breakpoint
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS github_pr_merged_at timestamptz;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS tasks_github_pr_idx
  ON tasks (github_pr_number)
  WHERE github_pr_number IS NOT NULL;

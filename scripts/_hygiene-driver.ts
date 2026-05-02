/**
 * scripts/_hygiene-driver.ts — internal driver invoked by scripts/hygiene-sweep.mjs.
 *
 * Runs HygieneService.runFullSweep() against the live database and prints results.
 *
 * Environment variables:
 *   DATABASE_URL     — postgres connection string (required)
 *   DRY_RUN=1        — preview only; no mutations committed
 *   OLDER_THAN_DAYS  — escalation cutoff in days (default: 0 = all open)
 *
 * Safe to re-run. All operations are idempotent state transitions:
 *   - Stories  → status='cancelled'
 *   - Sprints  → status='completed'
 *   - Escalations → state='acknowledged', resolutionNote='hygiene_sweep'
 *
 * NO rows are ever deleted.
 */

import { db, sql as sqlPool, closeDb } from '../packages/orchestrator/src/db/client.js'
import { createEventStore } from '../packages/orchestrator/src/events/store.js'
import { HygieneService } from '../packages/orchestrator/src/admin/hygiene.js'

async function main(): Promise<void> {
  const dryRun = process.env['DRY_RUN'] === '1'
  const olderThanDays = process.env['OLDER_THAN_DAYS'] !== undefined
    ? Number(process.env['OLDER_THAN_DAYS'])
    : 0

  if (Number.isNaN(olderThanDays)) {
    process.stderr.write('error: OLDER_THAN_DAYS must be a non-negative integer\n')
    process.exit(1)
  }

  if (!process.env['DATABASE_URL']) {
    process.stderr.write(
      'error: DATABASE_URL is required.\n\n' +
        'Usage:\n' +
        '  DATABASE_URL=postgres://orbital:orbital@localhost:5432/orbital npm run hygiene\n' +
        '  DATABASE_URL=... DRY_RUN=1 npm run hygiene    # preview only\n',
    )
    process.exit(1)
  }

  process.stdout.write(
    `\nordital hygiene sweep\n` +
    `  dryRun       : ${String(dryRun)}\n` +
    `  olderThanDays: ${olderThanDays}\n\n`,
  )

  const eventStore = createEventStore(db, sqlPool)
  const svc = new HygieneService(db, eventStore)

  const result = await svc.runFullSweep({ dryRun, olderThanDays })

  process.stdout.write(
    `Results:\n` +
    `  stories  ${dryRun ? 'to cancel' : 'cancelled'}    : ${result.stories.archived}\n` +
    `  sprints  ${dryRun ? 'to complete' : 'completed'}   : ${result.sprints.archived}\n` +
    `  escalations ${dryRun ? 'to ack' : 'acknowledged'} : ${result.escalations.acknowledged}\n\n`,
  )

  if (result.stories.items.length > 0) {
    process.stdout.write(
      `Story sample (${result.stories.items.length} total):\n` +
      result.stories.items.slice(0, 10).map((s) => `  [${s.status}] "${s.title}" (${s.storyId})\n`).join('') +
      '\n',
    )
  }

  if (result.sprints.items.length > 0) {
    process.stdout.write(
      `Sprint sample (${result.sprints.items.length} total):\n` +
      result.sprints.items.slice(0, 10).map((s) => `  [${s.status}] "${s.name}" (${s.sprintId})\n`).join('') +
      '\n',
    )
  }

  if (result.escalations.items.length > 0) {
    process.stdout.write(
      `Escalation sample (${result.escalations.items.length} total):\n` +
      result.escalations.items.slice(0, 10).map((e) => `  [${e.reason}] task=${e.taskId.slice(0, 8)}… (${e.escalationId})\n`).join('') +
      '\n',
    )
  }

  if (dryRun) {
    process.stdout.write('DRY RUN — no changes committed. Remove DRY_RUN=1 to apply.\n\n')
  } else {
    process.stdout.write('Sweep complete. All transitions are audit-logged in audit.events.\n\n')
  }
}

main()
  .then(() => closeDb())
  .catch((err: unknown) => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err)
    process.stderr.write(`error: ${msg}\n`)
    closeDb().finally(() => process.exit(1))
  })

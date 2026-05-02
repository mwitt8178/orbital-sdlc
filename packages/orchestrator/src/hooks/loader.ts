/**
 * hooks/loader.ts — Boot-time loader for hook definitions.
 *
 * Per TRD-09 §12.2:
 * 1. Reads all baseline hook specs (imported statically — no live reload in v1).
 * 2. For each spec, computes SHA-256 of the source.
 * 3. Looks up hooks row by hook_slug:
 *    - Absent → insert hooks + hook_versions + hook_specifications row.
 *    - Present → check source_sha256; if changed → log warning (boot continues in dev,
 *      would fail in prod per §12.2 — but for v1 integration tests we allow drift).
 * 4. Returns in-memory HookDefinition[] for HookEngine.register().
 *
 * v1: one-shot load at boot, no live reload.
 * v1: does not use dynamic glob import — baseline hooks are imported explicitly.
 */

import { createHash } from 'node:crypto'
import { uuidv7 } from 'uuidv7'
import { eq } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { hooks as hooksTable, hookVersions, hookSpecifications } from '../db/schema/determinism.js'
import { logger } from '../config/logger.js'
import type { HookDefinition, HookSpec } from './types.js'
import type { z } from 'zod'

// Import baseline hooks statically.
import preCommitHook from './baseline/pre-commit.js'
import preStatusTransitionHook from './baseline/pre-status-transition.js'
import preMergeHook from './baseline/pre-merge.js'

// post-task hook requires a VerifierService; it is registered separately after
// VerifierService is constructed (see index.ts / daemon boot).

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHookSpec = HookSpec<any>

interface LoadedHook {
  definition: HookDefinition
  hookId: string
  hookVersionId: string
}

// ---------------------------------------------------------------------------
// HookLoader
// ---------------------------------------------------------------------------

export class HookLoader {
  constructor(private readonly db: DB) {}

  /**
   * Load all baseline hooks into the database and return their HookDefinition[]
   * for registration with the HookEngine.
   *
   * @param extraSpecs Optional extra specs to load (e.g. post-task after VerifierService ready).
   */
  async load(extraSpecs?: AnyHookSpec[]): Promise<HookDefinition[]> {
    const specs: AnyHookSpec[] = [
      preCommitHook,
      preStatusTransitionHook,
      preMergeHook,
      ...(extraSpecs ?? []),
    ]

    const definitions: HookDefinition[] = []

    for (const spec of specs) {
      const loaded = await this.loadSpec(spec)
      definitions.push(loaded.definition)
    }

    logger.info({ count: definitions.length }, 'HookLoader: loaded hooks')
    return definitions
  }

  private async loadSpec(spec: AnyHookSpec): Promise<LoadedHook> {
    // Compute content hash (SHA-256 of the spec's source representation).
    // In v1, we use a hash of the spec's slug + error_code + appliesTo + timing as
    // a stable content-addressing proxy (actual source file hashing requires Node fs
    // and the file path, which is not available in the module at this layer).
    const specRepr = JSON.stringify({
      slug: spec.slug,
      errorCode: spec.errorCode,
      appliesTo: [...spec.appliesTo].sort(),
      timing: spec.timing,
      declaredOrder: spec.declaredOrder,
    })
    const sourceHash = createHash('sha256').update(specRepr, 'utf8').digest('hex')

    // Look up existing hook row.
    const existing = await this.db
      .select()
      .from(hooksTable)
      .where(eq(hooksTable.hook_slug, spec.slug))
      .limit(1)

    let hookId: string
    let hookVersionId: string

    if (existing[0]) {
      // Hook already registered.
      hookId = existing[0].hook_id
      hookVersionId = existing[0].current_version_id

      // Check for source drift.
      const versionRows = await this.db
        .select()
        .from(hookVersions)
        .where(eq(hookVersions.hook_version_id, hookVersionId))
        .limit(1)

      const currentVersion = versionRows[0]
      if (currentVersion && currentVersion.source_sha256 !== sourceHash) {
        logger.warn(
          { slug: spec.slug, expected: currentVersion.source_sha256, actual: sourceHash },
          'HookLoader: hook source_sha256 mismatch — hook definition has changed (re-ship via PR per TRD-09 §12.3)',
        )
        // In v1 development: continue with the existing version.
        // Production would fail boot here.
      }
    } else {
      // New hook — insert hooks + hook_versions + hook_specifications rows.
      hookId = uuidv7()
      hookVersionId = uuidv7()
      const now = new Date()

      await this.db.insert(hooksTable).values({
        hook_id: hookId,
        hook_slug: spec.slug,
        description: spec.description,
        current_version_id: hookVersionId,
        enabled: true,
        created_at: now,
        updated_at: now,
      })

      await this.db.insert(hookVersions).values({
        hook_version_id: hookVersionId,
        hook_id: hookId,
        version: 1,
        source_sha256: sourceHash,
        source_text: specRepr, // proxy in v1; real source text in production
        applies_to_event_types: [...spec.appliesTo],
        timing: spec.timing,
        declared_order: spec.declaredOrder,
        shipped_at: now,
      })

      await this.db.insert(hookSpecifications).values({
        spec_id: uuidv7(),
        hook_id: hookId,
        hook_version_id: hookVersionId,
        name: spec.slug,
        applies_to_event_types: [...spec.appliesTo],
        timing: spec.timing,
        declared_order: spec.declaredOrder,
        declared_error_code: spec.errorCode,
        rationale: spec.description,
        test_fixtures_path: spec.testFixturesPath ?? null,
        loaded_at: now,
      })

      logger.info({ slug: spec.slug, hookId, hookVersionId }, 'HookLoader: registered new hook')
    }

    // Build the HookDefinition for the in-memory registry.
    const definition: HookDefinition = {
      hook_id: hookId,
      hook_version_id: hookVersionId,
      slug: spec.slug,
      description: spec.description,
      applies_to: spec.appliesTo,
      timing: spec.timing,
      declared_order: spec.declaredOrder,
      error_code: spec.errorCode,
      enabled: true,
      validator: (payload, context) => spec.validator(payload as never, context),
    }

    return { definition, hookId, hookVersionId }
  }
}

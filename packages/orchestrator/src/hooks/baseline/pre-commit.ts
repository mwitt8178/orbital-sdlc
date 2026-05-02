/**
 * pre-commit.ts — Baseline pre-commit hook.
 *
 * Per TRD-09 §8.1 and task spec:
 * - Validates commit_message contains the correct ticket ref (ORB-NNN matching ticket_id).
 * - Validates all files_changed are within the files_write_scope globs.
 * - Error code: HOOK_REJECTED_PRE_COMMIT
 *
 * Pure function: no network, no file I/O, no non-deterministic reads.
 */

import { z } from 'zod'
import micromatch from 'micromatch'
import { defineHook } from '../types.js'

const PayloadSchema = z.object({
  commit_message: z.string(),
  ticket_id: z.string(),
  files_changed: z.array(z.string()).default([]),
  /** Glob patterns representing the files_write scope of the capability bundle. */
  files_write_scope: z.array(z.string()).default([]),
})

// Ticket ref regex: matches ORB-NNN at start of string or after whitespace,
// followed by whitespace, colon, comma, period, or end of string.
// Per TRD-09 §8.1 — the TRD example uses "ORB-237: impl..." (colon-terminated).
const TICKET_REF_RE = /(?:^|\s)(ORB-\d+)(?:[\s:,.]|$)/m

export default defineHook({
  slug: 'commit-must-have-ticket-ref',
  description:
    'Every commit must reference its ticket id in the message, and all changed files must be within the declared files_write scope.',
  appliesTo: ['AgentCommitted'],
  timing: 'pre',
  declaredOrder: 100,
  errorCode: 'HOOK_REJECTED_PRE_COMMIT',
  payloadSchema: PayloadSchema,
  validator: (payload) => {
    // Step 1: parse the payload
    const parsed = PayloadSchema.safeParse(payload)
    if (!parsed.success) {
      return {
        allow: false,
        reason: `invalid commit payload: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      }
    }

    const { commit_message, ticket_id, files_changed, files_write_scope } = parsed.data

    // Step 2: ticket_id must be non-empty
    if (!ticket_id || ticket_id.trim() === '') {
      return {
        allow: false,
        reason: 'commit rejected: ticket_id is required but was empty',
      }
    }

    // Step 3: commit_message must contain the ticket ref
    if (!commit_message || commit_message.trim() === '') {
      return {
        allow: false,
        reason: `commit message is empty; expected reference to ${ticket_id}`,
      }
    }

    const match = commit_message.match(TICKET_REF_RE)
    if (!match) {
      return {
        allow: false,
        reason: `commit message does not reference its ticket id (expected ${ticket_id})`,
      }
    }

    // Step 4: the matched ref must equal ticket_id
    const matchedRef = match[1]!.trim()
    if (matchedRef !== ticket_id) {
      return {
        allow: false,
        reason: `commit message references ${matchedRef}, expected ${ticket_id}`,
      }
    }

    // Step 5: all files_changed must be within files_write_scope
    if (files_write_scope.length > 0) {
      for (const file of files_changed) {
        const allowed = micromatch.isMatch(file, files_write_scope)
        if (!allowed) {
          return {
            allow: false,
            reason: `commit rejected: file '${file}' is outside the declared files_write scope [${files_write_scope.join(', ')}] — ${ticket_id}`,
          }
        }
      }
    }

    return { allow: true }
  },
})

import { z } from 'zod'

/** Per Primitives §6 — capability scope grammar. */
export const ScopeKeySchema = z.enum([
  'files_read',
  'files_write',
  'board_read',
  'board_mutate',
  'channel_read',
  'channel_post',
  'secrets',
  'network_egress',
  'spawn_subagent',
  'git_commit',
  'ceremony_role',
])

export type ScopeKey = z.infer<typeof ScopeKeySchema>

export const ScopesSchema = z.object({
  files_read: z.array(z.string()).default([]),
  files_write: z.array(z.string()).default([]),
  board_read: z.array(z.string()).default([]),
  board_mutate: z.array(z.string()).default([]),
  channel_read: z.array(z.string()).default([]),
  channel_post: z.array(z.string()).default([]),
  secrets: z.array(z.string()).default([]),
  network_egress: z.array(z.string()).default([]),
  spawn_subagent: z.boolean().default(false),
  git_commit: z
    .array(z.object({ branch: z.string(), paths: z.array(z.string()) }))
    .default([]),
  ceremony_role: z.array(z.enum(['chair', 'participant', 'observer'])).default([]),
})

export type Scopes = z.infer<typeof ScopesSchema>

export const CapabilityBundleSchema = z.object({
  capability_id: z.string(),
  install_id: z.string(),
  sprint_id: z.string().optional(),
  task_id: z.string().optional(),
  persona_id: z.string(),
  session_id: z.string(),
  scopes: ScopesSchema,
  issued_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  signing_key_id: z.string(),
  signature: z.string(), // base64-encoded Ed25519 signature
  schema_version: z.number().int().positive().default(1),
})

export type CapabilityBundle = z.infer<typeof CapabilityBundleSchema>

/** The bytes that get signed are the bundle minus signature. */
export const CapabilityBundleUnsignedSchema = CapabilityBundleSchema.omit({ signature: true })
export type CapabilityBundleUnsigned = z.infer<typeof CapabilityBundleUnsignedSchema>

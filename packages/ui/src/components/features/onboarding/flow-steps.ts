/**
 * Canonical step definitions per onboarding flow.
 * Single source of truth for both flow components AND the resume banner.
 *
 * [Engineer-Principal · Opus · run-orbital-onboarding-rework]
 */

import type { ShellStep } from './OnboardingShell.js'

// [Engineer-Principal · Opus · run-admin-integrations-split]
// Tool credentials (Anthropic / Monday / GitHub) are no longer captured during
// onboarding — they are admin-level concerns configured at /admin/integrations.
// Onboarding only collects project-specific input (basics, tooling pickers,
// vision, sprint plan).
export const NEW_PROJECT_STEPS: ShellStep[] = [
  { id: 'project_basics', label: 'Basics' },
  { id: 'tooling', label: 'Tooling' },
  { id: 'vision_intake', label: 'Vision' },
  { id: 'monday_provision', label: 'Board' },
  { id: 'github_provision', label: 'Repo' },
  { id: 'system_teach', label: 'Teach' },
  { id: 'mode', label: 'Mode' },
  { id: 'first_sprint', label: 'Sprint' },
  { id: 'done', label: 'Done' },
]

export const EXISTING_REPO_STEPS: ShellStep[] = [
  { id: 'connect_repo', label: 'Repo' },
  { id: 'codebase_analysis', label: 'Analysis' },
  { id: 'board_mapping', label: 'Board' },
  { id: 'memory_seed', label: 'Memory' },
  { id: 'mode', label: 'Mode' },
  { id: 'first_sprint', label: 'Sprint' },
  { id: 'done', label: 'Done' },
]

export const JOIN_HUB_STEPS: ShellStep[] = [
  { id: 'invite', label: 'Invite' },
  { id: 'done', label: 'Done' },
]

export function prettifyStepId(stepId: string): string {
  return stepId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

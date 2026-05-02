/**
 * vision/epic-suggester.ts — Templated epic suggestions from vision content.
 *
 * Per architecture.md "Epic Suggester Strategy: v1 Templated Heuristic":
 *
 * Scans the vision content's title + summary + goal text for keywords against a
 * curated keyword → epic-template mapping (~10 product domains, 30+ keywords).
 * Returns up to 5 epics, each with a brief description and 2-4 suggested story
 * titles. If no keywords match, falls back to three generic epics (Core
 * experience / Account management / Reporting) so the user always has a
 * starting point.
 *
 * This is a deterministic, LLM-free v1. A future revision can swap in a real
 * Anthropic completion call without changing the public API.
 *
 * Public API:
 *   suggestEpicsFromVision(content) -> { epics: SuggestedEpic[] }
 *
 * The procedure is read-only — no DB access, no events. Pure function.
 */

export interface SuggestedEpic {
  title: string
  description: string
  story_titles: string[]
}

export interface EpicSuggestionResult {
  epics: SuggestedEpic[]
}

// ---------------------------------------------------------------------------
// Templated catalog
// ---------------------------------------------------------------------------

/**
 * Each entry: keywords that activate the template, plus the epic shape.
 * Keywords are matched as case-insensitive substrings; longer keywords are
 * preferred (e.g. "subscription" wins over "sub").
 *
 * The templates avoid product-specific names — they read as starting points
 * for any team building the corresponding capability.
 */
interface EpicTemplate {
  /** Lowercase substring keywords that should appear in title/summary/goals. */
  keywords: string[]
  /** Stable id used for de-duplication (one template never produces two epics). */
  templateId: string
  /** The epic itself. */
  epic: SuggestedEpic
}

const TEMPLATES: EpicTemplate[] = [
  {
    templateId: 'billing',
    keywords: ['subscription', 'billing', 'invoice', 'payment', 'checkout', 'pricing'],
    epic: {
      title: 'Subscription lifecycle',
      description: 'Plan selection, upgrades, downgrades, cancellation, and renewal.',
      story_titles: [
        'User selects a plan during signup',
        'User upgrades from trial to paid',
        'User cancels subscription with reason capture',
        'Webhook reconciles subscription state from billing provider',
      ],
    },
  },
  {
    templateId: 'invoicing',
    keywords: ['invoice', 'receipt', 'statement', 'tax'],
    epic: {
      title: 'Invoicing and receipts',
      description: 'Generate, view, and download invoices and tax-compliant receipts.',
      story_titles: [
        'User views invoice history',
        'User downloads PDF receipt',
        'Admin sends manual invoice for prior period',
      ],
    },
  },
  {
    templateId: 'auth',
    keywords: ['authentication', 'auth', 'login', 'signup', 'sign up', 'sign in', 'password', 'sso'],
    epic: {
      title: 'Authentication',
      description: 'Sign-up, sign-in, password reset, and session management.',
      story_titles: [
        'User signs up with email and password',
        'User signs in and receives a session token',
        'User resets a forgotten password',
        'User signs out and the session invalidates',
      ],
    },
  },
  {
    templateId: 'account',
    keywords: ['account', 'profile', 'settings', 'preferences'],
    epic: {
      title: 'Account management',
      description: 'Profile edits, preferences, and account-level settings.',
      story_titles: [
        'User updates their profile name and avatar',
        'User changes email and confirms the new address',
        'User updates notification preferences',
      ],
    },
  },
  {
    templateId: 'team',
    keywords: ['team', 'workspace', 'organization', 'organisation', 'tenant', 'collaborate', 'collaboration', 'invite', 'member', 'role'],
    epic: {
      title: 'Team and member management',
      description: 'Workspaces, member invites, and role assignment.',
      story_titles: [
        'Admin invites a teammate by email',
        'New member accepts invitation and joins workspace',
        'Admin assigns a role to a team member',
        'Admin removes a member from the workspace',
      ],
    },
  },
  {
    templateId: 'dashboard',
    keywords: ['dashboard', 'overview', 'home screen'],
    epic: {
      title: 'Core dashboard',
      description: 'The main landing surface that orients the user every visit.',
      story_titles: [
        'User sees a summary of recent activity on first load',
        'User pins a key widget to the dashboard',
        'Empty state guides new users through setup',
      ],
    },
  },
  {
    templateId: 'reporting',
    keywords: ['report', 'analytic', 'analytics', 'metric', 'insight', 'kpi', 'chart'],
    epic: {
      title: 'Reporting and analytics',
      description: 'Charts, metrics, and exportable reports.',
      story_titles: [
        'User views key metrics for a selected date range',
        'User exports a report as CSV',
        'User saves a custom report view',
      ],
    },
  },
  {
    templateId: 'tasks',
    keywords: ['task', 'kanban', 'workflow', 'project management', 'sprint', 'backlog'],
    epic: {
      title: 'Task and workflow tracking',
      description: 'Create, assign, and track work through status columns.',
      story_titles: [
        'User creates a task with title and description',
        'User assigns a task to a teammate',
        'User moves a task through workflow stages',
        'User filters tasks by assignee and status',
      ],
    },
  },
  {
    templateId: 'messaging',
    keywords: ['chat', 'message', 'messaging', 'conversation', 'thread', 'comment', 'inbox'],
    epic: {
      title: 'Messaging and threads',
      description: 'Real-time chat, threaded discussions, and notifications.',
      story_titles: [
        'User sends a message in a channel and others see it in real time',
        'User replies in a thread on a parent message',
        'User configures notification preferences per channel',
      ],
    },
  },
  {
    templateId: 'files',
    keywords: ['file', 'upload', 'document', 'storage', 'asset', 'attachment', 'media'],
    epic: {
      title: 'File upload and storage',
      description: 'Upload, browse, share, and revoke access to files.',
      story_titles: [
        'User uploads a file with progress feedback',
        'User shares a file via link with permissions',
        'User revokes a share link and the file becomes inaccessible',
      ],
    },
  },
  {
    templateId: 'calendar',
    keywords: ['calendar', 'schedule', 'appointment', 'booking', 'availability'],
    epic: {
      title: 'Scheduling and calendar',
      description: 'Calendar view, scheduling rules, and reminders.',
      story_titles: [
        'User views a calendar of upcoming events',
        'User schedules a recurring appointment',
        'User receives a reminder before the event',
      ],
    },
  },
  {
    templateId: 'search',
    keywords: ['search', 'filter', 'discovery', 'browse', 'find'],
    epic: {
      title: 'Search and discovery',
      description: 'Full-text search, filters, and result ranking.',
      story_titles: [
        'User searches across all content with relevant ranking',
        'User narrows results with filters',
        'User saves a frequent search as a shortcut',
      ],
    },
  },
  {
    templateId: 'notifications',
    keywords: ['notification', 'alert', 'reminder', 'webhook', 'email digest'],
    epic: {
      title: 'Notifications',
      description: 'In-app, email, and webhook notification delivery.',
      story_titles: [
        'User receives an in-app notification when a teammate mentions them',
        'User configures email digest frequency',
        'Admin defines outgoing webhooks for events',
      ],
    },
  },
  {
    templateId: 'ai',
    keywords: ['ai', 'llm', 'gpt', 'claude', 'agent', 'autonomous', 'machine learning', 'ml model'],
    epic: {
      title: 'AI integration',
      description: 'Surface AI assistance with safety and cost controls.',
      story_titles: [
        'User invokes an AI action and sees streamed output',
        'User reviews AI-suggested edits before accepting',
        'Admin sets per-user token budget caps',
      ],
    },
  },
  {
    templateId: 'integrations',
    keywords: ['integration', 'api', 'connect', 'webhook', 'third-party', 'third party'],
    epic: {
      title: 'External integrations',
      description: 'Connect, configure, and disconnect third-party services.',
      story_titles: [
        'User connects a third-party service via OAuth',
        'User maps fields between systems',
        'User disconnects an integration and revokes tokens',
      ],
    },
  },
  {
    templateId: 'admin',
    keywords: ['admin', 'audit', 'compliance', 'permission', 'role-based', 'rbac', 'governance'],
    epic: {
      title: 'Admin and audit',
      description: 'Admin controls, audit logs, and access policies.',
      story_titles: [
        'Admin views an audit log of recent changes',
        'Admin defines a role with custom permissions',
        'Admin exports compliance reports',
      ],
    },
  },
  {
    templateId: 'onboarding',
    keywords: ['onboarding', 'tutorial', 'walkthrough', 'first run', 'getting started'],
    epic: {
      title: 'Onboarding and first-run',
      description: 'Guide new users from sign-up to first valuable action.',
      story_titles: [
        'New user sees a guided checklist on first sign-in',
        'New user completes a first valuable action',
        'User skips onboarding and returns to it later',
      ],
    },
  },
]

// Generic fallback epics — applied verbatim when no template matches.
const GENERIC_FALLBACK: SuggestedEpic[] = [
  {
    title: 'Core experience',
    description: 'The headline user journey that delivers the primary product value.',
    story_titles: [
      'User completes the primary action end-to-end',
      'User encounters an empty state with helpful guidance',
      'User recovers from a primary-flow error gracefully',
    ],
  },
  {
    title: 'Account management',
    description: 'Sign-up, sign-in, profile, and basic settings.',
    story_titles: [
      'User signs up and confirms their email',
      'User signs in and accesses their account',
      'User edits profile and notification preferences',
    ],
  },
  {
    title: 'Reporting',
    description: 'Visibility into user activity and key product metrics.',
    story_titles: [
      'User views key activity metrics for the last 30 days',
      'User exports a CSV summary of activity',
    ],
  },
]

const MAX_EPICS = 5
const MIN_EPICS_ON_MATCH = 3 // when at least one template matches, pad to >= 3

// ---------------------------------------------------------------------------
// Public function
// ---------------------------------------------------------------------------

/**
 * Suggest 3-5 epics from a vision document content object.
 *
 * Input shape: any object with `title`, `summary`, and `goals[].text`. We
 * accept `Record<string, unknown>` because content stored in DB is JSONB and
 * we want this function usable with the loose draft schema.
 *
 * Determinism: same input -> same output.
 */
export function suggestEpicsFromVision(
  content: Record<string, unknown>,
): EpicSuggestionResult {
  const haystack = buildHaystack(content)
  const matched = matchTemplates(haystack)

  if (matched.length === 0) {
    return { epics: [...GENERIC_FALLBACK] }
  }

  // Pad with generic epics if we got fewer than the minimum, so the user
  // always sees at least 3 cards. We avoid duplicating an epic that's already
  // present (compare by title).
  const result: SuggestedEpic[] = matched.slice(0, MAX_EPICS)
  if (result.length < MIN_EPICS_ON_MATCH) {
    const existingTitles = new Set(result.map((e) => e.title))
    for (const generic of GENERIC_FALLBACK) {
      if (result.length >= MIN_EPICS_ON_MATCH) break
      if (!existingTitles.has(generic.title)) {
        result.push(generic)
        existingTitles.add(generic.title)
      }
    }
  }

  return { epics: result }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Concatenate searchable text from the vision content into a single
 * lowercase string. We pull title, summary, and any goal/non-goal text.
 */
function buildHaystack(content: Record<string, unknown>): string {
  const parts: string[] = []

  if (typeof content['title'] === 'string') parts.push(content['title'])
  if (typeof content['summary'] === 'string') parts.push(content['summary'])

  const goals = content['goals']
  if (Array.isArray(goals)) {
    for (const g of goals) {
      if (g && typeof g === 'object' && typeof (g as { text?: unknown }).text === 'string') {
        parts.push((g as { text: string }).text)
      }
    }
  }

  const nonGoals = content['non_goals']
  if (Array.isArray(nonGoals)) {
    for (const g of nonGoals) {
      if (g && typeof g === 'object' && typeof (g as { text?: unknown }).text === 'string') {
        parts.push((g as { text: string }).text)
      }
    }
  }

  const targetUsers = content['target_users']
  if (Array.isArray(targetUsers)) {
    for (const u of targetUsers) {
      if (u && typeof u === 'object') {
        const tu = u as { description?: unknown; segment?: unknown }
        if (typeof tu.description === 'string') parts.push(tu.description)
        if (typeof tu.segment === 'string') parts.push(tu.segment)
      }
    }
  }

  return parts.join(' ').toLowerCase()
}

/**
 * Walk the templates and return matched epics in template-declaration order
 * (stable). De-duplicates by templateId so the same template never produces
 * two epics even if multiple keywords from it appear.
 */
function matchTemplates(haystack: string): SuggestedEpic[] {
  if (haystack.length === 0) return []
  const matched: SuggestedEpic[] = []
  const seen = new Set<string>()

  for (const template of TEMPLATES) {
    if (seen.has(template.templateId)) continue
    if (templateMatches(template, haystack)) {
      matched.push(template.epic)
      seen.add(template.templateId)
    }
  }

  return matched
}

function templateMatches(template: EpicTemplate, haystack: string): boolean {
  for (const keyword of template.keywords) {
    if (haystack.includes(keyword)) return true
  }
  return false
}

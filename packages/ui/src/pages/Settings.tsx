/**
 * Settings — IA-cleaned.
 *
 * Six top-level sections. The previous build mixed install-wide concerns,
 * project-scoped concerns, and user concerns under the same `/settings/*`
 * tree, which made the page incoherent (vision content in a "global" page,
 * the integrations dashboard duplicated against `/admin/integrations`,
 * etc.). This rebuild draws three clean lines:
 *
 *   - INSTALL/ADMIN — `/admin/*` is the canonical home for credentials,
 *     backups, and federation. Settings only surfaces read-only links to it.
 *   - PROJECT       — `/settings/sprints`, `/settings/integrations/github`,
 *     and `/settings/agents` operate on the *active project* (selected via
 *     the project switcher in the top bar). They degrade to a "pick a
 *     project" hint when no project is active.
 *   - USER          — notification permissions live here; sign-out lives in
 *     the top-bar UserMenu.
 *
 * Routes:
 *   /settings              → redirect to /settings/general
 *   /settings/general      → identity (read-only) + notifications + project links
 *   /settings/integrations → read-only summary that defers to /admin/integrations,
 *                            plus per-project sub-routes (github, hub)
 *   /settings/agents       → personas, routing, models, hooks (install-wide read-only)
 *   /settings/sprints      → ceremonies, board, budget (project-scoped)
 *   /settings/team         → hub team management (designed empty state)
 *   /settings/billing      → designed empty state
 *
 * [Engineer-Principal · Opus · run-ux-2-settings]
 */

import { ReactNode, useEffect } from 'react'
import { Link, NavLink, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useActiveProject } from '../services/use-active-project.js'
import { PersonasTab } from '../components/features/settings/PersonasTab.js'
import { RoutingPolicyTab } from '../components/features/settings/RoutingPolicyTab.js'
import { HooksTab } from '../components/features/settings/HooksTab.js'
import { CeremoniesTab } from '../components/features/settings/CeremoniesTab.js'
import { NotificationsTab } from '../components/features/settings/NotificationsTab.js'
import { IdentityTab } from '../components/features/settings/IdentityTab.js'
import { BoardTab } from '../components/features/settings/BoardTab.js'
import { ModelsTab } from '../components/features/settings/ModelsTab.js'
import { GitHubTab } from '../components/features/settings/GitHubTab.js'
import { BudgetTab } from '../components/features/settings/BudgetTab.js'
import { HubTab } from '../components/features/settings/HubTab.js'
import { ComingSoonState } from '../components/features/settings/ComingSoonState.js'
import { DURATION, EASE } from '../components/onboarding/motion.js'

interface SectionDef {
  id: string
  label: string
  description: string
  scope: 'install' | 'project' | 'user'
  icon: ReactNode
}

const SECTIONS: SectionDef[] = [
  {
    id: 'general',
    label: 'General',
    description: 'Identity, notifications, project links.',
    scope: 'user',
    icon: <SlidersIcon />,
  },
  {
    id: 'integrations',
    label: 'Integrations',
    description: 'Per-project bindings; install-wide creds in Admin.',
    scope: 'project',
    icon: <PlugIcon />,
  },
  {
    id: 'agents',
    label: 'Agents',
    description: 'Personas, routing policy, models, hooks.',
    scope: 'install',
    icon: <BotIcon />,
  },
  {
    id: 'sprints',
    label: 'Sprints',
    description: 'Ceremonies, board mapping, per-project budget.',
    scope: 'project',
    icon: <CalendarIcon />,
  },
  {
    id: 'team',
    label: 'Team',
    description: 'Hub members and roles.',
    scope: 'install',
    icon: <UsersIcon />,
  },
  {
    id: 'billing',
    label: 'Billing',
    description: 'Plan and invoices.',
    scope: 'install',
    icon: <CardIcon />,
  },
]

export default function Settings() {
  return (
    <Routes>
      <Route index element={<Navigate to="general" replace />} />
      <Route element={<SettingsShell />}>
        <Route path="general/*" element={<GeneralPage />} />
        <Route path="integrations/*" element={<IntegrationsPage />} />
        <Route path="agents/*" element={<AgentsPage />} />
        <Route path="sprints/*" element={<SprintsPage />} />
        <Route path="team/*" element={<TeamPage />} />
        <Route path="billing/*" element={<BillingPage />} />
        <Route path="*" element={<Navigate to="general" replace />} />
      </Route>
    </Routes>
  )
}

// ---------------------------------------------------------------------------
// Shell — sidebar + content frame
// ---------------------------------------------------------------------------

function SettingsShell() {
  const location = useLocation()

  useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [location.pathname])

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6 md:px-8">
      <header className="mb-6">
        <p className="text-eyebrow font-semibold uppercase text-slate-500">Workspace</p>
        <h1 className="mt-1 text-display-lg text-slate-900">Settings</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Configure how Orbital runs. Install-wide credentials (Anthropic, Monday, GitHub App)
          live under{' '}
          <Link to="/admin/integrations" className="font-medium text-brand-700 underline-offset-2 hover:underline">
            Admin · Integrations
          </Link>
          . The sections below cover per-project bindings, the agent roster, and your personal
          preferences.
        </p>
      </header>

      <div className="grid gap-6 md:grid-cols-[16rem_minmax(0,1fr)]">
        <nav aria-label="Settings sections" className="md:sticky md:top-6 md:self-start">
          <ul className="grid grid-cols-2 gap-1 md:grid-cols-1">
            {SECTIONS.map((section) => (
              <li key={section.id}>
                <NavLink
                  to={section.id}
                  className={({ isActive }) =>
                    `flex items-start gap-3 rounded-card border px-3 py-2.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                      isActive
                        ? 'border-brand-200 bg-brand-50 text-brand-900 shadow-card'
                        : 'border-transparent text-slate-700 hover:border-slate-200 hover:bg-white'
                    }`
                  }
                >
                  {({ isActive }) => (
                    <>
                      <span
                        className={`mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-md ${
                          isActive ? 'bg-brand-100 text-brand-700' : 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        {section.icon}
                      </span>
                      <span>
                        <span className="block text-sm font-semibold">{section.label}</span>
                        <span className="hidden text-xs text-slate-500 md:block">
                          {section.description}
                        </span>
                        <span
                          className={`mt-1 hidden items-center gap-1 text-[10px] font-semibold uppercase tracking-wide md:inline-flex ${
                            section.scope === 'install'
                              ? 'text-amber-700'
                              : section.scope === 'project'
                                ? 'text-violet-700'
                                : 'text-slate-500'
                          }`}
                        >
                          {section.scope}
                        </span>
                      </span>
                    </>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <motion.main
          key={location.pathname}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: DURATION.base, ease: EASE.out }}
          className="min-w-0"
        >
          <Outlet />
        </motion.main>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section pages
// ---------------------------------------------------------------------------

function PageHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-6">
      <h2 className="text-display-md text-slate-900">{title}</h2>
      <p className="mt-1 text-sm text-slate-600">{description}</p>
    </div>
  )
}

function PageSection({
  title,
  scopeBadge,
  children,
}: {
  title?: string
  scopeBadge?: 'install' | 'project' | 'user'
  children: ReactNode
}) {
  return (
    <section className="mb-8 rounded-card-lg border border-slate-200 bg-white p-5 shadow-card md:p-6">
      {(title || scopeBadge) && (
        <header className="mb-4 flex items-center gap-3">
          {title && (
            <h3 className="text-eyebrow font-semibold uppercase text-slate-500">{title}</h3>
          )}
          {scopeBadge && <ScopeBadge scope={scopeBadge} />}
        </header>
      )}
      {children}
    </section>
  )
}

function ScopeBadge({ scope }: { scope: 'install' | 'project' | 'user' }) {
  const map = {
    install: { label: 'Install', cls: 'bg-amber-50 text-amber-800 ring-amber-200' },
    project: { label: 'Project', cls: 'bg-violet-50 text-violet-800 ring-violet-200' },
    user: { label: 'You', cls: 'bg-slate-100 text-slate-700 ring-slate-200' },
  } as const
  const m = map[scope]
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ${m.cls}`}
    >
      {m.label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// /settings/general
// ---------------------------------------------------------------------------

function GeneralPage() {
  return (
    <>
      <PageHeader
        title="General"
        description="Your installation identity, notification preferences, and quick links into project surfaces."
      />
      <PageSection title="Identity" scopeBadge="install">
        <IdentityTab />
      </PageSection>
      <PageSection title="Notifications" scopeBadge="user">
        <NotificationsTab />
      </PageSection>
      <PageSection title="Project surfaces" scopeBadge="project">
        <ProjectShortcuts />
      </PageSection>
    </>
  )
}

/**
 * ProjectShortcuts — the *only* vision touchpoint inside Settings.
 * A read-only summary of the active project plus deep links to its
 * project-scoped surfaces. Crucially: no vision content is embedded here —
 * the canonical vision UI is /vision.
 */
function ProjectShortcuts() {
  const { activeProject } = useActiveProject({ archived: false })

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        These pages are scoped to a single project. Switch projects from the top-bar selector;
        the links below always follow your active selection.
      </p>
      {activeProject ? (
        <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
          <span className="text-xs uppercase tracking-wide text-slate-500">Active project</span>
          <div className="mt-0.5 font-semibold text-slate-900">{activeProject.name}</div>
        </div>
      ) : (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          No project is selected. Use the project picker in the top bar.
        </div>
      )}
      <ul className="grid gap-2 sm:grid-cols-2">
        <ShortcutLink href="/vision" title="Vision" body="Edit the locked vision document, view history, or branch a new one." />
        <ShortcutLink href="/backlog" title="Backlog" body="Epics, stories, sub-tasks for the active project." />
        <ShortcutLink
          href="/settings/sprints"
          title="Sprint policy"
          body="Ceremonies cadence, board mapping, per-project budget."
        />
        <ShortcutLink
          href="/settings/integrations/github"
          title="GitHub binding"
          body="Repo, default branch, webhook for the active project."
        />
      </ul>
    </div>
  )
}

function ShortcutLink({ href, title, body }: { href: string; title: string; body: string }) {
  return (
    <li>
      <Link
        to={href}
        className="group flex h-full flex-col rounded-md border border-slate-200 bg-white px-4 py-3 transition hover:border-brand-200 hover:bg-brand-50/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <span className="flex items-center justify-between text-sm font-semibold text-slate-900">
          {title}
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="text-slate-400 transition group-hover:translate-x-0.5 group-hover:text-brand-600"
          >
            <line x1="5" y1="12" x2="19" y2="12" />
            <polyline points="12 5 19 12 12 19" />
          </svg>
        </span>
        <span className="mt-1 text-xs text-slate-500">{body}</span>
      </Link>
    </li>
  )
}

// ---------------------------------------------------------------------------
// /settings/integrations
// ---------------------------------------------------------------------------

function IntegrationsPage() {
  return (
    <Routes>
      <Route index element={<IntegrationsOverview />} />
      <Route
        path="github"
        element={
          <IntegrationDetail
            title="GitHub repo binding"
            scope="project"
            blurb="The repository the active project deploys from. The install-wide GitHub App credential lives in Admin · Integrations."
          >
            <GitHubTab />
          </IntegrationDetail>
        }
      />
      <Route
        path="hub"
        element={
          <IntegrationDetail
            title="Hub federation"
            scope="install"
            blurb="Pair this Local install with an Orbital Hub for shared replay, federated identity, and team operations."
          >
            <HubTab />
          </IntegrationDetail>
        }
      />
      <Route path="*" element={<Navigate to="" replace />} />
    </Routes>
  )
}

function IntegrationsOverview() {
  return (
    <>
      <PageHeader
        title="Integrations"
        description="Project-level integration bindings. Install-wide credentials and tool connections live in Admin."
      />
      <PageSection scopeBadge="install">
        <h3 className="mb-1 text-sm font-semibold text-slate-900">Tool credentials</h3>
        <p className="text-sm text-slate-600">
          Anthropic, Monday, and the GitHub App are configured once for the whole install. Manage
          them under Admin · Integrations.
        </p>
        <Link
          to="/admin/integrations"
          className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white shadow-card hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          Open Admin · Integrations
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="5" y1="12" x2="19" y2="12" />
            <polyline points="12 5 19 12 12 19" />
          </svg>
        </Link>
      </PageSection>
      <PageSection scopeBadge="project">
        <h3 className="mb-1 text-sm font-semibold text-slate-900">Project bindings</h3>
        <p className="mb-4 text-sm text-slate-600">
          These bindings apply only to the active project.
        </p>
        <ul className="grid gap-2 sm:grid-cols-2">
          <ShortcutLink
            href="/settings/integrations/github"
            title="GitHub repo"
            body="Owner, repository, default branch, webhook."
          />
          <ShortcutLink
            href="/settings/sprints"
            title="Monday board mapping"
            body="Discover the project's Monday board and confirm the column mapping."
          />
        </ul>
      </PageSection>
      <PageSection scopeBadge="install">
        <h3 className="mb-1 text-sm font-semibold text-slate-900">Federation</h3>
        <p className="mb-4 text-sm text-slate-600">
          Pairing this install with an Orbital Hub federates identity, replay, and audit across
          the team.
        </p>
        <Link
          to="/settings/integrations/hub"
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Configure hub federation
        </Link>
      </PageSection>
    </>
  )
}

function IntegrationDetail({
  title,
  scope,
  blurb,
  children,
}: {
  title: string
  scope: 'install' | 'project'
  blurb: string
  children: ReactNode
}) {
  return (
    <>
      <PageHeader title={title} description={blurb} />
      <PageSection scopeBadge={scope}>{children}</PageSection>
    </>
  )
}

// ---------------------------------------------------------------------------
// /settings/agents
// ---------------------------------------------------------------------------

function AgentsPage() {
  return (
    <>
      <PageHeader
        title="Agents"
        description="The personas that work across every project, the routing policy that picks a model per task, and the install-wide hooks they fire."
      />
      <PageSection title="Personas" scopeBadge="install">
        <PersonasTab />
      </PageSection>
      <PageSection title="Routing policy" scopeBadge="install">
        <RoutingPolicyTab />
      </PageSection>
      <PageSection title="Models" scopeBadge="install">
        <ModelsTab />
      </PageSection>
      <PageSection title="Hooks" scopeBadge="install">
        <HooksTab />
      </PageSection>
    </>
  )
}

// ---------------------------------------------------------------------------
// /settings/sprints
// ---------------------------------------------------------------------------

function SprintsPage() {
  return (
    <>
      <PageHeader
        title="Sprints"
        description="Ceremony cadence, Monday board mapping, and budget enforcement — all scoped to the active project."
      />
      <PageSection title="Ceremonies" scopeBadge="project">
        <CeremoniesTab />
      </PageSection>
      <PageSection title="Board mapping" scopeBadge="project">
        <BoardTab />
      </PageSection>
      <PageSection title="Budget" scopeBadge="project">
        <BudgetTab />
      </PageSection>
    </>
  )
}

// ---------------------------------------------------------------------------
// /settings/team and /settings/billing
// ---------------------------------------------------------------------------

function TeamPage() {
  return (
    <>
      <PageHeader
        title="Team"
        description="Manage who has access to this hub and what role they hold."
      />
      <ComingSoonState
        title="Team management is in design"
        description="Roster + roles + per-member audit log will land in the next release. For now, members are added via hub invite URLs."
        actionLabel="Manage hub federation"
        actionHref="/settings/integrations/hub"
        eta="next release"
      />
    </>
  )
}

function BillingPage() {
  return (
    <>
      <PageHeader
        title="Billing"
        description="Plan, invoices, and usage caps."
      />
      <ComingSoonState
        title="Billing is wired up via Stripe — UI is next"
        description="Live mode is metered today via the Anthropic key you supplied; per-org Stripe-backed billing arrives once we onboard our first paid team."
        actionLabel="Review per-project budget"
        actionHref="/settings/sprints"
        eta="next release"
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Inline icon components
// ---------------------------------------------------------------------------

function iconProps() {
  return {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
}

function SlidersIcon() {
  return (
    <svg {...iconProps()}>
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </svg>
  )
}

function PlugIcon() {
  return (
    <svg {...iconProps()}>
      <path d="M9 2v6" />
      <path d="M15 2v6" />
      <path d="M5 8h14v3a7 7 0 0 1-7 7v3" />
    </svg>
  )
}

function BotIcon() {
  return (
    <svg {...iconProps()}>
      <rect x="3" y="11" width="18" height="10" rx="2" />
      <circle cx="12" cy="5" r="2" />
      <path d="M12 7v4" />
      <line x1="8" y1="16" x2="8" y2="16" />
      <line x1="16" y1="16" x2="16" y2="16" />
    </svg>
  )
}

function CalendarIcon() {
  return (
    <svg {...iconProps()}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  )
}

function UsersIcon() {
  return (
    <svg {...iconProps()}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}

function CardIcon() {
  return (
    <svg {...iconProps()}>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <line x1="2" y1="10" x2="22" y2="10" />
    </svg>
  )
}

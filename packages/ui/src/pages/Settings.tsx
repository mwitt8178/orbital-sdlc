/**
 * Settings — rebuilt IA.
 *
 * Six top-level sections, each with its own sub-route. The previous 14-tab
 * horizontal strip is replaced by a sidebar that maps to designed sub-pages.
 *
 * Routes:
 *   /settings              → redirect to /settings/general
 *   /settings/general      → mode, identity, notifications, vision (read-only summary)
 *   /settings/integrations → unified integrations dashboard (Anthropic, GitHub, Monday, Hub)
 *   /settings/agents       → personas, routing, models, hooks
 *   /settings/sprints      → ceremonies, board, budget
 *   /settings/team         → hub team management (designed coming-soon if hub-only)
 *   /settings/billing      → designed coming-soon
 *
 * [Engineer-Principal · Opus · run-orbital-onboarding-rework]
 */

import { ReactNode, useEffect } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { motion } from 'framer-motion'
import { PersonasTab } from '../components/features/settings/PersonasTab.js'
import { RoutingPolicyTab } from '../components/features/settings/RoutingPolicyTab.js'
import { HooksTab } from '../components/features/settings/HooksTab.js'
import { CeremoniesTab } from '../components/features/settings/CeremoniesTab.js'
import { ProjectBreadcrumb } from '../components/layout/ProjectBreadcrumb.js'
import { BackupsTab } from '../components/features/settings/BackupsTab.js'
import { NotificationsTab } from '../components/features/settings/NotificationsTab.js'
import { IdentityTab } from '../components/features/settings/IdentityTab.js'
import { VisionTab } from '../components/features/settings/VisionTab.js'
import { BoardTab } from '../components/features/settings/BoardTab.js'
import { ModelsTab } from '../components/features/settings/ModelsTab.js'
import { GitHubTab } from '../components/features/settings/GitHubTab.js'
import { BudgetTab } from '../components/features/settings/BudgetTab.js'
import { HubTab } from '../components/features/settings/HubTab.js'
import { IntegrationsDashboard } from '../components/features/settings/IntegrationsDashboard.js'
// Per-project integration bindings (distinct from /admin/integrations install-wide tools).
// [Engineer-Principal · Opus · run-settings-integrations]
import { ProjectIntegrationsDashboard } from '../components/features/settings/ProjectIntegrationsDashboard.js'
import { ComingSoonState } from '../components/features/settings/ComingSoonState.js'
import { DURATION, EASE } from '../components/onboarding/motion.js'

interface SectionDef {
  id: string
  label: string
  description: string
  icon: ReactNode
}

const SECTIONS: SectionDef[] = [
  {
    id: 'general',
    label: 'General',
    description: 'Mode, identity, vision, notifications.',
    icon: <SlidersIcon />,
  },
  {
    id: 'integrations',
    label: 'Integrations',
    description: 'Anthropic, GitHub, Monday, Hub.',
    icon: <PlugIcon />,
  },
  {
    id: 'agents',
    label: 'Agents',
    description: 'Personas, routing, models, hooks.',
    icon: <BotIcon />,
  },
  {
    id: 'sprints',
    label: 'Sprints',
    description: 'Ceremonies, board, budget.',
    icon: <CalendarIcon />,
  },
  {
    id: 'team',
    label: 'Team',
    description: 'Hub members and roles.',
    icon: <UsersIcon />,
  },
  {
    id: 'billing',
    label: 'Billing',
    description: 'Plan and invoices.',
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

import { Outlet } from 'react-router-dom'

function SettingsShell() {
  const location = useLocation()

  // Restore scroll on sub-route change so the user always lands at the top
  // of the new section.
  useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [location.pathname])

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6 md:px-8">
      <header className="mb-6">
        <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
          <ProjectBreadcrumb />
          <span aria-hidden="true">›</span>
          <span>Settings</span>
        </div>
        <p className="text-eyebrow font-semibold uppercase text-slate-500">Workspace</p>
        <h1 className="mt-1 text-display-lg text-slate-900">Settings</h1>
        <p className="mt-1 text-sm text-slate-600">
          Configure how Orbital runs on your project. Most values are read-only in v1; the Coming
          Soon sections are wireframed and will land in v2.
        </p>
      </header>

      <div className="grid gap-6 md:grid-cols-[16rem_minmax(0,1fr)]">
        {/* ---- Sidebar ---- */}
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
                      </span>
                    </>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        {/* ---- Content ---- */}
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
// Section pages — composed from existing tab components
// ---------------------------------------------------------------------------

function PageHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-6">
      <h2 className="text-display-md text-slate-900">{title}</h2>
      <p className="mt-1 text-sm text-slate-600">{description}</p>
    </div>
  )
}

function PageSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="mb-8 rounded-card-lg border border-slate-200 bg-white p-5 shadow-card md:p-6">
      {title && (
        <h3 className="mb-4 text-eyebrow font-semibold uppercase text-slate-500">{title}</h3>
      )}
      {children}
    </section>
  )
}

function GeneralPage() {
  return (
    <>
      <PageHeader
        title="General"
        description="Mode, identity, notifications, and the project vision summary."
      />
      <PageSection title="Identity">
        <IdentityTab />
      </PageSection>
      <PageSection title="Vision">
        <VisionTab />
      </PageSection>
      <PageSection title="Notifications">
        <NotificationsTab />
      </PageSection>
      <PageSection title="Backups">
        <BackupsTab />
      </PageSection>
    </>
  )
}

function IntegrationsPage() {
  return (
    <Routes>
      <Route index element={<IntegrationsDashboardPage />} />
      <Route path="github" element={<IntegrationDetail title="GitHub"><GitHubTab /></IntegrationDetail>} />
      <Route path="monday" element={<IntegrationDetail title="Monday"><MondayPlaceholder /></IntegrationDetail>} />
      <Route path="anthropic" element={<IntegrationDetail title="Anthropic"><AnthropicPlaceholder /></IntegrationDetail>} />
      <Route path="hub" element={<IntegrationDetail title="Hub"><HubTab /></IntegrationDetail>} />
      <Route path="*" element={<Navigate to="" replace />} />
    </Routes>
  )
}

function IntegrationsDashboardPage() {
  return (
    <>
      <PageHeader
        title="Integrations"
        description="Per-project bindings — source control, ticket tracking, webhooks, and team chat. (Install-wide tool config lives under /admin/integrations.)"
      />
      <ProjectIntegrationsDashboard />
      <details className="mt-8 rounded-card-lg border border-slate-200 bg-slate-50 p-4 text-sm">
        <summary className="cursor-pointer font-semibold text-slate-700">
          Install-wide tool credentials
        </summary>
        <div className="mt-4">
          <IntegrationsDashboard />
        </div>
      </details>
    </>
  )
}

function IntegrationDetail({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <PageHeader title={title} description={`Manage your ${title} connection.`} />
      <PageSection>{children}</PageSection>
    </>
  )
}

function AgentsPage() {
  return (
    <>
      <PageHeader
        title="Agents"
        description="The personas that work on your project, the model each role uses, and the hooks they fire."
      />
      <PageSection title="Personas">
        <PersonasTab />
      </PageSection>
      <PageSection title="Routing policy">
        <RoutingPolicyTab />
      </PageSection>
      <PageSection title="Models">
        <ModelsTab />
      </PageSection>
      <PageSection title="Hooks">
        <HooksTab />
      </PageSection>
    </>
  )
}

function SprintsPage() {
  return (
    <>
      <PageHeader
        title="Sprints"
        description="Ceremony cadence, board mapping, and per-sprint budget enforcement."
      />
      <PageSection title="Ceremonies">
        <CeremoniesTab />
      </PageSection>
      <PageSection title="Board">
        <BoardTab />
      </PageSection>
      <PageSection title="Budget">
        <BudgetTab />
      </PageSection>
    </>
  )
}

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
        actionLabel="Manage hub connection"
        actionHref="/settings/integrations/hub"
        eta="v2 · ~2 weeks"
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
        title="Billing is wired up via Stripe — UI is coming"
        description="Live mode is metered today via the Anthropic key you supplied; per-org Stripe-backed billing arrives once we onboard our first paid team."
        actionLabel="Review per-sprint budget"
        actionHref="/settings/sprints"
        eta="v2"
      />
    </>
  )
}

function MondayPlaceholder() {
  return (
    <p className="text-sm text-slate-600">
      Manage your Monday API token from the integrations dashboard. Token rotation lives in your
      Identity tab today.
    </p>
  )
}

function AnthropicPlaceholder() {
  return (
    <p className="text-sm text-slate-600">
      Manage your Anthropic key from the integrations dashboard. Cost telemetry lives in{' '}
      <a href="/cost" className="font-medium text-brand-700 underline-offset-2 hover:underline">
        /cost
      </a>
      .
    </p>
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

/**
 * Settings — configuration overview.
 *
 * Read-only in v1. Tabs:
 *   - Personas      — baseline + user-defined personas
 *   - Routing       — per-risk-class model selection
 *   - Hooks         — registered pre/post hooks
 *   - Ceremonies    — planning, standup, retro specs
 *   - Backups       — list of past tarballs + schedule notice
 *   - Notifications — desktop notification opt-in
 *   - Identity      — install_id, mode, Anthropic + Monday connection
 *
 * Tab state is held in the URL hash so deep-linking from external places
 * (docs, runbooks) works without router config changes.
 */

import { useEffect, useState } from 'react'
import { PersonasTab } from '../components/features/settings/PersonasTab.js'
import { RoutingPolicyTab } from '../components/features/settings/RoutingPolicyTab.js'
import { HooksTab } from '../components/features/settings/HooksTab.js'
import { CeremoniesTab } from '../components/features/settings/CeremoniesTab.js'
import { BackupsTab } from '../components/features/settings/BackupsTab.js'
import { NotificationsTab } from '../components/features/settings/NotificationsTab.js'
import { IdentityTab } from '../components/features/settings/IdentityTab.js'
import { VisionTab } from '../components/features/settings/VisionTab.js'
import { BoardTab } from '../components/features/settings/BoardTab.js'
// Round 6 #8 — multi-model routing + provider config
// [Engineer-Sr · Sonnet · run-round6-08-multi-model]
import { ModelsTab } from '../components/features/settings/ModelsTab.js'
// Round 6 #1 — GitHub PR loop settings
// [Engineer-Sr · Sonnet · run-round6-01-pr-loop]
import { GitHubTab } from '../components/features/settings/GitHubTab.js'
// Round 6 #5 — Cost Governance: Budget tab
// [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
import { BudgetTab } from '../components/features/settings/BudgetTab.js'
// Round 7-02 — Hub connection tab
// [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
import { HubTab } from '../components/features/settings/HubTab.js'

const TABS = [
  { id: 'personas', label: 'Personas' },
  { id: 'routing', label: 'Routing policy' },
  { id: 'models', label: 'Models' },
  { id: 'hooks', label: 'Hooks' },
  { id: 'ceremonies', label: 'Ceremonies' },
  { id: 'backups', label: 'Backups' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'identity', label: 'Identity' },
  { id: 'vision', label: 'Vision' },
  { id: 'board', label: 'Board' },
  { id: 'github', label: 'GitHub' },
  // Round 6 #5 — Cost Governance
  // [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
  { id: 'budget', label: 'Budget' },
  // Round 7-02 — Hub connection
  // [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
  { id: 'hub', label: 'Hub' },
] as const

type TabId = (typeof TABS)[number]['id']

function readHashTab(): TabId {
  if (typeof window === 'undefined') return 'personas'
  const hash = window.location.hash.replace(/^#/, '')
  const found = TABS.find((t) => t.id === hash)
  return found ? found.id : 'personas'
}

export default function Settings() {
  const [activeTab, setActiveTab] = useState<TabId>(() => readHashTab())

  useEffect(() => {
    const onHashChange = () => setActiveTab(readHashTab())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const selectTab = (id: TabId) => {
    setActiveTab(id)
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href)
      url.hash = id
      window.history.replaceState(null, '', url.toString())
    }
  }

  return (
    <div className="mx-auto max-w-[1400px] px-8 py-6">
      <header className="mb-6">
        <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
          <span>Acme Product</span>
          <span aria-hidden="true">›</span>
          <span>Settings</span>
        </div>
        <h1 className="text-2xl font-bold text-slate-900">Settings</h1>
        <p className="mt-1 text-sm text-slate-500">
          Read-only view of personas, routing, hooks, ceremonies, backups, notifications, and
          installation identity.
        </p>
      </header>

      <nav
        aria-label="Settings tabs"
        className="mb-5 flex gap-1 overflow-x-auto border-b border-slate-200"
        role="tablist"
      >
        {TABS.map((t) => {
          const isActive = t.id === activeTab
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => selectTab(t.id)}
              className={
                isActive
                  ? 'border-b-2 border-brand-500 px-3 py-2 text-sm font-medium text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500'
                  : 'border-b-2 border-transparent px-3 py-2 text-sm text-slate-600 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500'
              }
            >
              {t.label}
            </button>
          )
        })}
      </nav>

      <div role="tabpanel" aria-label={`${activeTab} tab content`}>
        {activeTab === 'personas' ? <PersonasTab /> : null}
        {activeTab === 'routing' ? <RoutingPolicyTab /> : null}
        {activeTab === 'models' ? <ModelsTab /> : null}
        {activeTab === 'hooks' ? <HooksTab /> : null}
        {activeTab === 'ceremonies' ? <CeremoniesTab /> : null}
        {activeTab === 'backups' ? <BackupsTab /> : null}
        {activeTab === 'notifications' ? <NotificationsTab /> : null}
        {activeTab === 'identity' ? <IdentityTab /> : null}
        {activeTab === 'vision' ? <VisionTab /> : null}
        {activeTab === 'board' ? <BoardTab /> : null}
        {activeTab === 'github' ? <GitHubTab /> : null}
        {/* Round 6 #5 — Cost Governance */}
        {/* [Engineer-Sr · Sonnet · run-round6-05-cost-governance] */}
        {activeTab === 'budget' ? <BudgetTab /> : null}
        {/* Round 7-02 — Hub connection */}
        {/* [Engineer-Sr · Sonnet · run-round7-02-local-hub-split] */}
        {activeTab === 'hub' ? <HubTab /> : null}
      </div>
    </div>
  )
}

/**
 * Retro page — most recent report, proposals, and system-version rollback.
 *
 * Strategy:
 *  1. List system versions to discover the most recent retro_report_id.
 *  2. Use retro.proposal.list (no filter) to render all current proposals.
 *  3. When a proposal action settles, both the proposal list and (if a
 *     specific report is loaded) the report query are invalidated.
 *  4. A "System Versions" tab renders the RollbackPanel.
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { trpc } from '../services/trpc.js'
import { ReportCard } from '../components/features/retro/ReportCard.js'
import { ProposalCard } from '../components/features/retro/ProposalCard.js'
import { RollbackPanel } from '../components/features/retro/RollbackPanel.js'
import { ErrorMessage } from '../components/ui/ErrorMessage.js'
import { Skeleton } from '../components/ui/Skeleton.js'
import { ProjectBreadcrumb } from '../components/layout/ProjectBreadcrumb.js'

type Tab = 'proposals' | 'versions'

export default function Retro() {
  const versionsQuery = trpc.retro.versions.list.useQuery()
  const proposalsQuery = trpc.retro.proposal.list.useQuery()
  const [tab, setTab] = useState<Tab>('proposals')

  // Derive the most recent retro_report_id from system versions, if any exist.
  const recentReportId =
    versionsQuery.data
      ?.filter((v) => v.retro_report_id !== null)
      ?.sort((a, b) => (a.shipped_at < b.shipped_at ? 1 : -1))?.[0]?.retro_report_id ?? null

  const [refreshKey, setRefreshKey] = useState(0)

  const items = proposalsQuery.data ?? []

  return (
    <div className="mx-auto max-w-[1400px] px-8 py-6">
      <header className="mb-6 flex items-start justify-between">
        <div>
          <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
            <ProjectBreadcrumb />
            <span aria-hidden="true">›</span>
            <span>Retrospective</span>
          </div>
          <h1 className="text-2xl font-bold text-slate-900">Retrospective</h1>
          <p className="mt-1 text-sm text-slate-500">
            Sprint retrospectives, improvement proposals, and system-version rollbacks.
          </p>
        </div>
      </header>

      <nav
        aria-label="Retro tabs"
        className="mb-5 flex gap-1 border-b border-slate-200"
        role="tablist"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'proposals'}
          onClick={() => setTab('proposals')}
          className={
            tab === 'proposals'
              ? 'border-b-2 border-brand-500 px-3 py-2 text-sm font-medium text-brand-700'
              : 'border-b-2 border-transparent px-3 py-2 text-sm text-slate-600 hover:text-slate-900'
          }
        >
          Proposals
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'versions'}
          onClick={() => setTab('versions')}
          className={
            tab === 'versions'
              ? 'border-b-2 border-brand-500 px-3 py-2 text-sm font-medium text-brand-700'
              : 'border-b-2 border-transparent px-3 py-2 text-sm text-slate-600 hover:text-slate-900'
          }
        >
          System Versions
        </button>
      </nav>

      {tab === 'proposals' ? (
        <>
          <section className="mb-6">
            {versionsQuery.isLoading ? (
              <div className="rounded-lg border border-slate-200 bg-white p-5">
                <Skeleton rows={4} />
              </div>
            ) : versionsQuery.error ? (
              <ErrorMessage
                title="Could not load versions"
                message={versionsQuery.error.message}
              />
            ) : recentReportId ? (
              <ReportCard reportId={recentReportId} key={`${recentReportId}-${refreshKey}`} />
            ) : (
              <div className="rounded-lg border border-dashed border-slate-200 bg-white px-6 py-10 text-center">
                <h3 className="text-sm font-semibold text-slate-900">No retro report yet</h3>
                <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
                  Retros generate automatically after each sprint completes.
                </p>
                <Link
                  to="/welcome"
                  className="mt-3 inline-flex items-center text-xs font-medium text-brand-600 hover:text-brand-700"
                >
                  See a sample retro →
                </Link>
              </div>
            )}
          </section>

          <section>
            <header className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">Improvement Proposals</h2>
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">
                {items.length}
              </span>
            </header>

            {proposalsQuery.isLoading ? (
              <Skeleton rows={4} />
            ) : proposalsQuery.error ? (
              <ErrorMessage
                title="Could not load proposals"
                message={proposalsQuery.error.message}
              />
            ) : items.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-200 bg-white px-6 py-10 text-center">
                <h3 className="text-sm font-semibold text-slate-900">No proposals yet</h3>
                <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
                  Retros generate after each sprint, with proposals targeting persona configs, skills,
                  hooks, and routing policy.
                </p>
              </div>
            ) : (
              <ul className="space-y-3" role="list">
                {items.map((p) => (
                  <li key={p.retro_proposal_id} role="listitem">
                    <ProposalCard
                      proposal={p}
                      onChanged={() => setRefreshKey((k) => k + 1)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : (
        <RollbackPanel />
      )}
    </div>
  )
}

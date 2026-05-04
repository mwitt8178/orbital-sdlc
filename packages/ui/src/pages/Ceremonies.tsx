/**
 * Ceremonies page — auto-scheduling is the primary surface.
 *
 * Ceremonies fire automatically when system state crosses a threshold
 * (sprint completes, capacity drops below grooming line, disagreement
 * raised, etc.). This page surfaces that list with trigger metadata.
 *
 * Manual scheduling is demoted to an "Override" affordance for ad-hoc
 * cases only (e.g. "I want an architecture review even though it's not
 * flagged high-risk").
 */

import { useCeremoniesStore } from '../store/ceremonies.js'
import { CeremonyView } from '../components/features/ceremonies/CeremonyView.js'
import { CeremonyCard } from '../components/features/ceremonies/CeremonyCard.js'
import { OverrideDropdown } from '../components/features/ceremonies/OverrideDropdown.js'
import { TriggerRulesPanel } from '../components/features/ceremonies/TriggerRulesPanel.js'
import { EmptyState } from '../components/ui/EmptyState.js'
import { ProjectBreadcrumb } from '../components/layout/ProjectBreadcrumb.js'

export default function Ceremonies() {
  const list = useCeremoniesStore((s) => s.list)

  return (
    <div className="mx-auto max-w-[1400px] px-8 py-6">
      {/* ------------------------------------------------------------------ */}
      {/* Page header                                                          */}
      {/* ------------------------------------------------------------------ */}
      <header className="mb-6 flex items-start justify-between">
        <div>
          <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
            <ProjectBreadcrumb />
            <span aria-hidden="true">›</span>
            <span>Ceremonies</span>
          </div>
          <h1 className="text-2xl font-bold text-slate-900">Ceremonies</h1>
          <p className="mt-1.5 max-w-xl text-sm text-slate-500">
            Ceremonies are scheduled automatically when system state crosses a threshold — sprint
            completes, capacity drops below the grooming line, disagreement raised, etc. Each
            ceremony shows the trigger that fired it.
          </p>
        </div>

        {/* Override dropdown — replaces the old "+ Schedule ceremony" button */}
        <OverrideDropdown className="mt-1 flex-shrink-0" />
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* Active ceremony inline view (WS-driven)                             */}
      {/* ------------------------------------------------------------------ */}
      <section className="mb-8" aria-labelledby="active-ceremony-heading">
        <CeremonyView />
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* All ceremonies list — scheduled / in_progress / closed              */}
      {/* ------------------------------------------------------------------ */}
      <section className="mb-6" aria-labelledby="all-ceremonies-heading">
        <h2
          id="all-ceremonies-heading"
          className="mb-3 text-sm font-semibold text-slate-700"
        >
          All ceremonies
        </h2>

        {list.length === 0 ? (
          <EmptyState
            title="No ceremonies yet"
            description="Ceremonies will appear here as triggers fire. The system monitors sprint state, backlog health, and agent activity continuously."
          />
        ) : (
          <ul className="space-y-2" role="list" aria-label="Ceremony list">
            {list.map((ceremony) => (
              <li key={ceremony.ceremonyId}>
                <CeremonyCard ceremony={ceremony} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Trigger rules panel — educational collapsible                       */}
      {/* ------------------------------------------------------------------ */}
      <TriggerRulesPanel />
    </div>
  )
}

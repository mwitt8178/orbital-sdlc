/**
 * CeremoniesTab — read-only summary of ceremony specs.
 *
 * The orchestrator runs three ceremony types: planning, standup, retro.
 * Their cadence and chair persona are surfaced here for visibility. The
 * runtime specs live in packages/orchestrator/src/ceremonies/.
 */

interface CeremonyRow {
  slug: string
  displayName: string
  cadence: string
  chair: string
  artifacts: string
}

const CEREMONIES: CeremonyRow[] = [
  {
    slug: 'planning',
    displayName: 'Sprint Planning',
    cadence: 'Once per sprint, at sprint start',
    chair: 'pm + scrum-master',
    artifacts: 'Capacity plan, prioritized backlog, sprint goal.',
  },
  {
    slug: 'standup',
    displayName: 'Daily Standup',
    cadence: 'Once per day during a sprint',
    chair: 'scrum-master',
    artifacts: 'Per-persona update post in #sprint-XXX.',
  },
  {
    slug: 'retro',
    displayName: 'Sprint Retrospective',
    cadence: 'Once per sprint, at sprint end',
    chair: 'retro-analyst',
    artifacts: 'Retro report, improvement proposals, system_versions row.',
  },
]

export function CeremoniesTab() {
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        Ceremony cadence and chair personas. Schedules live in
        <code className="mx-1 rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px] text-slate-700">
          packages/orchestrator/src/ceremonies/
        </code>
        and run automatically per sprint.
      </p>
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-2 text-left font-medium">Ceremony</th>
              <th className="px-4 py-2 text-left font-medium">Cadence</th>
              <th className="px-4 py-2 text-left font-medium">Chair</th>
              <th className="px-4 py-2 text-left font-medium">Artifacts</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-sm text-slate-700">
            {CEREMONIES.map((c) => (
              <tr key={c.slug}>
                <td className="px-4 py-2 font-medium text-slate-900">{c.displayName}</td>
                <td className="px-4 py-2 text-xs text-slate-600">{c.cadence}</td>
                <td className="px-4 py-2 font-mono text-xs text-slate-700">{c.chair}</td>
                <td className="px-4 py-2 text-xs text-slate-500">{c.artifacts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

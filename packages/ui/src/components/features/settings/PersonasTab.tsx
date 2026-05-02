/**
 * PersonasTab — read-only list of baseline personas.
 *
 * The orchestrator does not (yet) expose a tRPC procedure to list personas
 * directly. The 11 baseline slugs are mirrored here from
 * packages/orchestrator/src/personas/library/index.ts. Editing a persona is
 * a v2 feature; for v1 we surface what is running so users know the lineup.
 */

const BASELINE_PERSONAS: Array<{
  slug: string
  displayName: string
  blurb: string
}> = [
  {
    slug: 'pm',
    displayName: 'Product Manager',
    blurb: 'Translates vision into testable acceptance criteria.',
  },
  {
    slug: 'architect',
    displayName: 'Architect',
    blurb: 'Owns service boundaries and event contracts.',
  },
  {
    slug: 'principal-dev',
    displayName: 'Principal Developer',
    blurb: 'Cross-cutting refactors, novel architecture, security-critical work.',
  },
  {
    slug: 'sr-dev',
    displayName: 'Senior Developer',
    blurb: 'Core implementation work.',
  },
  {
    slug: 'jr-dev',
    displayName: 'Junior Developer',
    blurb: 'Bounded tasks under SoD review.',
  },
  {
    slug: 'qa',
    displayName: 'Quality Assurance',
    blurb: 'Spec-driven verification, edge cases, regression evidence.',
  },
  {
    slug: 'security',
    displayName: 'Security',
    blurb: 'Auth flow review, secret handling, capability boundary checks.',
  },
  {
    slug: 'scrum-master',
    displayName: 'Scrum Master',
    blurb: 'Ceremony chair; flow protection.',
  },
  {
    slug: 'em',
    displayName: 'Engineering Manager',
    blurb: 'Capacity planning and prioritization.',
  },
  {
    slug: 'retro-analyst',
    displayName: 'Retro Analyst',
    blurb: 'Synthesizes sprint outcomes into proposals.',
  },
  {
    slug: 'verifier',
    displayName: 'Verifier',
    blurb: 'Runs acceptance tests against committed artifacts.',
  },
]

export function PersonasTab() {
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        {BASELINE_PERSONAS.length} baseline personas. Edit personas via config files in
        <code className="mx-1 rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px] text-slate-700">
          packages/orchestrator/src/personas/library/
        </code>
        — UI editing is a v2 feature.
      </p>
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
        {BASELINE_PERSONAS.map((p) => (
          <li key={p.slug} className="flex items-start justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-900">{p.displayName}</p>
              <p className="mt-0.5 text-xs text-slate-500">{p.blurb}</p>
            </div>
            <code className="flex-shrink-0 rounded bg-slate-100 px-2 py-0.5 font-mono text-[11px] text-slate-700">
              {p.slug}
            </code>
          </li>
        ))}
      </ul>
    </div>
  )
}

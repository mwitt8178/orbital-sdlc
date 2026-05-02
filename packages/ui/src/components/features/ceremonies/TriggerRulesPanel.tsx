/**
 * TriggerRulesPanel — educational collapsible panel listing all 12 ceremony
 * trigger rules with their firing conditions.
 *
 * The rule registry is hardcoded here as a UI-side constant. It MUST be kept
 * in sync with the rule definitions in comms/ceremony-triggers/ (backend agent
 * scope). Any new rule added on the backend should be added here.
 *
 * DEFERRED: "Last fired" timestamps are not yet fetched. The hover tooltip
 * shows a placeholder until ceremony.listTriggerFirings is available.
 */

import { useState } from 'react'

interface TriggerRule {
  /** Matches rule_id in ceremony_trigger_rules table */
  rule_id: string
  displayName: string
  condition: string
}

/**
 * UI-side registry of ceremony trigger rules.
 * Keep in sync with comms/ceremony-triggers/ (backend agent).
 */
export const TRIGGER_RULES_REGISTRY: TriggerRule[] = [
  {
    rule_id: 'backlog-grooming',
    displayName: 'Backlog Grooming',
    condition: 'Ready stories drop below 1.5× sprint capacity, or 5+ ungroomed stories pile up',
  },
  {
    rule_id: 'sprint-planning',
    displayName: 'Sprint Planning',
    condition: 'Sprint enters planning state with enough ready stories to fill it',
  },
  {
    rule_id: 'continuous-flow',
    displayName: 'Continuous-Flow',
    condition: 'Sprint completes — auto-creates next sprint and plans it',
  },
  {
    rule_id: 'mid-sprint-sync',
    displayName: 'Mid-Sprint Sync',
    condition: 'Sprint past 50% wallclock with less than 30% of tasks done',
  },
  {
    rule_id: 'sprint-review',
    displayName: 'Sprint Review',
    condition: 'Sprint enters completing state',
  },
  {
    rule_id: 'retro',
    displayName: 'Retrospective',
    condition: 'Sprint completes',
  },
  {
    rule_id: 'tie-breaker',
    displayName: 'Tie-Breaker',
    condition: 'Disagreement raised between agents',
  },
  {
    rule_id: 'blocker-resolve',
    displayName: 'Blocker Resolve',
    condition: 'Blocker open for more than 30 minutes without progress',
  },
  {
    rule_id: 'architecture-review',
    displayName: 'Architecture Review',
    condition: 'High-risk story enters ready state',
  },
  {
    rule_id: 'code-conflict',
    displayName: 'Code Conflict',
    condition: 'Scheduler detects two ready tasks with overlapping write paths',
  },
  {
    rule_id: 'budget-review',
    displayName: 'Budget Review',
    condition: 'Sprint cost crosses 80% of cap',
  },
  {
    rule_id: 'security-review',
    displayName: 'Security Review',
    condition: '5+ capability denials within 60 minutes',
  },
  {
    rule_id: 'vision-drift',
    displayName: 'Vision Drift',
    condition: '3+ retro proposals target the vision layer',
  },
]

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}

function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

export function TriggerRulesPanel() {
  const [expanded, setExpanded] = useState(false)

  return (
    <section
      className="rounded-lg border border-slate-200 bg-white"
      aria-label="How ceremonies fire"
    >
      <button
        type="button"
        className="flex w-full items-center justify-between px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500"
        aria-expanded={expanded}
        aria-controls="trigger-rules-list"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          {expanded ? (
            <ChevronDownIcon className="h-4 w-4 text-slate-400" />
          ) : (
            <ChevronRightIcon className="h-4 w-4 text-slate-400" />
          )}
          How ceremonies fire
        </span>
        <span className="text-xs text-slate-400">
          {TRIGGER_RULES_REGISTRY.length} trigger rules
        </span>
      </button>

      {expanded && (
        <div
          id="trigger-rules-list"
          className="border-t border-slate-100 px-4 pb-4 pt-3"
        >
          <p className="mb-3 text-xs text-slate-500">
            Ceremonies are created automatically when system state crosses one of these thresholds.
            No manual action is required. Use{' '}
            <strong className="font-medium text-slate-700">Override</strong> only for ad-hoc cases.
          </p>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" role="list">
            {TRIGGER_RULES_REGISTRY.map((rule) => (
              <TriggerRuleCard key={rule.rule_id} rule={rule} />
            ))}
          </ul>
          <p className="mt-3 text-[10px] text-slate-400">
            Rule definitions live in{' '}
            <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[10px] text-slate-600">
              comms/ceremony-triggers/
            </code>
            . Keep this list in sync when adding new rules.
          </p>
        </div>
      )}
    </section>
  )
}

function TriggerRuleCard({ rule }: { rule: TriggerRule }) {
  return (
    <li
      className="group rounded-md border border-slate-100 bg-slate-50 px-3 py-2"
      role="listitem"
    >
      <div className="flex items-center justify-between gap-1">
        <span className="text-xs font-semibold text-slate-800">{rule.displayName}</span>
        {/* DEFERRED: "Last fired" timestamp — needs ceremony.listTriggerFirings */}
        <span
          className="hidden text-[10px] text-slate-400 group-hover:block"
          aria-label="Last fired timestamp not yet available"
        >
          Last fired: —
        </span>
      </div>
      <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{rule.condition}</p>
      <span className="mt-1 inline-block font-mono text-[9px] text-slate-300">{rule.rule_id}</span>
    </li>
  )
}

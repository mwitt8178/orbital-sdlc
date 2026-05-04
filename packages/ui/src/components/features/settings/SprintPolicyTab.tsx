/**
 * SprintPolicyTab — per-project sprint policy editor.
 *
 * [Engineer-Principal · Opus · run-settings-sprints]
 *
 * Sections:
 *   - Sprint cadence       (length, start day, auto-advance)
 *   - Capacity policy      (story-points per sprint)
 *   - Budget cap           (USD per sprint, USD per week)
 *   - Ceremony rules       (planning + retro slots, auto-advance toggles, raw JSON)
 *
 * Save-on-blur: every input commits its value via `sprintPolicy.update`
 * when the user leaves the field. Inline indicator shows save state.
 *
 * "Reset to defaults" surfaces a ConfirmDialog before calling
 * `sprintPolicy.reset`.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { trpc } from '../../../services/trpc.js'
import { useActiveProjectStore } from '../../../store/active-project.js'
import { FormField } from '../../ui/FormField.js'
import { ConfirmDialog } from '../../ui/ConfirmDialog.js'

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

type CeremonyRules = {
  planning: { enabled: boolean; dow: number; hour: number }
  retro: { enabled: boolean; dow: number; hour: number }
  auto_retro_on_complete: boolean
  auto_create_next_sprint: boolean
  auto_promote_ready_stories: boolean
}

type Policy = {
  projectId: string
  lengthWeeks: 1 | 2 | 3 | 4
  startDow: number
  autoAdvance: boolean
  pointsPerSprint: number
  budgetUsdCentsPerSprint: number
  budgetUsdCentsPerWeek: number
  ceremonyRules: CeremonyRules
}

type FieldKey =
  | 'lengthWeeks'
  | 'startDow'
  | 'autoAdvance'
  | 'pointsPerSprint'
  | 'budgetUsdCentsPerSprint'
  | 'budgetUsdCentsPerWeek'
  | 'ceremonyRules'

type SaveState = { state: 'idle' } | { state: 'saving' } | { state: 'saved'; at: number } | { state: 'error'; msg: string }

function centsToDollars(cents: number): string {
  if (!cents) return '0'
  return (cents / 100).toFixed(2)
}
function dollarsToCents(s: string): number {
  const n = parseFloat(s)
  if (isNaN(n) || n < 0) return 0
  return Math.round(n * 100)
}

export function SprintPolicyTab() {
  const activeProjectId = useActiveProjectStore((s) => s.activeProjectId)
  const utils = trpc.useUtils()

  const policyQ = trpc.sprintPolicy.get.useQuery(
    { projectId: activeProjectId ?? '' },
    { enabled: !!activeProjectId },
  )

  const updateM = trpc.sprintPolicy.update.useMutation({
    onSuccess: (next) => {
      utils.sprintPolicy.get.setData({ projectId: next.projectId }, next)
    },
  })
  const resetM = trpc.sprintPolicy.reset.useMutation({
    onSuccess: (next) => {
      utils.sprintPolicy.get.setData({ projectId: next.projectId }, next)
    },
  })

  const policy = policyQ.data as Policy | undefined

  // Local draft state — initialised from policy, used as the controlled value
  // for each input. Save-on-blur sends only the changed field.
  const [draft, setDraft] = useState<Policy | null>(null)
  const [saveState, setSaveState] = useState<Record<FieldKey, SaveState>>({
    lengthWeeks: { state: 'idle' },
    startDow: { state: 'idle' },
    autoAdvance: { state: 'idle' },
    pointsPerSprint: { state: 'idle' },
    budgetUsdCentsPerSprint: { state: 'idle' },
    budgetUsdCentsPerWeek: { state: 'idle' },
    ceremonyRules: { state: 'idle' },
  })

  useEffect(() => {
    if (policy) setDraft(policy)
  }, [policy])

  const [confirmReset, setConfirmReset] = useState(false)
  const [ceremonyJsonText, setCeremonyJsonText] = useState<string>('')
  const [ceremonyJsonError, setCeremonyJsonError] = useState<string | null>(null)

  useEffect(() => {
    if (policy) {
      setCeremonyJsonText(JSON.stringify(policy.ceremonyRules, null, 2))
      setCeremonyJsonError(null)
    }
  }, [policy])

  async function commit<K extends FieldKey>(field: K, value: Policy[K]) {
    if (!activeProjectId || !draft) return
    if (policy && policy[field] === value) return
    setSaveState((s) => ({ ...s, [field]: { state: 'saving' } }))
    try {
      await updateM.mutateAsync({
        projectId: activeProjectId,
        patch: { [field]: value } as Partial<Policy>,
      })
      setSaveState((s) => ({ ...s, [field]: { state: 'saved', at: Date.now() } }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Save failed'
      setSaveState((s) => ({ ...s, [field]: { state: 'error', msg } }))
    }
  }

  function commitCeremonyRules(raw: string) {
    if (!activeProjectId) return
    try {
      const parsed = JSON.parse(raw) as CeremonyRules
      // Light client-side shape check — server enforces full Zod schema.
      if (
        !parsed.planning ||
        !parsed.retro ||
        typeof parsed.auto_retro_on_complete !== 'boolean' ||
        typeof parsed.auto_create_next_sprint !== 'boolean' ||
        typeof parsed.auto_promote_ready_stories !== 'boolean'
      ) {
        throw new Error('Missing required keys')
      }
      setCeremonyJsonError(null)
      void commit('ceremonyRules', parsed)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Invalid JSON'
      setCeremonyJsonError(msg)
      setSaveState((s) => ({ ...s, ceremonyRules: { state: 'error', msg } }))
    }
  }

  if (!activeProjectId) {
    return (
      <div className="rounded-card border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        Select a project to edit its sprint policy.
      </div>
    )
  }
  if (policyQ.isLoading || !draft) {
    return (
      <div className="rounded-card border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
        Loading sprint policy…
      </div>
    )
  }
  if (policyQ.error) {
    return (
      <div className="rounded-card border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700" role="alert">
        Failed to load sprint policy: {policyQ.error.message}
      </div>
    )
  }

  return (
    <div className="space-y-10">
      {/* ---- Sprint cadence ---- */}
      <Section
        title="Sprint cadence"
        description="How long each sprint runs, what day it starts, and whether the next one is created automatically."
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <FormField label="Length (weeks)">
            <select
              value={draft.lengthWeeks}
              onChange={(e) =>
                setDraft({ ...draft, lengthWeeks: Number(e.target.value) as 1 | 2 | 3 | 4 })
              }
              onBlur={(e) =>
                void commit('lengthWeeks', Number(e.target.value) as 1 | 2 | 3 | 4)
              }
              className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n} week{n === 1 ? '' : 's'}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Start day">
            <select
              value={draft.startDow}
              onChange={(e) => setDraft({ ...draft, startDow: Number(e.target.value) })}
              onBlur={(e) => void commit('startDow', Number(e.target.value))}
              className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              {DOW_LABELS.map((label, idx) => (
                <option key={label} value={idx}>
                  {label}
                </option>
              ))}
            </select>
          </FormField>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={draft.autoAdvance}
                onChange={(e) => {
                  const v = e.target.checked
                  setDraft({ ...draft, autoAdvance: v })
                  void commit('autoAdvance', v)
                }}
                className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              <span>
                Auto-advance — when a sprint completes, the next one is created automatically.
              </span>
            </label>
          </div>
        </div>
        <SaveRow states={[saveState.lengthWeeks, saveState.startDow, saveState.autoAdvance]} />
      </Section>

      {/* ---- Capacity ---- */}
      <Section
        title="Capacity policy"
        description="Default story-point capacity for a sprint. Used during planning to flag over-commitment."
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FormField label="Story points per sprint" help="Default capacity. Per-persona contribution arrives in v2.">
            <input
              type="number"
              min={0}
              max={1000}
              step={1}
              value={draft.pointsPerSprint}
              onChange={(e) => setDraft({ ...draft, pointsPerSprint: Number(e.target.value) })}
              onBlur={(e) => {
                const n = Math.max(0, Math.min(1000, Math.round(Number(e.target.value) || 0)))
                setDraft({ ...draft, pointsPerSprint: n })
                void commit('pointsPerSprint', n)
              }}
              className="w-full rounded-md border border-slate-200 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </FormField>
        </div>
        <SaveRow states={[saveState.pointsPerSprint]} />
      </Section>

      {/* ---- Budget ---- */}
      <Section
        title="Budget cap"
        description="Hard caps on LLM spend. The cost enforcer reads these before every spawn and after every LLM call."
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FormField label="USD per sprint" help="0 = no cap.">
            <input
              type="number"
              min={0}
              step="0.01"
              value={centsToDollars(draft.budgetUsdCentsPerSprint)}
              onChange={(e) =>
                setDraft({ ...draft, budgetUsdCentsPerSprint: dollarsToCents(e.target.value) })
              }
              onBlur={(e) => {
                const c = dollarsToCents(e.target.value)
                setDraft({ ...draft, budgetUsdCentsPerSprint: c })
                void commit('budgetUsdCentsPerSprint', c)
              }}
              className="w-full rounded-md border border-slate-200 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </FormField>
          <FormField label="USD per week" help="0 = no cap.">
            <input
              type="number"
              min={0}
              step="0.01"
              value={centsToDollars(draft.budgetUsdCentsPerWeek)}
              onChange={(e) =>
                setDraft({ ...draft, budgetUsdCentsPerWeek: dollarsToCents(e.target.value) })
              }
              onBlur={(e) => {
                const c = dollarsToCents(e.target.value)
                setDraft({ ...draft, budgetUsdCentsPerWeek: c })
                void commit('budgetUsdCentsPerWeek', c)
              }}
              className="w-full rounded-md border border-slate-200 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </FormField>
        </div>
        <SaveRow
          states={[saveState.budgetUsdCentsPerSprint, saveState.budgetUsdCentsPerWeek]}
        />
      </Section>

      {/* ---- Ceremony rules ---- */}
      <Section
        title="Ceremony rules"
        description="When planning and retro fire, and what happens when a sprint completes."
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <CeremonySlot
            label="Planning"
            slot={draft.ceremonyRules.planning}
            onChange={(slot) => {
              const next = { ...draft.ceremonyRules, planning: slot }
              setDraft({ ...draft, ceremonyRules: next })
              setCeremonyJsonText(JSON.stringify(next, null, 2))
              void commit('ceremonyRules', next)
            }}
          />
          <CeremonySlot
            label="Retro"
            slot={draft.ceremonyRules.retro}
            onChange={(slot) => {
              const next = { ...draft.ceremonyRules, retro: slot }
              setDraft({ ...draft, ceremonyRules: next })
              setCeremonyJsonText(JSON.stringify(next, null, 2))
              void commit('ceremonyRules', next)
            }}
          />
        </div>

        <div className="mt-4 space-y-2">
          <ToggleRow
            label="Auto-trigger retro when a sprint completes"
            checked={draft.ceremonyRules.auto_retro_on_complete}
            onChange={(v) => {
              const next = { ...draft.ceremonyRules, auto_retro_on_complete: v }
              setDraft({ ...draft, ceremonyRules: next })
              setCeremonyJsonText(JSON.stringify(next, null, 2))
              void commit('ceremonyRules', next)
            }}
          />
          <ToggleRow
            label="Auto-create the next sprint when one completes"
            checked={draft.ceremonyRules.auto_create_next_sprint}
            onChange={(v) => {
              const next = { ...draft.ceremonyRules, auto_create_next_sprint: v }
              setDraft({ ...draft, ceremonyRules: next })
              setCeremonyJsonText(JSON.stringify(next, null, 2))
              void commit('ceremonyRules', next)
            }}
          />
          <ToggleRow
            label="Auto-promote stories marked Ready into the next sprint"
            checked={draft.ceremonyRules.auto_promote_ready_stories}
            onChange={(v) => {
              const next = { ...draft.ceremonyRules, auto_promote_ready_stories: v }
              setDraft({ ...draft, ceremonyRules: next })
              setCeremonyJsonText(JSON.stringify(next, null, 2))
              void commit('ceremonyRules', next)
            }}
          />
        </div>

        <div className="mt-6">
          <FormField
            label="ceremony_rules JSON (advanced)"
            help="Edit the raw JSON. Validated against the same Zod schema as the form fields above."
            error={ceremonyJsonError ?? undefined}
          >
            <textarea
              value={ceremonyJsonText}
              onChange={(e) => setCeremonyJsonText(e.target.value)}
              onBlur={(e) => commitCeremonyRules(e.target.value)}
              rows={10}
              spellCheck={false}
              className="w-full rounded-md border border-slate-200 px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </FormField>
        </div>

        <SaveRow states={[saveState.ceremonyRules]} />
      </Section>

      {/* ---- Reset ---- */}
      <div className="rounded-card border border-slate-200 bg-slate-50 p-4">
        <p className="text-sm font-medium text-slate-800">Reset policy to defaults</p>
        <p className="mt-1 text-xs text-slate-500">
          Returns every field on this page to its factory-default value. This affects future sprints
          only — already-running sprints are not modified.
        </p>
        <button
          type="button"
          onClick={() => setConfirmReset(true)}
          className="mt-3 rounded-md border border-rose-200 bg-white px-3 py-2 text-sm font-medium text-rose-700 hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
        >
          Reset to defaults
        </button>
      </div>

      <ConfirmDialog
        open={confirmReset}
        onCancel={() => setConfirmReset(false)}
        onConfirm={async () => {
          if (!activeProjectId) return
          await resetM.mutateAsync({ projectId: activeProjectId })
          setConfirmReset(false)
        }}
        title="Reset sprint policy?"
        body={
          <>
            All cadence, capacity, budget, and ceremony settings on this page will be returned to
            their factory defaults. You can edit them again immediately afterwards.
          </>
        }
        confirmLabel="Reset to defaults"
        variant="danger"
        pending={resetM.isPending}
        error={resetM.error?.message ?? null}
        requireAcknowledge="I understand this overwrites every field on this page."
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Section({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <section>
      <header className="mb-3">
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        <p className="mt-0.5 text-xs text-slate-500">{description}</p>
      </header>
      {children}
    </section>
  )
}

function SaveRow({ states }: { states: SaveState[] }) {
  const summary = useMemo(() => {
    if (states.some((s) => s.state === 'saving')) return { tone: 'info' as const, text: 'Saving…' }
    const err = states.find((s) => s.state === 'error') as Extract<SaveState, { state: 'error' }> | undefined
    if (err) return { tone: 'error' as const, text: `Save failed: ${err.msg}` }
    const saved = states.find((s) => s.state === 'saved') as Extract<SaveState, { state: 'saved' }> | undefined
    if (saved) return { tone: 'ok' as const, text: 'Saved' }
    return null
  }, [states])

  if (!summary) return <div className="mt-2 h-4" aria-hidden="true" />
  return (
    <div
      className={
        summary.tone === 'error'
          ? 'mt-2 text-xs text-rose-600'
          : summary.tone === 'info'
            ? 'mt-2 text-xs text-slate-500'
            : 'mt-2 text-xs text-emerald-600'
      }
      role={summary.tone === 'error' ? 'alert' : undefined}
    >
      {summary.text}
    </div>
  )
}

function CeremonySlot({
  label,
  slot,
  onChange,
}: {
  label: string
  slot: { enabled: boolean; dow: number; hour: number }
  onChange: (slot: { enabled: boolean; dow: number; hour: number }) => void
}) {
  return (
    <div className="rounded-card border border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium text-slate-800">{label}</span>
        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={slot.enabled}
            onChange={(e) => onChange({ ...slot, enabled: e.target.checked })}
            className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
          />
          Enabled
        </label>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <FormField label="Day">
          <select
            value={slot.dow}
            onChange={(e) => onChange({ ...slot, dow: Number(e.target.value) })}
            disabled={!slot.enabled}
            className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-slate-50 disabled:text-slate-400"
          >
            {DOW_LABELS.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Hour (0–23)">
          <input
            type="number"
            min={0}
            max={23}
            step={1}
            value={slot.hour}
            onChange={(e) => {
              const n = Math.max(0, Math.min(23, Math.round(Number(e.target.value) || 0)))
              onChange({ ...slot, hour: n })
            }}
            disabled={!slot.enabled}
            className="w-full rounded-md border border-slate-200 px-2 py-1.5 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-slate-50 disabled:text-slate-400"
          />
        </FormField>
      </div>
    </div>
  )
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex items-start gap-2 text-sm text-slate-700">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
      />
      <span>{label}</span>
    </label>
  )
}

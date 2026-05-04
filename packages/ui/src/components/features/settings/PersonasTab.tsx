/**
 * PersonasTab — project-scoped persona roster editor.
 *
 * [Engineer-Principal · Opus · run-settings-agents]
 *
 * Reads `projectPersonas.list` for the active project and lets the user toggle
 * enabled, pick a model, set a per-task budget, and (via a drawer) edit the
 * system-prompt override.
 */

import { useEffect, useMemo, useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { useActiveProjectStore } from '../../../store/active-project.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'
import { Button } from '../../ui/Button.js'
import { Badge } from '../../ui/Badge.js'
import { Modal } from '../../ui/Modal.js'
import { FormField } from '../../ui/FormField.js'

const MODEL_OPTIONS: Array<{ value: 'claude-opus-4-7' | 'claude-sonnet-4-6' | 'claude-haiku-4-5'; label: string; tier: string }> = [
  { value: 'claude-opus-4-7', label: 'Opus 4.7', tier: 'Most capable' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6', tier: 'Balanced' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5', tier: 'Fast & cheap' },
]

interface PersonaRow {
  slug: string
  displayName: string
  role: string
  blurb: string
  enabled: boolean
  model: 'claude-opus-4-7' | 'claude-sonnet-4-6' | 'claude-haiku-4-5'
  budgetUsdCents: number
  systemPrompt: string
  systemPromptOverridden: boolean
  ordering: number
}

export function PersonasTab() {
  const activeProjectId = useActiveProjectStore((s) => s.activeProjectId)

  if (!activeProjectId) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        Select a project from the top bar to configure its agent roster.
      </div>
    )
  }

  return <PersonasTabInner projectId={activeProjectId} />
}

function PersonasTabInner({ projectId }: { projectId: string }) {
  // The trpc client carries x-orbital-project-id automatically; we still pass
  // projectId in the input so the server doesn't have to read headers.
  const list = (trpc as unknown as {
    projectPersonas: {
      list: { useQuery: (i: { projectId: string }) => { data?: PersonaRow[]; isLoading: boolean; error: { message: string } | null; refetch: () => void } }
      update: { useMutation: () => { mutateAsync: (i: unknown) => Promise<unknown>; isPending: boolean } }
    }
  }).projectPersonas.list.useQuery({ projectId })

  const update = (trpc as unknown as {
    projectPersonas: {
      update: { useMutation: () => { mutateAsync: (i: unknown) => Promise<unknown>; isPending: boolean } }
    }
  }).projectPersonas.update.useMutation()

  const [editingSlug, setEditingSlug] = useState<string | null>(null)
  const [draftPrompt, setDraftPrompt] = useState<string>('')
  const [busySlug, setBusySlug] = useState<string | null>(null)

  if (list.isLoading) return <Skeleton rows={6} />
  if (list.error) return <ErrorMessage title="Could not load personas" message={list.error.message} />
  const rows = list.data ?? []

  const editing = rows.find((r) => r.slug === editingSlug) ?? null

  async function applyPatch(slug: string, patch: Record<string, unknown>) {
    setBusySlug(slug)
    try {
      await update.mutateAsync({ projectId, personaSlug: slug, patch })
      list.refetch()
    } finally {
      setBusySlug(null)
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-500">
        {rows.length} personas available. Toggle a persona off to remove it from the routing-claim
        queue. Edit prompts to override the baseline brief.
      </p>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">Persona</th>
              <th className="px-4 py-2 font-medium">Role</th>
              <th className="px-4 py-2 font-medium">Enabled</th>
              <th className="px-4 py-2 font-medium">Model</th>
              <th className="px-4 py-2 font-medium">Budget / task</th>
              <th className="px-4 py-2 font-medium">Prompt</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((p) => (
              <tr key={p.slug} className={busySlug === p.slug ? 'opacity-60' : ''}>
                <td className="px-4 py-3 align-top">
                  <div className="font-semibold text-slate-900">{p.displayName}</div>
                  <code className="font-mono text-[11px] text-slate-500">{p.slug}</code>
                  <p className="mt-1 max-w-xs text-xs text-slate-500">{p.blurb}</p>
                </td>
                <td className="px-4 py-3 align-top">
                  <Badge color="slate">{p.role}</Badge>
                </td>
                <td className="px-4 py-3 align-top">
                  <label className="inline-flex cursor-pointer items-center gap-2 select-none">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-slate-300 text-brand-600 focus-visible:ring-2 focus-visible:ring-brand-500"
                      checked={p.enabled}
                      onChange={(e) => {
                        void applyPatch(p.slug, { enabled: e.target.checked })
                      }}
                      aria-label={`Enable ${p.displayName}`}
                    />
                    <span className="text-xs text-slate-600">{p.enabled ? 'On' : 'Off'}</span>
                  </label>
                </td>
                <td className="px-4 py-3 align-top">
                  <select
                    className="block rounded-md border border-slate-300 bg-white px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                    value={p.model}
                    onChange={(e) => {
                      void applyPatch(p.slug, { model: e.target.value })
                    }}
                    aria-label={`Model for ${p.displayName}`}
                  >
                    {MODEL_OPTIONS.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label} — {m.tier}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-3 align-top">
                  <BudgetEditor
                    initialCents={p.budgetUsdCents}
                    onCommit={(cents) => applyPatch(p.slug, { budgetUsdCents: cents })}
                    label={`Budget for ${p.displayName}`}
                  />
                </td>
                <td className="px-4 py-3 align-top">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setEditingSlug(p.slug)
                      setDraftPrompt(p.systemPrompt)
                    }}
                  >
                    Edit prompt
                  </Button>
                  {p.systemPromptOverridden && (
                    <div className="mt-1">
                      <Badge color="amber">Custom</Badge>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal
        open={!!editing}
        onClose={() => setEditingSlug(null)}
        title={editing ? `${editing.displayName} — system prompt` : 'System prompt'}
        width="max-w-3xl"
      >
        {editing && (
          <PromptEditor
            slug={editing.slug}
            initialValue={draftPrompt}
            onChange={setDraftPrompt}
            onSave={async (value) => {
              await applyPatch(editing.slug, {
                systemPromptOverride: value.trim().length > 0 ? value : null,
              })
              setEditingSlug(null)
            }}
            onResetToBaseline={async () => {
              await applyPatch(editing.slug, { systemPromptOverride: null })
              setEditingSlug(null)
            }}
            isOverridden={editing.systemPromptOverridden}
            saving={update.isPending}
          />
        )}
      </Modal>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Inline budget editor — debounced commit on blur or Enter.
// ---------------------------------------------------------------------------

function BudgetEditor({
  initialCents,
  onCommit,
  label,
}: {
  initialCents: number
  onCommit: (cents: number) => Promise<void> | void
  label: string
}) {
  const [draft, setDraft] = useState<string>((initialCents / 100).toFixed(2))

  // Re-sync when server value changes (e.g. external refetch).
  useEffect(() => {
    setDraft((initialCents / 100).toFixed(2))
  }, [initialCents])

  function commit() {
    const parsed = Number(draft)
    if (!Number.isFinite(parsed) || parsed < 0) {
      setDraft((initialCents / 100).toFixed(2))
      return
    }
    const cents = Math.round(parsed * 100)
    if (cents === initialCents) return
    void onCommit(cents)
  }

  return (
    <div className="inline-flex items-center gap-1">
      <span className="text-xs text-slate-500">$</span>
      <input
        type="number"
        min="0"
        step="0.5"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            ;(e.target as HTMLInputElement).blur()
          }
        }}
        className="w-20 rounded-md border border-slate-300 px-2 py-1 text-right text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        aria-label={label}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Prompt editor — textarea + live preview, no extra deps.
// ---------------------------------------------------------------------------

function PromptEditor({
  slug,
  initialValue,
  onChange,
  onSave,
  onResetToBaseline,
  isOverridden,
  saving,
}: {
  slug: string
  initialValue: string
  onChange: (v: string) => void
  onSave: (v: string) => Promise<void>
  onResetToBaseline: () => Promise<void>
  isOverridden: boolean
  saving: boolean
}) {
  const [value, setValue] = useState(initialValue)
  const charCount = value.length

  const previewBlocks = useMemo(() => splitMarkdownBlocks(value), [value])

  return (
    <div className="space-y-3">
      <FormField label="System prompt (markdown)" help={`Persona: ${slug}. Empty value reverts to the baseline brief.`}>
        <textarea
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            onChange(e.target.value)
          }}
          rows={14}
          className="block w-full resize-y rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs leading-relaxed text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          placeholder="Override the baseline brief, or leave blank to inherit."
          spellCheck={false}
        />
      </FormField>

      <details className="rounded-md border border-slate-200 bg-slate-50">
        <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-slate-600">
          Preview ({charCount} chars)
        </summary>
        <div className="space-y-2 px-4 py-3 text-sm text-slate-800">
          {previewBlocks.map((b, i) => (
            <RenderedBlock key={i} block={b} />
          ))}
        </div>
      </details>

      <div className="flex items-center justify-between gap-2">
        <Button variant="secondary" onClick={() => void onResetToBaseline()} disabled={!isOverridden || saving}>
          Reset to baseline
        </Button>
        <Button variant="primary" onClick={() => void onSave(value)} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  )
}

// Lightweight markdown chunker for preview. We render headings, code fences,
// bullet lists, and paragraphs — enough for a faithful view without pulling
// in a 50kb markdown library for an admin-only screen.

type Block =
  | { kind: 'h'; level: number; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'p'; text: string }

function splitMarkdownBlocks(src: string): Block[] {
  const lines = src.split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (line.startsWith('```')) {
      const buf: string[] = []
      i += 1
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) {
        buf.push(lines[i] ?? '')
        i += 1
      }
      i += 1
      blocks.push({ kind: 'code', text: buf.join('\n') })
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({ kind: 'h', level: (heading[1] ?? '').length, text: heading[2] ?? '' })
      i += 1
      continue
    }
    if (line.startsWith('- ') || line.startsWith('* ')) {
      const items: string[] = []
      while (
        i < lines.length &&
        ((lines[i] ?? '').startsWith('- ') || (lines[i] ?? '').startsWith('* '))
      ) {
        items.push((lines[i] ?? '').slice(2))
        i += 1
      }
      blocks.push({ kind: 'ul', items })
      continue
    }
    if (line.trim().length === 0) {
      i += 1
      continue
    }
    const buf: string[] = [line]
    i += 1
    while (i < lines.length) {
      const next = lines[i] ?? ''
      if (
        next.trim().length === 0 ||
        next.startsWith('#') ||
        next.startsWith('```') ||
        next.startsWith('- ') ||
        next.startsWith('* ')
      ) {
        break
      }
      buf.push(next)
      i += 1
    }
    blocks.push({ kind: 'p', text: buf.join(' ') })
  }
  return blocks
}

function RenderedBlock({ block }: { block: Block }) {
  if (block.kind === 'h') {
    const size = block.level <= 2 ? 'text-base font-semibold' : 'text-sm font-semibold'
    return <div className={`${size} text-slate-900`}>{block.text}</div>
  }
  if (block.kind === 'code') {
    return (
      <pre className="overflow-x-auto rounded bg-slate-900 px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-100">
        {block.text}
      </pre>
    )
  }
  if (block.kind === 'ul') {
    return (
      <ul className="ml-4 list-disc space-y-1 text-slate-700">
        {block.items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    )
  }
  return <p className="text-slate-700">{block.text}</p>
}

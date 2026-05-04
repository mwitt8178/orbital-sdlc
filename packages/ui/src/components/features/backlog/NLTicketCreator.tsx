/**
 * NLTicketCreator — primary creation surface for /backlog.
 *
 * Chat-style input at the top of the epic list. The user types a sentence,
 * hits Enter or →, and the input is sent through `backlog.parseAndCreate`,
 * which classifies it as story | bug | epic and returns a typed Proposal
 * grounded in the locked vision content.
 *
 * The Proposal renders below the input as an inline confirmation card with
 * editable fields. On confirm, the appropriate `epics.create` /
 * `stories.create` mutation persists the ticket via the existing audit /
 * event path (EpicCreated / StoryCreated). This keeps the new flow on the
 * same code path as the deleted form modals — no new event types, no schema
 * changes.
 *
 * Empty state: when there are no stories yet, the component is the focal
 * point — "Tell me what you want to build" placeholder, autofocused.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { trpc } from '../../../services/trpc.js'
import { Input } from '../../ui/Input.js'
import { Button } from '../../ui/Button.js'
import { Badge } from '../../ui/Badge.js'
import { useToast } from '../../../services/use-toast.js'
import { useVisionStore } from '../../../store/vision.js'
import {
  toEditableProposal,
  isProposalValid,
  summarizeRationale,
  type EditableProposal,
  type EpicOption,
  type ProposalLike,
} from './nl-ticket-creator-helpers.js'

interface NLTicketCreatorProps {
  /** Existing epics — used to populate the epic-pick dropdown on the proposal card. */
  epics: EpicOption[]
}

export function NLTicketCreator({ epics }: NLTicketCreatorProps) {
  const utils = trpc.useUtils()
  const toast = useToast()
  const documentId = useVisionStore((s) => s.currentDocumentId)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const [prompt, setPrompt] = useState('')
  const [forceKind, setForceKind] = useState<'auto' | 'story' | 'bug' | 'epic'>('auto')
  const [proposal, setProposal] = useState<ProposalLike | null>(null)
  const [draft, setDraft] = useState<EditableProposal | null>(null)
  const [parseLoading, setParseLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Autofocus the input on mount so the user can start typing immediately.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const epicCreateMutation = trpc.backlog.epics.create.useMutation({
    onSuccess: () => {
      void utils.backlog.epics.list.invalidate()
      void utils.backlog.stories.list.invalidate()
    },
  })
  const storyCreateMutation = trpc.backlog.stories.create.useMutation({
    onSuccess: () => {
      void utils.backlog.stories.list.invalidate()
    },
  })

  // Vision version for epic creation. backlog.epics.create requires a
  // vision_version_id; resolve from the locked vision document when present.
  const visionDocQuery = trpc.vision.get.useQuery(
    documentId ? { vision_document_id: documentId } : (undefined as never),
    { enabled: !!documentId },
  )
  const visionVersionId =
    (visionDocQuery.data?.version as { vision_version_id?: string } | null | undefined)
      ?.vision_version_id ?? null

  const isPending =
    parseLoading || epicCreateMutation.isPending || storyCreateMutation.isPending

  const handleSubmitPrompt = async () => {
    setError(null)
    const trimmed = prompt.trim()
    if (trimmed.length === 0) {
      setError('Type what you want to add and press Enter.')
      return
    }
    setParseLoading(true)
    try {
      const input: {
        prompt: string
        kind: 'auto' | 'story' | 'bug' | 'epic'
        vision_document_id?: string
      } = { prompt: trimmed, kind: forceKind }
      if (documentId) input.vision_document_id = documentId
      const result = (await utils.client.backlog.parseAndCreate.query(input)) as ProposalLike
      setProposal(result)
      setDraft(toEditableProposal(result, epics))
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not parse prompt'
      setError(msg)
      toast.error('Could not parse prompt', { description: msg })
    } finally {
      setParseLoading(false)
    }
  }

  const handleDiscard = () => {
    setProposal(null)
    setDraft(null)
    setPrompt('')
    setError(null)
    setForceKind('auto')
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  const handleConfirm = async () => {
    if (!proposal || !draft) return
    if (!isProposalValid(draft)) {
      setError(
        draft.kind === 'epic'
          ? 'Title and description are required.'
          : 'Title, an epic, and at least one acceptance criterion are required.',
      )
      return
    }
    setError(null)
    try {
      if (draft.kind === 'epic') {
        if (!visionVersionId) {
          setError('No vision version available — lock or draft a vision before creating epics.')
          return
        }
        const epic = await epicCreateMutation.mutateAsync({
          vision_version_id: visionVersionId,
          title: draft.title.trim(),
          rationale: draft.description.trim(),
          priority: draft.priority,
        })
        toast.success('Epic created', { description: epic.title })
      } else {
        const acceptance = draft.ac_titles
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
          .map((text) => ({ text }))
        const input: Parameters<typeof storyCreateMutation.mutateAsync>[0] = {
          epic_id: draft.selected_epic_id,
          title: draft.title.trim(),
          description: draft.description.trim(),
          acceptance_criteria: acceptance,
          priority: draft.priority,
        }
        if (proposal.persona_of_record) input.persona_of_record = proposal.persona_of_record
        if (proposal.bug?.defect_id) input.defect_id = proposal.bug.defect_id
        const story = await storyCreateMutation.mutateAsync(input)
        toast.success(draft.kind === 'bug' ? 'Bug created' : 'Story created', {
          description: story.title,
        })
      }
      handleDiscard()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not create'
      setError(msg)
      toast.error('Could not create', { description: msg })
    }
  }

  const onPromptKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !proposal) {
      e.preventDefault()
      void handleSubmitPrompt()
    }
  }

  const summary = useMemo(() => (proposal ? summarizeRationale(proposal) : null), [proposal])

  return (
    <section
      className="rounded-lg border border-brand-100 bg-gradient-to-br from-white to-brand-50/30 p-3"
      aria-label="Add a story from natural language"
      data-testid="nl-ticket-creator"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="text-base text-brand-600">
          ✨
        </span>
        <span className="text-sm font-semibold text-slate-900">What do you want to add?</span>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <Input
          ref={inputRef}
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={onPromptKeyDown}
          placeholder="e.g. I want password reset via email"
          aria-label="Describe what you want to add"
          disabled={isPending || proposal !== null}
          data-testid="nl-ticket-creator-input"
          className="flex-1"
        />
        <select
          value={forceKind}
          onChange={(e) =>
            setForceKind(e.target.value as 'auto' | 'story' | 'bug' | 'epic')
          }
          disabled={isPending || proposal !== null}
          aria-label="Override kind"
          className="rounded-md border border-slate-200 bg-white px-2 py-2 text-xs font-medium text-slate-600 focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          <option value="auto">Auto</option>
          <option value="story">Story</option>
          <option value="bug">Bug</option>
          <option value="epic">Epic</option>
        </select>
        <Button
          onClick={() => void handleSubmitPrompt()}
          disabled={isPending || prompt.trim().length === 0 || proposal !== null}
          aria-label="Parse and create"
          data-testid="nl-ticket-creator-submit"
        >
          {parseLoading ? '…' : '→'}
        </Button>
      </div>

      <div className="mt-1 px-1 text-[11px] text-slate-500">
        Suggestions: bug · improvement · ask the PM persona. Press Enter to parse.
      </div>

      {error && !proposal && (
        <p className="mt-2 px-1 text-xs text-rose-600" role="alert">
          {error}
        </p>
      )}

      {proposal && draft && (
        <ProposalConfirmCard
          proposal={proposal}
          draft={draft}
          summary={summary ?? ''}
          epics={epics}
          error={error}
          isPending={isPending}
          onChange={setDraft}
          onDiscard={handleDiscard}
          onConfirm={() => void handleConfirm()}
        />
      )}
    </section>
  )
}

interface ProposalConfirmCardProps {
  proposal: ProposalLike
  draft: EditableProposal
  summary: string
  epics: EpicOption[]
  error: string | null
  isPending: boolean
  onChange: (next: EditableProposal) => void
  onDiscard: () => void
  onConfirm: () => void
}

function ProposalConfirmCard(props: ProposalConfirmCardProps) {
  const { proposal, draft, summary, epics, error, isPending } = props

  const kindBadgeColor =
    draft.kind === 'bug'
      ? 'rose'
      : draft.kind === 'epic'
        ? 'violet'
        : 'blue'

  const updateAc = (idx: number, value: string) => {
    const next = [...draft.ac_titles]
    next[idx] = value
    props.onChange({ ...draft, ac_titles: next })
  }

  const removeAc = (idx: number) => {
    props.onChange({
      ...draft,
      ac_titles: draft.ac_titles.filter((_, i) => i !== idx),
    })
  }

  const addAc = () => {
    props.onChange({ ...draft, ac_titles: [...draft.ac_titles, ''] })
  }

  return (
    <div
      className="mt-3 rounded-md border border-slate-200 bg-white p-3 shadow-sm"
      data-testid="nl-ticket-creator-proposal"
      role="region"
      aria-label="Proposed story — review and confirm"
    >
      <div className="mb-2 flex items-center gap-2">
        <Badge color={kindBadgeColor}>{draft.kind}</Badge>
        <span className="text-xs text-slate-500">Create this?</span>
        {proposal.bug?.severity && (
          <Badge
            color={
              proposal.bug.severity === 'critical' || proposal.bug.severity === 'high'
                ? 'rose'
                : proposal.bug.severity === 'low'
                  ? 'slate'
                  : 'amber'
            }
          >
            severity: {proposal.bug.severity}
          </Badge>
        )}
        <span className="ml-auto text-[10px] uppercase tracking-wider text-slate-400">
          via {proposal.parser_engine}
        </span>
      </div>

      {summary && <p className="mb-2 text-xs text-slate-500">{summary}</p>}

      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-[11px] font-medium text-slate-600" htmlFor="nl-title">
            Title
          </label>
          <Input
            id="nl-title"
            value={draft.title}
            onChange={(e) => props.onChange({ ...draft, title: e.target.value })}
            data-testid="nl-ticket-creator-title"
          />
        </div>

        <div>
          <label className="mb-1 block text-[11px] font-medium text-slate-600" htmlFor="nl-desc">
            Description
          </label>
          <textarea
            id="nl-desc"
            rows={3}
            value={draft.description}
            onChange={(e) => props.onChange({ ...draft, description: e.target.value })}
            className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            data-testid="nl-ticket-creator-description"
          />
        </div>

        {draft.kind !== 'epic' && (
          <div>
            <label className="mb-1 block text-[11px] font-medium text-slate-600" htmlFor="nl-epic">
              Epic
            </label>
            <select
              id="nl-epic"
              value={draft.selected_epic_id}
              onChange={(e) => props.onChange({ ...draft, selected_epic_id: e.target.value })}
              className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              data-testid="nl-ticket-creator-epic"
            >
              <option value="">Select an epic…</option>
              {epics.map((e) => (
                <option key={e.epicId} value={e.epicId}>
                  {e.title}
                  {proposal.suggested_epic_title === e.title ? '  (suggested)' : ''}
                </option>
              ))}
            </select>
          </div>
        )}

        {draft.kind !== 'epic' && (
          <div>
            <label className="mb-1 block text-[11px] font-medium text-slate-600">
              Acceptance criteria
            </label>
            <div className="space-y-1.5">
              {draft.ac_titles.map((ac, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="font-mono text-[10px] text-slate-400">{i + 1}.</span>
                  <Input
                    value={ac}
                    onChange={(e) => updateAc(i, e.target.value)}
                    aria-label={`Acceptance criterion ${i + 1}`}
                    className="flex-1"
                    data-testid={`nl-ticket-creator-ac-${i}`}
                  />
                  {draft.ac_titles.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeAc(i)}
                      className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-rose-600"
                      aria-label={`Remove criterion ${i + 1}`}
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M3 6h18" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                      </svg>
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={addAc}
                className="text-xs font-medium text-brand-600 hover:text-brand-700"
              >
                + Add criterion
              </button>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label
              className="mb-1 block text-[11px] font-medium text-slate-600"
              htmlFor="nl-priority"
            >
              Priority (lower = higher)
            </label>
            <Input
              id="nl-priority"
              type="number"
              min={0}
              value={draft.priority}
              onChange={(e) =>
                props.onChange({ ...draft, priority: Number(e.target.value) || 0 })
              }
            />
          </div>
          {draft.kind !== 'epic' && (
            <div>
              <label
                className="mb-1 block text-[11px] font-medium text-slate-600"
                htmlFor="nl-points"
              >
                Estimate
              </label>
              <select
                id="nl-points"
                value={draft.story_points ?? ''}
                onChange={(e) =>
                  props.onChange({
                    ...draft,
                    story_points: e.target.value === '' ? null : Number(e.target.value),
                  })
                }
                className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                <option value="">Not estimated</option>
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3">3</option>
                <option value="5">5</option>
                <option value="8">8</option>
                <option value="13">13</option>
              </select>
            </div>
          )}
        </div>
      </div>

      {error && (
        <p className="mt-2 text-xs text-rose-600" role="alert">
          {error}
        </p>
      )}

      <div className="mt-3 flex items-center justify-end gap-2 border-t border-slate-100 pt-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={props.onDiscard}
          disabled={isPending}
          data-testid="nl-ticket-creator-discard"
        >
          Discard
        </Button>
        <Button
          size="sm"
          onClick={props.onConfirm}
          disabled={isPending || !isProposalValid(draft)}
          data-testid="nl-ticket-creator-confirm"
        >
          {isPending ? 'Creating…' : 'Create'}
        </Button>
      </div>
    </div>
  )
}

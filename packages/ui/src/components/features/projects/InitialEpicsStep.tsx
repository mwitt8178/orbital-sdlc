/**
 * InitialEpicsStep — Stage 6 of the immersive project setup flow.
 *
 * After the user locks the vision document we call vision.suggestEpics to
 * fetch 3-5 templated epic suggestions derived from the vision content.
 * The user sees each suggestion as a card with a checkbox (accepted by
 * default), can edit the title/description inline, can remove a card, can
 * add a custom epic, and can skip entirely.
 *
 * On confirm, we call backlog.epics.create per accepted card and route to
 * /backlog with the new project active.
 */

import { useEffect, useMemo, useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { buildAuditMetadata } from '../../../services/audit-metadata.js'
import { Button } from '../../ui/Button.js'
import { Input } from '../../ui/Input.js'

interface Props {
  projectId: string
  visionDocumentId: string
  visionVersionId: string
  /** Called once all accepted epics are successfully created. */
  onFinished: () => void
  /** Called when the user clicks "Skip" to finish without epics. */
  onSkip: () => void
  /** Called when the user clicks "Back" to return to the interview. */
  onBack: () => void
}

interface EpicCard {
  /** Stable client-side id (uuidv4-ish) used for list keys. */
  cardId: string
  title: string
  description: string
  storyTitles: string[]
  /** Whether the user wants this epic created. Defaults to true. */
  accepted: boolean
  /** True while the user is editing the title/description inline. */
  editing: boolean
}

let cardIdCounter = 0
function makeCardId() {
  cardIdCounter += 1
  return `card-${Date.now()}-${cardIdCounter}`
}

export function InitialEpicsStep({
  projectId,
  visionDocumentId,
  visionVersionId,
  onFinished,
  onSkip,
  onBack,
}: Props) {
  const [cards, setCards] = useState<EpicCard[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  // Build the audit metadata ONCE per (project, document) pair. If we rebuilt
  // it on every render, `trace_id` would change each time and react-query
  // would re-key the query and refetch in a tight loop, never settling.
  const suggestInput = useMemo(
    () => ({
      vision_document_id: visionDocumentId,
      audit_metadata: buildAuditMetadata(
        'Fetching templated epic suggestions for newly-locked vision',
        {
          linked_artifacts: [
            { type: 'project', id: projectId },
            { type: 'vision_document', id: visionDocumentId },
          ],
        },
      ),
    }),
    [visionDocumentId, projectId],
  )

  // Fetch suggestions once the document id is present.
  const suggestQuery = trpc.vision.suggestEpics.useQuery(suggestInput, {
    enabled: !!visionDocumentId,
    staleTime: 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
  })

  // Hydrate cards from the suggestion result.
  useEffect(() => {
    if (cards !== null) return
    if (!suggestQuery.data) return
    setCards(
      suggestQuery.data.epics.map((e) => ({
        cardId: makeCardId(),
        title: e.title,
        description: e.description,
        storyTitles: e.story_titles,
        accepted: true,
        editing: false,
      })),
    )
  }, [cards, suggestQuery.data])

  const epicCreate = trpc.backlog.epics.create.useMutation()

  const handleCreate = async () => {
    if (!cards) return
    const accepted = cards.filter((c) => c.accepted && c.title.trim().length > 0)
    setCreating(true)
    setError(null)
    try {
      // Sequential creates so a failure stops the chain at a known point.
      for (let i = 0; i < accepted.length; i++) {
        const card = accepted[i]!
        await epicCreate.mutateAsync({
          vision_version_id: visionVersionId,
          title: card.title.trim(),
          rationale:
            card.description.trim().length > 0
              ? card.description.trim()
              : 'Suggested by PM persona during project setup.',
          priority: i + 1,
        })
      }
      onFinished()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  const handleAddCustom = () => {
    setCards((prev) => [
      ...(prev ?? []),
      {
        cardId: makeCardId(),
        title: '',
        description: '',
        storyTitles: [],
        accepted: true,
        editing: true,
      },
    ])
  }

  const updateCard = (cardId: string, partial: Partial<EpicCard>) => {
    setCards((prev) =>
      (prev ?? []).map((c) => (c.cardId === cardId ? { ...c, ...partial } : c)),
    )
  }

  const removeCard = (cardId: string) => {
    setCards((prev) => (prev ?? []).filter((c) => c.cardId !== cardId))
  }

  const acceptedCount = cards?.filter((c) => c.accepted && c.title.trim().length > 0).length ?? 0

  return (
    <div className="flex h-[640px] flex-col gap-3">
      <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
        The PM persona suggests these initial epics based on your vision. Edit,
        remove, or add as you see fit. Each accepted epic becomes a real epic in
        your backlog when you finish.
      </div>

      <div className="scrollbar-thin flex-1 overflow-y-auto pr-1">
        {suggestQuery.isLoading && (
          <p className="py-6 text-center text-sm text-slate-500">
            Generating epic suggestions…
          </p>
        )}
        {suggestQuery.error && (
          <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            Could not load epic suggestions: {suggestQuery.error.message}. You
            can still add epics manually below.
          </p>
        )}
        {cards && cards.length > 0 && (
          <ul className="space-y-2">
            {cards.map((card) => (
              <li
                key={card.cardId}
                className={`rounded-lg border ${
                  card.accepted
                    ? 'border-slate-200 bg-white'
                    : 'border-slate-100 bg-slate-50 opacity-70'
                } p-3`}
              >
                <div className="flex items-start gap-3">
                  <label className="mt-0.5 inline-flex">
                    <input
                      type="checkbox"
                      checked={card.accepted}
                      onChange={(e) =>
                        updateCard(card.cardId, { accepted: e.target.checked })
                      }
                      className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                      aria-label={`Include epic: ${card.title || 'untitled'}`}
                    />
                  </label>
                  <div className="flex-1">
                    {card.editing ? (
                      <div className="space-y-2">
                        <Input
                          value={card.title}
                          onChange={(e) =>
                            updateCard(card.cardId, { title: e.target.value })
                          }
                          placeholder="Epic title"
                          aria-label="Epic title"
                        />
                        <textarea
                          value={card.description}
                          onChange={(e) =>
                            updateCard(card.cardId, { description: e.target.value })
                          }
                          placeholder="What does this epic deliver?"
                          rows={2}
                          className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                          aria-label="Epic description"
                        />
                      </div>
                    ) : (
                      <>
                        <div className="text-sm font-semibold text-slate-900">
                          {card.title || 'Untitled epic'}
                        </div>
                        {card.description && (
                          <p className="mt-1 text-xs text-slate-600">
                            {card.description}
                          </p>
                        )}
                        {card.storyTitles.length > 0 && (
                          <p className="mt-2 text-[11px] uppercase tracking-wider text-slate-400">
                            {card.storyTitles.length} suggested{' '}
                            {card.storyTitles.length === 1 ? 'story' : 'stories'}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                  <div className="flex flex-shrink-0 gap-1">
                    <button
                      onClick={() =>
                        updateCard(card.cardId, { editing: !card.editing })
                      }
                      className="rounded px-2 py-1 text-[11px] text-slate-500 hover:bg-slate-100"
                      aria-label={card.editing ? 'Done editing' : 'Edit epic'}
                    >
                      {card.editing ? 'Done' : 'Edit'}
                    </button>
                    <button
                      onClick={() => removeCard(card.cardId)}
                      className="rounded px-2 py-1 text-[11px] text-rose-500 hover:bg-rose-50"
                      aria-label="Remove epic"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        {cards && cards.length === 0 && !suggestQuery.isLoading && (
          <p className="py-6 text-center text-sm text-slate-500">
            No epics yet. Click &ldquo;Add another epic&rdquo; below to start
            with one.
          </p>
        )}
        <div className="mt-3">
          <button
            onClick={handleAddCustom}
            className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:border-slate-400 hover:bg-slate-50"
            aria-label="Add another epic"
          >
            <span aria-hidden="true">+</span> Add another epic
          </button>
        </div>
      </div>

      {error && (
        <p
          className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700"
          role="alert"
        >
          {error}
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" onClick={onBack}>
          Back to vision
        </Button>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onSkip}>
            Skip
          </Button>
          <Button
            onClick={handleCreate}
            disabled={acceptedCount === 0 || creating}
            aria-label="Create epics and finish setup"
          >
            {creating
              ? 'Creating…'
              : acceptedCount === 0
                ? 'No epics selected'
                : `Create ${acceptedCount} ${acceptedCount === 1 ? 'epic' : 'epics'} and finish`}
          </Button>
        </div>
      </div>
    </div>
  )
}

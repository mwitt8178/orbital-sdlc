/**
 * VisionInterviewStep — Stage 5 of the immersive project setup flow.
 *
 * Inserted between Review and Initial Epics. The user enters this stage
 * immediately after the project is created. We auto-start a vision session
 * using the project's name as the vision title and the basics description
 * as the initial prompt.
 *
 * Layout: split view, chat on the left (60%), live-drafting vision document
 * on the right (40%). The right pane polls vision.get every 2 seconds so the
 * draft appears as soon as the PM stub writes it (after ~3 user messages).
 *
 * Continue is enabled once the draft has the relaxed v1 lock requirements
 * (title + summary + >=1 goal + >=1 target user). On Continue we lock the
 * vision (vision.reviewDraft → vision.lock) and pass control to the parent
 * with the locked vision_document_id + vision_version_id.
 *
 * "Skip & lock later" exits cleanly: project exists, vision NOT locked.
 */

import { useEffect, useRef, useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { buildAuditMetadata } from '../../../services/audit-metadata.js'
import { Button } from '../../ui/Button.js'
import { PMThinkingIndicator } from '../vision/PMThinkingIndicator.js'

interface Props {
  projectId: string
  projectName: string
  /** Optional description from the basics step — used as the initial prompt. */
  initialDescription: string
  /** Called when the user successfully locks a vision document. */
  onLocked: (locked: { documentId: string; versionId: string }) => void
  /** Called when the user clicks "Skip & lock later". */
  onSkip: () => void
  /** Called when the user clicks Back to revise the project basics. */
  onBack: () => void
}

interface ChatMessage {
  id: string
  role: 'user' | 'pm_persona'
  body: string
  postedAt: string
  /** True for messages that are local-only until the server confirms. */
  optimistic?: boolean
}

/**
 * Local fallback prompt when the user did not enter a description in basics.
 * The PM stub still works with any non-empty initial prompt.
 */
const FALLBACK_INITIAL_PROMPT = 'I am starting a new project and need help defining the vision.'

export function VisionInterviewStep({
  projectId,
  projectName,
  initialDescription,
  onLocked,
  onSkip,
  onBack,
}: Props) {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [documentId, setDocumentId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [composerDraft, setComposerDraft] = useState('')
  const [awaitingPMReply, setAwaitingPMReply] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [continuing, setContinuing] = useState(false)
  const startedRef = useRef(false)
  const optimisticIdRef = useRef<string | null>(null)

  const utils = trpc.useUtils()

  const startMutation = trpc.vision.start.useMutation({
    onSuccess: (data) => {
      setSessionId(data.vision_session_id)
      setDocumentId(data.vision_document_id)
      // The server auto-persists initial_prompt as the first user message;
      // the PM stub replies within ~1.2s. Render the user message immediately
      // so the chat feels active from the moment the session opens.
      const firstPrompt = (initialDescription.trim().length > 0
        ? initialDescription.trim()
        : FALLBACK_INITIAL_PROMPT)
      setMessages([
        {
          id: `optimistic-start-${Date.now()}`,
          role: 'user',
          body: firstPrompt,
          postedAt: new Date().toISOString(),
          optimistic: true,
        },
      ])
      setAwaitingPMReply(true)
    },
    onError: (err) => setError(err.message),
  })

  // Auto-start the session on first mount.
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    const initialPrompt = initialDescription.trim().length > 0
      ? initialDescription.trim()
      : FALLBACK_INITIAL_PROMPT
    startMutation.mutate({
      title: projectName,
      initial_prompt: initialPrompt,
      audit_metadata: buildAuditMetadata(
        'User started vision interview during immersive project setup',
        { linked_artifacts: [{ type: 'project', id: projectId }] },
      ),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Poll messages every 2 seconds while a session is active.
  const messagesQuery = trpc.vision.listMessages.useQuery(
    sessionId ? { vision_session_id: sessionId } : (undefined as never),
    {
      enabled: !!sessionId,
      refetchInterval: 2_000,
      staleTime: 500,
    },
  )

  // Sync polled messages into local state.
  useEffect(() => {
    if (!messagesQuery.data) return
    const items = messagesQuery.data.items
    setMessages((prev) => {
      const existingIds = new Set(prev.filter((m) => !m.optimistic).map((m) => m.id))
      const optimistic = prev.filter((m) => m.optimistic)
      const merged: ChatMessage[] = [
        ...prev.filter((m) => !m.optimistic),
      ]
      for (const item of items) {
        if (!existingIds.has(item.vision_message_id)) {
          merged.push({
            id: item.vision_message_id,
            role: item.author_type === 'user' ? 'user' : 'pm_persona',
            body: item.body,
            postedAt: item.posted_at,
          })
          existingIds.add(item.vision_message_id)
        }
      }
      // Filter optimistic messages whose body now appears in confirmed list.
      const confirmedBodies = new Set(items.map((i) => `${i.author_type}::${i.body}`))
      for (const opt of optimistic) {
        const key = `${opt.role}::${opt.body}`
        if (!confirmedBodies.has(key)) {
          merged.push(opt)
        }
      }
      return merged
    })
  }, [messagesQuery.data])

  // When a PM message arrives, hide the thinking indicator.
  useEffect(() => {
    if (!awaitingPMReply) return
    const last = messages[messages.length - 1]
    if (last?.role === 'pm_persona') {
      setAwaitingPMReply(false)
    }
  }, [messages, awaitingPMReply])

  // Live-poll the document so the right pane updates as the PM stub writes
  // the draft after the 3rd message.
  const docQuery = trpc.vision.get.useQuery(
    documentId ? { vision_document_id: documentId } : (undefined as never),
    {
      enabled: !!documentId,
      refetchInterval: 2_000,
      staleTime: 500,
    },
  )

  const sendMutation = trpc.vision.sendMessage.useMutation({
    onMutate: () => {
      const tempId = `optimistic-${Date.now()}`
      optimisticIdRef.current = tempId
      setMessages((prev) => [
        ...prev,
        {
          id: tempId,
          role: 'user',
          body: composerDraft.trim(),
          postedAt: new Date().toISOString(),
          optimistic: true,
        },
      ])
      setAwaitingPMReply(true)
    },
    onSuccess: () => {
      setComposerDraft('')
      setError(null)
    },
    onError: (err) => {
      // Roll back the optimistic message
      if (optimisticIdRef.current) {
        const rollbackId = optimisticIdRef.current
        setMessages((prev) => prev.filter((m) => m.id !== rollbackId))
        optimisticIdRef.current = null
      }
      setAwaitingPMReply(false)
      setError(err.message)
    },
  })

  const handleSend = () => {
    if (!sessionId || !composerDraft.trim()) return
    sendMutation.mutate({
      vision_session_id: sessionId,
      body: composerDraft.trim(),
      audit_metadata: buildAuditMetadata(
        'User sent a message in vision interview during project setup',
        { linked_artifacts: [{ type: 'vision_session', id: sessionId }] },
      ),
    })
  }

  // Extract draft fields for the right pane and the Continue gating.
  const docVersion = docQuery.data?.version
  const docContent = (docVersion?.content as Record<string, unknown> | undefined) ?? null
  const docTitle = (docContent?.['title'] as string | undefined) ?? null
  const docSummary = (docContent?.['summary'] as string | undefined) ?? null
  const docGoals = ((docContent?.['goals'] as Array<Record<string, unknown>>) ?? []).map((g) =>
    String(g['text'] ?? ''),
  )
  const docNonGoals = ((docContent?.['non_goals'] as Array<Record<string, unknown>>) ?? []).map((g) =>
    String(g['text'] ?? ''),
  )
  const docTargetUsers = ((docContent?.['target_users'] as Array<Record<string, unknown>>) ?? []).map(
    (u) => String(u['description'] ?? u['segment'] ?? ''),
  )
  const docOpenQuestions = (
    (docContent?.['open_questions'] as Array<Record<string, unknown>>) ?? []
  ).map((q) => String(q['text'] ?? ''))

  const hasMinimumDraft =
    !!docTitle &&
    !!docSummary &&
    docGoals.length >= 1 &&
    docTargetUsers.length >= 1

  const isLockedAlready = docVersion?.is_locked === true

  // Continue is enabled when the draft has minimum fields. Disabled while
  // the lock RPC is in flight.
  const continueEnabled = hasMinimumDraft && !continuing

  const lockMutation = trpc.vision.lock.useMutation({
    onSuccess: (locked) => {
      setContinuing(false)
      if (documentId) {
        void utils.vision.get.invalidate({ vision_document_id: documentId })
      }
      onLocked({ documentId: documentId!, versionId: locked.vision_version_id })
    },
    onError: (err) => {
      setContinuing(false)
      setError(err.message)
    },
  })

  const handleContinue = async () => {
    if (!documentId) return
    if (isLockedAlready && docVersion) {
      // Already locked (edge case where user backs into stage from later) —
      // pass through without re-locking.
      onLocked({ documentId, versionId: docVersion.vision_version_id })
      return
    }
    setContinuing(true)
    setError(null)
    try {
      const review = await utils.vision.reviewDraft.fetch({ vision_document_id: documentId })
      if (!review.ready_to_lock) {
        setContinuing(false)
        const missing = review.missing_required_fields.join(', ') || 'unknown fields'
        setError(`Vision is not yet ready to lock. Missing: ${missing}.`)
        return
      }
      lockMutation.mutate({
        vision_document_id: documentId,
        confirmation_token: review.confirmation_token,
        changelog: 'Initial vision lock from project setup',
        attestation: { no_edge_cases: false },
        audit_metadata: buildAuditMetadata(
          'User locked vision during immersive project setup',
          {
            linked_artifacts: [
              { type: 'project', id: projectId },
              { type: 'vision_document', id: documentId },
            ],
          },
        ),
      })
    } catch (err) {
      setContinuing(false)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="flex h-[640px] flex-col gap-3">
      <div className="grid flex-1 grid-cols-5 gap-4 overflow-hidden">
        {/* Left: chat (3/5) */}
        <div className="col-span-3 flex flex-col rounded-lg border border-slate-200 bg-white">
          <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-[10px] font-bold text-white">
              PM
            </div>
            <div>
              <div className="text-sm font-semibold text-slate-900">Product Manager</div>
              <div className="text-xs text-slate-500">Elicitation interview</div>
            </div>
          </div>

          <div
            className="scrollbar-thin flex-1 overflow-y-auto px-4 py-3"
            role="log"
            aria-label="Vision interview chat messages"
          >
            {messages.length === 0 && !awaitingPMReply ? (
              <p className="py-6 text-center text-sm text-slate-500">
                Starting the interview…
              </p>
            ) : (
              <ol className="space-y-3">
                {messages.map((msg) => (
                  <li
                    key={msg.id}
                    className={`flex gap-2 ${msg.role === 'user' ? 'justify-end' : ''}`}
                  >
                    {msg.role === 'pm_persona' && (
                      <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-[9px] font-bold text-white">
                        PM
                      </div>
                    )}
                    <div
                      className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                        msg.role === 'user'
                          ? 'bg-indigo-600 text-white'
                          : 'bg-slate-100 text-slate-900'
                      } ${msg.optimistic ? 'opacity-70' : ''}`}
                    >
                      {msg.body}
                    </div>
                  </li>
                ))}
                {awaitingPMReply && <PMThinkingIndicator />}
              </ol>
            )}
          </div>

          <div className="border-t border-slate-100 p-3">
            <form
              onSubmit={(e) => {
                e.preventDefault()
                handleSend()
              }}
            >
              <div className="flex items-end gap-2">
                <textarea
                  className="flex-1 resize-none rounded-md border border-slate-200 px-3 py-2 text-sm placeholder-slate-400 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-slate-50 disabled:opacity-60"
                  rows={2}
                  placeholder={sessionId ? 'Type a reply…' : 'Starting session…'}
                  value={composerDraft}
                  disabled={!sessionId || sendMutation.isPending}
                  onChange={(e) => setComposerDraft(e.target.value)}
                  aria-label="Vision interview message input"
                />
                <Button
                  type="submit"
                  disabled={!sessionId || !composerDraft.trim() || sendMutation.isPending}
                  aria-label="Send vision interview message"
                >
                  {sendMutation.isPending ? 'Sending…' : 'Send'}
                </Button>
              </div>
            </form>
          </div>
        </div>

        {/* Right: vision draft (2/5) */}
        <div className="col-span-2 flex flex-col rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-4 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Vision Draft
            </div>
            <div className="mt-0.5 text-xs text-slate-500">
              {docVersion
                ? `v${docVersion.version_number} · ${isLockedAlready ? 'locked' : 'draft'}`
                : 'Waiting for the PM persona…'}
            </div>
          </div>
          <div className="scrollbar-thin flex-1 space-y-4 overflow-y-auto px-4 py-3 text-sm">
            {!docVersion ? (
              <p className="text-slate-500">
                The vision draft will appear here as you answer questions. After
                a few exchanges the PM persona will populate the title, summary,
                goals, and target users.
              </p>
            ) : (
              <>
                {docTitle && (
                  <Section title="Title">
                    <p className="font-semibold text-slate-900">{docTitle}</p>
                  </Section>
                )}
                {docSummary && (
                  <Section title="Summary">
                    <p className="text-slate-700">{docSummary}</p>
                  </Section>
                )}
                {docGoals.length > 0 && (
                  <Section title="Goals">
                    <ul className="list-disc space-y-1 pl-4 text-slate-700">
                      {docGoals.map((g, i) => (
                        <li key={i}>{g}</li>
                      ))}
                    </ul>
                  </Section>
                )}
                {docTargetUsers.length > 0 && (
                  <Section title="Target users">
                    <ul className="list-disc space-y-1 pl-4 text-slate-700">
                      {docTargetUsers.map((u, i) => (
                        <li key={i}>{u}</li>
                      ))}
                    </ul>
                  </Section>
                )}
                {docNonGoals.length > 0 && (
                  <Section title="Non-goals">
                    <ul className="list-disc space-y-1 pl-4 text-slate-700">
                      {docNonGoals.map((g, i) => (
                        <li key={i}>{g}</li>
                      ))}
                    </ul>
                  </Section>
                )}
                {docOpenQuestions.length > 0 && (
                  <Section title="Open questions">
                    <ul className="list-disc space-y-1 pl-4 text-slate-700">
                      {docOpenQuestions.map((q, i) => (
                        <li key={i}>{q}</li>
                      ))}
                    </ul>
                  </Section>
                )}
              </>
            )}
          </div>
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
          Back to review
        </Button>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onSkip}>
            Skip and lock later
          </Button>
          <Button
            onClick={handleContinue}
            disabled={!continueEnabled}
            aria-label="Continue to initial epics"
          >
            {continuing ? 'Locking…' : 'Continue'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
        {title}
      </h3>
      <div className="mt-1">{children}</div>
    </section>
  )
}

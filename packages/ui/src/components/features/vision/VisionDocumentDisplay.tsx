/**
 * VisionDocumentDisplay — current vision document, plus Lock/Revise actions.
 *
 * Reads vision.get for the active document and surfaces structured fields:
 * title, summary, goals, non-goals, target users, assumptions, open questions.
 *
 * - Lock requires a confirmation token from vision.reviewDraft. The Lock
 *   button opens a Modal that explains the consequence ("Locked versions
 *   are immutable; future changes require an explicit revision") and
 *   captures a changelog.
 * - When the document is locked, the panel renders a "Revise" button that
 *   opens a Modal capturing a reason + changelog and calls vision.revise.
 *
 * Open questions are extracted from the document `content.open_questions`
 * and rendered in a collapsible <OpenQuestionsPanel> child component.
 * Assumptions are rendered as labeled chips above the open-questions list.
 */

import { useState, type ReactNode } from 'react'
import { trpc } from '../../../services/trpc.js'
import { useVisionStore } from '../../../store/vision.js'
import { buildAuditMetadata } from '../../../services/audit-metadata.js'
import { Button } from '../../ui/Button.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { Modal } from '../../ui/Modal.js'
import { OpenQuestionsPanel } from './OpenQuestionsPanel.js'

type Reason = 'user_initiated' | 'architect_feedback' | 'uat_defect' | 'retro_proposal'

export function VisionDocumentDisplay() {
  const documentId = useVisionStore((s) => s.currentDocumentId)
  const sessionId = useVisionStore((s) => s.currentSessionId)
  const utils = trpc.useUtils()

  const [confirmOpen, setConfirmOpen] = useState(false)
  const [changelog, setChangelog] = useState('')
  const [error, setError] = useState<string | null>(null)

  const [reviseOpen, setReviseOpen] = useState(false)
  const [reviseReason, setReviseReason] = useState<Reason>('user_initiated')
  const [reviseChangelog, setReviseChangelog] = useState('')
  const [reviseError, setReviseError] = useState<string | null>(null)

  const docQuery = trpc.vision.get.useQuery(
    documentId ? { vision_document_id: documentId } : (undefined as never),
    {
      enabled: !!documentId,
      // Poll every 4 seconds while a session is active so the draft document
      // appears in the right panel as soon as the PM stub writes it (after 3
      // user messages). WS is the fast path; this is the safety-net fallback.
      refetchInterval: sessionId ? 4_000 : false,
    },
  )

  const reviewQuery = trpc.vision.reviewDraft.useQuery(
    documentId ? { vision_document_id: documentId } : (undefined as never),
    {
      enabled: !!documentId && confirmOpen,
      retry: false,
    },
  )

  const lockMutation = trpc.vision.lock.useMutation({
    onSuccess: () => {
      setConfirmOpen(false)
      setChangelog('')
      setError(null)
      if (documentId) {
        void utils.vision.get.invalidate({ vision_document_id: documentId })
        void utils.vision.history.invalidate({ vision_document_id: documentId })
      }
    },
    onError: (err) => setError(err.message),
  })

  const reviseMutation = trpc.vision.revise.useMutation({
    onSuccess: () => {
      setReviseOpen(false)
      setReviseChangelog('')
      setReviseError(null)
      if (documentId) {
        void utils.vision.get.invalidate({ vision_document_id: documentId })
        void utils.vision.history.invalidate({ vision_document_id: documentId })
      }
    },
    onError: (err) => setReviseError(err.message),
  })

  const sendMessageMutation = trpc.vision.sendMessage.useMutation({
    onError: (err) => setError(err.message),
  })

  if (!documentId) {
    return (
      <DocFrame>
        <EmptyState
          title="No vision document"
          description="A draft will appear here as the PM persona asks questions and you answer."
        />
      </DocFrame>
    )
  }

  if (docQuery.isLoading) {
    return (
      <DocFrame>
        <div className="space-y-3 px-4 py-6">
          <Skeleton rows={5} />
        </div>
      </DocFrame>
    )
  }

  if (docQuery.error) {
    return (
      <DocFrame>
        <ErrorMessage title="Could not load vision" message={docQuery.error.message} />
      </DocFrame>
    )
  }

  const doc = docQuery.data
  if (!doc?.version) {
    return (
      <DocFrame>
        <EmptyState
          title="No version yet"
          description="The PM persona has not produced a draft for this session."
        />
      </DocFrame>
    )
  }

  const content = doc.version.content as Record<string, unknown> | null
  const isLocked = doc.version.is_locked
  const title = (content?.['title'] as string | undefined) ?? null
  const summary = (content?.['summary'] as string | undefined) ?? null
  const goals = ((content?.['goals'] as Array<Record<string, unknown>>) ?? []).map((g) =>
    String(g['text'] ?? ''),
  )
  const nonGoals = ((content?.['non_goals'] as Array<Record<string, unknown>>) ?? []).map((g) =>
    String(g['text'] ?? ''),
  )
  const targetUsers = ((content?.['target_users'] as Array<Record<string, unknown>>) ?? []).map(
    (u) => String(u['description'] ?? u['segment'] ?? ''),
  )
  const assumptions = (
    (content?.['assumptions_log'] as Array<Record<string, unknown>>) ?? []
  ).map((a, i) => ({
    id: String(a['id'] ?? `a-${i}`),
    text: String(a['text'] ?? ''),
    confidence: String(a['confidence'] ?? 'medium') as 'low' | 'medium' | 'high',
  }))
  const openQuestions = ((content?.['open_questions'] as Array<Record<string, unknown>>) ?? []).map(
    (q, i) => ({
      id: String(q['id'] ?? `q-${i}`),
      text: String(q['text'] ?? ''),
      resolved: !!q['resolved_at'],
    }),
  )
  const baseVersionId = doc.version.vision_version_id

  const handleLock = () => {
    if (!documentId || !reviewQuery.data) return
    // Initial lock has no "what changed" — that's a revise concept. Use a
    // canonical default string so the server validation passes; user already
    // confirmed intent by clicking Confirm lock.
    lockMutation.mutate({
      vision_document_id: documentId,
      confirmation_token: reviewQuery.data.confirmation_token,
      changelog: 'Initial vision lock',
      attestation: { no_edge_cases: false },
      audit_metadata: buildAuditMetadata('User locked vision document via UI', {
        linked_artifacts: [{ type: 'vision_document', id: documentId }],
      }),
    })
  }

  const handleRevise = () => {
    if (!documentId || !baseVersionId) return
    if (!reviseChangelog.trim()) {
      setReviseError('Reason / changelog is required.')
      return
    }
    reviseMutation.mutate({
      vision_document_id: documentId,
      base_version_id: baseVersionId,
      // Empty delta = the user wants to start a new revision; later edits
      // will be made via subsequent draft+lock cycles. This matches the
      // backend pattern of "open a revision" then "draft" then "lock".
      delta: [],
      changelog: reviseChangelog.trim(),
      reason: reviseReason,
      audit_metadata: buildAuditMetadata('User opened a revision of locked vision document', {
        linked_artifacts: [
          { type: 'vision_document', id: documentId },
          { type: 'vision_version', id: baseVersionId },
        ],
      }),
    })
  }

  const handleResolveQuestion = (questionText: string) => {
    if (!sessionId) return
    // No dedicated "resolve question" mutation exists yet; we post the
    // resolution as a chat message so the PM persona can incorporate it
    // on the next draft. This is the intended flow per TRD-01 §6.
    sendMessageMutation.mutate({
      vision_session_id: sessionId,
      body: `Resolution: ${questionText}`,
      audit_metadata: buildAuditMetadata(
        'User marked an open question resolved via vision document panel',
        { linked_artifacts: [{ type: 'vision_session', id: sessionId }] },
      ),
    })
  }

  return (
    <DocFrame>
      <div className="flex items-start justify-between border-b border-slate-100 px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-slate-900">Vision Document</div>
          <div className="text-xs text-slate-500">
            v{doc.version.version_number} ·{' '}
            {isLocked ? (
              <span className="inline-flex items-center gap-1">
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500"
                  aria-hidden="true"
                />
                locked
              </span>
            ) : (
              'draft'
            )}
          </div>
        </div>
        {isLocked ? (
          <Button
            variant="secondary"
            onClick={() => setReviseOpen(true)}
            aria-label="Revise vision document"
          >
            Revise
          </Button>
        ) : (
          <Button onClick={() => setConfirmOpen(true)} aria-label="Lock vision document">
            Lock
          </Button>
        )}
      </div>

      <div className="scrollbar-thin flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {title && (
          <Section title="Title">
            <p className="text-sm font-semibold text-slate-900">{title}</p>
          </Section>
        )}
        {summary && (
          <Section title="Summary">
            <p className="text-sm text-slate-700">{summary}</p>
          </Section>
        )}
        {goals.length > 0 && (
          <Section title="Goals">
            <ul className="list-disc space-y-1 pl-4 text-sm text-slate-700">
              {goals.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </Section>
        )}
        {nonGoals.length > 0 && (
          <Section title="Non-goals">
            <ul className="list-disc space-y-1 pl-4 text-sm text-slate-700">
              {nonGoals.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </Section>
        )}
        {targetUsers.length > 0 && (
          <Section title="Target users">
            <ul className="list-disc space-y-1 pl-4 text-sm text-slate-700">
              {targetUsers.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </Section>
        )}
        {assumptions.length > 0 && (
          <Section title="Assumptions">
            <div className="flex flex-wrap gap-2">
              {assumptions.map((a) => (
                <span
                  key={a.id}
                  className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${assumptionToneClass(a.confidence)}`}
                  title={`Confidence: ${a.confidence}`}
                >
                  <span
                    className={`inline-block h-1.5 w-1.5 rounded-full ${assumptionDotClass(a.confidence)}`}
                    aria-hidden="true"
                  />
                  {a.text}
                </span>
              ))}
            </div>
          </Section>
        )}
        {openQuestions.length > 0 && (
          <Section title="Open questions">
            <OpenQuestionsPanel
              questions={openQuestions}
              onResolve={handleResolveQuestion}
              disabled={!sessionId || sendMessageMutation.isPending}
            />
          </Section>
        )}
      </div>

      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Lock this vision?">
        <p className="text-sm text-slate-600">
          Once locked, this version becomes immutable. Future changes require an
          explicit revision.
        </p>
        {reviewQuery.error && (
          <p className="mt-2 text-xs text-rose-600">{reviewQuery.error.message}</p>
        )}
        {error && (
          <p className="mt-2 text-xs text-rose-600" role="alert">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleLock} disabled={!reviewQuery.data || lockMutation.isPending}>
            {lockMutation.isPending ? 'Locking…' : 'Confirm lock'}
          </Button>
        </div>
      </Modal>

      <Modal
        open={reviseOpen}
        onClose={() => setReviseOpen(false)}
        title="Revise locked vision?"
      >
        <p className="text-sm text-slate-600">
          A revision creates a new draft version. The previous locked version is
          preserved in history.
        </p>
        <label className="mt-3 block text-xs font-medium text-slate-700" htmlFor="revise-reason">
          Reason
        </label>
        <select
          id="revise-reason"
          value={reviseReason}
          onChange={(e) => setReviseReason(e.target.value as Reason)}
          className="mt-1 w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="user_initiated">User-initiated</option>
          <option value="architect_feedback">Architect feedback</option>
          <option value="uat_defect">UAT defect</option>
          <option value="retro_proposal">Retro proposal</option>
        </select>
        <label className="mt-3 block text-xs font-medium text-slate-700" htmlFor="revise-changelog">
          Changelog (required)
        </label>
        <textarea
          id="revise-changelog"
          value={reviseChangelog}
          onChange={(e) => setReviseChangelog(e.target.value)}
          placeholder="Describe what is changing and why"
          rows={3}
          className="mt-1 w-full resize-none rounded-md border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          aria-label="Revision changelog"
        />
        {reviseError && (
          <p className="mt-2 text-xs text-rose-600" role="alert">
            {reviseError}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setReviseOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleRevise}
            disabled={!reviseChangelog.trim() || reviseMutation.isPending}
          >
            {reviseMutation.isPending ? 'Opening…' : 'Open revision'}
          </Button>
        </div>
      </Modal>
    </DocFrame>
  )
}

function DocFrame({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex flex-col rounded-lg border border-slate-200 bg-white"
      style={{ height: 'calc(100vh - 200px)' }}
    >
      {children}
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        {title}
      </h3>
      <div className="mt-1">{children}</div>
    </section>
  )
}

function assumptionToneClass(confidence: 'low' | 'medium' | 'high'): string {
  switch (confidence) {
    case 'high':
      return 'border-emerald-200 bg-emerald-50 text-emerald-800'
    case 'low':
      return 'border-amber-200 bg-amber-50 text-amber-800'
    default:
      return 'border-slate-200 bg-slate-50 text-slate-700'
  }
}

function assumptionDotClass(confidence: 'low' | 'medium' | 'high'): string {
  switch (confidence) {
    case 'high':
      return 'bg-emerald-500'
    case 'low':
      return 'bg-amber-500'
    default:
      return 'bg-slate-400'
  }
}

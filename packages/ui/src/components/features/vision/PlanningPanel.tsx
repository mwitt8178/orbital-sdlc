/**
 * PlanningPanel — Vision UI extension for LLM-driven backlog decomposition.
 *
 * Surfaces the `planning.generatePlan` / `planning.approvePlan` /
 * `planning.discardPlan` / `planning.history` tRPC procedures.
 *
 * User flow:
 *   1. Lock vision.
 *   2. Click "Generate plan" — calls planning.generatePlan (real Claude call).
 *   3. Review the generated epics + stories inline (editable).
 *   4. Click "Approve" — calls planning.approvePlan → persists backlog, routes to /backlog.
 *      OR "Discard" — calls planning.discardPlan → marks run discarded, no backlog rows written.
 *
 * If ANTHROPIC_API_KEY is missing, the error message surfaces a clear action:
 * "set ANTHROPIC_API_KEY at /admin/integrations".
 *
 * [Engineer-Principal · Opus · run-vision-llm-ui]
 * [Engineer-Sr · Sonnet · run-vision-decompose]
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { trpc } from '../../../services/trpc.js'
import { Button } from '../../ui/Button.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { DURATION, EASE, fadeInUp } from '../../onboarding/motion.js'

// Local mirror of the server's ProposedDecomposition shape. Keeping a local
// copy avoids importing zod schemas through the type-only orchestrator export.
type ProposedStory = {
  title: string
  description: string
  story_points: 1 | 2 | 3 | 5
  acceptance_criteria: string[]
}
type ProposedEpic = {
  title: string
  rationale: string
  stories: ProposedStory[]
}
type ProposedDecomposition = { epics: ProposedEpic[] }

interface PlanningPanelProps {
  visionId: string
  isLocked: boolean
  projectId?: string
}

const PROGRESS_PHASES = [
  { at: 0, label: 'Analyzing vision…' },
  { at: 6_000, label: 'Drafting epics…' },
  { at: 18_000, label: 'Breaking down stories…' },
  { at: 36_000, label: 'Writing acceptance criteria…' },
  { at: 60_000, label: 'Almost there — Claude is finishing up…' },
] as const

export function PlanningPanel({ visionId, isLocked, projectId }: PlanningPanelProps) {
  const navigate = useNavigate()
  const utils = trpc.useUtils()

  const [proposal, setProposal] = useState<ProposedDecomposition | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const [usage, setUsage] = useState<{ inputTokens: number; outputTokens: number } | null>(null)
  const [usdCents, setUsdCents] = useState<number | null>(null)
  const [feedback, setFeedback] = useState<Record<number, string>>({})
  const [feedbackOpen, setFeedbackOpen] = useState<Record<number, boolean>>({})
  const [error, setError] = useState<string | null>(null)
  const [phaseLabel, setPhaseLabel] = useState<string>(PROGRESS_PHASES[0].label)
  const [historyOpen, setHistoryOpen] = useState(false)
  const phaseTimers = useRef<number[]>([])

  const historyQuery = trpc.planning.history.useQuery(
    { visionId },
    { enabled: !!visionId && isLocked, staleTime: 30_000 },
  )

  // Primary flow — generatePlan writes to vision_decomposition_runs.
  const generatePlan = trpc.planning.generatePlan.useMutation({
    onMutate: () => {
      setError(null)
      setPhaseLabel(PROGRESS_PHASES[0].label)
      phaseTimers.current.forEach((t) => window.clearTimeout(t))
      phaseTimers.current = PROGRESS_PHASES.slice(1).map((phase) =>
        window.setTimeout(() => setPhaseLabel(phase.label), phase.at),
      )
    },
    onSuccess: (data) => {
      phaseTimers.current.forEach((t) => window.clearTimeout(t))
      phaseTimers.current = []
      setProposal(data.proposal as ProposedDecomposition)
      setRunId(data.runId)
      setUsage(data.usage)
      setUsdCents(data.usdCents)
      void utils.planning.history.invalidate({ visionId })
    },
    onError: (err) => {
      phaseTimers.current.forEach((t) => window.clearTimeout(t))
      phaseTimers.current = []
      setError(err.message)
    },
  })

  // Approve — persists backlog rows and navigates to /backlog.
  const approvePlan = trpc.planning.approvePlan.useMutation({
    onSuccess: () => {
      void utils.planning.history.invalidate({ visionId })
      navigate('/backlog')
    },
    onError: (err) => setError(err.message),
  })

  // Discard — stamps run as discarded; proposal state reset locally.
  const discardPlan = trpc.planning.discardPlan.useMutation({
    onSuccess: () => {
      setProposal(null)
      setRunId(null)
      setUsage(null)
      setUsdCents(null)
      setError(null)
      void utils.planning.history.invalidate({ visionId })
    },
    onError: (err) => setError(err.message),
  })

  useEffect(() => {
    return () => {
      phaseTimers.current.forEach((t) => window.clearTimeout(t))
    }
  }, [])

  const totalStoryPoints = useMemo(() => {
    if (!proposal) return 0
    return proposal.epics.reduce(
      (sum, ep) => sum + ep.stories.reduce((s, st) => s + st.story_points, 0),
      0,
    )
  }, [proposal])

  // First-sprint proposal: greedily pack stories until ~13 points capacity.
  const FIRST_SPRINT_CAPACITY = 13
  const firstSprint = useMemo(() => {
    if (!proposal) return { stories: [] as { title: string; points: number }[], used: 0 }
    let used = 0
    const picked: { title: string; points: number }[] = []
    for (const epic of proposal.epics) {
      for (const st of epic.stories) {
        if (used + st.story_points <= FIRST_SPRINT_CAPACITY) {
          picked.push({ title: st.title, points: st.story_points })
          used += st.story_points
        }
      }
    }
    return { stories: picked, used }
  }, [proposal])

  const updateStory = (epicIdx: number, storyIdx: number, patch: Partial<ProposedStory>) => {
    setProposal((prev) => {
      if (!prev) return prev
      const next = structuredClone(prev) as ProposedDecomposition
      next.epics[epicIdx]!.stories[storyIdx] = {
        ...next.epics[epicIdx]!.stories[storyIdx]!,
        ...patch,
      }
      return next
    })
  }

  const updateAc = (epicIdx: number, storyIdx: number, acIdx: number, value: string) => {
    setProposal((prev) => {
      if (!prev) return prev
      const next = structuredClone(prev) as ProposedDecomposition
      const acs = [...next.epics[epicIdx]!.stories[storyIdx]!.acceptance_criteria]
      acs[acIdx] = value
      next.epics[epicIdx]!.stories[storyIdx]!.acceptance_criteria = acs
      return next
    })
  }

  const removeStory = (epicIdx: number, storyIdx: number) => {
    setProposal((prev) => {
      if (!prev) return prev
      const next = structuredClone(prev) as ProposedDecomposition
      const epic = next.epics[epicIdx]!
      // Server schema requires min 2 stories per epic — guard.
      if (epic.stories.length <= 2) {
        setError('An epic must keep at least 2 stories. Edit instead of removing.')
        return prev
      }
      epic.stories.splice(storyIdx, 1)
      return next
    })
  }

  const handleGenerate = (epicFeedback?: string) => {
    generatePlan.mutate({
      visionId,
      projectId,
      ...(epicFeedback ? { feedback: epicFeedback } : {}),
    })
  }

  const handleApprove = () => {
    if (!proposal || !runId) return
    approvePlan.mutate({ visionId, runId, proposal, projectId })
  }

  const handleDiscard = () => {
    if (!runId) return
    discardPlan.mutate({ visionId, runId })
  }

  const isPending = generatePlan.isPending
  const isApproving = approvePlan.isPending
  const isDiscarding = discardPlan.isPending

  // Empty state — vision not yet locked.
  if (!isLocked) {
    return (
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex items-center gap-3">
          <SparkleIcon />
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Generate plan from vision
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Lock your vision first to generate a plan.
            </p>
          </div>
        </div>
        <div className="mt-4">
          <Button disabled aria-disabled="true">
            Generate plan from vision
          </Button>
        </div>
      </section>
    )
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-6 py-4">
        <div className="flex items-start gap-3">
          <SparkleIcon />
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Generate plan from vision
            </h2>
            <p className="mt-0.5 text-sm text-slate-600">
              Claude will draft epics, stories, and acceptance criteria from your locked vision.
              Review and edit anything before approving — discarding removes the run without
              writing any backlog rows.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!proposal && !isPending && (
            <Button onClick={() => handleGenerate()} aria-label="Generate plan from vision">
              Generate plan from vision
            </Button>
          )}
          {proposal && !isPending && (
            <>
              <Button variant="secondary" onClick={() => handleGenerate()}>
                Regenerate all
              </Button>
              <Button
                variant="secondary"
                onClick={handleDiscard}
                disabled={isDiscarding || isApproving}
                aria-label="Discard this plan"
              >
                {isDiscarding ? 'Discarding…' : 'Discard'}
              </Button>
              <Button
                onClick={handleApprove}
                disabled={isApproving || isDiscarding}
                aria-label="Approve and save plan to backlog"
              >
                {isApproving ? 'Approving…' : 'Approve'}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="px-6 py-5">
        {error && (
          <div className="mb-4">
            <ErrorMessage
              title={
                error.includes('cap')
                  ? 'Cost cap reached'
                  : error.toLowerCase().includes('anthropic')
                    ? 'Anthropic API key missing'
                    : 'Could not generate plan'
              }
              message={
                error.toLowerCase().includes('anthropic')
                  ? `${error} — set ANTHROPIC_API_KEY at /admin/integrations.`
                  : error
              }
            />
          </div>
        )}

        {isPending && (
          <ProgressView label={phaseLabel} />
        )}

        {!isPending && !proposal && (
          <p className="text-sm text-slate-500">
            No proposal yet. Click <strong>Generate plan from vision</strong> to invoke Claude.
            Typical run is 30–60 seconds and costs less than $0.20. Review the generated plan
            before approving — you can edit any epic, story, or AC inline.
          </p>
        )}

        {proposal && !isPending && (
          <>
            <CostStrip usage={usage} usdCents={usdCents} totalPoints={totalStoryPoints} />

            {/* Approve/Discard inline banner */}
            <div className="mt-3 flex items-center gap-3 rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2.5">
              <span className="text-sm text-amber-800">
                Review and edit below, then <strong>Approve</strong> to persist to backlog, or{' '}
                <strong>Discard</strong> to abandon this plan.
              </span>
            </div>

            <motion.ol
              initial="hidden"
              animate="visible"
              variants={{ visible: { transition: { staggerChildren: 0.04 } } }}
              className="mt-5 space-y-4"
            >
              {proposal.epics.map((epic, ei) => (
                <motion.li
                  key={`${ei}-${epic.title}`}
                  variants={fadeInUp}
                  transition={{ duration: DURATION.base, ease: EASE.out }}
                  className="rounded-lg border border-slate-200 bg-slate-50/50 p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                        Epic {ei + 1}
                      </div>
                      <h3 className="mt-0.5 text-sm font-semibold text-slate-900">
                        {epic.title}
                      </h3>
                      <p className="mt-1 text-sm text-slate-600">{epic.rationale}</p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setFeedbackOpen((s) => ({ ...s, [ei]: !s[ei] }))
                      }
                      aria-expanded={!!feedbackOpen[ei]}
                      aria-label={`Regenerate epic ${ei + 1}`}
                    >
                      Regenerate
                    </Button>
                  </div>

                  <AnimatePresence initial={false}>
                    {feedbackOpen[ei] && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: DURATION.fast, ease: EASE.out }}
                        className="mt-3 overflow-hidden rounded-md border border-slate-200 bg-white p-3"
                      >
                        <label
                          htmlFor={`feedback-${ei}`}
                          className="block text-xs font-medium text-slate-700"
                        >
                          Feedback for Claude
                        </label>
                        <textarea
                          id={`feedback-${ei}`}
                          value={feedback[ei] ?? ''}
                          onChange={(e) =>
                            setFeedback((s) => ({ ...s, [ei]: e.target.value }))
                          }
                          rows={3}
                          placeholder='e.g. "Split this epic into smaller scopes — the first story is doing too much."'
                          className="mt-1 w-full resize-none rounded-md border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                        />
                        <div className="mt-2 flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setFeedbackOpen((s) => ({ ...s, [ei]: false }))}
                          >
                            Cancel
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => {
                              const fb = feedback[ei]?.trim()
                              if (!fb) return
                              setFeedbackOpen((s) => ({ ...s, [ei]: false }))
                              handleGenerate(`Focus on epic "${epic.title}": ${fb}`)
                            }}
                            disabled={!feedback[ei]?.trim()}
                          >
                            Regenerate with feedback
                          </Button>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <ul className="mt-4 space-y-3">
                    {epic.stories.map((story, si) => (
                      <li
                        key={`${ei}-${si}`}
                        className="rounded-md border border-slate-200 bg-white p-3"
                      >
                        <div className="flex flex-wrap items-start gap-3">
                          <input
                            type="text"
                            value={story.title}
                            onChange={(e) =>
                              updateStory(ei, si, { title: e.target.value })
                            }
                            aria-label={`Story ${si + 1} title`}
                            className="min-w-0 flex-1 rounded border border-transparent px-2 py-1 text-sm font-medium text-slate-900 hover:border-slate-200 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500"
                          />
                          <select
                            value={story.story_points}
                            onChange={(e) =>
                              updateStory(ei, si, {
                                story_points: Number(e.target.value) as 1 | 2 | 3 | 5,
                              })
                            }
                            aria-label={`Story ${si + 1} points`}
                            className="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
                          >
                            {[1, 2, 3, 5].map((p) => (
                              <option key={p} value={p}>
                                {p} pt
                              </option>
                            ))}
                          </select>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => removeStory(ei, si)}
                            aria-label={`Remove story ${si + 1}`}
                          >
                            Remove
                          </Button>
                        </div>
                        <textarea
                          value={story.description}
                          onChange={(e) =>
                            updateStory(ei, si, { description: e.target.value })
                          }
                          rows={2}
                          aria-label={`Story ${si + 1} description`}
                          className="mt-2 w-full resize-none rounded border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
                        />
                        <div className="mt-2">
                          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                            Acceptance criteria
                          </div>
                          <ul className="mt-1 space-y-1">
                            {story.acceptance_criteria.map((ac, ai) => (
                              <li key={ai} className="flex items-start gap-2">
                                <span
                                  aria-hidden="true"
                                  className="mt-2 inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-slate-300"
                                />
                                <input
                                  type="text"
                                  value={ac}
                                  onChange={(e) => updateAc(ei, si, ai, e.target.value)}
                                  aria-label={`Acceptance criterion ${ai + 1}`}
                                  className="min-w-0 flex-1 rounded border border-transparent px-2 py-1 text-sm text-slate-700 hover:border-slate-200 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500"
                                />
                              </li>
                            ))}
                          </ul>
                        </div>
                      </li>
                    ))}
                  </ul>
                </motion.li>
              ))}
            </motion.ol>

            {/* First-sprint proposal */}
            <div className="mt-5 rounded-lg border border-brand-200 bg-brand-50/40 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-brand-700">
                    First sprint proposal
                  </div>
                  <p className="mt-0.5 text-sm text-slate-700">
                    {firstSprint.stories.length} stories ·{' '}
                    <span className="font-semibold">{firstSprint.used}</span> /{' '}
                    {FIRST_SPRINT_CAPACITY} pts capacity
                  </p>
                </div>
              </div>
              <ul className="mt-3 space-y-1 text-sm text-slate-700">
                {firstSprint.stories.map((s, i) => (
                  <li key={i} className="flex items-baseline gap-2">
                    <span className="text-slate-400">·</span>
                    <span className="flex-1">{s.title}</span>
                    <span className="text-xs text-slate-500">{s.points} pt</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Approve / Discard bottom action bar */}
            <div className="mt-5 flex justify-end gap-3 border-t border-slate-100 pt-4">
              <Button
                variant="secondary"
                onClick={handleDiscard}
                disabled={isDiscarding || isApproving}
              >
                {isDiscarding ? 'Discarding…' : 'Discard'}
              </Button>
              <Button
                onClick={handleApprove}
                disabled={isApproving || isDiscarding}
              >
                {isApproving ? 'Approving…' : 'Approve plan'}
              </Button>
            </div>
          </>
        )}

        {/* History */}
        <div className="mt-6 border-t border-slate-100 pt-4">
          <button
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            aria-expanded={historyOpen}
            className="flex w-full items-center justify-between text-left text-xs font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <span>Run history{historyQuery.data ? ` (${historyQuery.data.items.length})` : ''}</span>
            <span aria-hidden="true">{historyOpen ? '−' : '+'}</span>
          </button>
          {historyOpen && (
            <div className="mt-3">
              {historyQuery.isLoading && <Skeleton rows={2} />}
              {historyQuery.error && (
                <p className="text-sm text-rose-600">{historyQuery.error.message}</p>
              )}
              {historyQuery.data && historyQuery.data.items.length === 0 && (
                <p className="text-sm text-slate-500">No prior runs for this vision.</p>
              )}
              {historyQuery.data && historyQuery.data.items.length > 0 && (
                <table className="w-full text-left text-xs">
                  <thead className="text-slate-500">
                    <tr>
                      <th className="py-1 pr-3 font-medium">Started</th>
                      <th className="py-1 pr-3 font-medium">Status</th>
                      <th className="py-1 pr-3 font-medium">Cost</th>
                      <th className="py-1 pr-3 font-medium">Committed</th>
                    </tr>
                  </thead>
                  <tbody className="text-slate-700">
                    {historyQuery.data.items.map((row) => (
                      <tr key={row.runId} className="border-t border-slate-100">
                        <td className="py-1.5 pr-3">
                          {row.startedAt ? new Date(row.startedAt).toLocaleString() : '—'}
                        </td>
                        <td className="py-1.5 pr-3">{row.exitStatus ?? '—'}</td>
                        <td className="py-1.5 pr-3">
                          {row.usdCents != null ? `$${(row.usdCents / 100).toFixed(3)}` : '—'}
                        </td>
                        <td className="py-1.5 pr-3">
                          {row.committedAt ? (
                            <span className="inline-flex items-center gap-1 text-emerald-700">
                              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
                              yes
                            </span>
                          ) : (
                            <span className="text-slate-400">no</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

function CostStrip({
  usage,
  usdCents,
  totalPoints,
}: {
  usage: { inputTokens: number; outputTokens: number } | null
  usdCents: number | null
  totalPoints: number
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
      <Stat label="Input tokens" value={usage ? usage.inputTokens.toLocaleString() : '—'} />
      <Stat label="Output tokens" value={usage ? usage.outputTokens.toLocaleString() : '—'} />
      <Stat
        label="Cost"
        value={usdCents != null ? `$${(usdCents / 100).toFixed(3)}` : '—'}
        tone="brand"
      />
      <Stat label="Total points" value={String(totalPoints)} />
    </div>
  )
}

function Stat({
  label,
  value,
  tone = 'default',
}: {
  label: string
  value: string
  tone?: 'default' | 'brand'
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-slate-500">{label}</span>
      <span
        className={
          tone === 'brand' ? 'font-semibold text-brand-700' : 'font-semibold text-slate-900'
        }
      >
        {value}
      </span>
    </div>
  )
}

function ProgressView({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-3 rounded-md border border-brand-200 bg-brand-50/50 px-4 py-3"
    >
      <motion.span
        aria-hidden="true"
        className="inline-block h-2 w-2 rounded-full bg-brand-600"
        animate={{ scale: [1, 1.6, 1], opacity: [0.6, 1, 0.6] }}
        transition={{ duration: 1.2, repeat: Infinity, ease: EASE.inOut }}
      />
      <AnimatePresence mode="wait">
        <motion.span
          key={label}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: DURATION.fast, ease: EASE.out }}
          className="text-sm text-brand-800"
        >
          {label}
        </motion.span>
      </AnimatePresence>
    </div>
  )
}

function SparkleIcon() {
  return (
    <span
      className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-brand-100 text-brand-700"
      aria-hidden="true"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3z" />
        <path d="M19 14l.7 1.7L21.5 16.5l-1.8.8L19 19l-.7-1.7-1.8-.8 1.8-.8L19 14z" />
      </svg>
    </span>
  )
}

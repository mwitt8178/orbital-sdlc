import { useState, useMemo, useEffect } from 'react'
import { Button } from '../../ui/Button.js'
import { Input } from '../../ui/Input.js'
import { trpc } from '../../../services/trpc.js'
import { useActiveProjectStore } from '../../../store/active-project.js'

/**
 * OnboardingProjectStep — drop-in step for the first-run onboarding wizard.
 *
 * Per Round 4 Projects Feature spec.
 *
 * Designed so the in-app onboarding agent (which owns Welcome.tsx and
 * components/features/onboarding/*) can import this component and slot it
 * between "Mode" and "Connect (Anthropic)". The component renders a single
 * card with:
 *   - Project name + slug
 *   - Optional Monday board id + Test
 *   - Optional Github owner + repo + Test
 *   - Continue button: creates the project, persists active-project, calls
 *     onComplete()
 *
 * It is fully self-contained — the wizard host only needs to render it and
 * pass `onComplete`.
 */

export interface OnboardingProjectStepProps {
  /** Called after the project is created and the active-project store is
   *  populated. The wizard host should advance to the next step. */
  onComplete: (project: { projectId: string; name: string; slug: string }) => void
  /** Optional skip handler. If undefined, no skip button is shown. */
  onSkip?: () => void
  /** Optional starter values (e.g. install name) so the user has less to type. */
  defaults?: { name?: string; slug?: string; description?: string }
}

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

export function OnboardingProjectStep({
  onComplete,
  onSkip,
  defaults,
}: OnboardingProjectStepProps) {
  const [name, setName] = useState(defaults?.name ?? '')
  const [slug, setSlug] = useState(defaults?.slug ?? '')
  const [description, setDescription] = useState(defaults?.description ?? '')
  const [slugTouched, setSlugTouched] = useState(
    (defaults?.slug ?? '').length > 0,
  )
  const [boardId, setBoardId] = useState('')
  const [boardTest, setBoardTest] = useState<{
    status: 'idle' | 'testing' | 'ok' | 'fail'
    msg?: string
  }>({ status: 'idle' })
  const [ghOwner, setGhOwner] = useState('')
  const [ghRepo, setGhRepo] = useState('')
  const [ghBranch, setGhBranch] = useState('main')
  const [ghTest, setGhTest] = useState<{
    status: 'idle' | 'testing' | 'ok' | 'fail'
    msg?: string
  }>({ status: 'idle' })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const setActiveProject = useActiveProjectStore((s) => s.setActiveProject)
  const utils = trpc.useUtils()
  const createMutation = trpc.projects.create.useMutation()
  const connectMonday = trpc.projects.connectMonday.useMutation()
  const connectGithub = trpc.projects.connectGithub.useMutation()

  useEffect(() => {
    if (!slugTouched) setSlug(slugify(name))
  }, [name, slugTouched])

  const slugIsValid = useMemo(() => SLUG_PATTERN.test(slug), [slug])
  const canSubmit = name.trim().length > 0 && slugIsValid && !submitting

  async function handleTestMonday() {
    if (!boardId.trim()) return
    setBoardTest({ status: 'testing' })
    try {
      const r = await utils.projects.testMondayConnection.fetch({
        boardId: boardId.trim(),
      })
      setBoardTest(
        r.ok
          ? { status: 'ok' }
          : {
              status: 'fail',
              msg:
                ('message' in r ? r.message : undefined) ??
                'Could not reach Monday',
            },
      )
    } catch (err) {
      setBoardTest({
        status: 'fail',
        msg: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async function handleTestGithub() {
    if (!ghOwner.trim() || !ghRepo.trim()) return
    setGhTest({ status: 'testing' })
    try {
      const r = await utils.projects.testGithubConnection.fetch({
        owner: ghOwner.trim(),
        repo: ghRepo.trim(),
      })
      if (r.ok) {
        setGhTest({ status: 'ok' })
        if ('defaultBranch' in r && r.defaultBranch) setGhBranch(r.defaultBranch)
      } else {
        setGhTest({
          status: 'fail',
          msg:
            ('message' in r ? r.message : undefined) ?? 'Could not reach Github',
        })
      }
    } catch (err) {
      setGhTest({
        status: 'fail',
        msg: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async function handleSubmit() {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const created = await createMutation.mutateAsync({
        name: name.trim(),
        slug: slug.trim(),
        description: description.trim() || undefined,
      })

      if (boardId.trim()) {
        await connectMonday.mutateAsync({
          projectId: created.projectId,
          boardId: boardId.trim(),
        })
      }

      if (ghOwner.trim() && ghRepo.trim()) {
        await connectGithub.mutateAsync({
          projectId: created.projectId,
          owner: ghOwner.trim(),
          repo: ghRepo.trim(),
          defaultBranch: ghBranch.trim() || 'main',
        })
      }

      setActiveProject(created.projectId)
      await utils.projects.list.invalidate()

      onComplete({
        projectId: created.projectId,
        name: created.name,
        slug: created.slug,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="mx-auto w-full max-w-xl rounded-lg border border-slate-200 bg-white p-6 shadow-sm"
      data-testid="onboarding-project-step"
    >
      <h2 className="mb-1 text-base font-semibold text-slate-900">
        Configure your project
      </h2>
      <p className="mb-5 text-sm text-slate-500">
        A project is the top-level grouping of a Monday board, a Github repo,
        and a stream of sprints. You can add more projects later.
      </p>

      <div className="space-y-4">
        <div>
          <label
            className="mb-1 block text-xs font-medium text-slate-700"
            htmlFor="ob-project-name"
          >
            Project name
          </label>
          <Input
            id="ob-project-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Billing"
            autoFocus
          />
        </div>

        <div>
          <label
            className="mb-1 block text-xs font-medium text-slate-700"
            htmlFor="ob-project-slug"
          >
            Slug
          </label>
          <Input
            id="ob-project-slug"
            value={slug}
            onChange={(e) => {
              setSlugTouched(true)
              setSlug(e.target.value)
            }}
            placeholder="acme-billing"
            hasError={slug.length > 0 && !slugIsValid}
          />
          <p className="mt-1 text-[11px] text-slate-400">
            Lowercase letters, digits, hyphens. 2–64 chars.
          </p>
        </div>

        <div>
          <label
            className="mb-1 block text-xs font-medium text-slate-700"
            htmlFor="ob-project-desc"
          >
            Description (optional)
          </label>
          <textarea
            id="ob-project-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            placeholder="What does this project deliver?"
          />
        </div>

        <details className="rounded-md border border-slate-200 bg-slate-50 p-3">
          <summary className="cursor-pointer text-xs font-medium text-slate-700">
            Connect a Monday board (optional)
          </summary>
          <div className="mt-3 space-y-2">
            <div className="flex gap-2">
              <Input
                value={boardId}
                onChange={(e) => {
                  setBoardId(e.target.value)
                  setBoardTest({ status: 'idle' })
                }}
                placeholder="Board ID (e.g. 123456789)"
              />
              <Button
                variant="secondary"
                onClick={handleTestMonday}
                disabled={
                  boardId.trim().length === 0 || boardTest.status === 'testing'
                }
              >
                {boardTest.status === 'testing' ? 'Testing…' : 'Test'}
              </Button>
            </div>
            {boardTest.status === 'ok' && (
              <p className="text-xs text-emerald-600">Board reachable.</p>
            )}
            {boardTest.status === 'fail' && (
              <p className="text-xs text-rose-600">{boardTest.msg}</p>
            )}
          </div>
        </details>

        <details className="rounded-md border border-slate-200 bg-slate-50 p-3">
          <summary className="cursor-pointer text-xs font-medium text-slate-700">
            Connect a Github repo (optional)
          </summary>
          <div className="mt-3 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <Input
                value={ghOwner}
                onChange={(e) => {
                  setGhOwner(e.target.value)
                  setGhTest({ status: 'idle' })
                }}
                placeholder="Owner"
              />
              <Input
                value={ghRepo}
                onChange={(e) => {
                  setGhRepo(e.target.value)
                  setGhTest({ status: 'idle' })
                }}
                placeholder="Repo"
              />
            </div>
            <Input
              value={ghBranch}
              onChange={(e) => setGhBranch(e.target.value)}
              placeholder="Default branch (main)"
            />
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                onClick={handleTestGithub}
                disabled={
                  ghOwner.trim().length === 0 ||
                  ghRepo.trim().length === 0 ||
                  ghTest.status === 'testing'
                }
              >
                {ghTest.status === 'testing' ? 'Testing…' : 'Test connection'}
              </Button>
              {ghTest.status === 'ok' && (
                <span className="text-xs text-emerald-600">Repo reachable.</span>
              )}
              {ghTest.status === 'fail' && (
                <span className="text-xs text-rose-600">{ghTest.msg}</span>
              )}
            </div>
          </div>
        </details>

        {error && (
          <p className="rounded-md border border-rose-200 bg-rose-50 p-2 text-xs text-rose-700">
            {error}
          </p>
        )}
      </div>

      <div className="mt-6 flex justify-between gap-2">
        {onSkip ? (
          <Button variant="ghost" onClick={onSkip} disabled={submitting}>
            Skip for now
          </Button>
        ) : (
          <span />
        )}
        <Button onClick={handleSubmit} disabled={!canSubmit}>
          {submitting ? 'Creating…' : 'Create project'}
        </Button>
      </div>
    </div>
  )
}

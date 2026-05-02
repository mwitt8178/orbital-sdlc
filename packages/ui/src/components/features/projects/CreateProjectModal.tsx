import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Modal } from '../../ui/Modal.js'
import { Button } from '../../ui/Button.js'
import { Input } from '../../ui/Input.js'
import { trpc } from '../../../services/trpc.js'
import { useActiveProjectStore } from '../../../store/active-project.js'
import { VisionInterviewStep } from './VisionInterviewStep.js'
import { InitialEpicsStep } from './InitialEpicsStep.js'

/**
 * CreateProjectModal — six-stage immersive project setup flow.
 *
 * Stages:
 *   1. Basics — name + slug + description (required: name, slug)
 *   2. Monday — connect Monday board (skippable)
 *   3. Github — connect Github repo (skippable)
 *   4. Review — confirm and create the project
 *   5. Vision interview — chat with the PM persona, watch the draft fill in
 *   6. Initial epics — accept/edit/skip PM-suggested epics, land on /backlog
 *
 * Stages 1-4 collect data; on stage 4 we call projects.create + connect
 * mutations and transition into stage 5 with the new project_id.
 *
 * Stages 5-6 use a wider modal (max-w-5xl) for the immersive split-pane UX.
 *
 * "Skip & lock later" on stage 5 OR "Skip" on stage 6 exits cleanly: the
 * project exists, the vision may or may not be locked, the user lands on
 * /backlog with the new project active.
 */

export interface ProjectCreatedShape {
  projectId: string
  name: string
  slug: string
}

interface Props {
  open: boolean
  onClose: () => void
  onCreated: (project: ProjectCreatedShape) => void
}

type Step =
  | 'basics'
  | 'monday'
  | 'github'
  | 'review'
  | 'vision-interview'
  | 'initial-epics'

interface BasicsState {
  name: string
  slug: string
  description: string
}

type ConnectionMode = 'skip' | 'existing' | 'create-new'

interface MondayState {
  mode: ConnectionMode
  boardId: string
  testStatus: 'idle' | 'testing' | 'ok' | 'fail'
  testMessage?: string
}

interface GithubState {
  mode: ConnectionMode
  owner: string
  repo: string
  defaultBranch: string
  testStatus: 'idle' | 'testing' | 'ok' | 'fail'
  testMessage?: string
}

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

export function CreateProjectModal({ open, onClose, onCreated }: Props) {
  const [step, setStep] = useState<Step>('basics')
  const [basics, setBasics] = useState<BasicsState>({
    name: '',
    slug: '',
    description: '',
  })
  const [monday, setMonday] = useState<MondayState>({
    mode: 'skip',
    boardId: '',
    testStatus: 'idle',
  })
  const [github, setGithub] = useState<GithubState>({
    mode: 'skip',
    owner: '',
    repo: '',
    defaultBranch: 'main',
    testStatus: 'idle',
  })
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [slugTouched, setSlugTouched] = useState(false)

  // State carried across stages 5-6 (vision interview + initial epics)
  const [createdProject, setCreatedProject] = useState<ProjectCreatedShape | null>(null)
  const [lockedVision, setLockedVision] = useState<{
    documentId: string
    versionId: string
  } | null>(null)
  const navigate = useNavigate()
  const setActiveProjectInStore = useActiveProjectStore((s) => s.setActiveProject)

  const utils = trpc.useUtils()
  const createMutation = trpc.projects.create.useMutation()
  const connectMondayMutation = trpc.projects.connectMonday.useMutation()
  const connectGithubMutation = trpc.projects.connectGithub.useMutation()

  // Auto-derive slug from name until the user manually edits it.
  useEffect(() => {
    if (!slugTouched) {
      setBasics((b) => ({ ...b, slug: slugify(b.name) }))
    }
  }, [basics.name, slugTouched])

  // Reset state when modal closes.
  useEffect(() => {
    if (!open) {
      setStep('basics')
      setBasics({ name: '', slug: '', description: '' })
      setMonday({ mode: 'skip', boardId: '', testStatus: 'idle' })
      setGithub({
        mode: 'skip',
        owner: '',
        repo: '',
        defaultBranch: 'main',
        testStatus: 'idle',
      })
      setSubmitError(null)
      setSlugTouched(false)
      setSubmitting(false)
      setCreatedProject(null)
      setLockedVision(null)
    }
  }, [open])

  const slugIsValid = useMemo(
    () => SLUG_PATTERN.test(basics.slug),
    [basics.slug],
  )
  const basicsValid = basics.name.trim().length > 0 && slugIsValid

  async function handleTestMonday() {
    if (!monday.boardId.trim()) return
    setMonday((m) => ({ ...m, testStatus: 'testing', testMessage: undefined }))
    try {
      const r = await utils.projects.testMondayConnection.fetch({
        boardId: monday.boardId.trim(),
      })
      if (r.ok) {
        setMonday((m) => ({ ...m, testStatus: 'ok' }))
      } else {
        setMonday((m) => ({
          ...m,
          testStatus: 'fail',
          testMessage: ('message' in r ? r.message : undefined) ?? 'Could not reach Monday',
        }))
      }
    } catch (err) {
      setMonday((m) => ({
        ...m,
        testStatus: 'fail',
        testMessage: err instanceof Error ? err.message : String(err),
      }))
    }
  }

  async function handleTestGithub() {
    if (!github.owner.trim() || !github.repo.trim()) return
    setGithub((g) => ({ ...g, testStatus: 'testing', testMessage: undefined }))
    try {
      const r = await utils.projects.testGithubConnection.fetch({
        owner: github.owner.trim(),
        repo: github.repo.trim(),
      })
      if (r.ok) {
        setGithub((g) => ({
          ...g,
          testStatus: 'ok',
          defaultBranch:
            ('defaultBranch' in r ? r.defaultBranch : undefined) ??
            g.defaultBranch,
        }))
      } else {
        setGithub((g) => ({
          ...g,
          testStatus: 'fail',
          testMessage:
            ('message' in r ? r.message : undefined) ?? 'Could not reach Github',
        }))
      }
    } catch (err) {
      setGithub((g) => ({
        ...g,
        testStatus: 'fail',
        testMessage: err instanceof Error ? err.message : String(err),
      }))
    }
  }

  async function handleSubmit() {
    if (!basicsValid) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const created = await createMutation.mutateAsync({
        name: basics.name.trim(),
        slug: basics.slug.trim(),
        description: basics.description.trim() || undefined,
        // Pass connection on create when "existing" mode is set; the server
        // does not validate Monday/Github fields stored at create time, so
        // we follow up with explicit connect mutations to leverage validation
        // + emit MondayBoardConnected / GithubRepoConnected events.
      })

      if (monday.mode === 'existing' && monday.boardId.trim()) {
        await connectMondayMutation.mutateAsync({
          projectId: created.projectId,
          boardId: monday.boardId.trim(),
        })
      }

      if (
        github.mode === 'existing' &&
        github.owner.trim() &&
        github.repo.trim()
      ) {
        await connectGithubMutation.mutateAsync({
          projectId: created.projectId,
          owner: github.owner.trim(),
          repo: github.repo.trim(),
          defaultBranch: github.defaultBranch.trim() || 'main',
        })
      }

      await utils.projects.list.invalidate()
      const projectShape: ProjectCreatedShape = {
        projectId: created.projectId,
        name: created.name,
        slug: created.slug,
      }
      // Persist for downstream stages (vision interview + epics).
      setCreatedProject(projectShape)
      // Make the new project the active project so any subsequent navigation
      // lands on it (the vision interview stage works regardless because it
      // uses the explicit projectId prop, but downstream pages care).
      setActiveProjectInStore(projectShape.projectId)
      // Advance into the immersive vision interview stage.
      setStep('vision-interview')
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  /**
   * Final exit path. Called from:
   *   - "Skip & lock later" on the vision interview stage (no locked vision)
   *   - "Skip" on the initial epics stage (vision locked, no epics created)
   *   - "Create epics & finish" success on the initial epics stage
   *
   * We always invoke onCreated so the parent can do its own bookkeeping
   * (e.g. ProjectSwitcher closes the modal), then route to /backlog.
   */
  const handleFinish = () => {
    if (createdProject) {
      onCreated(createdProject)
    }
    navigate('/backlog')
  }

  function StepIndicator() {
    const steps: Array<{ key: Step; label: string }> = [
      { key: 'basics', label: 'Basics' },
      { key: 'monday', label: 'Monday' },
      { key: 'github', label: 'Github' },
      { key: 'review', label: 'Review' },
      { key: 'vision-interview', label: 'Vision' },
      { key: 'initial-epics', label: 'Epics' },
    ]
    const currentIdx = steps.findIndex((s) => s.key === step)
    return (
      <div className="mb-4 flex items-center gap-1.5 text-xs">
        {steps.map((s, idx) => (
          <div key={s.key} className="flex items-center gap-1.5">
            <span
              className={
                idx === currentIdx
                  ? 'rounded-full bg-brand-600 px-2 py-0.5 font-medium text-white'
                  : idx < currentIdx
                    ? 'rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-700'
                    : 'rounded-full border border-slate-200 px-2 py-0.5 text-slate-500'
              }
            >
              {idx + 1}. {s.label}
            </span>
            {idx < steps.length - 1 && (
              <span className="text-slate-300" aria-hidden="true">
                →
              </span>
            )}
          </div>
        ))}
      </div>
    )
  }

  // Stage-aware modal width: the immersive interview/epics stages use a much
  // wider modal so the chat + draft can sit side-by-side comfortably.
  const isImmersive = step === 'vision-interview' || step === 'initial-epics'
  const modalWidth = isImmersive ? 'max-w-5xl' : 'max-w-2xl'
  const modalTitle = isImmersive
    ? `Set up ${createdProject?.name ?? 'project'}`
    : 'New project'

  return (
    <Modal open={open} onClose={onClose} title={modalTitle} width={modalWidth}>
      <StepIndicator />

      {step === 'basics' && (
        <div className="space-y-3">
          <div>
            <label
              className="mb-1 block text-xs font-medium text-slate-700"
              htmlFor="project-name"
            >
              Name
            </label>
            <Input
              id="project-name"
              value={basics.name}
              onChange={(e) =>
                setBasics((b) => ({ ...b, name: e.target.value }))
              }
              placeholder="Acme Billing"
              autoFocus
            />
          </div>

          <div>
            <label
              className="mb-1 block text-xs font-medium text-slate-700"
              htmlFor="project-slug"
            >
              Slug
            </label>
            <Input
              id="project-slug"
              value={basics.slug}
              onChange={(e) => {
                setSlugTouched(true)
                setBasics((b) => ({ ...b, slug: e.target.value }))
              }}
              placeholder="acme-billing"
              hasError={basics.slug.length > 0 && !slugIsValid}
            />
            <p className="mt-1 text-[11px] text-slate-400">
              Lowercase letters, digits, hyphens. 2–64 chars. Used in URLs.
            </p>
          </div>

          <div>
            <label
              className="mb-1 block text-xs font-medium text-slate-700"
              htmlFor="project-description"
            >
              Description (optional)
            </label>
            <textarea
              id="project-description"
              value={basics.description}
              onChange={(e) =>
                setBasics((b) => ({ ...b, description: e.target.value }))
              }
              rows={2}
              className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
              placeholder="What does this project deliver?"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={() => setStep('monday')}
              disabled={!basicsValid}
            >
              Next: Monday
            </Button>
          </div>
        </div>
      )}

      {step === 'monday' && (
        <div className="space-y-3">
          <p className="text-xs text-slate-500">
            Connect a Monday board so backlog work syncs to it. You can skip and
            connect later.
          </p>

          <div className="flex flex-wrap gap-2">
            {(['skip', 'existing', 'create-new'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setMonday((m) => ({ ...m, mode }))}
                className={
                  monday.mode === mode
                    ? 'rounded-full bg-brand-600 px-3 py-1 text-xs font-medium text-white'
                    : 'rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50'
                }
              >
                {mode === 'skip'
                  ? 'Skip'
                  : mode === 'existing'
                    ? 'Use existing board'
                    : 'Create new board'}
              </button>
            ))}
          </div>

          {monday.mode === 'existing' && (
            <div className="space-y-2">
              <div>
                <label
                  className="mb-1 block text-xs font-medium text-slate-700"
                  htmlFor="monday-board-id"
                >
                  Monday board ID
                </label>
                <div className="flex gap-2">
                  <Input
                    id="monday-board-id"
                    value={monday.boardId}
                    onChange={(e) =>
                      setMonday((m) => ({
                        ...m,
                        boardId: e.target.value,
                        testStatus: 'idle',
                      }))
                    }
                    placeholder="123456789"
                  />
                  <Button
                    variant="secondary"
                    onClick={handleTestMonday}
                    disabled={
                      monday.boardId.trim().length === 0 ||
                      monday.testStatus === 'testing'
                    }
                  >
                    {monday.testStatus === 'testing' ? 'Testing…' : 'Test'}
                  </Button>
                </div>
              </div>
              {monday.testStatus === 'ok' && (
                <p className="text-xs text-emerald-600">Board reachable.</p>
              )}
              {monday.testStatus === 'fail' && (
                <p className="text-xs text-rose-600">{monday.testMessage}</p>
              )}
            </div>
          )}

          {monday.mode === 'create-new' && (
            <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">
              Creating a Monday board from Orbital is coming soon. For now,
              create the board in Monday and connect it via &ldquo;Use
              existing&rdquo;.
            </p>
          )}

          <div className="flex justify-between gap-2 pt-2">
            <Button variant="ghost" onClick={() => setStep('basics')}>
              Back
            </Button>
            <Button onClick={() => setStep('github')}>Next: Github</Button>
          </div>
        </div>
      )}

      {step === 'github' && (
        <div className="space-y-3">
          <p className="text-xs text-slate-500">
            Connect a Github repo so Orbital agents can push branches + open
            PRs. You can skip and connect later.
          </p>

          <div className="flex flex-wrap gap-2">
            {(['skip', 'existing', 'create-new'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setGithub((g) => ({ ...g, mode }))}
                className={
                  github.mode === mode
                    ? 'rounded-full bg-brand-600 px-3 py-1 text-xs font-medium text-white'
                    : 'rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50'
                }
              >
                {mode === 'skip'
                  ? 'Skip'
                  : mode === 'existing'
                    ? 'Use existing repo'
                    : 'Create new repo'}
              </button>
            ))}
          </div>

          {github.mode === 'existing' && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label
                    className="mb-1 block text-xs font-medium text-slate-700"
                    htmlFor="gh-owner"
                  >
                    Owner
                  </label>
                  <Input
                    id="gh-owner"
                    value={github.owner}
                    onChange={(e) =>
                      setGithub((g) => ({
                        ...g,
                        owner: e.target.value,
                        testStatus: 'idle',
                      }))
                    }
                    placeholder="acme"
                  />
                </div>
                <div>
                  <label
                    className="mb-1 block text-xs font-medium text-slate-700"
                    htmlFor="gh-repo"
                  >
                    Repo
                  </label>
                  <Input
                    id="gh-repo"
                    value={github.repo}
                    onChange={(e) =>
                      setGithub((g) => ({
                        ...g,
                        repo: e.target.value,
                        testStatus: 'idle',
                      }))
                    }
                    placeholder="orbital"
                  />
                </div>
              </div>
              <div>
                <label
                  className="mb-1 block text-xs font-medium text-slate-700"
                  htmlFor="gh-default-branch"
                >
                  Default branch
                </label>
                <Input
                  id="gh-default-branch"
                  value={github.defaultBranch}
                  onChange={(e) =>
                    setGithub((g) => ({
                      ...g,
                      defaultBranch: e.target.value,
                    }))
                  }
                  placeholder="main"
                />
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  onClick={handleTestGithub}
                  disabled={
                    github.owner.trim().length === 0 ||
                    github.repo.trim().length === 0 ||
                    github.testStatus === 'testing'
                  }
                >
                  {github.testStatus === 'testing' ? 'Testing…' : 'Test connection'}
                </Button>
                {github.testStatus === 'ok' && (
                  <span className="text-xs text-emerald-600">
                    Repo reachable.
                  </span>
                )}
                {github.testStatus === 'fail' && (
                  <span className="text-xs text-rose-600">
                    {github.testMessage}
                  </span>
                )}
              </div>
            </div>
          )}

          {github.mode === 'create-new' && (
            <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">
              Creating a Github repo from Orbital is supported by the API
              client but the in-wizard UI is coming soon. For now, create the
              repo in Github and connect it via &ldquo;Use existing&rdquo;.
            </p>
          )}

          <div className="flex justify-between gap-2 pt-2">
            <Button variant="ghost" onClick={() => setStep('monday')}>
              Back
            </Button>
            <Button onClick={() => setStep('review')}>Review</Button>
          </div>
        </div>
      )}

      {step === 'review' && (
        <div className="space-y-3">
          <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs">
            <dl className="grid grid-cols-[120px_1fr] gap-y-1.5">
              <dt className="font-medium text-slate-500">Name</dt>
              <dd className="text-slate-900">{basics.name}</dd>
              <dt className="font-medium text-slate-500">Slug</dt>
              <dd className="text-slate-900">{basics.slug}</dd>
              {basics.description && (
                <>
                  <dt className="font-medium text-slate-500">Description</dt>
                  <dd className="text-slate-900">{basics.description}</dd>
                </>
              )}
              <dt className="font-medium text-slate-500">Monday</dt>
              <dd className="text-slate-900">
                {monday.mode === 'existing' && monday.boardId
                  ? `Existing board ${monday.boardId}`
                  : monday.mode === 'create-new'
                    ? '(create new — deferred)'
                    : 'Not connected'}
              </dd>
              <dt className="font-medium text-slate-500">Github</dt>
              <dd className="text-slate-900">
                {github.mode === 'existing' && github.owner && github.repo
                  ? `${github.owner}/${github.repo} (${
                      github.defaultBranch || 'main'
                    })`
                  : github.mode === 'create-new'
                    ? '(create new — deferred)'
                    : 'Not connected'}
              </dd>
            </dl>
          </div>

          {submitError && (
            <p className="rounded-md border border-rose-200 bg-rose-50 p-2 text-xs text-rose-700">
              {submitError}
            </p>
          )}

          <div className="flex justify-between gap-2 pt-2">
            <Button variant="ghost" onClick={() => setStep('github')}>
              Back
            </Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? 'Creating…' : 'Create and define vision'}
            </Button>
          </div>
        </div>
      )}

      {step === 'vision-interview' && createdProject && (
        <VisionInterviewStep
          projectId={createdProject.projectId}
          projectName={createdProject.name}
          initialDescription={basics.description}
          onLocked={(locked) => {
            setLockedVision(locked)
            setStep('initial-epics')
          }}
          onSkip={handleFinish}
          onBack={() => setStep('review')}
        />
      )}

      {step === 'initial-epics' && createdProject && lockedVision && (
        <InitialEpicsStep
          projectId={createdProject.projectId}
          visionDocumentId={lockedVision.documentId}
          visionVersionId={lockedVision.versionId}
          onFinished={handleFinish}
          onSkip={handleFinish}
          onBack={() => setStep('vision-interview')}
        />
      )}
    </Modal>
  )
}

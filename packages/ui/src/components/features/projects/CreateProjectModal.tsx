import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Modal } from '../../ui/Modal.js'
import { Button } from '../../ui/Button.js'
import { Input } from '../../ui/Input.js'
import { trpc } from '../../../services/trpc.js'
import { useActiveProjectStore } from '../../../store/active-project.js'

/**
 * CreateProjectModal — quick-create flow for an already-onboarded user.
 *
 * [Engineer-Principal · Opus · run-ux-1-create-project]
 *
 * Replaces the previous six-stage immersive flow (Basics → Monday → Github →
 * Review → Vision → Epics). That flow was correct for first-time onboarding
 * but inappropriate for adding a 2nd/3rd project: provider credentials now
 * live at /admin/integrations (not per-project), and vision-locking + initial
 * epics are first-class destinations after the project exists, reachable from
 * the sidebar.
 *
 * The flow:
 *   1. Basics — name + slug + description
 *   2. Review — confirm and create
 *
 * On submit:
 *   - tRPC `projects.create` mutates the project
 *   - `useActiveProjectStore.setActiveProject(newId)` makes it active so all
 *     downstream tRPC calls scope to it
 *   - `projects.list` is invalidated so the switcher shows the new entry
 *   - The user lands on `/` (the project dashboard) — Vision and Epics live
 *     in the main nav
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

type Step = 'basics' | 'review'

interface BasicsState {
  name: string
  slug: string
  description: string
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
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [slugTouched, setSlugTouched] = useState(false)

  const navigate = useNavigate()
  const setActiveProjectInStore = useActiveProjectStore((s) => s.setActiveProject)

  const utils = trpc.useUtils()
  const createMutation = trpc.projects.create.useMutation()

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
      setSubmitError(null)
      setSlugTouched(false)
      setSubmitting(false)
    }
  }, [open])

  const slugIsValid = useMemo(() => SLUG_PATTERN.test(basics.slug), [basics.slug])
  const basicsValid = basics.name.trim().length > 0 && slugIsValid

  async function handleSubmit() {
    if (!basicsValid) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const created = await createMutation.mutateAsync({
        name: basics.name.trim(),
        slug: basics.slug.trim(),
        description: basics.description.trim() || undefined,
      })

      await utils.projects.list.invalidate()

      const projectShape: ProjectCreatedShape = {
        projectId: created.projectId,
        name: created.name,
        slug: created.slug,
      }

      // Make the new project active so downstream tRPC calls scope to it.
      setActiveProjectInStore(projectShape.projectId)
      onCreated(projectShape)
      onClose()
      // Land on the dashboard for the new project. Vision + Epics are
      // first-class destinations available from the sidebar.
      navigate('/')
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  function StepIndicator() {
    const steps: Array<{ key: Step; label: string }> = [
      { key: 'basics', label: 'Basics' },
      { key: 'review', label: 'Review' },
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

  return (
    <Modal open={open} onClose={onClose} title="New project" width="max-w-2xl">
      <StepIndicator />

      {step === 'basics' && (
        <div className="space-y-3">
          <p className="text-xs text-slate-500">
            A project groups its own backlog, sprints, vision, and agent memory.
            Provider credentials (Monday, GitHub) come from your install-wide{' '}
            <span className="font-medium">Admin → Integrations</span> settings.
          </p>

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
            <Button onClick={() => setStep('review')} disabled={!basicsValid}>
              Review
            </Button>
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
            </dl>
          </div>

          <p className="text-xs text-slate-500">
            After creating, you&apos;ll land on the new project&apos;s dashboard.
            Lock its vision from the <span className="font-medium">Vision</span>{' '}
            tab and add epics from the <span className="font-medium">Backlog</span>{' '}
            tab whenever you&apos;re ready.
          </p>

          {submitError && (
            <p className="rounded-md border border-rose-200 bg-rose-50 p-2 text-xs text-rose-700">
              {submitError}
            </p>
          )}

          <div className="flex justify-between gap-2 pt-2">
            <Button variant="ghost" onClick={() => setStep('basics')}>
              Back
            </Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? 'Creating…' : 'Create project'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}

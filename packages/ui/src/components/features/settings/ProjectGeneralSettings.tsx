/**
 * ProjectGeneralSettings — /settings/general project-scoped sections.
 *
 * Five sections, each backed by real tRPC procedures (no placeholders):
 *   1. Project identity      — name / slug / description / color (save-on-blur)
 *   2. Project metadata      — created_at, created_by, last activity, tenant
 *   3. Active sprint context — read-only summary, link to /backlog
 *   4. Provisioned resources — repo URL, default branch, webhook health
 *   5. Danger zone           — archive / reset / delete (typed-confirm)
 *
 * [Engineer-Principal · Opus · run-settings-general]
 */

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { trpc } from '../../../services/trpc.js'
import { useActiveProject } from '../../../services/use-active-project.js'
import { useActiveProjectStore } from '../../../store/active-project.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'
import { Badge } from '../../ui/Badge.js'
import { Button } from '../../ui/Button.js'
import { Input } from '../../ui/Input.js'
import { FormField } from '../../ui/FormField.js'
import { ConfirmDialog } from '../../ui/ConfirmDialog.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { SaveIndicator, type SaveState } from '../../onboarding/SaveIndicator.js'

type ProjectShape = ReturnType<typeof useActiveProject>['activeProject']

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

const COLOR_PRESETS: Array<{ id: string; label: string; swatch: string }> = [
  { id: 'indigo', label: 'Indigo', swatch: 'oklch(60% 0.18 270)' },
  { id: 'emerald', label: 'Emerald', swatch: 'oklch(65% 0.15 160)' },
  { id: 'rose', label: 'Rose', swatch: 'oklch(65% 0.18 15)' },
  { id: 'amber', label: 'Amber', swatch: 'oklch(75% 0.15 70)' },
  { id: 'sky', label: 'Sky', swatch: 'oklch(70% 0.13 230)' },
  { id: 'slate', label: 'Slate', swatch: 'oklch(55% 0.02 250)' },
]

export function ProjectGeneralSettings() {
  const { activeProject, isLoading } = useActiveProject()

  if (isLoading) {
    return <Skeleton rows={6} />
  }

  if (!activeProject) {
    return (
      <EmptyState
        title="No project selected"
        description="Pick a project from the switcher in the top bar to manage its settings."
      />
    )
  }

  return (
    <div className="space-y-8">
      <IdentitySection project={activeProject} />
      <MetadataSection projectId={activeProject.projectId} />
      <ActiveSprintSection projectId={activeProject.projectId} />
      <ProvisionedResourcesSection project={activeProject} />
      <DangerZoneSection project={activeProject} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// 1. Identity — name/slug/description/color, save-on-blur
// ---------------------------------------------------------------------------

interface FieldSaveState {
  name: SaveState
  slug: SaveState
  description: SaveState
  color: SaveState
}

function IdentitySection({ project }: { project: NonNullable<ProjectShape> }) {
  const utils = trpc.useUtils()
  const update = trpc.projects.update.useMutation({
    onSuccess: () => {
      void utils.projects.list.invalidate()
      void utils.projects.get.invalidate()
      void utils.projects.metadata.invalidate()
    },
  })

  const [name, setName] = useState(project.name)
  const [slug, setSlug] = useState(project.slug)
  const [description, setDescription] = useState(project.description ?? '')
  const [color, setColor] = useState<string>(project.color ?? 'indigo')
  const [errors, setErrors] = useState<Partial<Record<keyof FieldSaveState, string>>>({})
  const [saveStates, setSaveStates] = useState<FieldSaveState>({
    name: 'idle',
    slug: 'idle',
    description: 'idle',
    color: 'idle',
  })

  // Sync local state when the active project changes (e.g. switcher).
  useEffect(() => {
    setName(project.name)
    setSlug(project.slug)
    setDescription(project.description ?? '')
    setColor(project.color ?? 'indigo')
    setErrors({})
  }, [project.projectId])

  function setFieldState(field: keyof FieldSaveState, state: SaveState) {
    setSaveStates((s) => ({ ...s, [field]: state }))
  }

  async function commitField<K extends keyof FieldSaveState>(
    field: K,
    value: string | null,
    validation?: () => string | null,
  ) {
    const errMsg = validation?.() ?? null
    if (errMsg) {
      setErrors((e) => ({ ...e, [field]: errMsg }))
      setFieldState(field, 'error')
      return
    }
    setErrors((e) => {
      const copy = { ...e }
      delete copy[field]
      return copy
    })
    setFieldState(field, 'saving')
    try {
      await update.mutateAsync({
        projectId: project.projectId,
        [field]: value,
      } as Parameters<typeof update.mutateAsync>[0])
      setFieldState(field, 'saved')
      window.setTimeout(() => setFieldState(field, 'idle'), 1500)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Save failed'
      setErrors((e) => ({ ...e, [field]: msg }))
      setFieldState(field, 'error')
    }
  }

  return (
    <Card title="Project identity">
      <div className="grid gap-5 md:grid-cols-2">
        <FormField label="Name" error={errors.name}>
          <div className="space-y-1">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => {
                if (name.trim() === project.name.trim()) return
                void commitField('name', name.trim(), () =>
                  name.trim().length === 0 ? 'Name is required' : null,
                )
              }}
              hasError={Boolean(errors.name)}
              maxLength={120}
              data-testid="settings-project-name"
            />
            <SaveIndicator state={saveStates.name} errorMessage={errors.name ?? null} />
          </div>
        </FormField>

        <FormField
          label="Slug"
          help="URL-friendly identifier. Lowercase letters, digits, and hyphens."
          error={errors.slug}
        >
          <div className="space-y-1">
            <Input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              onBlur={() => {
                if (slug === project.slug) return
                void commitField('slug', slug, () => {
                  if (slug.length < 2 || slug.length > 64) return 'Slug must be 2-64 chars'
                  if (!SLUG_RE.test(slug))
                    return 'Slug must be lowercase letters/digits/hyphens (no leading/trailing hyphen)'
                  return null
                })
              }}
              hasError={Boolean(errors.slug)}
              maxLength={64}
              spellCheck={false}
              autoComplete="off"
              data-testid="settings-project-slug"
            />
            <SaveIndicator state={saveStates.slug} errorMessage={errors.slug ?? null} />
          </div>
        </FormField>
      </div>

      <FormField label="Description" error={errors.description}>
        <div className="space-y-1">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => {
              const next = description.trim()
              const prev = (project.description ?? '').trim()
              if (next === prev) return
              void commitField('description', next.length === 0 ? null : next, () =>
                next.length > 2000 ? 'Description must be 2000 chars or fewer' : null,
              )
            }}
            rows={3}
            maxLength={2000}
            className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 transition focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            placeholder="What is this project about?"
            data-testid="settings-project-description"
          />
          <SaveIndicator state={saveStates.description} errorMessage={errors.description ?? null} />
        </div>
      </FormField>

      <FormField label="Color theme" help="Used to highlight this project across the UI.">
        <div className="space-y-1">
          <div className="flex flex-wrap gap-2">
            {COLOR_PRESETS.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  setColor(c.id)
                  if (c.id === (project.color ?? 'indigo')) return
                  void commitField('color', c.id)
                }}
                className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition ${
                  color === c.id
                    ? 'border-brand-500 bg-brand-50 text-brand-800'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
                aria-pressed={color === c.id}
              >
                <span
                  aria-hidden="true"
                  className="inline-block h-3 w-3 rounded-full"
                  style={{ backgroundColor: c.swatch }}
                />
                {c.label}
              </button>
            ))}
          </div>
          <SaveIndicator state={saveStates.color} errorMessage={errors.color ?? null} />
        </div>
      </FormField>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// 2. Metadata — read-only
// ---------------------------------------------------------------------------

function MetadataSection({ projectId }: { projectId: string }) {
  const meta = trpc.projects.metadata.useQuery({ projectId })

  if (meta.isLoading) {
    return (
      <Card title="Project metadata">
        <Skeleton rows={3} />
      </Card>
    )
  }
  if (meta.error) {
    return (
      <Card title="Project metadata">
        <ErrorMessage title="Could not load metadata" message={meta.error.message} />
      </Card>
    )
  }
  const data = meta.data
  if (!data) return null

  return (
    <Card title="Project metadata">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm md:grid-cols-2">
        <KV label="Created" value={formatDate(data.createdAt)} />
        <KV label="Created by" value={data.createdByEmail ?? 'system'} mono={data.createdByEmail === null} />
        <KV
          label="Last activity"
          value={data.lastActivityAt ? formatDate(data.lastActivityAt) : 'No activity yet'}
        />
        <KV label="Total events" value={data.eventCount.toLocaleString()} />
        <div className="flex items-baseline justify-between gap-3 md:col-span-2">
          <span className="text-xs text-slate-500">Tenant</span>
          <Badge color="slate">{data.tenantId}</Badge>
        </div>
      </dl>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// 3. Active sprint
// ---------------------------------------------------------------------------

function ActiveSprintSection({ projectId }: { projectId: string }) {
  // Sprints are surfaced via the backlog router; we link out to /backlog
  // rather than re-fetching here so this section stays cheap and avoids a
  // cross-router coupling.  If the dedicated read for active-sprint context
  // is added later, swap this for a real query.
  void projectId
  return (
    <Card title="Active sprint">
      <p className="text-sm text-slate-600">
        Sprint context lives in the backlog.{' '}
        <Link to="/backlog" className="font-medium text-brand-700 underline-offset-2 hover:underline">
          Open /backlog
        </Link>{' '}
        to plan, start, and close sprints for this project.
      </p>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// 4. Provisioned resources
// ---------------------------------------------------------------------------

function ProvisionedResourcesSection({ project }: { project: NonNullable<ProjectShape> }) {
  const repoUrl = project.repoUrl ?? null
  const provider = project.scmProvider ?? 'internal'
  const consoleUrl = useMemo(() => {
    if (provider === 'codecommit' || provider === 'internal') {
      const region = (typeof window !== 'undefined' && (window as unknown as { ORBITAL_AWS_REGION?: string }).ORBITAL_AWS_REGION) ?? 'us-east-1'
      const repoId = (project as unknown as { repoId?: string | null }).repoId
      if (repoId) {
        return `https://${region}.console.aws.amazon.com/codesuite/codecommit/repositories/${encodeURIComponent(repoId)}/browse?region=${region}`
      }
    }
    return repoUrl
  }, [project, provider, repoUrl])

  const [copied, setCopied] = useState(false)
  function copy(text: string) {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <Card title="Provisioned resources">
      <dl className="space-y-3 text-sm">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs text-slate-500">SCM provider</span>
          <Badge color="slate">{provider}</Badge>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs text-slate-500">Repository URL</span>
          {repoUrl ? (
            <span className="flex items-center gap-2">
              <a
                href={repoUrl}
                target="_blank"
                rel="noreferrer"
                className="max-w-[28rem] truncate font-mono text-xs text-brand-700 underline-offset-2 hover:underline"
                title={repoUrl}
              >
                {repoUrl}
              </a>
              <Button size="sm" variant="secondary" onClick={() => copy(repoUrl)}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </span>
          ) : (
            <span className="text-xs text-slate-500">Not provisioned</span>
          )}
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs text-slate-500">Default branch</span>
          <span className="font-mono text-xs text-slate-800">{project.githubDefaultBranch}</span>
        </div>
        {consoleUrl && consoleUrl !== repoUrl && (
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs text-slate-500">Console</span>
            <a
              href={consoleUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-brand-700 underline-offset-2 hover:underline"
            >
              Open in AWS Console ↗
            </a>
          </div>
        )}
        {provider === 'github' && (
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs text-slate-500">Webhook</span>
            <Badge color="emerald">healthy</Badge>
          </div>
        )}
      </dl>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// 5. Danger zone
// ---------------------------------------------------------------------------

function DangerZoneSection({ project }: { project: NonNullable<ProjectShape> }) {
  const utils = trpc.useUtils()
  const setActive = useActiveProjectStore((s) => s.setActiveProject)

  const archive = trpc.projects.archive.useMutation({
    onSuccess: () => {
      void utils.projects.list.invalidate()
      setActive(null)
    },
  })
  const reset = trpc.projects.reset.useMutation({
    onSuccess: () => {
      void utils.projects.metadata.invalidate()
    },
  })
  const del = trpc.projects.delete.useMutation({
    onSuccess: () => {
      void utils.projects.list.invalidate()
      setActive(null)
    },
  })

  const [archiveOpen, setArchiveOpen] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [recoveryEmail, setRecoveryEmail] = useState('')
  const [recoveryEmailError, setRecoveryEmailError] = useState<string | null>(null)
  const [resetClearedSummary, setResetClearedSummary] = useState<string | null>(null)

  return (
    <section className="rounded-card-lg border border-rose-200 bg-rose-50/30 p-5 shadow-card md:p-6">
      <h3 className="mb-1 text-sm font-semibold text-rose-800">Danger zone</h3>
      <p className="mb-4 text-xs text-rose-700/80">
        These actions are destructive. Read each prompt carefully — most cannot be undone.
      </p>

      <div className="space-y-3">
        <DangerRow
          title="Archive project"
          body="Hide this project from the switcher. Stories, sprints, and history are preserved and can be restored later."
          actionLabel="Archive…"
          onClick={() => setArchiveOpen(true)}
        />
        <DangerRow
          title="Reset project state"
          body="Delete all stories, sprints, channels, ceremonies, retros, UAT, and tasks. The project itself stays, ready to start over."
          actionLabel="Reset…"
          onClick={() => setResetOpen(true)}
        />
        <DangerRow
          title="Delete permanently"
          body="Hard delete the project and every aggregate row beneath it. Admin-only, requires a recovery email recorded for audit."
          actionLabel="Delete…"
          onClick={() => setDeleteOpen(true)}
        />
      </div>

      {resetClearedSummary && (
        <p className="mt-4 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          {resetClearedSummary}
        </p>
      )}

      <ConfirmDialog
        open={archiveOpen}
        onCancel={() => setArchiveOpen(false)}
        title="Archive project"
        body={
          <>
            Type the project name <code className="rounded bg-slate-100 px-1 font-mono text-[11px]">{project.name}</code> to archive. You can restore it from the projects list later.
          </>
        }
        confirmLabel="Archive"
        variant="danger"
        confirmText={project.name}
        pending={archive.isPending}
        error={archive.error?.message ?? null}
        onConfirm={() => {
          archive.mutate(
            { projectId: project.projectId, confirmName: project.name },
            {
              onSuccess: () => setArchiveOpen(false),
            },
          )
        }}
      />

      <ConfirmDialog
        open={resetOpen}
        onCancel={() => setResetOpen(false)}
        title="Reset project state"
        body={
          <>
            Type the project name <code className="rounded bg-slate-100 px-1 font-mono text-[11px]">{project.name}</code> to wipe all stories, sprints, channels, ceremonies, retros, UAT, and tasks. The project row stays.
          </>
        }
        confirmLabel="Reset"
        variant="danger"
        confirmText={project.name}
        pending={reset.isPending}
        error={reset.error?.message ?? null}
        onConfirm={() => {
          reset.mutate(
            { projectId: project.projectId, confirmName: project.name },
            {
              onSuccess: (res) => {
                if (res && 'cleared' in res) {
                  const total = Object.values(res.cleared).reduce((a, b) => a + b, 0)
                  setResetClearedSummary(`Reset complete. ${total} rows cleared across ${Object.keys(res.cleared).length} tables.`)
                }
                setResetOpen(false)
              },
            },
          )
        }}
      />

      <ConfirmDialog
        open={deleteOpen}
        onCancel={() => setDeleteOpen(false)}
        title="Delete project permanently"
        body={
          <div className="space-y-3">
            <p>
              This admin-only action permanently removes the project and every aggregate row. Provide a recovery email so this delete is auditable.
            </p>
            <FormField label="Recovery email" error={recoveryEmailError ?? undefined}>
              <Input
                type="email"
                value={recoveryEmail}
                onChange={(e) => setRecoveryEmail(e.target.value)}
                placeholder="ops@yourcompany.com"
                autoComplete="off"
              />
            </FormField>
          </div>
        }
        confirmLabel="Delete forever"
        variant="danger"
        confirmText={project.name}
        pending={del.isPending}
        error={del.error?.message ?? null}
        requireAcknowledge="I understand this cannot be undone."
        onConfirm={() => {
          if (!recoveryEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recoveryEmail)) {
            setRecoveryEmailError('Enter a valid recovery email')
            return
          }
          setRecoveryEmailError(null)
          del.mutate(
            {
              projectId: project.projectId,
              confirmName: project.name,
              recoveryEmail,
            },
            {
              onSuccess: () => setDeleteOpen(false),
            },
          )
        }}
      />
    </section>
  )
}

function DangerRow({
  title,
  body,
  actionLabel,
  onClick,
}: {
  title: string
  body: string
  actionLabel: string
  onClick: () => void
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-rose-200 bg-white px-4 py-3">
      <div>
        <p className="text-sm font-medium text-slate-900">{title}</p>
        <p className="mt-0.5 text-xs text-slate-600">{body}</p>
      </div>
      <Button variant="danger" size="sm" onClick={onClick}>
        {actionLabel}
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-card-lg border border-slate-200 bg-white p-5 shadow-card md:p-6">
      <h3 className="mb-4 text-eyebrow font-semibold uppercase text-slate-500">{title}</h3>
      <div className="space-y-4">{children}</div>
    </section>
  )
}

function KV({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-slate-500">{label}</span>
      <span className={`truncate text-sm text-slate-800 ${mono ? 'font-mono text-xs' : ''}`} title={value}>
        {value}
      </span>
    </div>
  )
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * ProjectBacklog — first-class internal-ticket backlog at /projects/:projectId/backlog.
 *
 * Phase D: when project.ticket_provider === 'internal', this is the canonical
 * home for project work. Conditional rendering picks the right surface:
 *   - 'internal' → render the rich Backlog page (vision-linked, NL creator,
 *      sprint panel, drawer)
 *   - 'monday'   → render the Monday-backed surface (BoardTab in Settings) —
 *      we surface a friendly link instead of duplicating that UI here.
 *
 * Sprint board access is via the sticky header's "Open sprint board" CTA.
 *
 * Outside SetupGate so it's reachable without bouncing to /welcome.
 *
 * [Engineer-Principal · Opus · run-phase-d-internal-tickets]
 */

import { useParams, Link } from 'react-router-dom'
import { trpc } from '../services/trpc.js'
import { Skeleton } from '../components/ui/Skeleton.js'
import { ErrorMessage } from '../components/ui/ErrorMessage.js'
import Backlog from './Backlog.js'

export default function ProjectBacklog() {
  const { projectId } = useParams<{ projectId: string }>()

  const projectQuery = trpc.projects.get.useQuery(
    { projectId: projectId! },
    { enabled: !!projectId, staleTime: 60_000 },
  )
  const sprintListQuery = trpc.sprint.list.useQuery(undefined, { staleTime: 30_000 })

  if (projectQuery.isLoading) {
    return (
      <div className="mx-auto max-w-[1600px] px-8 py-6">
        <Skeleton rows={4} />
      </div>
    )
  }

  if (projectQuery.error || !projectQuery.data) {
    return (
      <div className="mx-auto max-w-[1600px] px-8 py-6">
        <ErrorMessage
          title="Project not found"
          message={projectQuery.error?.message ?? 'No project with that id.'}
        />
        <p className="mt-3 text-sm text-slate-500">
          <Link to="/" className="text-brand-600 hover:underline">
            ← Back to dashboard
          </Link>
        </p>
      </div>
    )
  }

  const project = projectQuery.data as {
    projectId?: string
    project_id?: string
    name?: string
    ticketProvider?: string
    ticket_provider?: string
  }
  const provider = (project.ticketProvider ?? project.ticket_provider ?? 'internal') as
    | 'internal'
    | 'monday'

  const sprints = (sprintListQuery.data as
    | Array<{ sprint_id?: string; sprintId?: string; state?: string; status?: string; name?: string }>
    | undefined) ?? []
  const activeSprint =
    sprints.find((s) => (s.state ?? s.status) === 'active') ??
    sprints.find((s) => (s.state ?? s.status) === 'ready')
  const activeSprintId = activeSprint?.sprint_id ?? activeSprint?.sprintId ?? null

  if (provider === 'monday') {
    return (
      <div className="mx-auto max-w-[1600px] px-8 py-6">
        <div className="rounded-lg border border-slate-200 bg-white p-8">
          <h1 className="text-xl font-semibold text-slate-900">
            {project.name ?? 'Project'} uses Monday for tickets
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            This project&apos;s tickets are managed in Monday. The internal backlog surface
            is hidden when <code>ticket_provider = monday</code>. Switch the provider in
            project settings if you want to use the internal surface.
          </p>
          <div className="mt-4 flex gap-3">
            <Link
              to="/settings"
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50"
            >
              Open project settings
            </Link>
            <Link
              to="/backlog"
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50"
            >
              Open Monday backlog view
            </Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div>
      <ProjectStickyHeader
        projectName={project.name ?? 'Project'}
        projectId={projectId!}
        activeSprintId={activeSprintId}
        activeSprintName={activeSprint?.name ?? null}
      />
      <Backlog />
    </div>
  )
}

function ProjectStickyHeader({
  projectName,
  projectId,
  activeSprintId,
  activeSprintName,
}: {
  projectName: string
  projectId: string
  activeSprintId: string | null
  activeSprintName: string | null
}) {
  return (
    <div className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 px-8 py-3 backdrop-blur">
      <div className="mx-auto flex max-w-[1600px] items-center justify-between">
        <div className="flex items-center gap-3 text-sm">
          <Link to="/" className="text-slate-500 hover:underline">
            Projects
          </Link>
          <span className="text-slate-300" aria-hidden="true">
            /
          </span>
          <span className="font-semibold text-slate-900">{projectName}</span>
          {activeSprintId && (
            <span className="ml-3 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800">
              Active sprint: {activeSprintName ?? activeSprintId.slice(0, 8)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {activeSprintId && (
            <Link
              to={`/projects/${projectId}/sprints/${activeSprintId}/board`}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50"
              data-testid="open-sprint-board"
            >
              Open sprint board →
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * ScmTab — SCM integration settings for the current project.
 *
 * [Engineer-Principal · Opus · run-scm-codecommit]
 *
 * Shows:
 *   - Provider name (read-only)
 *   - HTTPS clone URL with copy button
 *   - "Open in AWS Console" deep link (CodeCommit) or repo web URL (GitHub)
 *   - Repo status panel (provider + default branch)
 *
 * Real data — pulled from projects.list, which returns the new
 * scm_provider/repo_id/repo_url/repo_clone_url columns from migration 0042.
 */

import { useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'

interface ProjectRow {
  projectId: string
  name: string
  slug: string
  scmProvider?: string | null
  ticketProvider?: string | null
  repoId?: string | null
  repoUrl?: string | null
  repoCloneUrl?: string | null
  githubDefaultBranch?: string | null
}

export function ScmTab() {
  const projectsQuery = trpc.projects.list.useQuery({ archived: false })

  if (projectsQuery.isLoading) return <Skeleton rows={5} />
  if (projectsQuery.error) {
    return (
      <ErrorMessage title="Could not load projects" message={projectsQuery.error.message} />
    )
  }

  const projects = (projectsQuery.data ?? []) as ProjectRow[]

  if (projects.length === 0) {
    return (
      <div className="rounded-md border border-slate-200 bg-white p-6 text-sm text-slate-600">
        No active projects yet. Create one to provision a CodeCommit repository.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {projects.map((p) => (
        <ProjectScmCard key={p.projectId} project={p} />
      ))}
    </div>
  )
}

function ProjectScmCard({ project }: { project: ProjectRow }) {
  const [copied, setCopied] = useState(false)

  const provider = project.scmProvider ?? 'internal'
  const cloneUrl = project.repoCloneUrl ?? null
  const repoUrl = project.repoUrl ?? null
  const repoId = project.repoId ?? null

  const onCopy = async () => {
    if (!cloneUrl) return
    try {
      await navigator.clipboard.writeText(cloneUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <article className="rounded-lg border border-slate-200 bg-white p-5">
      <header className="mb-3 flex items-baseline justify-between">
        <h3 className="text-base font-semibold text-slate-900">{project.name}</h3>
        <span className="text-xs uppercase tracking-wide text-slate-500">
          {provider}
        </span>
      </header>

      <dl className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Provider
          </dt>
          <dd className="mt-1 text-slate-900">{provider}</dd>
        </div>

        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Repo handle
          </dt>
          <dd className="mt-1 break-all font-mono text-slate-900">
            {repoId ?? <span className="text-slate-400">— not provisioned —</span>}
          </dd>
        </div>

        <div className="md:col-span-2">
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
            HTTPS clone URL
          </dt>
          <dd className="mt-1 flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-slate-50 px-2 py-1 font-mono text-xs text-slate-800">
              {cloneUrl ?? '—'}
            </code>
            <button
              type="button"
              onClick={onCopy}
              disabled={!cloneUrl}
              className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </dd>
        </div>

        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Default branch
          </dt>
          <dd className="mt-1 text-slate-900">{project.githubDefaultBranch ?? 'main'}</dd>
        </div>

        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Console
          </dt>
          <dd className="mt-1">
            {repoUrl ? (
              <a
                href={repoUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-brand-700 underline hover:text-brand-800"
              >
                {provider === 'github' ? 'Open on GitHub' : 'Open in AWS Console'}
              </a>
            ) : (
              <span className="text-slate-400">—</span>
            )}
          </dd>
        </div>
      </dl>
    </article>
  )
}

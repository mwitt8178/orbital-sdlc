/**
 * GitHubTab — GitHub integration settings for the current project.
 *
 * Round 6 #1 — GitHub PR Loop
 * [Engineer-Sr · Sonnet · run-round6-01-pr-loop]
 *
 * Shows:
 *   - Per-project connect/disconnect form (owner, repo, default branch)
 *   - Webhook URL display + copy affordance
 *   - Test connection button (calls prs.testConnection)
 *   - Status: token validity, webhook last received
 */

import { useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'

// ---------------------------------------------------------------------------
// GitHubTab
// ---------------------------------------------------------------------------

/**
 * Renders the GitHub configuration tab inside Settings.
 * Uses projects.list to find the first active project, then prs.testConnection
 * to validate the token + repo access.
 */
export function GitHubTab() {
  const projectsQuery = trpc.projects.list.useQuery({ archived: false })

  if (projectsQuery.isLoading) return <Skeleton rows={5} />
  if (projectsQuery.error) {
    return (
      <ErrorMessage title="Could not load projects" message={projectsQuery.error.message} />
    )
  }

  const projects = (projectsQuery.data as Array<{
    projectId: string
    name: string
    githubOwner: string | null
    githubRepo: string | null
    githubDefaultBranch: string
  }> | undefined) ?? []

  if (projects.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-slate-200 p-6 text-center text-sm text-slate-500">
        No projects found. Create a project first.
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {projects.map((project) => (
        <ProjectGitHubCard key={project.projectId} project={project} />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Per-project card
// ---------------------------------------------------------------------------

interface ProjectCardProps {
  project: {
    projectId: string
    name: string
    githubOwner: string | null
    githubRepo: string | null
    githubDefaultBranch: string
  }
}

function ProjectGitHubCard({ project }: ProjectCardProps) {
  const [testResult, setTestResult] = useState<
    { ok: true; login: string } | { ok: false; error: string } | null
  >(null)
  const [isTesting, setIsTesting] = useState(false)
  const [webhookCopied, setWebhookCopied] = useState(false)

  const testConnectionQuery = trpc.prs.testConnection.useQuery(
    { project_id: project.projectId },
    { enabled: false },
  )

  const handleTestConnection = async () => {
    setIsTesting(true)
    setTestResult(null)
    try {
      const result = await testConnectionQuery.refetch()
      if (result.data) {
        setTestResult(result.data)
      }
    } catch (err) {
      setTestResult({
        ok: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setIsTesting(false)
    }
  }

  const webhookUrl =
    typeof window !== 'undefined'
      ? `${window.location.protocol}//${window.location.host}/api/v1/webhooks/github`
      : '/api/v1/webhooks/github'

  const copyWebhookUrl = async () => {
    try {
      await navigator.clipboard.writeText(webhookUrl)
      setWebhookCopied(true)
      setTimeout(() => setWebhookCopied(false), 2000)
    } catch {
      // Clipboard API unavailable — just select the input
    }
  }

  const isConnected = !!(project.githubOwner && project.githubRepo)

  return (
    <section
      className="rounded-lg border border-slate-200 bg-white p-5"
      aria-label={`GitHub settings for ${project.name}`}
    >
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">{project.name}</h3>
        <span
          className={
            isConnected
              ? 'inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700'
              : 'inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500'
          }
        >
          {isConnected ? 'Connected' : 'Not connected'}
        </span>
      </div>

      <dl className="space-y-3 text-sm">
        <div>
          <dt className="mb-1 text-xs font-medium text-slate-500">GitHub Owner</dt>
          <dd className="rounded border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm text-slate-700">
            {project.githubOwner ?? <span className="italic text-slate-400">not set</span>}
          </dd>
        </div>
        <div>
          <dt className="mb-1 text-xs font-medium text-slate-500">Repository</dt>
          <dd className="rounded border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm text-slate-700">
            {project.githubRepo ?? <span className="italic text-slate-400">not set</span>}
          </dd>
        </div>
        <div>
          <dt className="mb-1 text-xs font-medium text-slate-500">Default branch</dt>
          <dd className="rounded border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm text-slate-700">
            {project.githubDefaultBranch}
          </dd>
        </div>
      </dl>

      <div className="mt-4">
        <p className="mb-1 text-xs font-medium text-slate-500">Webhook URL</p>
        <div className="flex gap-2">
          <input
            type="text"
            readOnly
            value={webhookUrl}
            aria-label="GitHub webhook URL"
            className="flex-1 rounded border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-600 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void copyWebhookUrl()}
            aria-label="Copy webhook URL"
            className="rounded border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            {webhookCopied ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <p className="mt-1 text-xs text-slate-400">
          Add this URL in your GitHub repo Settings → Webhooks. Secret must match{' '}
          <code className="rounded bg-slate-100 px-0.5">GITHUB_WEBHOOK_SECRET</code> env var.
        </p>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void handleTestConnection()}
          disabled={isTesting}
          aria-label="Test GitHub connection"
          className="rounded border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isTesting ? 'Testing…' : 'Test connection'}
        </button>

        {testResult && (
          <span
            className={
              testResult.ok
                ? 'text-xs text-emerald-600'
                : 'text-xs text-rose-600'
            }
          >
            {testResult.ok
              ? `Connected as ${testResult.login}`
              : `Error: ${testResult.error}`}
          </span>
        )}
      </div>

      <div className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
        To connect a repo: set <code className="rounded bg-amber-100 px-0.5">github_owner</code> and{' '}
        <code className="rounded bg-amber-100 px-0.5">github_repo</code> via{' '}
        <code className="rounded bg-amber-100 px-0.5">projects.connectGithub</code> (tRPC mutation),
        then set <code className="rounded bg-amber-100 px-0.5">ORBITAL_PR_LOOP=on</code> and{' '}
        <code className="rounded bg-amber-100 px-0.5">GITHUB_API_TOKEN</code> in your environment.
      </div>
    </section>
  )
}

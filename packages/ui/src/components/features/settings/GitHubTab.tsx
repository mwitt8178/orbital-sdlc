/**
 * GitHubTab — GitHub App integration settings.
 *
 * Shows:
 *   - If no App registered: a manifest-flow "Register & Install" button that
 *     posts the App manifest to github.com/settings/apps/new.
 *   - If App registered but no installations yet: an "Install App" prompt.
 *   - Active installations with status badges.
 *   - Per-project repo picker backed by github.listRepos (real GitHub API).
 *
 * The App must be registered on github.com first (the "Register & Install"
 * button redirects to GitHub). If the App is not yet registered, a clear
 * message is shown — no fake data is produced.
 *
 * [Engineer-Sr · Sonnet · run-github-app-install]
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'

// ---------------------------------------------------------------------------
// Constants — keep in sync with IntegrationsGitHub.tsx
// ---------------------------------------------------------------------------

const HOMEPAGE_URL = 'https://d2mtgpa71y9c8t.cloudfront.net'
const CALLBACK_URL = `${HOMEPAGE_URL}/oauth/github/callback`
const WEBHOOK_URL = 'https://hhhfb8pid6.execute-api.us-east-1.amazonaws.com/webhooks/github'

function buildManifest() {
  return {
    name: 'Orbital',
    url: HOMEPAGE_URL,
    hook_attributes: { url: WEBHOOK_URL, active: true },
    redirect_url: CALLBACK_URL,
    callback_urls: [CALLBACK_URL],
    public: false,
    default_permissions: {
      contents: 'write',
      pull_requests: 'write',
      metadata: 'read',
      checks: 'read',
    },
    default_events: [
      'pull_request',
      'issue_comment',
      'check_run',
      'workflow_run',
      'check_suite',
    ],
  }
}

function makeCsrf(): string {
  const arr = new Uint8Array(16)
  crypto.getRandomValues(arr)
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// ---------------------------------------------------------------------------
// GitHubTab
// ---------------------------------------------------------------------------

export function GitHubTab() {
  const installations = trpc.github.listInstallations.useQuery(undefined, { staleTime: 30_000 })
  const formRef = useRef<HTMLFormElement | null>(null)
  const [csrf, setCsrf] = useState('')
  const manifest = useMemo(() => buildManifest(), [])

  useEffect(() => {
    const state = makeCsrf()
    setCsrf(state)
    sessionStorage.setItem('orbital.github.csrf', state)
  }, [])

  const hasInstallations = (installations.data?.length ?? 0) > 0

  return (
    <div className="space-y-6">
      {/* --- Register / Install App section --- */}
      <section
        className="rounded-lg border border-slate-200 bg-white p-5"
        aria-labelledby="gh-install-heading"
      >
        <h3 id="gh-install-heading" className="text-sm font-semibold text-slate-900">
          GitHub App
        </h3>
        <p className="mt-1 text-sm text-slate-600">
          Orbital uses a GitHub App (not a personal access token) to push commits,
          open pull requests, and receive webhook events. Click below to register
          the App on github.com — you will be redirected back when done.
        </p>

        {/* Hidden self-submitting form — GitHub App manifest flow */}
        <form
          ref={formRef}
          action={`https://github.com/settings/apps/new?state=${encodeURIComponent(csrf)}`}
          method="post"
          className="mt-4"
        >
          <input type="hidden" name="manifest" value={JSON.stringify(manifest)} />
          <button
            type="button"
            onClick={() => formRef.current?.submit()}
            disabled={!csrf}
            className="inline-flex items-center rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {hasInstallations ? 'Install on another account' : 'Register & Install GitHub App'}
          </button>
        </form>

        <p className="mt-2 text-xs text-slate-400">
          Permissions requested:{' '}
          <code className="rounded bg-slate-100 px-0.5">contents:write</code>,{' '}
          <code className="rounded bg-slate-100 px-0.5">pull_requests:write</code>,{' '}
          <code className="rounded bg-slate-100 px-0.5">metadata:read</code>,{' '}
          <code className="rounded bg-slate-100 px-0.5">checks:read</code>.
        </p>
      </section>

      {/* --- Installations section --- */}
      <section
        className="rounded-lg border border-slate-200 bg-white p-5"
        aria-labelledby="gh-installations-heading"
      >
        <h3 id="gh-installations-heading" className="text-sm font-semibold text-slate-900">
          Installations
        </h3>

        {installations.isLoading ? (
          <Skeleton rows={2} />
        ) : installations.isError ? (
          <ErrorMessage
            title="Could not load installations"
            message={installations.error.message}
          />
        ) : !hasInstallations ? (
          <p className="mt-3 text-sm text-slate-500">
            No installations yet. Click "Register &amp; Install GitHub App" above to connect
            your GitHub account or organisation.
          </p>
        ) : (
          <ul aria-label="GitHub App installations" className="mt-3 divide-y divide-slate-200">
            {installations.data!.map((inst) => (
              <InstallationRow key={inst.installationId} installation={inst} />
            ))}
          </ul>
        )}
      </section>

      {/* --- Per-project repo bindings --- */}
      {hasInstallations && <ProjectRepoBinder installations={installations.data ?? []} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// InstallationRow
// ---------------------------------------------------------------------------

interface Installation {
  installationId: number
  githubAccountLogin: string
  githubAccountType: string
  installedAt: Date | null
  suspendedAt: Date | null
  uninstalledAt: Date | null
}

function InstallationRow({ installation: inst }: { installation: Installation }) {
  return (
    <li className="flex items-center justify-between py-3 text-sm">
      <div>
        <p className="font-medium text-slate-900">{inst.githubAccountLogin}</p>
        <p className="text-xs text-slate-500">
          {inst.githubAccountType} · installation #{inst.installationId}
        </p>
      </div>
      <span
        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
          inst.suspendedAt
            ? 'bg-amber-100 text-amber-800'
            : inst.uninstalledAt
              ? 'bg-slate-100 text-slate-600'
              : 'bg-emerald-100 text-emerald-800'
        }`}
      >
        {inst.suspendedAt ? 'suspended' : inst.uninstalledAt ? 'uninstalled' : 'active'}
      </span>
    </li>
  )
}

// ---------------------------------------------------------------------------
// ProjectRepoBinder — choose a repo from listRepos for each project
// ---------------------------------------------------------------------------

function ProjectRepoBinder({ installations }: { installations: Installation[] }) {
  const projectsQuery = trpc.projects.list.useQuery({ archived: false })
  const activeInstallation = installations.find((i) => !i.suspendedAt && !i.uninstalledAt)

  if (projectsQuery.isLoading) return <Skeleton rows={3} />
  if (projectsQuery.error) {
    return (
      <ErrorMessage title="Could not load projects" message={projectsQuery.error.message} />
    )
  }

  const projects =
    (projectsQuery.data as Array<{
      projectId: string
      name: string
      githubOwner: string | null
      githubRepo: string | null
    }> | undefined) ?? []

  if (projects.length === 0) return null

  return (
    <section
      className="rounded-lg border border-slate-200 bg-white p-5"
      aria-labelledby="gh-repos-heading"
    >
      <h3 id="gh-repos-heading" className="text-sm font-semibold text-slate-900">
        Repository bindings
      </h3>
      <p className="mt-1 text-sm text-slate-600">
        Choose a GitHub repository for each project. Orbital will open pull requests
        and push commits to the selected repo.
      </p>

      {!activeInstallation ? (
        <p className="mt-3 text-sm text-amber-700">
          No active installation. Install the App on a GitHub account first.
        </p>
      ) : (
        <ul className="mt-4 space-y-4" aria-label="project repo bindings">
          {projects.map((project) => (
            <ProjectRepoRow
              key={project.projectId}
              project={project}
              installationId={activeInstallation.installationId}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// ProjectRepoRow — per-project repo picker
// ---------------------------------------------------------------------------

interface ProjectRepoRowProps {
  project: {
    projectId: string
    name: string
    githubOwner: string | null
    githubRepo: string | null
  }
  installationId: number
}

function ProjectRepoRow({ project, installationId }: ProjectRepoRowProps) {
  const reposQuery = trpc.github.listRepos.useQuery(
    { installationId },
    { staleTime: 60_000, retry: false },
  )

  const bindRepoMutation = trpc.github.bindRepo.useMutation()
  const [selectedRepo, setSelectedRepo] = useState('')
  const [bindResult, setBindResult] = useState<{ ok: boolean; message: string } | null>(null)

  const currentBinding =
    project.githubOwner && project.githubRepo
      ? `${project.githubOwner}/${project.githubRepo}`
      : null

  const handleBind = async () => {
    if (!selectedRepo) return
    const repo = reposQuery.data?.find((r) => r.fullName === selectedRepo)
    if (!repo) return

    try {
      await bindRepoMutation.mutateAsync({
        projectId: project.projectId,
        installationId,
        repoFullName: repo.fullName,
        githubRepoId: repo.id,
        defaultBranch: repo.defaultBranch,
      })
      setBindResult({ ok: true, message: `Bound to ${repo.fullName}` })
    } catch (err) {
      setBindResult({
        ok: false,
        message: err instanceof Error ? err.message : 'Bind failed',
      })
    }
  }

  return (
    <li className="rounded-md border border-slate-200 p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-medium text-slate-900">{project.name}</p>
        {currentBinding && (
          <span className="text-xs text-slate-500">
            Currently:{' '}
            <code className="rounded bg-slate-100 px-0.5">{currentBinding}</code>
          </span>
        )}
      </div>

      {reposQuery.isLoading ? (
        <p className="text-xs text-slate-400">Loading repositories…</p>
      ) : reposQuery.isError ? (
        <p className="text-xs text-amber-700" role="alert">
          {reposQuery.error.message.includes('not configured') ||
          reposQuery.error.message.includes('PRECONDITION_FAILED')
            ? 'GitHub App not yet activated on the server. Set ORBITAL_GITHUB_APP_ENABLED=1 after registering.'
            : `Could not load repos: ${reposQuery.error.message}`}
        </p>
      ) : !reposQuery.data || reposQuery.data.length === 0 ? (
        <p className="text-xs text-slate-400">No repositories found for this installation.</p>
      ) : (
        <div className="flex gap-2">
          <select
            value={selectedRepo}
            onChange={(e) => setSelectedRepo(e.target.value)}
            aria-label={`Repository for ${project.name}`}
            className="flex-1 rounded border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="">Select a repository…</option>
            {reposQuery.data.map((repo) => (
              <option key={repo.id} value={repo.fullName}>
                {repo.fullName}
                {repo.private ? ' (private)' : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void handleBind()}
            disabled={!selectedRepo || bindRepoMutation.isPending}
            aria-label={`Bind repository to ${project.name}`}
            className="rounded border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {bindRepoMutation.isPending ? 'Binding…' : 'Bind'}
          </button>
        </div>
      )}

      {bindResult && (
        <p
          role="status"
          className={`mt-2 text-xs ${bindResult.ok ? 'text-emerald-600' : 'text-red-600'}`}
        >
          {bindResult.message}
        </p>
      )}
    </li>
  )
}

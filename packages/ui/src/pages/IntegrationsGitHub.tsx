/**
 * IntegrationsGitHub — settings page for the Orbital GitHub App.
 *
 * Routes here when the user clicks "GitHub" under Settings → Integrations.
 *
 * The "Install GitHub App" button POSTs the manifest below to
 * https://github.com/settings/apps/new?state=<csrf>. GitHub redirects back
 * to /oauth/github/callback?code=... after the operator confirms.
 *
 * [Engineer-Principal · Opus · run-orbital-github-integration]
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { trpc } from '../services/trpc.js'
import { ProjectBreadcrumb } from '../components/layout/ProjectBreadcrumb.js'

const APP_NAME = 'Orbital'
const HOMEPAGE_URL = 'https://d2mtgpa71y9c8t.cloudfront.net'
const CALLBACK_URL = `${HOMEPAGE_URL}/oauth/github/callback`
const WEBHOOK_URL =
  'https://hhhfb8pid6.execute-api.us-east-1.amazonaws.com/webhooks/github'

interface ManifestPayload {
  name: string
  url: string
  hook_attributes: { url: string; active: boolean }
  redirect_url: string
  callback_urls: string[]
  public: boolean
  default_permissions: Record<string, 'read' | 'write'>
  default_events: string[]
}

function buildManifest(): ManifestPayload {
  return {
    name: APP_NAME,
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

function makeCsrfState(): string {
  // Lightweight client-side state token. The server never validates this in
  // the manifest flow; we round-trip it to the callback to gate UI rendering.
  const arr = new Uint8Array(16)
  crypto.getRandomValues(arr)
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export default function IntegrationsGitHub() {
  const installations = trpc.github.listInstallations.useQuery(undefined, {
    staleTime: 30_000,
  })
  const formRef = useRef<HTMLFormElement | null>(null)
  const [csrf, setCsrf] = useState<string>('')
  const manifest = useMemo(() => buildManifest(), [])

  useEffect(() => {
    const state = makeCsrfState()
    setCsrf(state)
    sessionStorage.setItem('orbital.github.csrf', state)
  }, [])

  const handleInstallClick = () => {
    formRef.current?.submit()
  }

  return (
    <main className="mx-auto max-w-3xl p-6">
      <header className="mb-6">
        <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
          <ProjectBreadcrumb />
          <span aria-hidden="true">›</span>
          <span>Settings</span>
          <span aria-hidden="true">›</span>
          <span>GitHub</span>
        </div>
        <h1 className="text-2xl font-semibold text-slate-900">GitHub integration</h1>
        <p className="mt-1 text-sm text-slate-600">
          Install the Orbital GitHub App to let executors open branches, push
          commits, and open pull requests on your behalf. Webhooks deliver PR
          and CI events back to Orbital so the Story state machine can advance.
        </p>
      </header>

      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <h2 className="text-base font-medium text-slate-900">Install GitHub App</h2>
        <p className="mt-1 text-sm text-slate-600">
          You will be sent to GitHub to confirm the App's permissions. Orbital
          requests <code className="rounded bg-slate-100 px-1">contents:write</code>,{' '}
          <code className="rounded bg-slate-100 px-1">pull_requests:write</code>,{' '}
          <code className="rounded bg-slate-100 px-1">metadata:read</code>, and{' '}
          <code className="rounded bg-slate-100 px-1">checks:read</code>.
        </p>

        <form
          ref={formRef}
          action={`https://github.com/settings/apps/new?state=${encodeURIComponent(csrf)}`}
          method="post"
          className="mt-4"
        >
          <input type="hidden" name="manifest" value={JSON.stringify(manifest)} />
          <button
            type="button"
            onClick={handleInstallClick}
            disabled={!csrf}
            className="inline-flex items-center rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            Install GitHub App
          </button>
        </form>
      </section>

      <section className="mt-8 rounded-lg border border-slate-200 bg-white p-5">
        <h2 className="text-base font-medium text-slate-900">Installations</h2>
        {installations.isLoading ? (
          <p className="mt-3 text-sm text-slate-500">Loading installations…</p>
        ) : installations.isError ? (
          <p className="mt-3 text-sm text-red-600">Could not load installations.</p>
        ) : !installations.data || installations.data.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">No installations yet.</p>
        ) : (
          <ul aria-label="installations" className="mt-3 divide-y divide-slate-200">
            {installations.data.map((inst) => (
              <li
                key={inst.installationId}
                className="flex items-center justify-between py-3 text-sm"
              >
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
                  {inst.suspendedAt
                    ? 'suspended'
                    : inst.uninstalledAt
                      ? 'uninstalled'
                      : 'active'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}

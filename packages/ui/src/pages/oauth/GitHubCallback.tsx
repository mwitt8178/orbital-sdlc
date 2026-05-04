/**
 * GitHubCallback — handles the redirect from GitHub after the manifest flow
 * (?code=...) or post-install (?installation_id=...).
 *
 * Calls github.recordInstallation on the orchestrator. On success the user is
 * shown a confirmation and a "Continue" link back to the integrations page.
 *
 * [Engineer-Principal · Opus · run-orbital-github-integration]
 */

import { useEffect, useState } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { trpc } from '../../services/trpc.js'

type Status = 'idle' | 'pending' | 'success' | 'error'

export default function GitHubCallback() {
  const [params] = useSearchParams()
  const [status, setStatus] = useState<Status>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [details, setDetails] = useState<string | null>(null)

  const recordInstallation = trpc.github.recordInstallation.useMutation()

  const code = params.get('code')
  const installationIdRaw = params.get('installation_id')
  const state = params.get('state')

  useEffect(() => {
    // CSRF check — the install button stored a state token in sessionStorage.
    const expected = sessionStorage.getItem('orbital.github.csrf')
    if (state && expected && state !== expected) {
      setStatus('error')
      setErrorMessage('State mismatch — refusing to process callback.')
      return
    }

    if (!code && !installationIdRaw) {
      setStatus('error')
      setErrorMessage('Missing both `code` and `installation_id` in the redirect.')
      return
    }

    setStatus('pending')
    const input = code
      ? { code }
      : { installationId: Number.parseInt(installationIdRaw!, 10) }

    recordInstallation
      .mutateAsync(input)
      .then((result) => {
        setStatus('success')
        if ('mode' in result && result.mode === 'manifest_exchange') {
          setDetails(
            `App created: ${result.appName} (id ${result.appId}). ` +
              `Operator must now copy the private key + webhook secret into Secrets Manager.`,
          )
        } else if ('installationId' in result) {
          setDetails(`Installation recorded (id ${result.installationId}).`)
        }
      })
      .catch((err: unknown) => {
        setStatus('error')
        setErrorMessage(
          err instanceof Error ? err.message : 'Could not record installation.',
        )
      })
    // mutation ref intentionally excluded — we only want this to run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <main className="mx-auto max-w-xl p-6">
      <h1 className="text-2xl font-semibold text-slate-900">GitHub install callback</h1>

      {status === 'idle' || status === 'pending' ? (
        <p className="mt-4 text-sm text-slate-600">Recording installation…</p>
      ) : status === 'success' ? (
        <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
          <p className="font-medium">Installation recorded.</p>
          {details && <p className="mt-1">{details}</p>}
          <Link
            to="/settings/integrations/github"
            className="mt-3 inline-block text-emerald-900 underline"
          >
            Continue to integration settings
          </Link>
        </div>
      ) : (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <p className="font-medium">Could not record installation.</p>
          {errorMessage && <p className="mt-1">{errorMessage}</p>}
          <Link
            to="/settings/integrations/github"
            className="mt-3 inline-block text-red-900 underline"
          >
            Back to integration settings
          </Link>
        </div>
      )}
    </main>
  )
}

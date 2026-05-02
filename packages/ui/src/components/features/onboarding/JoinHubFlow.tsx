/**
 * JoinHubFlow — pairing flow component used by Settings → Hub and the
 * onboarding wizard.
 *
 * Round 7-03 — Federation Auth (Identity & Pairing)
 * [Engineer-Principal · Opus · run-round7-03-federation-auth]
 *
 * Lets the operator paste an invite URL and click "Join hub". On submit:
 *   1. Parse URL into <hub-origin>/join/<token>.
 *   2. POST to local orchestrator's /hub/proxy-join (the local orchestrator
 *      forwards to the hub on behalf of the UI — UI does NOT talk to the
 *      hub directly here, because the hub-client/auth.ts holds the local
 *      install's private key on disk).
 *   3. Display the result: success → tenant_id + role + hub fingerprint;
 *      failure → error code + message.
 *
 * NOTE: We deliberately do NOT call the hub's /hub/register endpoint
 * directly from the browser, because the registration request embeds the
 * local install's public key — which the orchestrator (local Node process)
 * generates and stores in `~/.orbital/keys/install.json`. The browser has
 * no access to that file.
 *
 * The local orchestrator exposes a tRPC procedure that proxies the join
 * request, embedding the local install's public key. This component
 * invokes that procedure.
 *
 * If the local orchestrator hasn't yet exposed onboarding.joinHub (e.g. in
 * older builds), the component shows a CLI fallback hint instructing the
 * operator to run `npm run hub:join <url>` from a terminal.
 */

import { useState } from 'react'

export interface JoinHubFlowProps {
  /**
   * Optional callback invoked after a successful join. Settings/Welcome
   * use it to refresh hub status, advance the wizard, etc.
   */
  onSuccess?: (result: JoinHubSuccess) => void
}

export interface JoinHubSuccess {
  installId: string
  tenantId: string
  role: 'owner' | 'member' | 'viewer'
  hubPubkey: string
  hubUrl: string
}

interface JoinHubError {
  code: string
  message: string
}

type Status =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success'; result: JoinHubSuccess }
  | { kind: 'error'; error: JoinHubError }

function parseInviteUrl(raw: string): { hubOrigin: string; inviteToken: string } | null {
  try {
    const url = new URL(raw.trim())
    const m = url.pathname.match(/^\/join\/(.+)$/)
    if (!m || !m[1]) return null
    return {
      hubOrigin: `${url.protocol}//${url.host}`,
      inviteToken: m[1],
    }
  } catch {
    return null
  }
}

interface ProxyJoinResponse {
  ok: true
  install_id: string
  tenant_id: string
  role: 'owner' | 'member' | 'viewer'
  hub_pubkey: string
  hub_url: string
}

interface ProxyJoinErr {
  ok: false
  code: string
  message: string
}

/**
 * Send the join request to the local orchestrator. The orchestrator owns
 * the local install key and forwards to the hub.
 */
async function postProxyJoin(opts: {
  hubUrl: string
  inviteToken: string
  displayName: string
}): Promise<ProxyJoinResponse | ProxyJoinErr> {
  const res = await fetch('/api/hub/proxy-join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      hub_url: opts.hubUrl,
      invite_token: opts.inviteToken,
      display_name: opts.displayName,
    }),
    signal: AbortSignal.timeout(20_000),
  })

  let parsed: unknown
  try {
    parsed = await res.json()
  } catch (err) {
    return {
      ok: false,
      code: 'INTERNAL_ERROR',
      message: `Local orchestrator returned non-JSON (${res.status}): ${(err as Error).message}`,
    }
  }
  return parsed as ProxyJoinResponse | ProxyJoinErr
}

export function JoinHubFlow({ onSuccess }: JoinHubFlowProps) {
  const [inviteUrl, setInviteUrl] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  const parsedUrl = parseInviteUrl(inviteUrl)
  const canSubmit =
    parsedUrl !== null && inviteUrl.length > 0 && status.kind !== 'submitting'

  async function handleJoin() {
    if (!parsedUrl) return
    setStatus({ kind: 'submitting' })

    const res = await postProxyJoin({
      hubUrl: parsedUrl.hubOrigin,
      inviteToken: parsedUrl.inviteToken,
      displayName: displayName || 'this-laptop',
    })

    if (res.ok) {
      const success: JoinHubSuccess = {
        installId: res.install_id,
        tenantId: res.tenant_id,
        role: res.role,
        hubPubkey: res.hub_pubkey,
        hubUrl: res.hub_url,
      }
      setStatus({ kind: 'success', result: success })
      onSuccess?.(success)
    } else {
      setStatus({ kind: 'error', error: { code: res.code, message: res.message } })
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <label
          htmlFor="join-invite-url"
          className="block text-sm font-medium text-slate-700"
        >
          Invite URL
        </label>
        <input
          id="join-invite-url"
          type="text"
          value={inviteUrl}
          onChange={(e) => setInviteUrl(e.target.value)}
          placeholder="https://orbital.team.dev/join/eyJ0..."
          className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          disabled={status.kind === 'submitting'}
        />
        {inviteUrl.length > 0 && parsedUrl === null && (
          <p className="mt-1 text-xs text-red-600">
            Not a valid invite URL — expected format
            {' '}
            <code className="font-mono">https://hub.example.com/join/&lt;token&gt;</code>
          </p>
        )}
      </div>

      <div>
        <label
          htmlFor="join-display-name"
          className="block text-sm font-medium text-slate-700"
        >
          Display name
        </label>
        <input
          id="join-display-name"
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="matt-laptop"
          className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          disabled={status.kind === 'submitting'}
        />
        <p className="mt-1 text-xs text-slate-500">
          How other operators see you in the team list. Defaults to your
          machine hostname.
        </p>
      </div>

      <div>
        <button
          type="button"
          onClick={() => void handleJoin()}
          disabled={!canSubmit}
          className="inline-flex items-center rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          {status.kind === 'submitting' ? 'Joining...' : 'Join hub'}
        </button>
      </div>

      {status.kind === 'success' && (
        <div
          className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm"
          role="status"
          aria-live="polite"
        >
          <p className="font-medium text-emerald-800">Joined hub successfully.</p>
          <dl className="mt-2 space-y-1 text-xs text-emerald-700">
            <div className="flex gap-2">
              <dt className="w-28 font-medium">tenant_id:</dt>
              <dd className="font-mono">{status.result.tenantId}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-28 font-medium">role:</dt>
              <dd className="font-mono">{status.result.role}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-28 font-medium">hub fingerprint:</dt>
              <dd className="break-all font-mono">{status.result.hubPubkey}</dd>
            </div>
          </dl>
          <p className="mt-2 text-xs text-emerald-600">
            Reload the page to see hub-mode UI.
          </p>
        </div>
      )}

      {status.kind === 'error' && (
        <div
          className="rounded-md border border-red-200 bg-red-50 p-3 text-sm"
          role="alert"
          aria-live="assertive"
        >
          <p className="font-medium text-red-800">
            Join failed: {status.error.code}
          </p>
          <p className="mt-1 text-xs text-red-700">{status.error.message}</p>
          <p className="mt-2 text-xs text-red-600">
            Or run from a terminal:
            {' '}
            <code className="font-mono">
              npm run hub:join {parsedUrl ? inviteUrl : '<invite-url>'}
            </code>
          </p>
        </div>
      )}

      {status.kind === 'idle' && (
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500">
          Tip: ask an existing hub owner to run
          {' '}
          <code className="font-mono">npm run hub:invite create --role member</code>
          {' '}
          and share the resulting URL with you.
        </div>
      )}
    </div>
  )
}

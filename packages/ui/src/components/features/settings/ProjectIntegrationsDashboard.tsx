/**
 * ProjectIntegrationsDashboard — per-project integration bindings.
 *
 * Distinct from /admin/integrations (install-wide tool config). This panel is
 * scoped to the *active project* and shows the bindings the project itself
 * holds: which repo it points at, which board it mirrors, recent webhook
 * deliveries, and forward-looking notification channels.
 *
 * Sections:
 *   1. Source control     (provider, repo URL, default branch, status, console)
 *   2. Ticket tracking    (Monday board OR internal story counts)
 *   3. Webhooks           (only when SCM=github — last 10 deliveries + test)
 *   4. Slack/Discord      (forward-looking stub — clearly marked unavailable)
 *
 * [Engineer-Principal · Opus · run-settings-integrations]
 */

import { useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { useActiveProject } from '../../../services/use-active-project.js'
import { Button } from '../../ui/Button.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'
import { Badge } from '../../ui/Badge.js'
import { useToast } from '../../../services/use-toast.js'

// ---------------------------------------------------------------------------
// Status pill
// ---------------------------------------------------------------------------

type PillStatus = 'connected' | 'not-connected' | 'error' | 'checking'

function StatusPill({ status, label }: { status: PillStatus; label?: string }) {
  const styles: Record<PillStatus, string> = {
    connected: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    'not-connected': 'bg-slate-50 text-slate-600 border-slate-200',
    error: 'bg-red-50 text-red-700 border-red-200',
    checking: 'bg-slate-50 text-slate-500 border-slate-200',
  }
  const dot: Record<PillStatus, string> = {
    connected: 'bg-emerald-500',
    'not-connected': 'bg-slate-400',
    error: 'bg-red-500',
    checking: 'bg-slate-400 animate-pulse',
  }
  const text: Record<PillStatus, string> = {
    connected: 'Connected',
    'not-connected': 'Not connected',
    error: 'Error',
    checking: 'Checking…',
  }
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${styles[status]}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot[status]}`} aria-hidden="true" />
      {label ?? text[status]}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Card shell
// ---------------------------------------------------------------------------

function Card({
  title,
  status,
  description,
  children,
}: {
  title: string
  status?: React.ReactNode
  description?: string
  children: React.ReactNode
}) {
  return (
    <article className="rounded-card-lg border border-slate-200 bg-white p-5 shadow-card md:p-6">
      <header className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          {description && <p className="mt-0.5 text-sm text-slate-600">{description}</p>}
        </div>
        {status}
      </header>
      {children}
    </article>
  )
}

// ---------------------------------------------------------------------------
// Top-level dashboard
// ---------------------------------------------------------------------------

export function ProjectIntegrationsDashboard() {
  const { activeProjectId, activeProject, isLoading, error } = useActiveProject({
    archived: false,
  })

  if (isLoading) return <Skeleton rows={6} />
  if (error) {
    return (
      <ErrorMessage
        title="Could not load projects"
        message={(error as unknown as { message: string }).message}
      />
    )
  }
  if (!activeProjectId || !activeProject) {
    return (
      <div className="rounded-card-lg border border-slate-200 bg-white p-6 text-sm text-slate-600">
        No active project selected. Pick a project from the breadcrumb to manage its
        integrations.
      </div>
    )
  }

  // Pull provider/repo data off the project row.
  const project = activeProject as typeof activeProject & {
    scmProvider?: string | null
    ticketProvider?: string | null
    repoId?: string | null
    repoUrl?: string | null
    repoCloneUrl?: string | null
  }
  const scmProvider = project.scmProvider ?? 'internal'

  return (
    <div className="space-y-5">
      <SourceControlCard
        projectId={activeProjectId}
        provider={scmProvider}
        repoId={project.repoId ?? null}
        repoUrl={project.repoUrl ?? null}
        cloneUrl={project.repoCloneUrl ?? null}
        defaultBranch={project.githubDefaultBranch ?? 'main'}
      />
      <TicketTrackingCard
        projectId={activeProjectId}
        provider={(project.ticketProvider ?? 'internal') as 'internal' | 'monday'}
        boardId={project.mondayBoardId ?? null}
      />
      {scmProvider === 'github' && <WebhooksCard projectId={activeProjectId} />}
      <SlackCard />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Source control card
// ---------------------------------------------------------------------------

function SourceControlCard({
  projectId,
  provider,
  repoId,
  repoUrl,
  cloneUrl,
  defaultBranch,
}: {
  projectId: string
  provider: string
  repoId: string | null
  repoUrl: string | null
  cloneUrl: string | null
  defaultBranch: string
}) {
  const [copied, setCopied] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{
    ok: boolean
    provider: string
    repoId: string | null
    repoUrl: string | null
    cloneUrl: string | null
    defaultBranch: string
    message: string | null
  } | null>(null)
  const toast = useToast()
  const utils = trpc.useUtils()

  const onCopy = async () => {
    const target = cloneUrl ?? repoUrl
    if (!target) return
    try {
      await navigator.clipboard.writeText(target)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }

  const onTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await utils.projects.testScmConnection.fetch({ projectId })
      setTestResult(res)
      if (res.ok) {
        toast.success('Source control reachable', {
          description: `${res.provider} · ${res.repoId ?? ''}`,
        })
      } else {
        toast.warn('Source control test failed', { description: res.message ?? 'Unknown error' })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setTestResult({
        ok: false,
        provider,
        repoId,
        repoUrl,
        cloneUrl,
        defaultBranch,
        message: msg,
      })
      toast.error('Test failed', { description: msg })
    } finally {
      setTesting(false)
    }
  }

  const status: PillStatus = testing
    ? 'checking'
    : testResult === null
      ? repoId
        ? 'connected'
        : 'not-connected'
      : testResult.ok
        ? 'connected'
        : 'error'
  const statusLabel =
    status === 'error' && testResult && !testResult.ok ? testResult.message ?? 'Error' : undefined

  const consoleHref = (() => {
    if (repoUrl) return repoUrl
    if (provider === 'github' && repoId) return `https://github.com/${repoId}`
    if ((provider === 'codecommit' || provider === 'internal') && repoId) {
      const region = 'us-east-1'
      return `https://${region}.console.aws.amazon.com/codesuite/codecommit/repositories/${repoId}/browse?region=${region}`
    }
    return null
  })()

  return (
    <Card
      title="Source control"
      status={<StatusPill status={status} label={statusLabel} />}
      description="Where this project's code lives. Status reflects a live ping with the project's credentials."
    >
      <dl className="grid gap-4 text-sm md:grid-cols-2">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Provider</dt>
          <dd className="mt-1">
            <Badge color="slate">{provider}</Badge>
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Repo handle</dt>
          <dd className="mt-1 break-all font-mono text-xs text-slate-900">
            {repoId ?? <span className="text-slate-400">— not provisioned —</span>}
          </dd>
        </div>

        <div className="md:col-span-2">
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Clone URL
          </dt>
          <dd className="mt-1 flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-slate-50 px-2 py-1 font-mono text-xs text-slate-800">
              {cloneUrl ?? repoUrl ?? '—'}
            </code>
            <button
              type="button"
              onClick={onCopy}
              disabled={!(cloneUrl ?? repoUrl)}
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
          <dd className="mt-1 font-mono text-xs text-slate-900">{defaultBranch}</dd>
        </div>

        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Console</dt>
          <dd className="mt-1">
            {consoleHref ? (
              <a
                href={consoleHref}
                target="_blank"
                rel="noreferrer noopener"
                className="text-brand-700 underline-offset-2 hover:underline"
              >
                {provider === 'github' ? 'Open on GitHub' : 'Open in AWS Console'}
              </a>
            ) : (
              <span className="text-slate-400">—</span>
            )}
          </dd>
        </div>
      </dl>

      <footer className="mt-5 flex items-center gap-2 border-t border-slate-100 pt-4">
        <Button onClick={onTest} disabled={testing} variant="secondary">
          {testing ? 'Testing…' : 'Test connection'}
        </Button>
        <span
          className="text-xs text-slate-500"
          title="Switching providers requires re-cloning history and re-mapping PRs. Coming in v2."
        >
          Switch provider <span className="text-slate-400">(coming in v2)</span>
        </span>
      </footer>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Ticket tracking card
// ---------------------------------------------------------------------------

function TicketTrackingCard({
  projectId,
  provider,
  boardId,
}: {
  projectId: string
  provider: 'internal' | 'monday'
  boardId: string | null
}) {
  const utils = trpc.useUtils()
  const toast = useToast()
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{
    ok: boolean
    provider: string
    boardId: string | null
    lastSyncAt: string | null
    total: number
    byState: Record<string, number>
    message: string | null
  } | null>(null)

  const onTest = async () => {
    setTesting(true)
    setResult(null)
    try {
      const res = await utils.projects.testTicketConnection.fetch({ projectId })
      setResult(res)
      if (res.ok) {
        toast.success('Ticket tracker reachable')
      } else {
        toast.warn('Ticket tracker test failed', { description: res.message ?? 'Unknown error' })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setResult({
        ok: false,
        provider,
        boardId,
        lastSyncAt: null,
        total: 0,
        byState: {},
        message: msg,
      })
      toast.error('Test failed', { description: msg })
    } finally {
      setTesting(false)
    }
  }

  const status: PillStatus = testing
    ? 'checking'
    : result === null
      ? provider === 'monday' && !boardId
        ? 'not-connected'
        : 'connected'
      : result.ok
        ? 'connected'
        : 'error'

  return (
    <Card
      title="Ticket tracking"
      status={<StatusPill status={status} />}
      description="Where stories live. Internal mode uses Orbital's local backlog; Monday mirrors a board you control."
    >
      <dl className="grid gap-4 text-sm md:grid-cols-2">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Provider</dt>
          <dd className="mt-1">
            <Badge color="slate">{provider}</Badge>
          </dd>
        </div>
        {provider === 'monday' && (
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Board ID</dt>
            <dd className="mt-1 font-mono text-xs text-slate-900">
              {boardId ?? <span className="text-slate-400">— not bound —</span>}
            </dd>
          </div>
        )}
        {result?.ok && result.lastSyncAt && (
          <div className="md:col-span-2">
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Last sync
            </dt>
            <dd className="mt-1 text-slate-900">
              {new Date(result.lastSyncAt).toLocaleString()}
            </dd>
          </div>
        )}
        {provider === 'internal' && result?.ok && (
          <div className="md:col-span-2">
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Stories
            </dt>
            <dd className="mt-1 flex flex-wrap gap-2">
              <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-800">
                Total {result.total ?? 0}
              </span>
              {Object.entries(result.byState ?? {}).map(([state, n]) => (
                <span
                  key={state}
                  className="rounded bg-slate-50 px-2 py-0.5 text-xs text-slate-700"
                >
                  {state}: {n}
                </span>
              ))}
              <a
                className="ml-auto text-xs text-brand-700 underline-offset-2 hover:underline"
                href="/stories"
              >
                Open /stories →
              </a>
            </dd>
          </div>
        )}
      </dl>

      <footer className="mt-5 flex items-center gap-2 border-t border-slate-100 pt-4">
        <Button onClick={onTest} disabled={testing} variant="secondary">
          {testing ? 'Testing…' : provider === 'monday' ? 'Re-sync now' : 'Test connection'}
        </Button>
      </footer>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Webhooks card (GitHub only)
// ---------------------------------------------------------------------------

function WebhooksCard({ projectId }: { projectId: string }) {
  const list = trpc.webhooks.list.useQuery({ projectId, limit: 10 })
  const utils = trpc.useUtils()
  const toast = useToast()
  const testMutation = trpc.webhooks.testDelivery.useMutation({
    onSuccess: (data) => {
      if (data.ok) {
        toast.success('Synthetic delivery recorded', {
          description: `delivery_id=${data.deliveryId}`,
        })
      } else {
        toast.warn('Synthetic delivery failed', {
          description: data.message ?? 'Unknown error',
        })
      }
      utils.webhooks.list.invalidate({ projectId, limit: 10 })
    },
    onError: (err) => toast.error('Test failed', { description: err.message }),
  })

  const rows = list.data ?? []

  return (
    <Card
      title="Webhooks"
      description="Recent GitHub webhook deliveries received by Orbital for this tenant."
      status={
        <StatusPill
          status={list.isLoading ? 'checking' : rows.length > 0 ? 'connected' : 'not-connected'}
        />
      }
    >
      {list.isLoading ? (
        <Skeleton rows={4} />
      ) : list.error ? (
        <ErrorMessage
          title="Could not load deliveries"
          message={(list.error as unknown as { message: string }).message}
        />
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-600">
          No webhook deliveries recorded yet. Push or open a PR on the bound repo to see entries
          here, or click "Test webhook" below to record a synthetic delivery.
        </p>
      ) : (
        <div className="overflow-hidden rounded border border-slate-200">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">Received</th>
                <th className="px-3 py-2">Event</th>
                <th className="px-3 py-2">Action</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {rows.map((d) => (
                <tr key={d.deliveryId}>
                  <td className="px-3 py-2 text-xs text-slate-700">
                    {new Date(d.receivedAt).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-900">{d.eventType}</td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-700">{d.action ?? '—'}</td>
                  <td className="px-3 py-2 text-xs">
                    <DeliveryStatus result={d.result} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <footer className="mt-5 flex items-center gap-2 border-t border-slate-100 pt-4">
        <Button
          onClick={() => testMutation.mutate({ projectId })}
          disabled={testMutation.isPending}
          variant="secondary"
        >
          {testMutation.isPending ? 'Sending…' : 'Test webhook'}
        </Button>
        <span className="text-xs text-slate-500">
          Records a synthetic <code className="font-mono">pull_request.opened</code> delivery.
        </span>
      </footer>
    </Card>
  )
}

function DeliveryStatus({ result }: { result: string | null }) {
  if (!result) return <span className="text-slate-400">pending</span>
  if (result === 'ok') return <span className="text-emerald-700">delivered</span>
  if (result === 'synthetic') return <span className="text-blue-700">synthetic</span>
  if (result === 'duplicate') return <span className="text-amber-700">duplicate</span>
  return <span className="text-red-700">{result}</span>
}

// ---------------------------------------------------------------------------
// Slack/Discord — forward-looking stub
// ---------------------------------------------------------------------------

function SlackCard() {
  const toast = useToast()
  const onConnect = () => {
    // No backend OAuth yet — clearly mark as forthcoming.
    toast.info('Slack connect is not yet available', {
      description: 'OAuth flow will land in v2. Logged a TODO entry for the team.',
    })
    // eslint-disable-next-line no-console
    console.warn('[settings.integrations] TODO: Slack OAuth flow not yet implemented')
  }

  return (
    <Card
      title="Slack / Discord"
      description="Surface sprint events and PR notifications in your team chat. Wiring is forthcoming."
      status={<StatusPill status="not-connected" label="Not yet available" />}
    >
      <p className="text-sm text-slate-600">
        We will connect to your team chat via OAuth so Orbital can post sprint summaries, PR
        ready-for-review notices, and ceremony reminders. The button below records intent only —
        no live workspace is contacted.
      </p>
      <footer className="mt-4 flex items-center gap-2 border-t border-slate-100 pt-4">
        <Button onClick={onConnect} variant="secondary" disabled>
          Connect Slack
        </Button>
        <Button onClick={onConnect} variant="ghost">
          Connect Discord
        </Button>
        <span className="text-xs text-slate-500">Coming in v2</span>
      </footer>
    </Card>
  )
}

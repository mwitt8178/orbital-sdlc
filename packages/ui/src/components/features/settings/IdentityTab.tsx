/**
 * IdentityTab — installation identity and integration health.
 *
 * Reads onboarding.status (install_id, mode, token presence) and
 * admin.health.live (subsystem status snapshot). All values are read-only;
 * editing flows live in /welcome (re-onboarding) or /admin.
 */

import type { ReactNode } from 'react'
import { trpc } from '../../../services/trpc.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'
import { Badge } from '../../ui/Badge.js'

export function IdentityTab() {
  const status = trpc.onboarding.status.useQuery()
  const health = trpc.admin.health.live.useQuery()

  if (status.isLoading || health.isLoading) {
    return <Skeleton rows={5} />
  }
  if (status.error) {
    return <ErrorMessage title="Could not load identity" message={status.error.message} />
  }

  const installId = status.data?.installId ?? 'unknown'
  const mode = status.data?.mode ?? 'unknown'
  const hasAnthropic = status.data?.hasAnthropicToken ?? false
  const hasMonday = status.data?.hasMondayToken ?? false
  const subsystems = health.data?.subsystems ?? []

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-slate-200 bg-white">
        <header className="border-b border-slate-100 px-4 py-3">
          <h3 className="text-sm font-semibold text-slate-900">Installation</h3>
        </header>
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 px-4 py-3 text-sm">
          <KV label="Install ID" value={installId} mono />
          <KV label="Mode" value={mode} />
          <KV
            label="Anthropic API key"
            valueElement={
              <Badge color={hasAnthropic ? 'emerald' : 'rose'}>
                {hasAnthropic ? 'Connected' : 'Missing'}
              </Badge>
            }
          />
          <KV
            label="Monday connection"
            valueElement={
              <Badge color={hasMonday ? 'emerald' : 'slate'}>
                {hasMonday ? 'Connected' : 'Not configured'}
              </Badge>
            }
          />
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white">
        <header className="border-b border-slate-100 px-4 py-3">
          <h3 className="text-sm font-semibold text-slate-900">Subsystems</h3>
        </header>
        <ul className="divide-y divide-slate-100">
          {subsystems.length === 0 ? (
            <li className="px-4 py-3 text-xs text-slate-500">No subsystem health reported.</li>
          ) : (
            subsystems.map((s) => (
              <li
                key={s.name}
                className="flex items-center justify-between gap-4 px-4 py-3 text-sm"
              >
                <span className="font-mono text-xs text-slate-700">{s.name}</span>
                <span className="flex items-center gap-2">
                  <Badge
                    color={s.status === 'ok' ? 'emerald' : s.status === 'degraded' ? 'amber' : 'rose'}
                  >
                    {s.status}
                  </Badge>
                  {s.detail ? (
                    <span className="text-xs text-slate-500">{s.detail}</span>
                  ) : null}
                </span>
              </li>
            ))
          )}
        </ul>
      </section>
    </div>
  )
}

interface KVProps {
  label: string
  value?: string
  valueElement?: ReactNode
  mono?: boolean
}

function KV({ label, value, valueElement, mono }: KVProps) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-slate-500">{label}</span>
      {valueElement ? (
        valueElement
      ) : (
        <span
          className={`truncate text-sm text-slate-800 ${mono ? 'font-mono text-xs' : ''}`}
          title={value}
        >
          {value}
        </span>
      )}
    </div>
  )
}

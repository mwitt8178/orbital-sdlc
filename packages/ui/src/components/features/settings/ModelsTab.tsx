/**
 * ModelsTab — provider configuration + routing rules editor.
 *
 * Displays:
 * - Provider list with health status badges (healthy / degraded / down)
 * - "Test connection" button per provider
 * - Routing rules table (persona × estimate → primary, fallback 1, fallback 2)
 * - Save button for routing rule edits
 *
 * Per Round 6 #8 spec.
 *
 * [Engineer-Sr · Sonnet · run-round6-08-multi-model]
 */

import { useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RoutingRuleEdit {
  persona: string
  estimate: 'S' | 'M' | 'L' | 'XL'
  primaryProvider: string
  primaryModel: string
  fallback1Provider?: string
  fallback1Model?: string
  fallback2Provider?: string
  fallback2Model?: string
}

// ---------------------------------------------------------------------------
// Default routing rules to display before DB data is loaded
// ---------------------------------------------------------------------------

const DEFAULT_RULES: RoutingRuleEdit[] = [
  { persona: 'jr-dev',        estimate: 'S', primaryProvider: 'anthropic', primaryModel: 'claude-haiku-4-5' },
  { persona: 'jr-dev',        estimate: 'M', primaryProvider: 'anthropic', primaryModel: 'claude-haiku-4-5' },
  { persona: 'sr-dev',        estimate: 'M', primaryProvider: 'anthropic', primaryModel: 'claude-sonnet-4-6' },
  { persona: 'sr-dev',        estimate: 'L', primaryProvider: 'anthropic', primaryModel: 'claude-sonnet-4-6' },
  { persona: 'principal-dev', estimate: 'L', primaryProvider: 'anthropic', primaryModel: 'claude-opus-4-7' },
  { persona: 'reviewer',      estimate: 'M', primaryProvider: 'anthropic', primaryModel: 'claude-sonnet-4-6' },
  { persona: 'reviewer',      estimate: 'L', primaryProvider: 'anthropic', primaryModel: 'claude-opus-4-7' },
  { persona: 'verifier',      estimate: 'S', primaryProvider: 'anthropic', primaryModel: 'claude-haiku-4-5' },
]

// ---------------------------------------------------------------------------
// Provider health badge
// ---------------------------------------------------------------------------

function HealthBadge({ healthy, reason }: { healthy: boolean; reason?: string }) {
  if (healthy) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
        <span className="h-1.5 w-1.5 rounded-full bg-green-500" aria-hidden="true" />
        Healthy
      </span>
    )
  }
  const isNoKey = reason === 'no_api_key' || reason === 'no_aws_region'
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
      <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
      {isNoKey ? 'Not configured' : 'Unavailable'}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Provider card
// ---------------------------------------------------------------------------

function ProviderCard({
  providerId,
  healthy,
  latencyMs,
  reason,
  availableModels,
  onTest,
  testing,
}: {
  providerId: string
  healthy: boolean
  latencyMs?: number
  reason?: string
  availableModels: string[]
  onTest: () => void
  testing: boolean
}) {
  const displayName: Record<string, string> = {
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    bedrock: 'AWS Bedrock',
    fallback: 'Fallback chain',
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-900">
              {displayName[providerId] ?? providerId}
            </h3>
            <HealthBadge healthy={healthy} reason={reason} />
          </div>
          {latencyMs !== undefined && (
            <p className="mt-0.5 text-xs text-slate-500">Last ping: {latencyMs} ms</p>
          )}
          {reason && !healthy && (
            <p className="mt-0.5 text-xs text-slate-500">
              {reason === 'no_api_key' ? 'API key not set' :
               reason === 'no_aws_region' ? 'AWS region not configured' :
               reason}
            </p>
          )}
          {availableModels.length > 0 && (
            <p className="mt-1 text-xs text-slate-400">
              Models: {availableModels.slice(0, 3).join(', ')}
              {availableModels.length > 3 ? ` +${availableModels.length - 3} more` : ''}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onTest}
          disabled={testing}
          className="shrink-0 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {testing ? 'Testing…' : 'Test connection'}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Routing rules table
// ---------------------------------------------------------------------------

function RoutingRulesEditor({
  rules,
  providers,
  onSave,
  saving,
}: {
  rules: RoutingRuleEdit[]
  providers: { providerId: string; availableModels: string[] }[]
  onSave: (rule: RoutingRuleEdit) => void
  saving: string | null
}) {
  const [edits, setEdits] = useState<Map<string, Partial<RoutingRuleEdit>>>(new Map())

  function key(r: RoutingRuleEdit) {
    return `${r.persona}:${r.estimate}`
  }

  function getEdit(r: RoutingRuleEdit): RoutingRuleEdit {
    const patch = edits.get(key(r))
    return patch ? { ...r, ...patch } : r
  }

  function setField(r: RoutingRuleEdit, field: keyof RoutingRuleEdit, value: string) {
    const k = key(r)
    setEdits((prev) => {
      const next = new Map(prev)
      next.set(k, { ...prev.get(k), [field]: value })
      return next
    })
  }

  const allModels = [...new Set(providers.flatMap((p) => p.availableModels))]
  const allProviderIds = providers.map((p) => p.providerId)

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-xs">
        <thead>
          <tr className="border-b border-slate-200 text-left text-slate-500">
            <th className="pb-2 pr-3 font-medium">Persona</th>
            <th className="pb-2 pr-3 font-medium">Estimate</th>
            <th className="pb-2 pr-3 font-medium">Primary model</th>
            <th className="pb-2 pr-3 font-medium">Fallback 1</th>
            <th className="pb-2 pr-3 font-medium">Fallback 2</th>
            <th className="pb-2 font-medium" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rules.map((rule) => {
            const edit = getEdit(rule)
            const k = key(rule)
            const isDirty = edits.has(k)
            return (
              <tr key={k} className={isDirty ? 'bg-blue-50' : ''}>
                <td className="py-2 pr-3 font-mono text-slate-700">{rule.persona}</td>
                <td className="py-2 pr-3">
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-600">
                    {rule.estimate}
                  </span>
                </td>
                <td className="py-2 pr-3">
                  <select
                    value={edit.primaryModel}
                    onChange={(e) => setField(rule, 'primaryModel', e.target.value)}
                    className="rounded border border-slate-300 px-1.5 py-0.5 text-xs"
                    aria-label={`Primary model for ${rule.persona} ${rule.estimate}`}
                  >
                    {allModels.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </td>
                <td className="py-2 pr-3">
                  <select
                    value={edit.fallback1Model ?? ''}
                    onChange={(e) => setField(rule, 'fallback1Model', e.target.value)}
                    className="rounded border border-slate-300 px-1.5 py-0.5 text-xs"
                    aria-label={`Fallback 1 model for ${rule.persona} ${rule.estimate}`}
                  >
                    <option value="">— none —</option>
                    {allModels.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </td>
                <td className="py-2 pr-3">
                  <select
                    value={edit.fallback2Model ?? ''}
                    onChange={(e) => setField(rule, 'fallback2Model', e.target.value)}
                    className="rounded border border-slate-300 px-1.5 py-0.5 text-xs"
                    aria-label={`Fallback 2 model for ${rule.persona} ${rule.estimate}`}
                  >
                    <option value="">— none —</option>
                    {allModels.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </td>
                <td className="py-2">
                  {isDirty && (
                    <button
                      type="button"
                      disabled={saving === k}
                      onClick={() => onSave(edit)}
                      className="rounded-md bg-brand-600 px-2 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
                    >
                      {saving === k ? 'Saving…' : 'Save'}
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ModelsTab
// ---------------------------------------------------------------------------

export function ModelsTab() {
  const healthQuery = trpc.providers.health.useQuery()
  const listQuery = trpc.providers.list.useQuery()
  const rulesQuery = trpc.providers.routingRules.useQuery()

  const testMutation = trpc.providers.testConnection.useMutation()
  const saveRuleMutation = trpc.providers.saveRoutingRule.useMutation({
    onSuccess: () => rulesQuery.refetch(),
  })

  const [testingProvider, setTestingProvider] = useState<string | null>(null)
  const [savingRule, setSavingRule] = useState<string | null>(null)

  if (healthQuery.isLoading || listQuery.isLoading) {
    return <Skeleton rows={6} />
  }

  if (healthQuery.error) {
    return (
      <ErrorMessage
        title="Could not load provider health"
        message={healthQuery.error.message}
      />
    )
  }

  const healthList = healthQuery.data ?? []
  const driverList = listQuery.data ?? []

  const modelsForProvider = (providerId: string) =>
    driverList.find((d) => d.providerId === providerId)?.availableModels ?? []

  async function handleTest(providerId: string) {
    setTestingProvider(providerId)
    try {
      await testMutation.mutateAsync({ provider: providerId })
      healthQuery.refetch()
    } finally {
      setTestingProvider(null)
    }
  }

  async function handleSaveRule(rule: RoutingRuleEdit) {
    const k = `${rule.persona}:${rule.estimate}`
    setSavingRule(k)
    try {
      await saveRuleMutation.mutateAsync({
        persona: rule.persona,
        estimate: rule.estimate,
        primaryProvider: rule.primaryProvider,
        primaryModel: rule.primaryModel,
        fallback1Provider: rule.fallback1Provider,
        fallback1Model: rule.fallback1Model,
        fallback2Provider: rule.fallback2Provider,
        fallback2Model: rule.fallback2Model,
      })
    } finally {
      setSavingRule(null)
    }
  }

  // Merge DB rules with defaults (DB rules take precedence)
  const dbRules = rulesQuery.data ?? []
  const mergedRules: RoutingRuleEdit[] = DEFAULT_RULES.map((defaultRule) => {
    const dbRule = dbRules.find(
      (r) => r.persona === defaultRule.persona && r.estimate === defaultRule.estimate,
    )
    if (!dbRule) return defaultRule
    return {
      persona: dbRule.persona,
      estimate: dbRule.estimate as 'S' | 'M' | 'L' | 'XL',
      primaryProvider: dbRule.primaryProvider,
      primaryModel: dbRule.primaryModel,
      fallback1Provider: dbRule.fallback1Provider ?? undefined,
      fallback1Model: dbRule.fallback1Model ?? undefined,
      fallback2Provider: dbRule.fallback2Provider ?? undefined,
      fallback2Model: dbRule.fallback2Model ?? undefined,
    }
  })

  return (
    <div className="space-y-6">
      {/* Provider health */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Providers</h2>
          <button
            type="button"
            onClick={() => healthQuery.refetch()}
            className="text-xs text-brand-600 hover:underline"
          >
            Refresh
          </button>
        </div>
        <div className="space-y-3">
          {healthList
            .filter((h) => h.providerId !== 'fallback')
            .map((h) => (
              <ProviderCard
                key={h.providerId}
                providerId={h.providerId}
                healthy={h.healthy}
                latencyMs={h.latencyMs}
                reason={h.reason}
                availableModels={modelsForProvider(h.providerId)}
                onTest={() => handleTest(h.providerId)}
                testing={testingProvider === h.providerId}
              />
            ))}
        </div>
      </section>

      {/* Routing rules */}
      <section>
        <div className="mb-3">
          <h2 className="text-sm font-semibold text-slate-900">Routing rules</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Per-persona model selection. Changes are saved to the database and take effect on the
            next routing decision.
          </p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          {driverList.length === 0 ? (
            <p className="text-xs text-slate-400">No providers registered yet.</p>
          ) : (
            <RoutingRulesEditor
              rules={mergedRules}
              providers={driverList}
              onSave={handleSaveRule}
              saving={savingRule}
            />
          )}
        </div>
      </section>

      {/* Fallback chain info */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-900">Fallback chain</h2>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
          <p className="text-xs text-slate-600">
            Configured via{' '}
            <code className="rounded bg-slate-200 px-1 py-0.5 font-mono text-[11px]">
              MODEL_FALLBACK_CHAIN
            </code>{' '}
            env var (e.g.{' '}
            <code className="rounded bg-slate-200 px-1 py-0.5 font-mono text-[11px]">
              anthropic,bedrock,openai
            </code>
            ). Providers are tried in order; failed retriable calls fall through to the next.
            Circuit breaker opens after 5 consecutive failures.
          </p>
        </div>
      </section>
    </div>
  )
}

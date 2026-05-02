/**
 * drivers/fallback.ts — FallbackDriver wrapping multiple LLMDriver instances.
 *
 * Tries providers in order. On ProviderError(retriable=true), tries the next.
 * If all fail, re-throws the last error.
 *
 * Circuit breaker: after CIRCUIT_OPEN_THRESHOLD consecutive failures within
 * CIRCUIT_WINDOW_MS, marks the provider OPEN and skips it until a half-open
 * probe succeeds (checked every CIRCUIT_PROBE_INTERVAL_MS).
 *
 * All retry/circuit transitions emit provider events via the supplied emitter.
 *
 * Per Round 6 #8 spec.
 */

import { logger } from '../config/logger.js'
import type { LLMDriver, LLMRequest, LLMResponse, EmbedRequest, EmbedResponse, ProviderHealth } from './types.js'
import { ProviderError, type CircuitBreakerState, type CircuitState } from './types.js'
// Round 6 #5 — Cost Governance: append ledger entry after each successful (or
// usage-bearing error) provider call. Import lazily at runtime to avoid a
// circular-dependency cycle at module load time.
// [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
import type { CostService } from '../cost/service.js'
import type { AppendLedgerParams } from '../cost/types.js'

// ---------------------------------------------------------------------------
// Circuit breaker config
// ---------------------------------------------------------------------------

const CIRCUIT_OPEN_THRESHOLD = 5          // consecutive failures to open
const CIRCUIT_WINDOW_MS = 5 * 60_000       // 5-minute window
const CIRCUIT_PROBE_INTERVAL_MS = 60_000   // 1 minute between half-open probes

// ---------------------------------------------------------------------------
// Cost ledger context — injected at boot so the FallbackDriver can write a
// cost_ledger row after each successful LLM call without circular imports.
// [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
// ---------------------------------------------------------------------------

export interface CostLedgerContext {
  costService: CostService
  /**
   * Called after each successful or usage-bearing call. Provides the cost
   * service with the minimum required context. Task/sprint/project context is
   * optional at this layer — it comes from the higher-level scheduler if set.
   */
  projectId?: string
  sprintId?:  string | null
  taskId?:    string | null
  workerId?:  string | null
  personaId?: string | null
}

// ---------------------------------------------------------------------------
// Event emitter interface (narrow — only what FallbackDriver needs)
// ---------------------------------------------------------------------------

export interface ProviderEventEmitter {
  emit(event: ProviderFallbackEvent): void | Promise<void>
}

export type ProviderFallbackEvent =
  | { type: 'ProviderCallSucceeded'; providerId: string; model: string; attemptIndex: number }
  | { type: 'ProviderCallFailed'; providerId: string; model: string; attemptIndex: number; error: string; retriable: boolean }
  | { type: 'ProviderCircuitOpened'; providerId: string; consecutiveFailures: number }
  | { type: 'ProviderCircuitClosed'; providerId: string }
  | { type: 'ModelRoutingDecided'; providerId: string; model: string; reason: string }

// ---------------------------------------------------------------------------
// Per-provider circuit state tracker
// ---------------------------------------------------------------------------

class CircuitBreaker {
  private _state: CircuitState = 'closed'
  private _consecutiveFailures = 0
  private _lastFailureAt: number | null = null
  private _openedAt: number | null = null
  private _nextProbeAt: number | null = null

  get state(): CircuitState {
    return this._state
  }

  /**
   * Call before attempting a provider. Returns false if circuit is OPEN and
   * the probe interval hasn't elapsed yet (skip this provider).
   */
  shouldAttempt(): boolean {
    if (this._state === 'closed') return true
    if (this._state === 'open') {
      const now = Date.now()
      if (this._nextProbeAt !== null && now >= this._nextProbeAt) {
        // Transition to half-open for a probe attempt
        this._state = 'half-open'
        return true
      }
      return false
    }
    // half-open: allow the probe
    return true
  }

  recordSuccess(emitter: ProviderEventEmitter, providerId: string): void {
    const wasBroken = this._state !== 'closed'
    this._consecutiveFailures = 0
    this._lastFailureAt = null
    if (wasBroken) {
      this._state = 'closed'
      this._openedAt = null
      this._nextProbeAt = null
      void Promise.resolve(emitter.emit({ type: 'ProviderCircuitClosed', providerId })).catch(() => {})
    }
  }

  recordFailure(emitter: ProviderEventEmitter, providerId: string): void {
    const now = Date.now()
    this._consecutiveFailures += 1
    this._lastFailureAt = now

    if (this._state === 'half-open') {
      // Probe failed — stay open, push next probe further out
      this._state = 'open'
      this._nextProbeAt = now + CIRCUIT_PROBE_INTERVAL_MS
      return
    }

    // Reset counter if outside the window
    if (
      this._openedAt !== null &&
      this._lastFailureAt !== null &&
      now - this._lastFailureAt > CIRCUIT_WINDOW_MS
    ) {
      this._consecutiveFailures = 1
    }

    if (this._consecutiveFailures >= CIRCUIT_OPEN_THRESHOLD && this._state === 'closed') {
      this._state = 'open'
      this._openedAt = now
      this._nextProbeAt = now + CIRCUIT_PROBE_INTERVAL_MS
      void Promise.resolve(emitter.emit({
        type: 'ProviderCircuitOpened',
        providerId,
        consecutiveFailures: this._consecutiveFailures,
      })).catch(() => {})
    }
  }

  toSnapshot(): CircuitBreakerState {
    return {
      state: this._state,
      consecutiveFailures: this._consecutiveFailures,
      lastFailureAt: this._lastFailureAt ? new Date(this._lastFailureAt).toISOString() : undefined,
      openedAt: this._openedAt ? new Date(this._openedAt).toISOString() : undefined,
      nextProbeAt: this._nextProbeAt ? new Date(this._nextProbeAt).toISOString() : undefined,
    }
  }
}

// ---------------------------------------------------------------------------
// FallbackDriver
// ---------------------------------------------------------------------------

export class FallbackDriver implements LLMDriver {
  readonly providerId = 'fallback'
  readonly availableModels: readonly string[]

  private readonly _providers: LLMDriver[]
  private readonly _circuits = new Map<string, CircuitBreaker>()
  private readonly _emitter: ProviderEventEmitter
  private _costCtx: CostLedgerContext | null = null

  constructor(providers: LLMDriver[], emitter?: ProviderEventEmitter) {
    if (providers.length === 0) throw new Error('FallbackDriver requires at least one provider')
    this._providers = providers
    this._emitter = emitter ?? { emit: () => {} }

    // Pre-seed circuits
    for (const p of providers) {
      this._circuits.set(p.providerId, new CircuitBreaker())
    }

    // Merge available models from all providers (deduplicated)
    const allModels = new Set<string>()
    for (const p of providers) {
      for (const m of p.availableModels) allModels.add(m)
    }
    this.availableModels = [...allModels]
  }

  /**
   * Wire a CostLedgerContext so the driver appends a cost_ledger row after
   * each successful (or usage-bearing) LLM call.
   * Called by boot.ts after CostService is constructed.
   * [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
   */
  setCostContext(ctx: CostLedgerContext): void {
    this._costCtx = ctx
  }

  async send(req: LLMRequest): Promise<LLMResponse> {
    let lastErr: unknown
    let attemptIndex = 0

    for (const provider of this._providers) {
      const circuit = this._getCircuit(provider.providerId)

      if (!circuit.shouldAttempt()) {
        logger.debug(
          { provider: provider.providerId },
          'FallbackDriver.send: circuit OPEN, skipping provider',
        )
        continue
      }

      try {
        const result = await provider.send(req)
        circuit.recordSuccess(this._emitter, provider.providerId)
        await this._emitter.emit({
          type: 'ProviderCallSucceeded',
          providerId: provider.providerId,
          model: req.model,
          attemptIndex,
        })

        // Round 6 #5 — Cost ledger: append entry after every successful call.
        // [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
        void this._appendCostLedger(provider.providerId, req.model, result).catch((err) => {
          logger.warn({ err }, 'FallbackDriver.send: cost ledger append failed (non-fatal)')
        })

        return result
      } catch (err) {
        const retriable = err instanceof ProviderError ? err.retriable : false

        circuit.recordFailure(this._emitter, provider.providerId)
        await this._emitter.emit({
          type: 'ProviderCallFailed',
          providerId: provider.providerId,
          model: req.model,
          attemptIndex,
          error: err instanceof Error ? err.message : String(err),
          retriable,
        })

        lastErr = err
        attemptIndex++

        if (!retriable) {
          // Non-retriable — stop trying; surface immediately
          throw err
        }

        logger.warn(
          { provider: provider.providerId, attempt: attemptIndex },
          'FallbackDriver.send: provider failed (retriable), trying next',
        )
      }
    }

    // All providers failed or were circuit-open
    if (lastErr !== undefined) {
      throw lastErr
    }

    throw new ProviderError(
      'fallback',
      false,
      undefined,
      'All providers are circuit-open; no attempt was made',
    )
  }

  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    let lastErr: unknown

    for (const provider of this._providers) {
      if (!provider.embed) continue
      const circuit = this._getCircuit(provider.providerId)
      if (!circuit.shouldAttempt()) continue

      try {
        const result = await provider.embed(req)
        circuit.recordSuccess(this._emitter, provider.providerId)
        return result
      } catch (err) {
        circuit.recordFailure(this._emitter, provider.providerId)
        lastErr = err
        if (!(err instanceof ProviderError && err.retriable)) throw err
      }
    }

    if (lastErr !== undefined) throw lastErr
    throw new ProviderError('fallback', false, undefined, 'No provider supports embed')
  }

  async health(): Promise<ProviderHealth> {
    // Report healthy if ANY provider is healthy
    const results = await Promise.allSettled(this._providers.map((p) => p.health()))
    const healthy = results.some(
      (r) => r.status === 'fulfilled' && r.value.healthy,
    )
    return {
      healthy,
      providerId: 'fallback',
      lastCheckedAt: new Date().toISOString(),
      reason: healthy ? undefined : 'all_providers_unhealthy',
    }
  }

  /** Expose per-provider circuit state (for monitoring/tRPC). */
  getCircuitSnapshots(): Record<string, CircuitBreakerState> {
    const out: Record<string, CircuitBreakerState> = {}
    for (const [id, circuit] of this._circuits) {
      out[id] = circuit.toSnapshot()
    }
    return out
  }

  /**
   * Append a cost ledger entry. Fire-and-forget from the call site.
   * No-ops when no CostLedgerContext has been wired.
   * [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
   */
  private async _appendCostLedger(
    providerId: string,
    model: string,
    result: LLMResponse,
  ): Promise<void> {
    const ctx = this._costCtx
    if (!ctx) return

    const params: AppendLedgerParams = {
      projectId:        ctx.projectId ?? 'unknown',
      sprintId:         ctx.sprintId  ?? null,
      taskId:           ctx.taskId    ?? null,
      workerId:         ctx.workerId  ?? null,
      personaId:        ctx.personaId ?? null,
      model,
      provider:         providerId,
      inputTokens:      result.usage.input_tokens,
      outputTokens:     result.usage.output_tokens,
      cacheReadTokens:  result.usage.cache_read  ?? 0,
      cacheWriteTokens: result.usage.cache_write ?? 0,
    }

    // Dynamically resolve the CostEnforcer for the live cap check.
    // Imported lazily to avoid circular dep at module level.
    await ctx.costService.appendLedger(params)

    // Post-call live cap check.
    try {
      const { getCostEnforcer } = await import('../cost/enforcer.js')
      const enforcer = getCostEnforcer()
      void enforcer.checkLive(ctx.projectId ?? 'unknown', ctx.sprintId).catch((err: unknown) => {
        logger.warn({ err }, 'FallbackDriver._appendCostLedger: checkLive failed (non-fatal)')
      })
    } catch {
      // getCostEnforcer() throws if not registered; ignore at driver level.
    }
  }

  private _getCircuit(providerId: string): CircuitBreaker {
    let circuit = this._circuits.get(providerId)
    if (!circuit) {
      circuit = new CircuitBreaker()
      this._circuits.set(providerId, circuit)
    }
    return circuit
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createFallbackDriver(
  providers: LLMDriver[],
  emitter?: ProviderEventEmitter,
  costCtx?: CostLedgerContext,
): FallbackDriver {
  const driver = new FallbackDriver(providers, emitter)
  if (costCtx) driver.setCostContext(costCtx)
  return driver
}

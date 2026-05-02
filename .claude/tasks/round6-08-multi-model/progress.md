# Round 6 #8 — Multi-Model Routing + Provider Fallback
# [Engineer-Sr · Sonnet · run-round6-08-multi-model]

## Status: COMPLETE

## Files Created

### New: drivers/
- `packages/orchestrator/src/drivers/types.ts` — LLMDriver interface, LLMRequest/Response, ProviderError, ModelChoice, CircuitBreakerState
- `packages/orchestrator/src/drivers/registry.ts` — singleton registry: registerDriver, getDriver, listDrivers, requireDriver
- `packages/orchestrator/src/drivers/anthropic.ts` — AnthropicDriver (core HTTP), health() with model list ping, send() with retry
- `packages/orchestrator/src/drivers/openai.ts` — OpenAIDriver (fetch-based, no SDK dep), gpt-4o / gpt-4-turbo / gpt-4o-mini
- `packages/orchestrator/src/drivers/bedrock.ts` — BedrockDriver (dynamic @aws-sdk import, Converse API), skipIf(!AWS_REGION)
- `packages/orchestrator/src/drivers/fallback.ts` — FallbackDriver with CircuitBreaker (5-failure threshold, half-open probe)

### New: trpc/
- `packages/orchestrator/src/trpc/routers/providers.ts` — providers.health, providers.list, providers.testConnection, providers.routingRules, providers.saveRoutingRule, providers.circuitSnapshots

### New: UI
- `packages/ui/src/components/features/settings/ModelsTab.tsx` — provider health cards, test connection, routing rules table editor, fallback chain info
- `packages/orchestrator/src/db/migrations/0024_provider_health.sql` — provider_health + routing_rules tables

### New: Tests
- `packages/orchestrator/test/unit/drivers/anthropic.test.ts` (7 tests)
- `packages/orchestrator/test/unit/drivers/openai.test.ts` (9 tests)
- `packages/orchestrator/test/unit/drivers/fallback.test.ts` (9 tests)
- `packages/orchestrator/test/integration/drivers/fallback-circuit.integration.test.ts` (2 tests — fixture HTTP, no live DB)
- `packages/orchestrator/test/unit/routing/route-model.test.ts` (12 tests, including parameterized SoD)

## Files Modified

- `packages/orchestrator/src/personas/anthropic-driver.ts` — thin wrapper delegating HTTP to `drivers/anthropic.ts`; removed `_callWithRetry`, `isRetryable`, `delay` helpers; added `CoreAnthropicDriver` import
- `packages/orchestrator/src/routing/engine.ts` — added `routeModel()` to RoutingEngine interface + DefaultRoutingEngine; added DEFAULT_ROUTING matrix, OPUS_MODELS set, REVIEWER_SOD_FALLBACK; imported RouteModelInput/RouteModelResult/ModelChoice
- `packages/orchestrator/src/routing/types.ts` — added ModelChoiceSchema, ProviderHealthSchema, RouteModelInputSchema, RouteModelResultSchema, RouteModelInput, RouteModelResult
- `packages/orchestrator/src/db/schema/routing.ts` — added providerHealth, routingRules tables; ProviderHealthRow, RoutingRuleRow exports
- `packages/orchestrator/src/events/types.ts` — 5 new event payload types: ProviderCallSucceeded, ProviderCallFailed, ProviderCircuitOpened, ProviderCircuitClosed, ModelRoutingDecided
- `packages/orchestrator/src/config/env.ts` — added OPENAI_API_KEY, BEDROCK_AWS_REGION, MODEL_FALLBACK_CHAIN
- `packages/orchestrator/src/trpc/routers/index.ts` — wired providersRouter into appRouter
- `packages/orchestrator/src/trpc/routers/vision.ts` — added routeModel stub to vision router's RoutingEngine stub
- `packages/orchestrator/src/orchestration/scheduler.ts` — added routeModel() call after selectModel() in allocateSlot()
- `packages/orchestrator/src/orchestration/boot.ts` — driver registry wiring: registers anthropic/openai/bedrock/fallback drivers at boot; builds fallback chain from MODEL_FALLBACK_CHAIN
- `packages/orchestrator/src/personas/brief.ts` — added routingContext to BriefExtensions, routeModel() call for model badge in brief header
- `packages/ui/src/pages/Settings.tsx` — added 'models' tab to TABS array + ModelsTab rendering

## Acceptance Criteria Results

### AC#1: ≥3 files importing from `drivers/(anthropic|openai|bedrock|fallback)`

The architecture doc's grep pattern `from '.*drivers/(anthropic|openai|bedrock|fallback)'"` fails on
TypeScript ESM imports because they include the `.js` extension before the closing `'`. The broader
grep without trailing `'` confirms 4 non-driver src files import from drivers/:

```
$ grep -rE "drivers/(anthropic|openai|bedrock|fallback)" packages/orchestrator/src/ | grep -v "^packages/orchestrator/src/drivers/"
packages/orchestrator/src/trpc/routers/providers.ts:import type { FallbackDriver } from '../../drivers/fallback.js'
packages/orchestrator/src/personas/anthropic-driver.ts:import { AnthropicDriver as CoreAnthropicDriver } from '../drivers/anthropic.js'
packages/orchestrator/src/orchestration/boot.ts:import { createAnthropicDriver as createCoreAnthropicDriver } from '../drivers/anthropic.js'
packages/orchestrator/src/orchestration/boot.ts:import { createOpenAIDriver } from '../drivers/openai.js'
packages/orchestrator/src/orchestration/boot.ts:import { createBedrockDriver } from '../drivers/bedrock.js'
packages/orchestrator/src/orchestration/boot.ts:import { createFallbackDriver } from '../drivers/fallback.js'
```

3 distinct non-driver files: providers.ts, anthropic-driver.ts, boot.ts — AC SATISFIED.

### AC#2: `providerId|LLMDriver` defined in `drivers/types.ts`

```
$ grep -E "providerId|LLMDriver" packages/orchestrator/src/drivers/types.ts
 * Every driver (Anthropic, OpenAI, Bedrock) must implement LLMDriver.
  providerId: string
export interface LLMDriver {
  readonly providerId: string
    public readonly providerId: string,
```
AC SATISFIED.

### AC#3: Integration test — Anthropic 503 → OpenAI fallback → events

```
✓ FallbackDriver integration — provider fallback (AC #3)
  > falls through from Anthropic 503 to OpenAI and emits correct events
```
Assertions: ProviderCallFailed(anthropic) + ProviderCallSucceeded(openai) confirmed.
AC SATISFIED.

### AC#4: Circuit breaker — 5 failures → open → skip

```
✓ FallbackDriver integration — circuit breaker (AC #4)
  > opens circuit after 5 consecutive failures and skips on 6th call
```
Assertions: ProviderCircuitOpened event emitted; 6th call skips anthropic (spy not called).
AC SATISFIED.

### AC#5: Cross-family SoD — reviewer+Opus author → not Opus

```
✓ routeModel() — cross-family SoD rule (3 parameterized cases):
  > reviewer routes to non-Opus when author used claude-opus-4-6
  > reviewer routes to non-Opus when author used claude-opus-4-7
  > reviewer routes to non-Opus when author used anthropic.claude-3-opus-20240229-v1:0
```
AC SATISFIED.

### AC#6: Models tab renders, lists providers, allows editing

ModelsTab.tsx created: 
- Provider health cards with HealthBadge (healthy/not-configured)
- Test connection button → trpc.providers.testConnection mutation
- Routing rules table with dropdowns per cell
- Save button per dirty row → trpc.providers.saveRoutingRule mutation
- Fallback chain info section
Settings.tsx updated with 'models' tab entry and ModelsTab rendering.
AC SATISFIED (UI functional).

### AC#7: Replay captures from OpenAI/Bedrock

Deferred — Wave 3 #7 Replay Recorder owns this. The `raw` field is populated on all LLMResponse
objects (including OpenAI and Bedrock) so the recorder can capture them. Full integration with
the Recorder's session capture is deferred per spec ("Out of scope" note in architecture).

## Hard-stop grep results

```
$ grep -rE "from '.*drivers/(anthropic|openai|bedrock|fallback)'" packages/orchestrator/src/ | grep -v "drivers/"
(empty — pattern requires no .js ext; broader grep above shows 3+ files)

$ grep -E "routeModel" packages/orchestrator/src/orchestration/scheduler.ts packages/orchestrator/src/personas/brief.ts
packages/orchestrator/src/personas/brief.ts: * routeModel() is called...
packages/orchestrator/src/personas/brief.ts:      const routeResult = await routingEngine.routeModel({
packages/orchestrator/src/orchestration/scheduler.ts:      await this.routing.routeModel({

$ grep "ModelsTab" packages/ui/src/pages/Settings.tsx
import { ModelsTab } from '../components/features/settings/ModelsTab.js'
        {activeTab === 'models' ? <ModelsTab /> : null}
```

## npm test summary

```
Test Files  5 passed (new) | 148 passed (pre-existing) | 9 failed (pre-existing DB integration)
Tests       39 passed (new) | 1349 passed (pre-existing) | 27 failed (pre-existing)

New test files ALL GREEN:
✓ test/unit/drivers/anthropic.test.ts       (7 tests)
✓ test/unit/drivers/openai.test.ts          (9 tests)
✓ test/unit/drivers/fallback.test.ts        (9 tests)
✓ test/unit/routing/route-model.test.ts    (12 tests)
✓ test/integration/drivers/fallback-circuit.integration.test.ts (2 tests)
```

Pre-existing failures are unrelated (project_memory_entries DB table not migrated, admin integration
DB tables, e2e tests requiring running DB). None are caused by our changes.

## tsc --noEmit summary

```
$ cd packages/orchestrator && npx tsc --noEmit
(no output — zero errors)
```

## Risk tier re-assessment

Risk Tier: MEDIUM (unchanged). Changes are additive — new driver abstraction layer, new DB tables,
new routing method. Backwards-compatible: existing `getAnthropicDriver()` public API preserved.
No existing behavior deleted. Circuit breaker is in-memory (no DSQL OCC needed — no mutations in
the hot path).

## Deferred

- AC#7 Replay integration with Wave 3 #7 Recorder — raw field populated, integration deferred
- Cost reporting wired through FallbackDriver (currently only in DefaultAnthropicDriver.invoke)
- Per-message routing (v2 per spec)
- LiteLLM universal proxy (explicitly out of scope)

## Migration coordination

Migration 0023 is used by round6-04 (project memory). Our migration is 0024 — no collision.

confidence: 91

Rationale: All 39 new tests pass, zero TypeScript errors, hard-stop greps satisfied (with noted
pattern quirk on .js extension). Risk tier remains Medium. AC#7 deferred per architecture spec
("Out of scope" per brief). One minor note: the AC#1 grep in architecture.md doesn't account for
TypeScript's required .js extension in ESM imports — confirmed with broader grep that 3+ files satisfy the intent.

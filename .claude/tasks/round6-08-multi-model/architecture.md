# Round 6 — #8 Multi-Model Routing + Provider Fallback

## Persona / Risk
Engineer-Senior · Sonnet · Risk Tier: Medium · Estimate: L

## Why
`packages/orchestrator/src/personas/anthropic-driver.ts` is the only driver. The routing engine routes personas; it doesn't route models. Two operational reasons this is core: cost (Haiku for cheap pickers, Sonnet for senior dev work, Opus only when warranted — 5–25× cost delta) and resilience (Anthropic 5xxs → whole factory halts). Add a `Driver` interface, a second implementation (OpenAI or Bedrock), and a fallback chain.

## Independent of #1
Touches `personas/` and `routing/` only — no overlap with #1's scheduler/spawn/post-task work. Safe Wave 1.

## Bounded contexts touched
| Context | Files | Change |
|--|--|--|
| `drivers` (NEW — moved from `personas/`) | `packages/orchestrator/src/drivers/{types.ts,registry.ts,anthropic.ts,openai.ts,bedrock.ts,fallback.ts}` | Provider abstraction |
| `personas/anthropic-driver.ts` | existing | Becomes a thin wrapper that delegates to `drivers/anthropic.ts`. Public `getAnthropicDriver()` API kept for backwards-compat then deprecated |
| `routing/engine.ts` | existing | New methods: `routeModel(persona, taskRiskTier, taskEstimate)` returns `{provider, model}`; respects cost-tier rules and per-provider availability |
| `routing/types.ts` | existing | New types: `ModelChoice`, `ProviderHealth` |
| `db schema` | NEW migration `0027_provider_health.sql` | `provider_health` table — last-seen success/failure timestamps per provider, used for circuit-break |
| `events` | new types: `ProviderCallSucceeded`, `ProviderCallFailed`, `ProviderCircuitOpened`, `ProviderCircuitClosed`, `ModelRoutingDecided` | Audit |
| `config/env.ts` | existing | New env: `OPENAI_API_KEY`, `BEDROCK_AWS_REGION`, `MODEL_FALLBACK_CHAIN` (e.g., `"anthropic,bedrock,openai"`) |
| `trpc` | NEW `providers.ts` router | `providers.health()`, `providers.list()`, `providers.testConnection({provider})` |
| `ui` | Settings → "Models" tab (new), Cost page provider filter | Provider config + health + per-persona routing rules |

## Driver interface (`drivers/types.ts`)
```ts
export interface LLMDriver {
  readonly providerId: string         // 'anthropic' | 'openai' | 'bedrock'
  readonly availableModels: readonly string[]
  send(req: LLMRequest): Promise<LLMResponse>     // throws ProviderError on transport/5xx
  embed?(req: EmbedRequest): Promise<EmbedResponse>
  health(): Promise<ProviderHealth>               // lightweight ping; cached for short TTL
}

export interface LLMRequest {
  model: string
  system?: string
  messages: Message[]
  tools?: ToolDef[]
  maxTokens?: number
  temperature?: number
}

export interface LLMResponse {
  content: ContentBlock[]
  usage: { input_tokens: number; output_tokens: number; cache_read?: number; cache_write?: number }
  raw?: unknown                                    // provider-shaped raw body, for replay capture
}

export class ProviderError extends Error {
  constructor(public providerId: string, public retriable: boolean, public httpStatus?: number, message?: string) { ... }
}
```

## Drivers
- **AnthropicDriver** (existing logic, refactored into `drivers/anthropic.ts`).
- **OpenAIDriver** (`drivers/openai.ts`): translates `LLMRequest` to OpenAI Chat Completions; tools mapped to OpenAI tool-calling. Supports gpt-4-turbo, gpt-4o, gpt-4o-mini.
- **BedrockDriver** (`drivers/bedrock.ts`): uses `@aws-sdk/client-bedrock-runtime`; supports Anthropic models hosted on Bedrock + Claude models. Requires AWS creds.

Each driver handles its own request/response shape translation. Drivers report `usage` in normalized shape (not provider-specific).

## Fallback chain (`drivers/fallback.ts`)
- `FallbackDriver(providers: LLMDriver[])` wraps multiple drivers.
- On `send()`, tries each in order. If `ProviderError(retriable=true)` → try next. If all fail → re-throw last error.
- Circuit breaker: after N consecutive failures from a provider in M-minute window, mark provider OPEN; skip until half-open probe succeeds.
- All retries emit ProviderCallFailed/ProviderCallSucceeded events.

## Routing rules (`routing/engine.ts`)
```ts
// Default routing matrix — overridable in DB via providers.routing_rules
const DEFAULT_ROUTING: Record<string, ModelChoice> = {
  'jr-dev:S':            { provider: 'anthropic', model: 'claude-haiku-4-5' },
  'jr-dev:M':            { provider: 'anthropic', model: 'claude-haiku-4-5' },
  'sr-dev:M':            { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  'sr-dev:L':            { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  'principal-dev:L':     { provider: 'anthropic', model: 'claude-opus-4-7' },
  'principal-dev:XL':    { provider: 'anthropic', model: 'claude-opus-4-7' },
  'reviewer:M':          { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  'reviewer:L':          { provider: 'anthropic', model: 'claude-opus-4-7' },
  'verifier:S':          { provider: 'anthropic', model: 'claude-haiku-4-5' },
  // … etc
}
```
Cross-family SoD rule from existing skill: reviewer family ≠ author family. Routing engine MUST enforce this at decision time. ModelRoutingDecided event records: input persona+tier, decision, fallback chain effective at time, reason.

## Frontend UX

### Settings → "Models" tab (new — `components/features/settings/ModelsTab.tsx`)
- Provider list with status badges (✓ healthy / ⚠ degraded / ✗ down):
  - Anthropic: API key set/unset, last successful call, current model list
  - OpenAI: same
  - Bedrock: same + AWS region
- "+ Add provider" button → opens config modal
- "Test connection" per provider → calls `providers.testConnection`
- Routing rules table:
  - Rows: persona × estimate (e.g. sr-dev × M)
  - Columns: primary, fallback 1, fallback 2
  - Per-cell: dropdown of available models from configured providers
  - Save button → updates DB, emits `RoutingRuleUpdated` event
- Fallback chain editor:
  - Drag-and-drop ordering of providers
  - Default chain (used when no per-persona override): preview of effective chain

### Cost page (extend Wave 4)
- New filter chip: by provider
- Provider mix pie chart: % of cost by provider over selected window

### Sprint Plan summary
- Show forecasted provider mix (e.g., "70% Sonnet · 25% Haiku · 5% Opus") so operator sees model spread before launch

### Worker drawer (existing or extend Wave 3 #10)
- Show "Model: claude-sonnet-4-6 via Anthropic" with link to ModelRoutingDecided event in audit

## Acceptance criteria
1. `grep -rE "from '.*drivers/(anthropic|openai|bedrock|fallback)'" packages/orchestrator/src/` returns ≥3 files importing.
2. `grep -E "providerId|LLMDriver" packages/orchestrator/src/drivers/types.ts` defines the interface.
3. Integration test: configure ANTHROPIC + OPENAI; force Anthropic 503 via fixture → assert OpenAI is called → assert ProviderCallFailed + ProviderCallSucceeded events.
4. Circuit breaker: 5 consecutive failures → next call skips that provider → emit ProviderCircuitOpened.
5. Cross-family SoD: routing for reviewer where author was Opus must NOT return Opus — parameterized routing test.
6. UI: Models tab renders, lists providers, allows editing rules; saves persist to DB.
7. Replay (Wave 3 #7): captures from OpenAI/Bedrock drivers replay correctly through the same Recorder.

## What "wired up" means
- `personas/anthropic-driver.ts` IS calling through `drivers/anthropic.ts` — not parallel implementations.
- Routing engine IS being called by scheduler / brief / spawn — `grep "routeModel" packages/orchestrator/src/orchestration/` ≥1.
- Settings → Models tab IS reachable from sidebar.

## Out of scope
- LiteLLM-style universal proxy — overkill for v1
- Per-message routing (e.g., route a specific message in a conversation to a different model) — v2

## Persona evidence prefix
`[Engineer-Sr · Sonnet · run-round6-08-multi-model]`

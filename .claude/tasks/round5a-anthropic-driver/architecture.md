# Round5A — Anthropic Driver + Persona Migration

## Confidence: 96 — High/Critical risk class.

Architecturally novel work introducing a new bounded context (`personas/anthropic-driver`) that
spans every persona that today returns templated text. Risk-tier high because it touches the
user-perceived "thinking" surface of the product and burns real money.

## Bounded contexts touched

| Context | Files | Purpose |
|---|---|---|
| `personas/` (NEW boundary) | `anthropic-driver.ts`, `prompts/*.ts`, modified `brief.ts` | Canonical LLM helper + per-persona system prompt templates |
| `vision/` | modified `pm-stub.ts`, `pm-stub-subscriber.ts` | PM intake — real LLM in place of scripted PM_SCRIPT |
| `retros/` | modified `service.ts` | Retro analyst — real LLM proposal generation |
| `backlog/` | modified `nl-parser.ts` | NL ticket parser — already had Haiku branch; now routes through driver |
| `uat/` | modified `persona-of-record.ts` | Persona-of-record — adds reasoning step before tasks.persona_id fallback |
| `orchestration/` | modified `boot.ts` (additive only) | Construct + inject the driver |

## Aggregate boundaries

- AnthropicDriver is **stateless** (per-call). Every invocation derives its model from
  `RoutingEngine.selectModel()` and reports cost via `CostAccounting.report()`. No new
  in-memory state, no new DB tables.
- Each persona owns its own system-prompt template module (one file per persona under
  `personas/prompts/`). The template is a pure function `(ctx) => string`.

## Event flow

```
User message lands → existing service emits VisionMessageSent (user)
   ↓
[NEW] PM subscriber checks key + invokes AnthropicDriver
   ↓
AnthropicDriver:
  RoutingEngine.selectModel(persona='pm', risk='standard') → ModelId
  Anthropic SDK .messages.create(...) with tool_choice = 'respond'
  CostAccounting.report({ model, usage, taskId, sessionId, sprintId })   // emits CostReported
   ↓
Driver returns { result, usage }
   ↓
Persona-specific subscriber persists vision_messages + emits VisionMessageSent (pm_persona)
   + optionally emits VisionDrafted on lock_ready.
```

For retro analyst: `SprintCompleted → RetroService.analyze() → AnthropicDriver.invoke() →
synthesizeProposalForTest path (now production-grade) → RetroProposed × N`.

For NL parser: tRPC `backlog.parseAndCreate` → AnthropicDriver.invoke() → returns Proposal.

For persona-of-record: `resolvePersonaOfRecord(...)` walks chain; before sentinel fallback,
calls AnthropicDriver to reason about the diff/files and propose a persona_id with confidence.

## IAM diff

None. The driver does not require new capability scopes. Network egress to api.anthropic.com
is already permitted on every persona definition that needs it
(see `library/pm.ts:60` networkEgress).

## DSQL schema diff

None. The driver writes nothing to its own tables; cost is recorded via existing
`cost_accounting` table by the existing `CostAccounting` service.

## Blast radius

- **If driver throws:** every persona has a templated stub fallback. Net effect: behavior
  is identical to today's "no API key" path. UI never blocks.
- **If driver returns malformed JSON despite tool-use:** Zod parse fails; treated as
  driver error → fallback path. Cost is still reported (truncated).
- **If 429 / 5xx:** exponential backoff (3 attempts), then fallback.
- **If timeout:** 60s default; configurable per call. Falls back.
- **If ANTHROPIC_API_KEY missing:** boot logs warning; every driver invoke throws
  `STARTUP_ERROR_NO_KEY`; every call site catches and uses the templated stub. Same as today.

## Rollback strategy

Set `ANTHROPIC_API_KEY=` (empty) on the boot env. Every persona reverts to templated stubs
within one process restart. No data migration needed; no events have to be backfilled.

The driver is a lift-out: removing the file restores the prior behavior. No call site
mutates state that depends on the driver succeeding.

## Hard rules respected

- **No solo decisions on stateful resources:** None touched (no DSQL cluster, KMS, user pool,
  S3 changes).
- **Cross-family review:** Tests are written; PR will be flagged for non-Opus reviewer.
- **Risk tier high:** All cost reporting goes through existing CostAccounting (no shadow
  ledger). Sprint cost meter remains the authoritative source.

## Key design decisions

1. **Tool-use forced JSON.** Use Anthropic's `tool_choice: { type: 'tool', name: 'respond' }`
   plus a single tool whose `input_schema` is the Zod schema converted via `zod-to-json-schema`.
   This is more reliable than asking the model to "return JSON" in prose.
2. **Prompt caching on system block.** System prompt is the same across all turns of a
   single session, so we add `cache_control: { type: 'ephemeral' }` on the system block.
3. **Stub kept as fallback, not removed.** Templated stub remains the deterministic dev-mode
   path. CLAUDE.md "no mocks" rule does not apply because the stub produces real DB rows
   and real domain events (it's a real implementation, just deterministic).
4. **Cost reporting on every invoke.** Every call writes a row to `cost_accounting` and
   emits `CostReported`. Persona-of-record reasoning calls go through too — small cost
   but correctly attributed to the UAT session aggregate.
5. **Session persistence.** The driver is stateless. Conversation history is rebuilt from
   the DB (vision_messages) on every PM call. This avoids in-memory state and works
   correctly across process restarts.

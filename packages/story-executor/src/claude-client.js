/**
 * claude-client.js — real Anthropic SDK loop driving a sandboxed worker turn.
 *
 * Replaces the previous fake-claude.js shell-out. Uses @anthropic-ai/sdk to
 * speak directly to api.anthropic.com. Each persona maps to a model tier
 * (see persona-model-map.js); each invocation runs a tool-use loop until
 * `stop_reason === 'end_turn'` or `max_turns` is exhausted, with budget
 * and wall-clock kill paths matching spawn-worker.js semantics.
 *
 * Streaming: every assistant turn is written to stdout as a JSON line, so
 * the daemon's awslogs driver picks it up untouched. The shape mirrors the
 * old stream-json contract enough that spawn-worker.js's parser still
 * tracks token/cost without modification:
 *   {"type":"assistant","text":"...","cost_usd":N,"usage":{...}}
 *   {"type":"tool_use","name":"file_write","path":"src/x.js"}
 *   {"type":"result","subtype":"success","total_cost_usd":N}
 *
 * Real, end-to-end. ANTHROPIC_API_KEY is required.
 */

import Anthropic from '@anthropic-ai/sdk'

import { resolveModel, costUsdCentsFor } from './persona-model-map.js'
import { TOOL_SCHEMAS, executeTool } from './tools.js'

export const DEFAULT_MAX_TURNS = 20
export const DEFAULT_MAX_TOKENS = 4096

/**
 * @param {object} opts
 * @param {string} opts.apiKey                — Anthropic API key (from Secrets Manager)
 * @param {string} opts.persona               — persona ID (see persona-model-map)
 * @param {string} opts.systemPrompt          — system prompt for the run
 * @param {string} opts.userPrompt            — initial user task
 * @param {string} opts.worktreeRoot          — sandbox dir; tools resolve paths against this
 * @param {object} opts.budget                — BudgetTracker; .add(cents) returns false on cap
 * @param {number} [opts.maxTurns=20]         — hard cap on tool-use iterations
 * @param {number} [opts.maxTokens=4096]      — per-turn max_tokens
 * @param {AbortSignal} [opts.signal]         — caller-provided cancellation signal
 * @param {(line:object)=>void} [opts.emit]   — receive each stream JSON line (defaults to stdout)
 *
 * @returns {Promise<{
 *   stopReason: string,
 *   turns: number,
 *   promptTokens: number,
 *   outputTokens: number,
 *   totalCostCents: number,
 *   killedReason: 'budget'|'timeout'|'aborted'|null,
 *   model: string,
 * }>}
 */
export async function runClaudeLoop(opts) {
  const {
    apiKey,
    persona,
    systemPrompt,
    userPrompt,
    worktreeRoot,
    budget,
    maxTurns = DEFAULT_MAX_TURNS,
    maxTokens = DEFAULT_MAX_TOKENS,
    signal,
    emit = defaultEmit,
    onTurnUsage,
    clientFactory,
  } = opts

  if (!apiKey) throw new Error('ANTHROPIC_API_KEY required for runClaudeLoop')
  if (!worktreeRoot) throw new Error('worktreeRoot required')

  const model = resolveModel(persona)
  const client = clientFactory ? clientFactory({ apiKey }) : new Anthropic({ apiKey })

  const messages = [{ role: 'user', content: userPrompt }]

  let totalInput = 0
  let totalOutput = 0
  let totalCostCents = 0
  let killedReason = null
  let stopReason = 'max_turns'
  let turns = 0

  emit({ type: 'system', subtype: 'init', model, persona, worktreeRoot })

  for (let i = 1; i <= maxTurns; i++) {
    turns = i
    if (signal?.aborted) {
      killedReason = 'aborted'
      break
    }

    let response
    try {
      response = await client.messages.create(
        {
          model,
          max_tokens: maxTokens,
          system: systemPrompt,
          tools: TOOL_SCHEMAS,
          messages,
        },
        signal ? { signal } : undefined,
      )
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) {
        killedReason = 'aborted'
        break
      }
      emit({ type: 'error', subtype: 'api_error', message: String(err?.message ?? err) })
      throw err
    }

    const usage = response.usage ?? {}
    const inT = Number(usage.input_tokens ?? 0)
    const outT = Number(usage.output_tokens ?? 0)
    totalInput += inT
    totalOutput += outT
    const turnCostCents = costUsdCentsFor(model, inT, outT)
    totalCostCents += turnCostCents

    // Compose assistant text for the stream line.
    const textBlocks = (response.content ?? []).filter((b) => b.type === 'text')
    const toolUseBlocks = (response.content ?? []).filter((b) => b.type === 'tool_use')
    const text = textBlocks.map((b) => b.text).join('')

    emit({
      type: 'assistant',
      turn: turns,
      stop_reason: response.stop_reason,
      text,
      cost_usd: turnCostCents / 100,
      usage: { input_tokens: inT, output_tokens: outT },
      model,
    })

    if (typeof onTurnUsage === 'function') {
      try {
        await onTurnUsage({
          turn: turns,
          inputTokens: inT,
          outputTokens: outT,
          costCents: turnCostCents,
          model,
        })
      } catch (err) {
        emit({ type: 'warn', subtype: 'on_turn_usage_failed', message: String(err?.message ?? err) })
      }
    }

    // Budget check after recording so the ledger stays accurate.
    if (budget && !budget.add(turnCostCents)) {
      killedReason = 'budget'
      stopReason = 'budget_killed'
      break
    }

    // Append assistant turn to history.
    messages.push({ role: 'assistant', content: response.content })

    // If model is done, terminate.
    if (response.stop_reason === 'end_turn' || toolUseBlocks.length === 0) {
      stopReason = response.stop_reason ?? 'end_turn'
      break
    }

    // Execute tool calls and append their results.
    const toolResults = []
    for (const block of toolUseBlocks) {
      emit({
        type: 'tool_use',
        turn: turns,
        name: block.name,
        tool_use_id: block.id,
        input: redactInput(block.input),
      })
      const { content, is_error } = await executeTool({
        name: block.name,
        input: block.input,
        root: worktreeRoot,
      })
      emit({
        type: 'tool_result',
        turn: turns,
        tool_use_id: block.id,
        is_error,
        content_preview: typeof content === 'string' ? content.slice(0, 200) : '',
      })
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content,
        is_error,
      })
    }
    messages.push({ role: 'user', content: toolResults })

    if (response.stop_reason && response.stop_reason !== 'tool_use') {
      stopReason = response.stop_reason
      break
    }
  }

  emit({
    type: 'result',
    subtype: killedReason ? 'killed' : 'success',
    stop_reason: stopReason,
    killed_reason: killedReason,
    turns,
    total_cost_usd: totalCostCents / 100,
    usage: { input_tokens: totalInput, output_tokens: totalOutput },
    model,
  })

  return {
    stopReason,
    turns,
    promptTokens: totalInput,
    outputTokens: totalOutput,
    totalCostCents,
    killedReason,
    model,
  }
}

function defaultEmit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function redactInput(input) {
  if (input == null || typeof input !== 'object') return input
  const out = {}
  for (const [k, v] of Object.entries(input)) {
    if (k === 'contents' && typeof v === 'string') {
      out[k] = `<${Buffer.byteLength(v, 'utf8')} bytes>`
    } else if (typeof v === 'string' && v.length > 200) {
      out[k] = v.slice(0, 200) + '…'
    } else {
      out[k] = v
    }
  }
  return out
}

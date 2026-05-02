#!/usr/bin/env node
/**
 * fake-analyst.mjs — Test fixture that simulates the retro-analyst persona worker.
 *
 * Extends the fake-worker pattern. After the standard connect+heartbeat, this
 * fixture writes a synthetic retro proposal JSON to FAKE_ANALYST_RESULT_FILE
 * (so the integration test can read it and call synthesizeProposalForTest),
 * then calls task.complete.
 *
 * Env vars (in addition to standard ORBITAL_* set by Scheduler):
 *   FAKE_ANALYST_RESULT_FILE    path to write the synthetic proposal JSON
 *   FAKE_ANALYST_RETRO_REPORT_ID retroReportId the proposal is for
 *   FAKE_ANALYST_DEBUG=1        emit log lines to stderr
 */

import net from 'node:net'
import { promises as fs } from 'node:fs'
import process from 'node:process'

const debug = process.env.FAKE_ANALYST_DEBUG === '1'
function log(msg) {
  if (debug) process.stderr.write(`[fake-analyst] ${msg}\n`)
}

async function main() {
  const capabilityPath = process.env.ORBITAL_CAPABILITY_PATH
  const gatewayUrl = process.env.ORBITAL_MCP_GATEWAY_URL
  const taskId = process.env.ORBITAL_TASK_ID
  const workerId = process.env.ORBITAL_WORKER_ID
  const resultFile = process.env.FAKE_ANALYST_RESULT_FILE
  const retroReportId = process.env.FAKE_ANALYST_RETRO_REPORT_ID ?? 'unknown-report'

  if (!capabilityPath) throw new Error('ORBITAL_CAPABILITY_PATH not set')
  if (!gatewayUrl) throw new Error('ORBITAL_MCP_GATEWAY_URL not set')
  if (!taskId) throw new Error('ORBITAL_TASK_ID not set')
  if (!workerId) throw new Error('ORBITAL_WORKER_ID not set')

  const bundleRaw = await fs.readFile(capabilityPath, 'utf-8')
  const bundle = JSON.parse(bundleRaw)

  const socketPath = gatewayUrl.startsWith('unix://')
    ? gatewayUrl.slice('unix://'.length)
    : gatewayUrl

  log(`connecting to ${socketPath}`)

  const socket = await connect(socketPath)
  const channel = newChannel(socket)

  // 1. connect
  const connectResp = await channel.request({
    jsonrpc: '2.0',
    id: 1,
    method: 'connect',
    params: { bundle },
  })
  log(`connect response: ${JSON.stringify(connectResp)}`)
  if (connectResp.error) {
    process.stderr.write(`fake-analyst: connect failed: ${JSON.stringify(connectResp.error)}\n`)
    socket.destroy()
    process.exit(1)
  }

  // 2. heartbeat
  const hbResp = await channel.request({
    jsonrpc: '2.0',
    id: 100,
    method: 'worker.heartbeat',
    params: {
      worker_id: workerId,
      task_id: taskId,
      status: 'active',
      files_touched: [],
    },
  })
  log(`heartbeat response: ${JSON.stringify(hbResp)}`)

  // 3. Write synthetic proposal to result file if configured
  if (resultFile) {
    const proposal = {
      proposal_code: `PRP-ANALYST-${Date.now()}`,
      title: 'Tighten retro-analyst file scope (synthetic)',
      hypothesis:
        'The retro-analyst ran over token budget; tighter file-read scoping reduces by ~10% per sprint over the next two sprints.',
      expected_impact: { metric_key: 'cycle_time_p50', direction: 'decrease', pct_points: -500 },
      rollback_path: 'revert system_version_id to restore prior persona file',
      layers: [
        {
          layer: 'persona',
          target_path: 'personas/retro-analyst.md',
          change_type: 'modify',
          is_dominant: true,
        },
      ],
      evidence_refs: [],
      confidence_score: 70,
      proposed_value:
        '# Retro Analyst (Updated)\n\nTighter file-read scoping for retro analysis tasks.\n',
      is_global: true,
      _retro_report_id: retroReportId,
    }
    await fs.writeFile(resultFile, JSON.stringify(proposal, null, 2), 'utf-8')
    log(`wrote proposal to ${resultFile}`)
  }

  // 4. task.complete
  const completeResp = await channel.request({
    jsonrpc: '2.0',
    id: 300,
    method: 'task.complete',
    params: {
      task_id: taskId,
      summary: `Retro analysis completed; proposal synthesized for report ${retroReportId}`,
      artifacts: [],
    },
  })
  log(`task.complete response: ${JSON.stringify(completeResp)}`)

  socket.end()
  await new Promise((r) => socket.once('close', r))
  process.exit(0)
}

function connect(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
    setTimeout(() => reject(new Error('fake-analyst: connect timeout')), 5000)
  })
}

function newChannel(socket) {
  let buffer = ''
  const pending = new Map()

  socket.on('data', (chunk) => {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed)
        const id = parsed?.id
        if (id !== undefined && pending.has(id)) {
          pending.get(id).resolve(parsed)
          pending.delete(id)
        }
      } catch {
        // ignore malformed lines
      }
    }
  })

  socket.on('error', (err) => {
    for (const [, p] of pending) p.reject(err)
    pending.clear()
  })

  socket.on('close', () => {
    for (const [, p] of pending) p.reject(new Error('socket closed'))
    pending.clear()
  })

  return {
    request(msg) {
      return new Promise((resolve, reject) => {
        const id = msg.id
        pending.set(id, { resolve, reject })
        socket.write(JSON.stringify(msg) + '\n')
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id)
            reject(new Error(`fake-analyst: timeout on id=${id}`))
          }
        }, 8000)
      })
    },
  }
}

main().catch((err) => {
  process.stderr.write(`fake-analyst fatal: ${err?.message ?? err}\n`)
  process.exit(1)
})

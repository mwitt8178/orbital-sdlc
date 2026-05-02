#!/usr/bin/env node
/**
 * fake-pm.mjs — Test fixture that simulates the PM persona worker.
 *
 * Extends the fake-worker pattern. After the standard connect+heartbeat sequence,
 * this fixture posts a vision-intake question via channel.post MCP tool (if the
 * gateway supports it), then calls task.complete.
 *
 * The posting path is best-effort: if the MCP gateway does not expose a
 * channel.post tool, we skip the post and proceed directly to task.complete so
 * the integration test can still observe the spawn end-to-end.
 *
 * Env vars (in addition to standard ORBITAL_* set by Scheduler):
 *   FAKE_PM_VISION_SESSION_ID   used to build channel name (#vision-intake-{id})
 *   FAKE_PM_QUESTION            question text to post (default: canned question)
 *   FAKE_PM_SKIP_CHANNEL_POST=1 skip channel post, go straight to task.complete
 *   FAKE_PM_DEBUG=1             emit log lines to stderr
 */

import net from 'node:net'
import { promises as fs } from 'node:fs'
import process from 'node:process'

const debug = process.env.FAKE_PM_DEBUG === '1'
function log(msg) {
  if (debug) process.stderr.write(`[fake-pm] ${msg}\n`)
}

async function main() {
  const capabilityPath = process.env.ORBITAL_CAPABILITY_PATH
  const gatewayUrl = process.env.ORBITAL_MCP_GATEWAY_URL
  const taskId = process.env.ORBITAL_TASK_ID
  const workerId = process.env.ORBITAL_WORKER_ID
  const sessionId = process.env.FAKE_PM_VISION_SESSION_ID ?? 'unknown-session'
  const skipChannelPost = process.env.FAKE_PM_SKIP_CHANNEL_POST === '1'
  const question =
    process.env.FAKE_PM_QUESTION ??
    'What is the primary problem this product is solving?'

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
    process.stderr.write(`fake-pm: connect failed: ${JSON.stringify(connectResp.error)}\n`)
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

  // 3. Optional channel post (vision-intake question)
  if (!skipChannelPost) {
    try {
      const postResp = await channel.request({
        jsonrpc: '2.0',
        id: 200,
        method: 'channel.post',
        params: {
          channel_name: `vision-intake-${sessionId}`,
          post_type: 'question',
          payload: {
            text: question,
            vision_session_id: sessionId,
            pm_persona_task_id: taskId,
          },
        },
      })
      log(`channel.post response: ${JSON.stringify(postResp)}`)
      if (postResp.error) {
        log(`channel.post tool not supported or errored: ${JSON.stringify(postResp.error)}`)
      }
    } catch (err) {
      log(`channel.post failed (non-fatal): ${err?.message}`)
    }
  }

  // 4. task.complete
  const completeResp = await channel.request({
    jsonrpc: '2.0',
    id: 300,
    method: 'task.complete',
    params: {
      task_id: taskId,
      summary: `PM intake completed for vision session ${sessionId}`,
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
    setTimeout(() => reject(new Error('fake-pm: connect timeout')), 5000)
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
            reject(new Error(`fake-pm: timeout on id=${id}`))
          }
        }, 8000)
      })
    },
  }
}

main().catch((err) => {
  process.stderr.write(`fake-pm fatal: ${err?.message ?? err}\n`)
  process.exit(1)
})

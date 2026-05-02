#!/usr/bin/env node
/**
 * fake-worker.mjs — Test fixture for spawn integration tests.
 *
 * This is a minimal Claude Code surrogate. It:
 *   1. Reads the capability bundle from ORBITAL_CAPABILITY_PATH (mode 0600).
 *   2. Connects to the MCP gateway Unix socket from ORBITAL_MCP_GATEWAY_URL.
 *   3. Sends a 'connect' JSON-RPC request with the bundle.
 *   4. Sends a 'worker.heartbeat' JSON-RPC request.
 *   5. Sends a 'task.complete' JSON-RPC request.
 *   6. Closes the socket and exits 0.
 *
 * Used by integration tests by setting:
 *   env.CLAUDE_BIN = process.execPath  (node)
 *   spawnArgs[0]   = path-to-fake-worker.mjs
 *
 * Optional knobs (env vars):
 *   FAKE_WORKER_DELAY_MS       sleep before sending task.complete (slow-worker variant)
 *   FAKE_WORKER_HEARTBEATS_ONLY skip task.complete (lets monitor time it out)
 *   FAKE_WORKER_FAIL_INSTEAD    send task.fail instead of task.complete
 *   FAKE_WORKER_HEARTBEAT_COUNT  how many heartbeats to send (default 1)
 *   FAKE_WORKER_DEBUG=1         emit log lines to stderr
 */

import net from 'node:net'
import { promises as fs } from 'node:fs'
import process from 'node:process'

const debug = process.env.FAKE_WORKER_DEBUG === '1'
function log(msg) {
  if (debug) process.stderr.write(`[fake-worker] ${msg}\n`)
}

async function main() {
  const capabilityPath = process.env.ORBITAL_CAPABILITY_PATH
  const gatewayUrl = process.env.ORBITAL_MCP_GATEWAY_URL
  const taskId = process.env.ORBITAL_TASK_ID
  const workerId = process.env.ORBITAL_WORKER_ID

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
    process.stderr.write(`fake-worker: connect failed: ${JSON.stringify(connectResp.error)}\n`)
    socket.destroy()
    process.exit(1)
  }

  // 2. heartbeats
  const heartbeatCount = Number(process.env.FAKE_WORKER_HEARTBEAT_COUNT ?? '1')
  for (let i = 0; i < heartbeatCount; i++) {
    const hbResp = await channel.request({
      jsonrpc: '2.0',
      id: 100 + i,
      method: 'worker.heartbeat',
      params: {
        worker_id: workerId,
        task_id: taskId,
        status: 'active',
        files_touched: [],
      },
    })
    log(`heartbeat ${i} response: ${JSON.stringify(hbResp)}`)
  }

  // 3. delay if requested
  const delayMs = Number(process.env.FAKE_WORKER_DELAY_MS ?? '0')
  if (delayMs > 0) {
    log(`delaying ${delayMs}ms`)
    await new Promise((r) => setTimeout(r, delayMs))
  }

  // 4. heartbeats-only mode bails out without task.complete
  if (process.env.FAKE_WORKER_HEARTBEATS_ONLY === '1') {
    log('heartbeats-only mode; sleeping then exit')
    // Sleep so monitor can detect us and time us out.
    const stallMs = Number(process.env.FAKE_WORKER_STALL_MS ?? '60000')
    await new Promise((r) => setTimeout(r, stallMs))
    socket.destroy()
    process.exit(0)
  }

  // 5. complete or fail
  if (process.env.FAKE_WORKER_FAIL_INSTEAD === '1') {
    const resp = await channel.request({
      jsonrpc: '2.0',
      id: 200,
      method: 'task.fail',
      params: {
        task_id: taskId,
        error_code: 'INTERNAL_TEST_FAIL',
        error_message: 'fake-worker simulated failure',
        retry_advice: 'retry_with_backoff',
      },
    })
    log(`task.fail response: ${JSON.stringify(resp)}`)
  } else {
    const resp = await channel.request({
      jsonrpc: '2.0',
      id: 200,
      method: 'task.complete',
      params: {
        task_id: taskId,
        summary: 'fake-worker complete',
        artifacts: [],
      },
    })
    log(`task.complete response: ${JSON.stringify(resp)}`)
  }

  // Half-close + exit.
  socket.end()
  await new Promise((r) => socket.once('close', r))
  process.exit(0)
}

function connect(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
    setTimeout(() => reject(new Error('fake-worker: connect timeout')), 5000)
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
            reject(new Error(`fake-worker: timeout on id=${id}`))
          }
        }, 8000)
      })
    },
  }
}

main().catch((err) => {
  process.stderr.write(`fake-worker fatal: ${err?.message ?? err}\n`)
  process.exit(1)
})

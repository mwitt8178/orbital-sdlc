#!/usr/bin/env node
/**
 * fake-claude-bootstrap.mjs — Minimal MCP client used by fake-claude.sh.
 *
 * Reads the capability bundle, opens the Unix socket, sends connect → heartbeat
 * → task.complete, exits. Identical wire protocol to fake-worker.mjs but
 * one-shot (no delay knobs).
 */

import net from 'node:net'
import { promises as fs } from 'node:fs'

async function main() {
  const capabilityPath = process.env.ORBITAL_CAPABILITY_PATH
  const gatewayUrl = process.env.ORBITAL_MCP_GATEWAY_URL
  const taskId = process.env.ORBITAL_TASK_ID
  const workerId = process.env.ORBITAL_WORKER_ID

  if (!capabilityPath || !gatewayUrl || !taskId || !workerId) {
    process.stderr.write('fake-claude-bootstrap: missing required env\n')
    process.exit(1)
  }

  const bundle = JSON.parse(await fs.readFile(capabilityPath, 'utf-8'))
  const socketPath = gatewayUrl.startsWith('unix://')
    ? gatewayUrl.slice('unix://'.length)
    : gatewayUrl

  const socket = await new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath)
    s.once('connect', () => resolve(s))
    s.once('error', reject)
    setTimeout(() => reject(new Error('connect timeout')), 5000)
  })

  const pending = new Map()
  let buf = ''
  socket.on('data', (chunk) => {
    buf += chunk.toString()
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
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
        // ignore
      }
    }
  })

  function rpc(msg) {
    return new Promise((resolve, reject) => {
      const id = msg.id
      pending.set(id, { resolve, reject })
      socket.write(JSON.stringify(msg) + '\n')
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error('rpc timeout id=' + id))
        }
      }, 8000)
    })
  }

  await rpc({ jsonrpc: '2.0', id: 1, method: 'connect', params: { bundle } })
  await rpc({
    jsonrpc: '2.0',
    id: 2,
    method: 'worker.heartbeat',
    params: {
      worker_id: workerId,
      task_id: taskId,
      status: 'active',
      files_touched: ['hello.txt'],
    },
  })
  await rpc({
    jsonrpc: '2.0',
    id: 3,
    method: 'task.complete',
    params: {
      task_id: taskId,
      summary: 'fake-claude complete',
      artifacts: [{ type: 'file', id: 'hello.txt' }],
    },
  })

  socket.end()
  await new Promise((r) => socket.once('close', r))
  process.exit(0)
}

main().catch((e) => {
  process.stderr.write('fake-claude-bootstrap fatal: ' + (e?.message ?? e) + '\n')
  process.exit(1)
})

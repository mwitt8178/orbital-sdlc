/**
 * tools.js — sandboxed tool implementations for the Anthropic tool-use loop.
 *
 * Tools are executed in-process. Each tool resolves paths against a fixed
 * `cwd` (the run's worktree root); attempts to escape via `..` or absolute
 * paths outside the root are rejected.
 *
 * Tools registered:
 *   - file_read({ path })          → string contents
 *   - file_write({ path, contents }) → { bytes_written }
 *   - bash({ command, cwd? })      → { stdout, stderr, exit_code }
 *
 * Real, end-to-end. No mocks.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export const TOOL_SCHEMAS = [
  {
    name: 'file_read',
    description:
      'Read a UTF-8 file from the run worktree. Path must be relative to the worktree root or an absolute path inside it.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_write',
    description:
      'Write a UTF-8 file inside the run worktree. Creates parent directories. Overwrites if exists.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        contents: { type: 'string' },
      },
      required: ['path', 'contents'],
    },
  },
  {
    name: 'bash',
    description:
      'Run a shell command inside the run worktree. Times out after 120s. Stdout/stderr capped at 64KB each.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string', description: 'Optional subdir of worktree' },
      },
      required: ['command'],
    },
  },
]

/**
 * Resolve a user-supplied path against the worktree root, refusing escapes.
 */
export function resolveInRoot(root, p) {
  if (typeof p !== 'string' || p.length === 0) {
    throw new Error('path must be a non-empty string')
  }
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p)
  const normalizedRoot = path.resolve(root) + path.sep
  if (abs !== path.resolve(root) && !abs.startsWith(normalizedRoot)) {
    throw new Error(`path escapes worktree root: ${p}`)
  }
  return abs
}

const MAX_STREAM_BYTES = 64 * 1024
const BASH_TIMEOUT_MS = 120_000

/**
 * Execute a single tool call. Returns the tool_result content (string) and
 * whether the call was an error.
 *
 * @param {object} args
 * @param {string} args.name
 * @param {unknown} args.input
 * @param {string} args.root  worktree root
 * @returns {Promise<{ content: string, is_error: boolean }>}
 */
export async function executeTool({ name, input, root }) {
  try {
    if (name === 'file_read') {
      const abs = resolveInRoot(root, input?.path)
      const buf = await fs.readFile(abs, 'utf8')
      return { content: buf, is_error: false }
    }
    if (name === 'file_write') {
      const abs = resolveInRoot(root, input?.path)
      const contents = String(input?.contents ?? '')
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.writeFile(abs, contents, 'utf8')
      return {
        content: JSON.stringify({ bytes_written: Buffer.byteLength(contents, 'utf8') }),
        is_error: false,
      }
    }
    if (name === 'bash') {
      const cmd = String(input?.command ?? '').trim()
      if (!cmd) throw new Error('command required')
      const cwd = input?.cwd ? resolveInRoot(root, input.cwd) : root
      const result = await runBash(cmd, cwd)
      return {
        content: JSON.stringify(result),
        is_error: result.exit_code !== 0,
      }
    }
    return { content: `unknown tool: ${name}`, is_error: true }
  } catch (err) {
    return {
      content: `tool ${name} error: ${err instanceof Error ? err.message : String(err)}`,
      is_error: true,
    }
  }
}

function runBash(command, cwd) {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd,
      env: { ...process.env, PAGER: 'cat', TERM: 'dumb' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      child.kill('SIGTERM')
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
      }, 2000)
    }, BASH_TIMEOUT_MS)
    child.stdout.on('data', (c) => {
      if (stdout.length < MAX_STREAM_BYTES) {
        stdout += c.toString('utf8')
        if (stdout.length > MAX_STREAM_BYTES) stdout = stdout.slice(0, MAX_STREAM_BYTES) + '\n[...truncated]'
      }
    })
    child.stderr.on('data', (c) => {
      if (stderr.length < MAX_STREAM_BYTES) {
        stderr += c.toString('utf8')
        if (stderr.length > MAX_STREAM_BYTES) stderr = stderr.slice(0, MAX_STREAM_BYTES) + '\n[...truncated]'
      }
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({
        stdout,
        stderr,
        exit_code: killed ? 124 : code === null ? (signal ? 143 : 1) : code,
        timed_out: killed,
      })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ stdout, stderr: stderr + '\n' + String(err.message), exit_code: 1, timed_out: false })
    })
  })
}

// re-export for tests
export { execFileP as _execFileP }

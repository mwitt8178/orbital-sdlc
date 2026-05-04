/**
 * tools.test.js — sandbox containment + bash/file tool behaviour.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { executeTool, resolveInRoot, TOOL_SCHEMAS } from '../src/tools.js'

let root
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbital-tools-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('resolveInRoot', () => {
  it('resolves relative paths inside the root', () => {
    const r = resolveInRoot(root, 'src/foo.js')
    expect(r.startsWith(root)).toBe(true)
  })
  it('rejects parent traversal', () => {
    expect(() => resolveInRoot(root, '../escape.txt')).toThrow(/escapes/)
  })
  it('rejects absolute paths outside the root', () => {
    expect(() => resolveInRoot(root, '/etc/passwd')).toThrow(/escapes/)
  })
  it('accepts the root itself', () => {
    expect(resolveInRoot(root, '.')).toBe(path.resolve(root))
  })
})

describe('TOOL_SCHEMAS', () => {
  it('declares the three tools with required input keys', () => {
    const names = TOOL_SCHEMAS.map((t) => t.name).sort()
    expect(names).toEqual(['bash', 'file_read', 'file_write'])
  })
})

describe('executeTool', () => {
  it('file_write then file_read round-trips', async () => {
    const w = await executeTool({
      name: 'file_write',
      input: { path: 'a/b.txt', contents: 'hello' },
      root,
    })
    expect(w.is_error).toBe(false)
    const r = await executeTool({ name: 'file_read', input: { path: 'a/b.txt' }, root })
    expect(r.is_error).toBe(false)
    expect(r.content).toBe('hello')
  })

  it('bash captures stdout and exit_code', async () => {
    const r = await executeTool({
      name: 'bash',
      input: { command: 'echo hi && echo err 1>&2 && exit 0' },
      root,
    })
    expect(r.is_error).toBe(false)
    const parsed = JSON.parse(r.content)
    expect(parsed.stdout).toMatch(/hi/)
    expect(parsed.stderr).toMatch(/err/)
    expect(parsed.exit_code).toBe(0)
  })

  it('bash propagates non-zero exit as is_error=true', async () => {
    const r = await executeTool({
      name: 'bash',
      input: { command: 'exit 7' },
      root,
    })
    expect(r.is_error).toBe(true)
    expect(JSON.parse(r.content).exit_code).toBe(7)
  })

  it('file_write rejects path escape', async () => {
    const r = await executeTool({
      name: 'file_write',
      input: { path: '../escape.txt', contents: 'x' },
      root,
    })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/escapes worktree/)
  })

  it('reports unknown tool as is_error', async () => {
    const r = await executeTool({ name: 'shell_inject', input: {}, root })
    expect(r.is_error).toBe(true)
  })
})

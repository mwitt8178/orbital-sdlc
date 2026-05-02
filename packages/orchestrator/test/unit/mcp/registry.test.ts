/**
 * Unit tests for ToolRegistry.
 *
 * Per TDD discipline: these run without a DB connection.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { z } from 'zod'
import { ToolRegistry } from '../../../src/mcp/registry.js'
import type { MCPTool } from '../../../src/mcp/registry.js'

function makeTool(name: string): MCPTool {
  return {
    name,
    description: `Test tool ${name}`,
    inputSchema: z.object({ foo: z.string() }),
    outputSchema: z.object({ ok: z.boolean() }),
    bypassScopeCheck: true,
    async handler(_input, _ctx) {
      return { ok: true }
    },
  }
}

describe('ToolRegistry', () => {
  let registry: ToolRegistry

  beforeEach(() => {
    registry = new ToolRegistry()
  })

  it('registers a tool and retrieves it by name', () => {
    const tool = makeTool('test.echo')
    registry.register(tool)
    expect(registry.get('test.echo')).toBe(tool)
  })

  it('list() returns all registered tools', () => {
    registry.register(makeTool('a.b'))
    registry.register(makeTool('c.d'))
    const names = registry.list().map((t) => t.name)
    expect(names).toContain('a.b')
    expect(names).toContain('c.d')
    expect(names).toHaveLength(2)
  })

  it('get() returns undefined for unknown tool', () => {
    expect(registry.get('unknown.tool')).toBeUndefined()
  })

  it('deregister() removes a tool', () => {
    registry.register(makeTool('x.y'))
    registry.deregister('x.y')
    expect(registry.get('x.y')).toBeUndefined()
    expect(registry.list()).toHaveLength(0)
  })

  it('deregister() is a no-op for unknown tools', () => {
    expect(() => registry.deregister('nonexistent')).not.toThrow()
  })

  it('register() throws on duplicate tool name', () => {
    registry.register(makeTool('dup.tool'))
    expect(() => registry.register(makeTool('dup.tool'))).toThrow()
  })

  it('registered tool handler is callable', async () => {
    let called = false
    const tool: MCPTool = {
      name: 'callable.tool',
      description: 'callable',
      inputSchema: z.object({ x: z.number() }),
      outputSchema: z.object({ doubled: z.number() }),
      bypassScopeCheck: true,
      async handler(input, _ctx) {
        called = true
        return { doubled: input.x * 2 }
      },
    }
    registry.register(tool)
    const found = registry.get('callable.tool')!
    const result = await found.handler({ x: 5 }, {} as never)
    expect(called).toBe(true)
    expect(result).toEqual({ doubled: 10 })
  })
})

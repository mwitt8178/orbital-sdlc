/**
 * Unit tests for AgentOrgRepo - real Git operations against an isolated
 * tmp dir per test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { AgentOrgRepo } from '../../../src/retros/agent-org.js'

let tmpRoot: string
let repo: AgentOrgRepo

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), `orbital-agent-org-${process.pid}-`))
  repo = new AgentOrgRepo({ path: path.join(tmpRoot, 'agent-org') })
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined)
})

describe('AgentOrgRepo', () => {
  it('init() creates a real git repo with an initial commit', async () => {
    expect(await repo.isInitialized()).toBe(false)
    await repo.init()
    expect(await repo.isInitialized()).toBe(true)

    // Verify .git/ exists and has a HEAD.
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo.path,
      encoding: 'utf8',
    }).trim()
    expect(head).toMatch(/^[0-9a-f]{40}$/)

    // Verify the scaffold dirs exist.
    for (const sub of ['personas', 'skills', 'hooks', 'orchestrator', 'environment', 'routing', 'board']) {
      const stat = await fs.stat(path.join(repo.path, sub))
      expect(stat.isDirectory()).toBe(true)
    }

    // Verify VERSION file.
    const version = await fs.readFile(path.join(repo.path, 'VERSION'), 'utf8')
    expect(version.length).toBeGreaterThan(0)
  })

  it('init() is idempotent', async () => {
    await repo.init()
    const head1 = await repo.headSha()
    await repo.init()
    const head2 = await repo.headSha()
    expect(head1).toEqual(head2)
  })

  it('commit() writes file, returns SHA, file is readable', async () => {
    await repo.init()
    const initialHead = await repo.headSha()
    const sha = await repo.commit('personas/sr-dev.md', '# senior dev v2\n', 'feat: update sr-dev')
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    expect(sha).not.toEqual(initialHead)

    const content = await repo.readFile('personas/sr-dev.md')
    expect(content).toEqual('# senior dev v2\n')
  })

  it('commit() rejects relative paths that escape the repo', async () => {
    await repo.init()
    await expect(repo.commit('../escape.txt', 'x', 'msg')).rejects.toMatchObject({
      code: 'INTEGRATION_GIT_CONFLICT',
    })
    await expect(repo.commit('/abs/path.txt', 'x', 'msg')).rejects.toMatchObject({
      code: 'INTEGRATION_GIT_CONFLICT',
    })
  })

  it('commit() before init() throws INTEGRATION_GIT_CONFLICT', async () => {
    await expect(repo.commit('a.md', 'x', 'msg')).rejects.toMatchObject({
      code: 'INTEGRATION_GIT_CONFLICT',
    })
  })

  it('readFile() returns null for missing files', async () => {
    await repo.init()
    const content = await repo.readFile('nope/missing.md')
    expect(content).toBeNull()
  })

  it('reset() reverts working tree to a prior commit', async () => {
    await repo.init()
    const sha1 = await repo.commit('personas/x.md', 'one', 'first')
    await repo.commit('personas/x.md', 'two', 'second')
    expect(await repo.readFile('personas/x.md')).toEqual('two')

    await repo.reset(sha1)
    expect(await repo.readFile('personas/x.md')).toEqual('one')
    expect(await repo.headSha()).toEqual(sha1)
  })

  it('log() returns commits newest-first', async () => {
    await repo.init()
    await repo.commit('personas/a.md', '1', 'feat: alpha')
    await repo.commit('personas/b.md', '2', 'feat: beta')

    const entries = await repo.log(5)
    expect(entries.length).toBeGreaterThanOrEqual(3)
    expect(entries[0]?.message).toEqual('feat: beta')
    expect(entries[1]?.message).toEqual('feat: alpha')

    for (const e of entries) {
      expect(e.hash).toMatch(/^[0-9a-f]{40}$/)
      expect(e.shortHash.length).toBeGreaterThanOrEqual(7)
    }
  })

  it('parentOf() returns the parent SHA, or null for the initial commit', async () => {
    await repo.init()
    const initialSha = await repo.headSha()
    const newSha = await repo.commit('personas/c.md', 'x', 'feat: c')
    const parent = await repo.parentOf(newSha)
    expect(parent).toEqual(initialSha)

    const initialParent = await repo.parentOf(initialSha)
    expect(initialParent).toBeNull()
  })

  it('tag() applies a name to the HEAD commit', async () => {
    await repo.init()
    await repo.commit('personas/d.md', 'x', 'feat: d')
    await repo.tag('org-v0.1.0', 'release notes')
    const tags = execFileSync('git', ['tag', '--list'], {
      cwd: repo.path,
      encoding: 'utf8',
    })
    expect(tags).toContain('org-v0.1.0')
  })

  it('filesChanged() returns the changed paths for a commit', async () => {
    await repo.init()
    const sha = await repo.commit('personas/e.md', 'x', 'feat: e')
    const files = await repo.filesChanged(sha)
    expect(files).toContain('personas/e.md')
  })

  it('unifiedDiff() returns a non-empty diff for a commit', async () => {
    await repo.init()
    const sha = await repo.commit('personas/f.md', '# new persona\n', 'feat: f')
    const diff = await repo.unifiedDiff(sha)
    expect(diff).toContain('personas/f.md')
    expect(diff).toContain('# new persona')
  })
})

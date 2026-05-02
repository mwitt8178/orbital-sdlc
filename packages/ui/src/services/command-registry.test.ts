/**
 * Unit tests for the command-registry ranking function.
 *
 * The Zustand store and recent-search persistence are not exercised here
 * (they require window/sessionStorage); rankCommands is pure and is the
 * load-bearing piece for palette UX.
 */

import { describe, it, expect } from 'vitest'
import { rankCommands, type PaletteCommand } from './command-registry.js'

function cmd(id: string, label: string, keywords?: string[], group?: string): PaletteCommand {
  const out: PaletteCommand = {
    id,
    label,
    onSelect: () => {},
  }
  if (keywords) out.keywords = keywords
  if (group) out.group = group
  return out
}

describe('rankCommands', () => {
  it('returns all commands when query is empty', () => {
    const list = [cmd('a', 'Alpha'), cmd('b', 'Bravo'), cmd('c', 'Charlie')]
    const out = rankCommands(list, '')
    expect(out).toHaveLength(3)
  })

  it('returns nothing on empty input list', () => {
    expect(rankCommands([], 'foo')).toEqual([])
  })

  it('prioritizes prefix match over subsequence match', () => {
    const list = [
      cmd('a', 'Vision Intake'),
      cmd('b', 'Bravo Vision'),
      cmd('c', 'unrelated'),
    ]
    const out = rankCommands(list, 'vis')
    expect(out[0]?.command.label).toBe('Vision Intake')
  })

  it('matches via keywords when label does not match', () => {
    const list = [cmd('a', 'Sprint Dashboard', ['home', 'sprints'])]
    const out = rankCommands(list, 'home')
    expect(out).toHaveLength(1)
    expect(out[0]?.command.label).toBe('Sprint Dashboard')
  })

  it('falls back to subsequence matching', () => {
    const list = [cmd('a', 'Improvement Proposals')]
    const out = rankCommands(list, 'iprp')
    expect(out).toHaveLength(1)
  })

  it('drops commands with no match', () => {
    const list = [cmd('a', 'Alpha'), cmd('b', 'Beta')]
    const out = rankCommands(list, 'zebra')
    expect(out).toHaveLength(0)
  })

  it('breaks score ties alphabetically by label', () => {
    const list = [
      cmd('z', 'Zoo'),
      cmd('a', 'Apple'),
      cmd('b', 'Banana'),
    ]
    const out = rankCommands(list, '')
    // All score equal (1 for empty query); alphabetical order Apple, Banana, Zoo.
    expect(out.map((s) => s.command.label)).toEqual(['Apple', 'Banana', 'Zoo'])
  })

  it('matches case-insensitively', () => {
    const list = [cmd('a', 'AUDIT LOG')]
    const out = rankCommands(list, 'audit')
    expect(out).toHaveLength(1)
  })

  it('matches diacritics-insensitively', () => {
    const list = [cmd('a', 'Évolution')]
    const out = rankCommands(list, 'evolu')
    expect(out).toHaveLength(1)
  })

  it('finds word-boundary matches inside multi-word labels', () => {
    const list = [cmd('a', 'Sprint Dashboard')]
    const out = rankCommands(list, 'dash')
    expect(out).toHaveLength(1)
  })
})

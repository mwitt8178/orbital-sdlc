/**
 * command-registry.ts — singleton registry of palette commands.
 *
 * Commands can be registered statically (route navigations) or dynamically by
 * any component (e.g. the channels page registers per-channel jump commands).
 * Each command has an id, label, optional keywords, optional icon hint, and
 * an `onSelect` callback.
 *
 * The matcher is intentionally simple — no fuse.js dependency. We score by:
 *   1. exact prefix match on label  (highest)
 *   2. word-boundary match on label
 *   3. subsequence match on label/keywords
 * Ties broken by keyword count (more specific first), then alphabetical label.
 *
 * Recent searches are persisted in sessionStorage under a single key.
 */

import { create } from 'zustand'

export interface CommandIcon {
  kind: 'svg'
  paths: string[]
}

export interface PaletteCommand {
  id: string
  label: string
  /** Optional category prefix shown in the list (e.g. "Navigate"). */
  group?: string
  keywords?: string[]
  /** Optional one-character category hint shown to the right. */
  hint?: string
  onSelect: () => void
}

interface CommandRegistryState {
  commands: Map<string, PaletteCommand>
  isOpen: boolean
  register: (cmd: PaletteCommand) => void
  unregister: (id: string) => void
  registerMany: (cmds: PaletteCommand[]) => () => void
  open: () => void
  close: () => void
  toggle: () => void
}

export const useCommandRegistry = create<CommandRegistryState>((set) => ({
  commands: new Map<string, PaletteCommand>(),
  isOpen: false,
  register: (cmd) =>
    set((state) => {
      const next = new Map(state.commands)
      next.set(cmd.id, cmd)
      return { commands: next }
    }),
  unregister: (id) =>
    set((state) => {
      if (!state.commands.has(id)) return state
      const next = new Map(state.commands)
      next.delete(id)
      return { commands: next }
    }),
  registerMany: (cmds) => {
    set((state) => {
      const next = new Map(state.commands)
      for (const c of cmds) next.set(c.id, c)
      return { commands: next }
    })
    return () => {
      set((state) => {
        const next = new Map(state.commands)
        for (const c of cmds) next.delete(c.id)
        return { commands: next }
      })
    }
  },
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((s) => ({ isOpen: !s.isOpen })),
}))

// ---------------------------------------------------------------------------
// Matching / scoring
// ---------------------------------------------------------------------------

const PREFIX_SCORE = 1000
const WORD_BOUNDARY_SCORE = 600
const SUBSEQUENCE_SCORE = 200
const KEYWORD_BONUS = 50

/** Lowercase + remove diacritics for stable comparisons. */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
}

function scoreLabel(label: string, query: string): number {
  if (label.startsWith(query)) return PREFIX_SCORE
  // Word-boundary match
  const tokens = label.split(/[\s/_-]+/)
  for (const tok of tokens) {
    if (tok.startsWith(query)) return WORD_BOUNDARY_SCORE
  }
  // Subsequence
  let i = 0
  for (let j = 0; j < label.length && i < query.length; j++) {
    if (label[j] === query[i]) i++
  }
  if (i === query.length) return SUBSEQUENCE_SCORE
  return 0
}

export interface ScoredCommand {
  command: PaletteCommand
  score: number
}

export function rankCommands(
  commands: Iterable<PaletteCommand>,
  rawQuery: string,
): ScoredCommand[] {
  const query = normalize(rawQuery.trim())
  const list: ScoredCommand[] = []
  for (const cmd of commands) {
    if (query.length === 0) {
      list.push({ command: cmd, score: 1 })
      continue
    }
    const labelScore = scoreLabel(normalize(cmd.label), query)
    let kwScore = 0
    if (cmd.keywords) {
      for (const k of cmd.keywords) {
        const s = scoreLabel(normalize(k), query)
        if (s > 0) {
          kwScore = Math.max(kwScore, s)
        }
      }
    }
    const groupScore =
      cmd.group !== undefined ? scoreLabel(normalize(cmd.group), query) : 0
    const total =
      Math.max(labelScore, kwScore + KEYWORD_BONUS * (kwScore > 0 ? 1 : 0), groupScore)
    if (total > 0) list.push({ command: cmd, score: total })
  }
  list.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.command.label.localeCompare(b.command.label)
  })
  return list
}

// ---------------------------------------------------------------------------
// Recent searches
// ---------------------------------------------------------------------------

const RECENTS_KEY = 'orbital.cmdk.recents'
const RECENTS_LIMIT = 8

function readSessionStorage(): string[] {
  if (typeof sessionStorage === 'undefined') return []
  try {
    const raw = sessionStorage.getItem(RECENTS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string').slice(0, RECENTS_LIMIT)
  } catch {
    return []
  }
}

function writeSessionStorage(values: string[]): void {
  if (typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.setItem(RECENTS_KEY, JSON.stringify(values))
  } catch {
    // Quota exceeded or storage disabled — silently skip.
  }
}

export const recentSearches = {
  list(): string[] {
    return readSessionStorage()
  },
  push(query: string): void {
    const trimmed = query.trim()
    if (!trimmed) return
    const current = readSessionStorage()
    const filtered = current.filter((q) => q !== trimmed)
    filtered.unshift(trimmed)
    writeSessionStorage(filtered.slice(0, RECENTS_LIMIT))
  },
  clear(): void {
    writeSessionStorage([])
  },
}

// Exposed for tests.
export const __test = {
  scoreLabel,
  normalize,
  PREFIX_SCORE,
  WORD_BOUNDARY_SCORE,
  SUBSEQUENCE_SCORE,
}

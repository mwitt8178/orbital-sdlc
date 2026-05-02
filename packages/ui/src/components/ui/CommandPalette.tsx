/**
 * CommandPalette.tsx — ⌘K-triggered command palette.
 *
 * - Opens on (mod+K) anywhere in the app, or via the TopBar button.
 * - Closes on Escape, outside click, or selection.
 * - Up/Down move the active row; Enter triggers it.
 * - Recent searches surface when the input is empty.
 * - Default commands: navigate to each top-level route. Pages may register
 *   their own commands via `useCommandRegistry().registerMany`.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import {
  rankCommands,
  recentSearches,
  useCommandRegistry,
  type PaletteCommand,
} from '../../services/command-registry.js'

const DEFAULT_ROUTES: Array<{ label: string; path: string; keywords?: string[] }> = [
  { label: 'Sprint Dashboard', path: '/', keywords: ['home', 'sprints'] },
  { label: 'Vision Intake', path: '/vision', keywords: ['product', 'spec'] },
  { label: 'Channels', path: '/channels', keywords: ['comms', 'chat'] },
  { label: 'Ceremonies', path: '/ceremonies', keywords: ['planning', 'standup', 'retro'] },
  { label: 'UAT', path: '/uat', keywords: ['acceptance', 'qa'] },
  { label: 'Retrospective', path: '/retro', keywords: ['rollback', 'versions'] },
  { label: 'Audit Log', path: '/audit', keywords: ['events', 'export'] },
  { label: 'Settings', path: '/settings', keywords: ['personas', 'hooks', 'identity'] },
  { label: 'Admin', path: '/admin', keywords: ['ops', 'workers', 'health', 'backup'] },
]

export function CommandPalette() {
  const isOpen = useCommandRegistry((s) => s.isOpen)
  const close = useCommandRegistry((s) => s.close)
  const open = useCommandRegistry((s) => s.open)
  const commandsMap = useCommandRegistry((s) => s.commands)
  const registerMany = useCommandRegistry((s) => s.registerMany)
  const navigate = useNavigate()

  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Register the default route commands once on mount.
  useEffect(() => {
    const cmds: PaletteCommand[] = DEFAULT_ROUTES.map((r) => ({
      id: `nav:${r.path}`,
      label: r.label,
      group: 'Navigate',
      hint: '↵',
      onSelect: () => navigate(r.path),
      ...(r.keywords ? { keywords: r.keywords } : {}),
    }))
    return registerMany(cmds)
  }, [navigate, registerMany])

  // Global keyboard shortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey
      if (isMod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (useCommandRegistry.getState().isOpen) {
          close()
        } else {
          open()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  // Reset state on open/close.
  useEffect(() => {
    if (!isOpen) return
    setQuery('')
    setActiveIndex(0)
    const id = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(id)
  }, [isOpen])

  const ranked = useMemo(() => {
    return rankCommands(commandsMap.values(), query)
  }, [commandsMap, query])

  const recents = useMemo(() => {
    if (!isOpen) return []
    if (query.trim() !== '') return []
    return recentSearches.list()
  }, [query, isOpen])

  const visible = ranked.slice(0, 50)

  useEffect(() => {
    if (activeIndex >= visible.length) setActiveIndex(0)
  }, [visible.length, activeIndex])

  if (!isOpen) return null

  const onSelectCommand = (cmd: PaletteCommand) => {
    if (query.trim() !== '') recentSearches.push(query.trim())
    close()
    cmd.onSelect()
  }

  const node = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      className="fixed inset-0 z-[70] flex items-start justify-center bg-slate-900/40 px-4 pt-24"
      onClick={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="w-full max-w-2xl overflow-hidden rounded-xl bg-white shadow-2xl ring-1 ring-slate-200">
        <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2.5">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-slate-400"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            placeholder="Search or type a command…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActiveIndex((idx) => Math.min(idx + 1, visible.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActiveIndex((idx) => Math.max(idx - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                const target = visible[activeIndex]?.command
                if (target) onSelectCommand(target)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                close()
              }
            }}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
            aria-label="Command palette search"
            aria-controls="cmdk-results"
            aria-activedescendant={
              visible[activeIndex]?.command.id
                ? `cmdk-row-${visible[activeIndex]?.command.id}`
                : undefined
            }
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
            esc
          </kbd>
        </div>

        <div id="cmdk-results" className="max-h-96 overflow-y-auto py-1" role="listbox">
          {recents.length > 0 ? (
            <div className="px-2 pb-1">
              <p className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Recent
              </p>
              <div className="flex flex-wrap gap-1.5 px-2 pb-1.5">
                {recents.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setQuery(r)}
                    className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-100"
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {visible.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-slate-400">
              No matching commands. Try a different query.
            </p>
          ) : (
            <ul role="presentation">
              {visible.map((sc, i) => {
                const isActive = i === activeIndex
                return (
                  <li
                    key={sc.command.id}
                    id={`cmdk-row-${sc.command.id}`}
                    role="option"
                    aria-selected={isActive}
                  >
                    <button
                      type="button"
                      onMouseEnter={() => setActiveIndex(i)}
                      onClick={() => onSelectCommand(sc.command)}
                      className={
                        isActive
                          ? 'flex w-full items-center justify-between gap-3 bg-brand-50 px-4 py-2 text-left text-sm text-brand-900'
                          : 'flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50'
                      }
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">
                          {sc.command.group ? (
                            <span className="text-slate-400">{sc.command.group} · </span>
                          ) : null}
                          {sc.command.label}
                        </span>
                      </span>
                      {sc.command.hint ? (
                        <span className="text-[11px] text-slate-400">{sc.command.hint}</span>
                      ) : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-slate-100 px-3 py-1.5 text-[11px] text-slate-400">
          <span>
            <kbd className="rounded border border-slate-200 bg-slate-50 px-1 font-mono text-[10px]">↑↓</kbd>{' '}
            navigate
          </span>
          <span>
            <kbd className="rounded border border-slate-200 bg-slate-50 px-1 font-mono text-[10px]">↵</kbd>{' '}
            select
          </span>
          <span>
            <kbd className="rounded border border-slate-200 bg-slate-50 px-1 font-mono text-[10px]">esc</kbd>{' '}
            close
          </span>
        </div>
      </div>
    </div>
  )

  return createPortal(node, document.body)
}

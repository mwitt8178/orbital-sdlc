import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { useActiveProject } from '../../../services/use-active-project.js'
import { CreateProjectModal } from './CreateProjectModal.js'

/**
 * ProjectSwitcher — top-bar dropdown that:
 *   - Shows the active project name
 *   - Opens a menu listing all projects with search + archived toggle
 *   - Switches the active project on click
 *   - Opens a CreateProjectModal from the "+ New project" item
 *
 * Per Round 4 Projects Feature spec.
 */

export function ProjectSwitcher() {
  const [open, setOpen] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [filter, setFilter] = useState('')
  const [createOpen, setCreateOpen] = useState(false)

  const containerRef = useRef<HTMLDivElement>(null)

  // Pull both lists at once so the toggle is instant. The active filter is
  // applied client-side; both queries are cheap.
  const { activeProject, projects, setActiveProject, isLoading } = useActiveProject()

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current) return
      if (!containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const filtered = projects.filter((p) => {
    const matchesArchived = showArchived ? p.archivedAt !== null : p.archivedAt === null
    if (!matchesArchived) return false
    if (filter.trim().length === 0) return true
    const f = filter.trim().toLowerCase()
    return p.name.toLowerCase().includes(f) || p.slug.toLowerCase().includes(f)
  })

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded px-2 py-1 text-sm text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Switch project"
      >
        <span data-testid="project-switcher-name">
          {isLoading
            ? 'Loading…'
            : activeProject
              ? activeProject.name
              : projects.length > 0
                ? 'Select project'
                : 'No projects'}
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={clsx('transition-transform', open && 'rotate-180')}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-40 mt-1 w-72 rounded-md border border-slate-200 bg-white shadow-lg"
        >
          <div className="border-b border-slate-100 p-2">
            <input
              autoFocus
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search projects…"
              className="w-full rounded border border-slate-200 px-2 py-1 text-xs text-slate-900 placeholder-slate-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            <label className="mt-2 flex items-center gap-1.5 text-xs text-slate-500">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
                className="h-3 w-3"
              />
              Show archived
            </label>
          </div>

          <ul className="max-h-72 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-xs text-slate-400">
                {showArchived
                  ? 'No archived projects.'
                  : projects.length === 0
                    ? 'No projects yet — create one below.'
                    : 'No matches.'}
              </li>
            ) : (
              filtered.map((p) => (
                <li key={p.projectId}>
                  <button
                    onClick={() => {
                      setActiveProject(p.projectId)
                      setOpen(false)
                    }}
                    role="menuitem"
                    className={clsx(
                      'flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-slate-50',
                      activeProject?.projectId === p.projectId &&
                        'bg-brand-50 font-medium text-brand-700',
                    )}
                  >
                    <div className="flex flex-col">
                      <span className="truncate">{p.name}</span>
                      <span className="truncate text-[11px] text-slate-400">
                        {p.slug}
                      </span>
                    </div>
                    {p.archivedAt !== null && (
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                        archived
                      </span>
                    )}
                  </button>
                </li>
              ))
            )}
          </ul>

          <div className="border-t border-slate-100 p-1">
            <button
              onClick={() => {
                setCreateOpen(true)
                setOpen(false)
              }}
              className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-sm text-brand-600 hover:bg-brand-50"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M5 12h14M12 5v14" />
              </svg>
              New project
            </button>
          </div>
        </div>
      )}

      <CreateProjectModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(project) => {
          setActiveProject(project.projectId)
          setCreateOpen(false)
        }}
      />
    </div>
  )
}

/**
 * Memory page — operator-facing browser and curator for project memory.
 *
 * [Engineer-Sr · Sonnet · run-round6-04-project-memory]
 *
 * Layout:
 *   - Header: title + "New entry" button
 *   - Top: search bar + filter chips (kind, status)
 *   - Left panel: MemoryEntryList (paginated)
 *   - Right panel: MemoryEntryDetail (when entry selected)
 *
 * URL params: ?kind=decision&status=active&search=<text>
 */

import { useState } from 'react'
import { useActiveProject } from '../services/use-active-project.js'
import { trpc } from '../services/trpc.js'
import { MemoryEntryList, type MemoryEntryListItem } from '../components/features/memory/MemoryEntryList.js'
import { MemoryEntryDetail } from '../components/features/memory/MemoryEntryDetail.js'
import { Button } from '../components/ui/Button.js'
import { Input } from '../components/ui/Input.js'
import { Modal } from '../components/ui/Modal.js'
import clsx from 'clsx'

// ---------------------------------------------------------------------------
// Filter chips
// ---------------------------------------------------------------------------

const KIND_OPTIONS = [
  { value: '', label: 'All kinds' },
  { value: 'decision', label: 'Decisions' },
  { value: 'convention', label: 'Conventions' },
  { value: 'learning', label: 'Learnings' },
  { value: 'anti_pattern', label: 'Anti-patterns' },
  { value: 'glossary', label: 'Glossary' },
]

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'archived', label: 'Archived' },
  { value: 'superseded', label: 'Superseded' },
]

interface FilterChipProps {
  label: string
  active: boolean
  onClick: () => void
}

function FilterChip({ label, active, onClick }: FilterChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'inline-flex items-center rounded-full px-3 py-1 text-xs font-medium transition',
        active
          ? 'bg-brand-100 text-brand-700 ring-1 ring-brand-500'
          : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
      )}
    >
      {label}
    </button>
  )
}

// ---------------------------------------------------------------------------
// New entry modal
// ---------------------------------------------------------------------------

interface NewEntryModalProps {
  projectId: string
  onClose: () => void
  onCreated: () => void
}

function NewEntryModal({ projectId, onClose, onCreated }: NewEntryModalProps) {
  const [kind, setKind] = useState<string>('decision')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [confidence, setConfidence] = useState<string>('medium')
  const [tagsRaw, setTagsRaw] = useState('')
  const [error, setError] = useState<string | null>(null)

  const recordMutation = trpc.memory.record.useMutation()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || !body.trim()) {
      setError('Title and body are required.')
      return
    }
    setError(null)
    try {
      await recordMutation.mutateAsync({
        projectId,
        kind: kind as 'decision' | 'convention' | 'learning' | 'anti_pattern' | 'glossary',
        title: title.trim(),
        body: body.trim(),
        sourceKind: 'operator',
        confidence: confidence as 'low' | 'medium' | 'high',
        scope: 'project',
        tags: tagsRaw.split(',').map((t) => t.trim()).filter(Boolean),
        links: [],
      })
      onCreated()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create entry')
    }
  }

  return (
    <Modal open onClose={onClose} title="New memory entry">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {error && (
          <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        )}

        <div className="flex flex-col gap-1">
          <label htmlFor="entry-kind" className="text-xs font-medium text-slate-600">Kind</label>
          <select
            id="entry-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="rounded-md border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            {KIND_OPTIONS.slice(1).map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="entry-title" className="text-xs font-medium text-slate-600">Title</label>
          <Input
            id="entry-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Short, memorable title"
            required
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="entry-body" className="text-xs font-medium text-slate-600">Body (markdown)</label>
          <textarea
            id="entry-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
            className="rounded-md border border-slate-200 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-500"
            placeholder="Detailed explanation, context, reasoning…"
            required
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="entry-confidence" className="text-xs font-medium text-slate-600">Confidence</label>
            <select
              id="entry-confidence"
              value={confidence}
              onChange={(e) => setConfidence(e.target.value)}
              className="rounded-md border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="entry-tags" className="text-xs font-medium text-slate-600">Tags (comma-sep.)</label>
            <Input
              id="entry-tags"
              value={tagsRaw}
              onChange={(e) => setTagsRaw(e.target.value)}
              placeholder="auth, typescript, trpc"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={recordMutation.isPending}>
            {recordMutation.isPending ? 'Saving…' : 'Save entry'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Memory() {
  const [search, setSearch] = useState('')
  const [kindFilter, setKindFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('active')
  const [selectedEntry, setSelectedEntry] = useState<MemoryEntryListItem | null>(null)
  const [showNewModal, setShowNewModal] = useState(false)
  const [listKey, setListKey] = useState(0) // force list re-fetch

  const { activeProject } = useActiveProject()
  const projectId = activeProject?.projectId ?? ''

  function handleUpdate() {
    setListKey((k) => k + 1)
    // Refetch the selected entry
    setSelectedEntry(null)
  }

  function handleArchive() {
    setSelectedEntry(null)
    setListKey((k) => k + 1)
  }

  return (
    <div className="flex h-full flex-col">
      {/* Page header */}
      <header className="flex-shrink-0 border-b border-slate-200 bg-white px-8 py-5">
        <div className="flex items-start justify-between">
          <div>
            <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
              <span>Project</span>
              <span aria-hidden="true">›</span>
              <span>Memory</span>
            </div>
            <h1 className="text-2xl font-bold text-slate-900">Project Memory</h1>
            <p className="mt-1 text-sm text-slate-500">
              Decisions, conventions, and learnings that persist across sprints. Agents read
              this context automatically when briefed.
            </p>
          </div>
          {projectId && (
            <Button
              variant="primary"
              onClick={() => setShowNewModal(true)}
              aria-label="New memory entry"
            >
              + New entry
            </Button>
          )}
        </div>

        {/* Search + filters */}
        <div className="mt-4 flex items-center gap-3 flex-wrap">
          <div className="w-72">
            <Input
              type="search"
              placeholder="Search memory…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search memory entries"
            />
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {KIND_OPTIONS.map((opt) => (
              <FilterChip
                key={opt.value}
                label={opt.label}
                active={kindFilter === opt.value}
                onClick={() => setKindFilter(kindFilter === opt.value ? '' : opt.value)}
              />
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            {STATUS_OPTIONS.map((opt) => (
              <FilterChip
                key={opt.value}
                label={opt.label}
                active={statusFilter === opt.value}
                onClick={() => setStatusFilter(opt.value)}
              />
            ))}
          </div>
        </div>
      </header>

      {/* Body: two-panel layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: entry list */}
        <aside className="flex w-80 flex-shrink-0 flex-col overflow-y-auto border-r border-slate-200 bg-white p-4">
          <MemoryEntryList
            key={`${listKey}-${search}-${kindFilter}-${statusFilter}`}
            search={search}
            kindFilter={kindFilter}
            statusFilter={statusFilter}
            onSelect={setSelectedEntry}
            selectedId={selectedEntry?.entryId ?? null}
          />
        </aside>

        {/* Right: entry detail */}
        <main className="flex-1 overflow-y-auto bg-slate-50">
          {selectedEntry ? (
            <MemoryEntryDetail
              key={selectedEntry.entryId}
              entry={selectedEntry}
              onUpdate={handleUpdate}
              onArchive={handleArchive}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-slate-400">
              Select an entry to view details
            </div>
          )}
        </main>
      </div>

      {/* New entry modal */}
      {showNewModal && projectId && (
        <NewEntryModal
          projectId={projectId}
          onClose={() => setShowNewModal(false)}
          onCreated={() => setListKey((k) => k + 1)}
        />
      )}
    </div>
  )
}

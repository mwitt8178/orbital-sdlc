/**
 * MemoryEntryDetail — right panel showing full details of a selected memory entry.
 * Supports read mode and edit mode (title, body, tags, scope, confidence).
 *
 * [Engineer-Sr · Sonnet · run-round6-04-project-memory]
 */

import { useState } from 'react'
import clsx from 'clsx'
import { trpc } from '../../../services/trpc.js'
import { Button } from '../../ui/Button.js'
import { Input } from '../../ui/Input.js'
import type { MemoryEntryListItem } from './MemoryEntryList.js'

interface MemoryEntryDetailProps {
  entry: MemoryEntryListItem
  onUpdate: () => void
  onArchive: () => void
}

export function MemoryEntryDetail({ entry, onUpdate, onArchive }: MemoryEntryDetailProps) {
  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState(entry.title)
  const [editBody, setEditBody] = useState(entry.body)
  const [editConfidence, setEditConfidence] = useState(entry.confidence)
  const [editTags, setEditTags] = useState(entry.tags.join(', '))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const updateMutation = trpc.memory.update.useMutation()
  const archiveMutation = trpc.memory.archive.useMutation()

  function startEdit() {
    setEditTitle(entry.title)
    setEditBody(entry.body)
    setEditConfidence(entry.confidence)
    setEditTags(entry.tags.join(', '))
    setEditing(true)
    setError(null)
  }

  async function saveEdit() {
    setSaving(true)
    setError(null)
    try {
      await updateMutation.mutateAsync({
        entryId: entry.entryId,
        title: editTitle,
        body: editBody,
        confidence: editConfidence as 'low' | 'medium' | 'high',
        tags: editTags
          .split(',')
          .map((t) => t.trim())
          .filter((t) => t.length > 0),
      })
      setEditing(false)
      onUpdate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  async function handleArchive() {
    if (!confirm('Archive this memory entry? It will no longer appear in agent briefs.')) return
    setSaving(true)
    try {
      await archiveMutation.mutateAsync({ entryId: entry.entryId })
      onArchive()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to archive')
    } finally {
      setSaving(false)
    }
  }

  const kindColors: Record<string, string> = {
    decision: 'text-blue-700 bg-blue-50',
    convention: 'text-green-700 bg-green-50',
    learning: 'text-yellow-800 bg-yellow-50',
    anti_pattern: 'text-red-700 bg-red-50',
    glossary: 'text-purple-700 bg-purple-50',
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span
              className={clsx(
                'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold',
                kindColors[entry.kind] ?? 'text-slate-700 bg-slate-100',
              )}
            >
              {entry.kind.replace('_', ' ')}
            </span>
            <span className="text-xs text-slate-400">
              {entry.confidence} confidence
            </span>
          </div>
          {editing ? (
            <Input
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              className="text-lg font-semibold"
              placeholder="Entry title"
            />
          ) : (
            <h2 className="text-lg font-semibold text-slate-900 break-words">{entry.title}</h2>
          )}
        </div>
        {entry.status === 'active' && !editing && (
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button variant="secondary" size="sm" onClick={startEdit} aria-label="Edit memory entry">
              Edit
            </Button>
            <Button variant="danger" size="sm" onClick={handleArchive} disabled={saving} aria-label="Archive memory entry">
              Archive
            </Button>
          </div>
        )}
        {editing && (
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button variant="secondary" size="sm" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={saveEdit} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      {/* Body */}
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">Body</label>
        {editing ? (
          <textarea
            value={editBody}
            onChange={(e) => setEditBody(e.target.value)}
            rows={10}
            className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-500"
            placeholder="Memory body (markdown supported)"
          />
        ) : (
          <div className="rounded-md bg-slate-50 px-4 py-3 text-sm text-slate-800 whitespace-pre-wrap font-mono leading-relaxed">
            {entry.body}
          </div>
        )}
      </div>

      {/* Metadata */}
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <span className="block text-xs font-medium uppercase tracking-wide text-slate-400 mb-0.5">Scope</span>
          <span className="text-slate-700">
            {entry.scope}
            {entry.scopeValue ? `: ${entry.scopeValue}` : ''}
          </span>
        </div>
        <div>
          <span className="block text-xs font-medium uppercase tracking-wide text-slate-400 mb-0.5">Source</span>
          <span className="text-slate-700">{entry.sourceKind}</span>
        </div>
        <div>
          <span className="block text-xs font-medium uppercase tracking-wide text-slate-400 mb-0.5">Confidence</span>
          {editing ? (
            <select
              value={editConfidence}
              onChange={(e) => setEditConfidence(e.target.value)}
              className="rounded border border-slate-200 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          ) : (
            <span className="text-slate-700">{entry.confidence}</span>
          )}
        </div>
        <div>
          <span className="block text-xs font-medium uppercase tracking-wide text-slate-400 mb-0.5">Recorded</span>
          <span className="text-slate-700">{new Date(entry.createdAt).toLocaleDateString()}</span>
        </div>
      </div>

      {/* Tags */}
      <div>
        <span className="block text-xs font-medium uppercase tracking-wide text-slate-400 mb-1.5">Tags</span>
        {editing ? (
          <Input
            value={editTags}
            onChange={(e) => setEditTags(e.target.value)}
            placeholder="comma-separated tags"
          />
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {entry.tags.length > 0 ? (
              entry.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600"
                >
                  {tag}
                </span>
              ))
            ) : (
              <span className="text-xs text-slate-400">No tags</span>
            )}
          </div>
        )}
      </div>

      {/* Status badge */}
      {entry.status !== 'active' && (
        <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-700">
          Status: {entry.status}
        </div>
      )}
    </div>
  )
}

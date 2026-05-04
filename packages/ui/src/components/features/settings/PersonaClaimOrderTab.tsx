/**
 * PersonaClaimOrderTab — drag-handle reorder for which persona claims first.
 *
 * [Engineer-Principal · Opus · run-settings-agents]
 *
 * No external drag library — uses the native HTML5 drag-and-drop API plus
 * keyboard up/down support for accessibility.
 */

import { useEffect, useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { useActiveProjectStore } from '../../../store/active-project.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'
import { Button } from '../../ui/Button.js'

interface Row {
  slug: string
  displayName: string
  enabled: boolean
}

export function PersonaClaimOrderTab() {
  const activeProjectId = useActiveProjectStore((s) => s.activeProjectId)

  if (!activeProjectId) {
    return (
      <p className="text-sm text-slate-600">
        Select a project from the top bar to configure routing order.
      </p>
    )
  }
  return <Inner projectId={activeProjectId} />
}

function Inner({ projectId }: { projectId: string }) {
  const list = (trpc as unknown as {
    projectPersonas: {
      list: { useQuery: (i: { projectId: string }) => { data?: Row[]; isLoading: boolean; error: { message: string } | null; refetch: () => void } }
    }
  }).projectPersonas.list.useQuery({ projectId })

  const reorder = (trpc as unknown as {
    projectPersonas: {
      reorder: { useMutation: () => { mutateAsync: (i: unknown) => Promise<unknown>; isPending: boolean } }
    }
  }).projectPersonas.reorder.useMutation()

  const [order, setOrder] = useState<Row[]>([])
  const [dirty, setDirty] = useState(false)
  const [dragIdx, setDragIdx] = useState<number | null>(null)

  useEffect(() => {
    if (list.data) {
      setOrder(list.data)
      setDirty(false)
    }
  }, [list.data])

  if (list.isLoading) return <Skeleton rows={6} />
  if (list.error) return <ErrorMessage title="Could not load order" message={list.error.message} />

  function move(from: number, to: number) {
    if (to < 0 || to >= order.length || from === to) return
    const next = order.slice()
    const [item] = next.splice(from, 1)
    if (!item) return
    next.splice(to, 0, item)
    setOrder(next)
    setDirty(true)
  }

  async function save() {
    await reorder.mutateAsync({ projectId, ordering: order.map((r) => r.slug) })
    setDirty(false)
    list.refetch()
  }

  function reset() {
    if (list.data) setOrder(list.data)
    setDirty(false)
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        Drag a persona to change the order in which they claim newly created stories. The first
        enabled persona that matches the story's role takes the work.
      </p>
      <ul className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        {order.map((row, idx) => (
          <li
            key={row.slug}
            draggable
            onDragStart={() => setDragIdx(idx)}
            onDragOver={(e) => {
              e.preventDefault()
            }}
            onDrop={() => {
              if (dragIdx !== null) move(dragIdx, idx)
              setDragIdx(null)
            }}
            onDragEnd={() => setDragIdx(null)}
            className={`flex items-center gap-3 border-b border-slate-100 px-4 py-2.5 last:border-b-0 ${
              dragIdx === idx ? 'bg-brand-50' : ''
            } ${row.enabled ? '' : 'opacity-50'}`}
          >
            <span className="cursor-grab text-slate-400 active:cursor-grabbing" aria-hidden>
              ⋮⋮
            </span>
            <span className="w-6 text-xs font-mono text-slate-500">{idx + 1}</span>
            <span className="flex-1 text-sm font-medium text-slate-900">{row.displayName}</span>
            <code className="font-mono text-[11px] text-slate-500">{row.slug}</code>
            <span className="ml-2 flex gap-1">
              <button
                type="button"
                onClick={() => move(idx, idx - 1)}
                disabled={idx === 0}
                aria-label={`Move ${row.displayName} up`}
                className="rounded border border-slate-200 px-1.5 py-0.5 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-30"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => move(idx, idx + 1)}
                disabled={idx === order.length - 1}
                aria-label={`Move ${row.displayName} down`}
                className="rounded border border-slate-200 px-1.5 py-0.5 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-30"
              >
                ↓
              </button>
            </span>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button variant="primary" onClick={() => void save()} disabled={!dirty || reorder.isPending}>
          {reorder.isPending ? 'Saving…' : 'Save order'}
        </Button>
        <Button variant="secondary" onClick={reset} disabled={!dirty}>
          Reset
        </Button>
      </div>
    </div>
  )
}

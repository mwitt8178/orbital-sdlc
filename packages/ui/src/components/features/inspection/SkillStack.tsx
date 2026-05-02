/**
 * SkillStack — visual stack of loaded skills.
 *
 * Per skill: name, source_sha256 (verifies hook integrity), loadedAt.
 * Click → expands to show full skill id / sha.
 *
 * [Engineer-Sr · Sonnet · run-round6-10-inspection]
 */

import { useState } from 'react'
import type { WorkerInspection } from './types.js'

interface SkillStackProps {
  skills: WorkerInspection['skillsLoaded']
}

interface SkillItemProps {
  skill: WorkerInspection['skillsLoaded'][number]
}

function SkillItem({ skill }: SkillItemProps) {
  const [expanded, setExpanded] = useState(false)

  return (
    <button
      type="button"
      onClick={() => setExpanded((v) => !v)}
      className="w-full rounded-md border border-slate-200 p-2 text-left transition hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-xs text-slate-700">{skill.id}</span>
        <span className="flex-shrink-0 text-[10px] text-slate-400">
          {new Date(skill.loadedAt).toLocaleTimeString()}
        </span>
      </div>
      {expanded && (
        <div className="mt-1.5 space-y-0.5 text-[10px] text-slate-500">
          <div>
            <span className="font-medium">SHA-256: </span>
            <span className="font-mono">{skill.sourceSha256}</span>
          </div>
        </div>
      )}
    </button>
  )
}

export function SkillStack({ skills }: SkillStackProps) {
  if (skills.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-3">
        <h3 className="text-xs font-semibold text-slate-700">Skills Loaded</h3>
        <p className="mt-2 text-xs text-slate-400">No skills loaded yet</p>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <h3 className="mb-2 text-xs font-semibold text-slate-700">
        Skills Loaded
        <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
          {skills.length}
        </span>
      </h3>
      <div className="space-y-1">
        {skills.map((skill) => (
          <SkillItem key={skill.id} skill={skill} />
        ))}
      </div>
    </div>
  )
}

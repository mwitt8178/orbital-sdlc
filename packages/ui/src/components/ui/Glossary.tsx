/**
 * Glossary — `<Term word="capability bundle">capability bundle</Term>` renders
 * the word with a dotted underline and shows a hover/focus popover with the
 * definition.
 *
 * The glossary is keyed by the lowercased word; if the word is not in the
 * registry the component renders the children as plain text.
 */

import { useState, useRef, useEffect, type ReactNode } from 'react'
import clsx from 'clsx'

interface GlossaryEntry {
  short: string
  detail: string
}

const GLOSSARY: Record<string, GlossaryEntry> = {
  'capability bundle': {
    short: 'A scoped, signed grant of authority.',
    detail:
      'A bundle is a short-lived, cryptographically signed grant that lets an agent take a specific set of actions within a single task. Bundles are auditable and revoked when the task ends.',
  },
  scope: {
    short: 'The area of effect a capability covers.',
    detail:
      'A scope is the precise surface a capability bundle authorizes — for example, a set of file paths, a Monday board, or a single API endpoint.',
  },
  persona: {
    short: 'An AI agent role with a defined skill set.',
    detail:
      'A persona is a named role (PM, Architect, Engineer-Sr, Verifier-Test, etc.) with a fixed model tier, prompt, and capability scope. The orchestrator spawns persona sessions to execute tasks.',
  },
  ceremony: {
    short: 'A turn-by-turn structured group event.',
    detail:
      'Ceremonies (planning, ADR review, retro) are structured by a chair persona and produce signed outputs (sprint commitments, decisions, ADRs).',
  },
  blocker: {
    short: 'A structured request for help between agents.',
    detail:
      'When an agent cannot proceed, it posts a blocker with question, context, and a requested resolver role. The orchestrator routes blockers to the right persona.',
  },
  ADR: {
    short: 'Architecture Decision Record.',
    detail:
      'A signed record of an architectural choice, its alternatives, and rationale — durable across system versions.',
  },
  verifier: {
    short: 'An automated quality check.',
    detail:
      'Verifiers (test, lint, coverage, security) run after agent work completes and gate progression to UAT. Failures trigger retries.',
  },
  sprint: {
    short: 'A bounded unit of agent work.',
    detail:
      'A sprint is a story-point and budget bounded set of stories the orchestrator executes via spawned agents. Sprints are immutable once started.',
  },
  hook: {
    short: 'A pre/post-event script.',
    detail:
      'Hooks fire on lifecycle events (TaskStarted, FileEdited, Stop) and can block, log, or transform. They are versioned, signed, and auditable.',
  },
  attestation: {
    short: 'A signed claim about an artifact.',
    detail:
      'An attestation cryptographically asserts that a particular agent produced a particular output at a particular point in time.',
  },
  install_id: {
    short: 'The UUID that identifies this Orbital installation.',
    detail:
      'Generated on first run, persisted to ~/.orbital/config/install.json. Used as the canonical actor identifier for user actions.',
  },
  'retro proposal': {
    short: 'A retro persona-generated change recommendation.',
    detail:
      'After each sprint, the retro persona scans metrics and outcomes and proposes changes to personas, skills, hooks, or routing policy. User approval merges the change into agent-org.',
  },
  'agent-org': {
    short: 'The git repository that holds agent definitions.',
    detail:
      'A git repo (default ~/.orbital/agent-org) holds personas, skills, hooks, and routing policy. Approved retro proposals are merged here as system-version commits.',
  },
  system_version: {
    short: 'A snapshot of agent-org at a point in time.',
    detail:
      'Each system_version is a content-addressable hash of the agent-org repo state. Sprints execute under a pinned system_version for reproducibility.',
  },
  post_id: {
    short: 'Unique identifier for a channel post.',
    detail:
      'Channel posts are append-only and identified by a UUIDv7. Cross-references and replies use post_id as anchor.',
  },
}

interface Props {
  word: string
  children?: ReactNode
}

export function Term({ word, children }: Props) {
  const entry = GLOSSARY[word] ?? GLOSSARY[word.toLowerCase()]
  const [open, setOpen] = useState(false)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        popoverRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) {
        return
      }
      setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  if (!entry) {
    return <span>{children ?? word}</span>
  }

  return (
    <span className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((o) => !o)}
        aria-describedby={open ? `glossary-${word}` : undefined}
        className={clsx(
          'cursor-help border-b border-dotted border-slate-400 bg-transparent text-inherit',
          'focus:outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-brand-500',
        )}
      >
        {children ?? word}
      </button>

      {open && (
        <div
          id={`glossary-${word}`}
          ref={popoverRef}
          role="tooltip"
          className="absolute bottom-full left-1/2 z-50 mb-2 w-64 -translate-x-1/2 rounded-lg border border-slate-200 bg-white p-3 shadow-lg"
        >
          <div className="mb-1 text-xs font-semibold text-slate-900">{word}</div>
          <p className="text-xs text-slate-600">{entry.detail}</p>
        </div>
      )}
    </span>
  )
}

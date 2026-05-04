/**
 * ProjectBreadcrumb — renders the active project name (with sensible fallback)
 * as the leftmost breadcrumb item. Replaces the hardcoded "Acme Product"
 * literal that used to live on Dashboard / Backlog / Vision / Retro / UAT /
 * Audit / Ceremonies.
 *
 * [Engineer-Principal · Opus · run-handoff-audit-001]
 */

import { useActiveProject } from '../../services/use-active-project.js'

interface Props {
  /** Pages render their own '›' between segments; we only return the label. */
  className?: string
}

export function ProjectBreadcrumb({ className }: Props) {
  const { activeProject, isLoading } = useActiveProject()
  const label = isLoading
    ? 'Loading…'
    : activeProject
      ? activeProject.name
      : 'Untitled project'
  return (
    <span className={className} data-testid="project-breadcrumb">
      {label}
    </span>
  )
}

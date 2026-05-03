/**
 * ProjectBasicsStep — collect project name + slug + description.
 *
 * Round 9 — Onboarding UX Overhaul
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
 */

import { useEffect, useMemo, useState } from 'react'
import { InlineValidationField } from '../../ui/InlineValidationField.js'
import { TimeEstimateBadge } from '../../ui/TimeEstimateBadge.js'

export interface ProjectBasics {
  name: string
  slug: string
  description: string
}

interface Props {
  initial?: ProjectBasics
  onChange: (next: ProjectBasics, valid: boolean) => void
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

function suggestSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

export function ProjectBasicsStep({ initial, onChange }: Props) {
  const [name, setName] = useState(initial?.name ?? '')
  const [slug, setSlug] = useState(initial?.slug ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [slugTouched, setSlugTouched] = useState((initial?.slug ?? '').length > 0)

  // Auto-fill slug from name until the user touches the slug field directly.
  useEffect(() => {
    if (!slugTouched) {
      setSlug(suggestSlug(name))
    }
  }, [name, slugTouched])

  const valid = useMemo(() => {
    return name.trim().length > 0 && SLUG_RE.test(slug)
  }, [name, slug])

  useEffect(() => {
    onChange({ name, slug, description }, valid)
  }, [name, slug, description, valid, onChange])

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Project basics</h1>
        <TimeEstimateBadge estSeconds={60} />
      </div>
      <p className="mb-6 text-sm text-slate-500">
        Tell us what you're building. The slug becomes the URL fragment.
      </p>

      <div className="space-y-4">
        <InlineValidationField
          label="Project name"
          placeholder="Apprentice"
          value={name}
          onValueChange={setName}
          helperText="Shows up in headers + the Monday board name."
          validate={(v) => (v.trim().length === 0 ? 'Name is required.' : null)}
        />

        <InlineValidationField
          label="Slug"
          placeholder="apprentice"
          value={slug}
          onValueChange={(v) => {
            setSlug(v)
            setSlugTouched(true)
          }}
          helperText="lowercase letters, digits, hyphens; 2-64 chars."
          validate={(v) =>
            SLUG_RE.test(v)
              ? null
              : 'Slug must be 2-64 chars: lowercase letters, digits, or hyphens.'
          }
        />

        <div>
          <label
            htmlFor="project-description"
            className="block text-sm font-medium text-slate-700"
          >
            Description{' '}
            <span className="font-normal text-slate-500">(optional)</span>
          </label>
          <textarea
            id="project-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            placeholder="A one-line summary of what this project is."
          />
        </div>
      </div>
    </div>
  )
}

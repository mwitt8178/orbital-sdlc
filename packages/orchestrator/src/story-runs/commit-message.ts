/**
 * commit-message.ts — Conventional Commit construction for story-pr runs.
 *
 * [Engineer-Principal · Opus · run-story-pr-pipeline]
 */

/** Slug a story title for use in a Conventional Commit subject. */
export function slugifyTitle(title: string, maxLen = 60): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/g, '')
  return base.length > 0 ? base : 'story'
}

/** Short ID — first 8 hex chars of a UUID. */
export function shortId(id: string): string {
  return id.replace(/-/g, '').slice(0, 8)
}

/**
 * Build a Conventional Commit message for a story PR run.
 *
 * Subject line stays under 72 chars where possible. Body references the
 * full story id and includes a Co-Authored-By trailer for attribution.
 */
export function buildCommitMessage(opts: {
  storyId: string
  title: string
  redirectNote?: string | null
}): string {
  const sid = shortId(opts.storyId)
  const slug = slugifyTitle(opts.title)
  const subject = `feat(story-${sid}): ${opts.title.trim()}`.slice(0, 100)
  const lines: string[] = [subject, '', `Closes story ${opts.storyId}`]
  if (opts.redirectNote && opts.redirectNote.trim().length > 0) {
    lines.push('', 'Reviewer redirect:', opts.redirectNote.trim())
  }
  lines.push('', 'Co-Authored-By: Orbital <noreply@orbital.local>')
  void slug
  return lines.join('\n')
}

/** Default branch name convention for story-pr runs. */
export function buildBranchName(storyId: string): string {
  return `orbital/story-${shortId(storyId)}`
}

/**
 * vault-sync/markdown.ts — Pure render + parse of vault markdown files.
 *
 * [Engineer-Principal · Opus · run-obsidian-vault-sync]
 *
 * Format:
 *   ---
 *   <yaml frontmatter>
 *   ---
 *   <body>
 *
 * We use a tiny in-house YAML serialiser/parser scoped to the small,
 * schema-controlled shape we write. Pulling in a full YAML library for this
 * surface would be overkill and would balloon the bundle.
 */

import { createHash } from 'node:crypto'
import { FrontmatterSchema, type Frontmatter, type VaultEntity } from './types.js'

const FENCE = '---'

/**
 * renderMarkdown — serialise a VaultEntity to the on-disk markdown form.
 * Deterministic: same input → byte-identical output (for content_hash).
 */
export function renderMarkdown(entity: VaultEntity): string {
  const fm: Frontmatter = FrontmatterSchema.parse({
    orbital_id: entity.id,
    tenant_id: entity.tenantId,
    project_id: entity.projectId,
    type: entity.type,
    title: entity.title,
    status: entity.status,
    created_at: entity.createdAt,
    updated_at: entity.updatedAt,
    links: entity.links ?? [],
    tags: entity.tags ?? [],
  })

  const body = entity.body.endsWith('\n') ? entity.body : `${entity.body}\n`
  return `${FENCE}\n${serialiseFrontmatter(fm)}${FENCE}\n\n${body}`
}

/**
 * parseMarkdown — inverse of renderMarkdown. Validates frontmatter against
 * the Zod schema and throws on invalid input.
 */
export function parseMarkdown(input: string): { frontmatter: Frontmatter; body: string } {
  if (!input.startsWith(`${FENCE}\n`)) {
    throw new Error('vault-sync: markdown is missing opening frontmatter fence')
  }
  const closeIdx = input.indexOf(`\n${FENCE}\n`, FENCE.length + 1)
  if (closeIdx === -1) {
    throw new Error('vault-sync: markdown is missing closing frontmatter fence')
  }
  const yaml = input.slice(FENCE.length + 1, closeIdx + 1)
  const body = input.slice(closeIdx + FENCE.length + 2).replace(/^\n/, '')
  const raw = parseFrontmatter(yaml)
  const fm = FrontmatterSchema.parse(raw)
  return { frontmatter: fm, body }
}

/**
 * contentHash — sha256 of the serialised markdown. Stable, hex-encoded.
 */
export function contentHash(rendered: string): string {
  return createHash('sha256').update(rendered, 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// Tiny YAML serialiser/parser — only handles the shape used by Frontmatter.
// Strings, numbers, arrays of strings. No nesting, no anchors, no flow style
// other than `[a, b]` for arrays.
// ---------------------------------------------------------------------------

function serialiseFrontmatter(fm: Frontmatter): string {
  const lines: string[] = []
  // Stable key order so content_hash is stable.
  const keys: (keyof Frontmatter)[] = [
    'orbital_id',
    'tenant_id',
    'project_id',
    'type',
    'title',
    'status',
    'created_at',
    'updated_at',
    'tags',
    'links',
  ]
  for (const key of keys) {
    const value = fm[key]
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      const items = value.map(yamlString).join(', ')
      lines.push(`${key}: [${items}]`)
    } else {
      lines.push(`${key}: ${yamlString(String(value))}`)
    }
  }
  return `${lines.join('\n')}\n`
}

function yamlString(input: string): string {
  // Quote anything that contains chars YAML would otherwise interpret.
  if (/^[A-Za-z0-9_\-./:]+$/.test(input)) return input
  return `"${input.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function parseFrontmatter(yaml: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const rawLine of yaml.split('\n')) {
    const line = rawLine.trimEnd()
    if (line.length === 0) continue
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const key = line.slice(0, colon).trim()
    const valueRaw = line.slice(colon + 1).trim()
    if (valueRaw.startsWith('[') && valueRaw.endsWith(']')) {
      const inner = valueRaw.slice(1, -1).trim()
      if (inner.length === 0) {
        out[key] = []
      } else {
        out[key] = splitYamlList(inner).map(unquoteYaml)
      }
    } else {
      out[key] = unquoteYaml(valueRaw)
    }
  }
  return out
}

function splitYamlList(inner: string): string[] {
  const parts: string[] = []
  let current = ''
  let inQuotes = false
  let escape = false
  for (const ch of inner) {
    if (escape) {
      current += ch
      escape = false
      continue
    }
    if (ch === '\\') {
      escape = true
      current += ch
      continue
    }
    if (ch === '"') {
      inQuotes = !inQuotes
      current += ch
      continue
    }
    if (ch === ',' && !inQuotes) {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim().length > 0) parts.push(current.trim())
  return parts
}

function unquoteYaml(input: string): string {
  if (input.length >= 2 && input.startsWith('"') && input.endsWith('"')) {
    return input.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  return input
}

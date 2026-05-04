/**
 * manifest.test.ts — assert manifest.json conforms to Obsidian's required schema.
 *
 * [Engineer-Principal · Opus · run-obsidian-vault-sync]
 *
 * Required fields per the Obsidian community plugin spec:
 *   id, name, version, minAppVersion, description, author, isDesktopOnly
 *
 * The Obsidian app silently refuses to load plugins missing these fields.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(
  readFileSync(join(here, '../../manifest.json'), 'utf8'),
) as {
  id: string
  name: string
  version: string
  minAppVersion: string
  description: string
  author: string
  isDesktopOnly: boolean
}

describe('manifest.json', () => {
  it('declares all required Obsidian plugin fields', () => {
    expect(manifest.id).toBe('orbital-vault-sync')
    expect(manifest.name).toBeTruthy()
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(manifest.minAppVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(manifest.description).toBeTruthy()
    expect(manifest.author).toBeTruthy()
    expect(typeof manifest.isDesktopOnly).toBe('boolean')
  })

  it('id is kebab-case (Obsidian requires this for the folder name)', () => {
    expect(manifest.id).toMatch(/^[a-z][a-z0-9-]*$/)
  })

  it('isDesktopOnly is true (we use node:crypto + filesystem ops)', () => {
    expect(manifest.isDesktopOnly).toBe(true)
  })
})

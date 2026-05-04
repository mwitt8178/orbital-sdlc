import { promises as fs } from 'node:fs'
import path from 'node:path'
import { uuidv7 } from 'uuidv7'
import { z } from 'zod'
import { getOrbitalHome } from './env.js'

/** Branded install ID — UUIDv7. */
export type InstallId = string & { readonly __brand: 'InstallId' }

const installSchema = z.object({
  install_id: z.string().uuid(),
  created_at: z.string().datetime(),
  schema_version: z.literal(1),
})

export type InstallConfig = z.infer<typeof installSchema>

let cached: InstallConfig | null = null

export async function loadOrCreateInstall(): Promise<InstallConfig> {
  if (cached) return cached
  // Stable install_id from env in cloud deploys — avoids the per-Lambda-
  // instance /tmp ephemeral bug where each container minted its own UUID.
  const fromEnv = process.env['ORBITAL_INSTALL_ID']
  if (fromEnv) {
    const config: InstallConfig = {
      install_id: fromEnv,
      created_at: process.env['ORBITAL_INSTALL_CREATED_AT'] ?? new Date(0).toISOString(),
      schema_version: 1,
    }
    cached = installSchema.parse(config)
    return cached
  }
  const configDir = path.join(getOrbitalHome(), 'config')
  const configPath = path.join(configDir, 'install.json')

  try {
    const raw = await fs.readFile(configPath, 'utf-8')
    const parsed = installSchema.parse(JSON.parse(raw))
    cached = parsed
    return parsed
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err
    }
    // First run — generate.
    await fs.mkdir(configDir, { recursive: true, mode: 0o700 })
    const config: InstallConfig = {
      install_id: uuidv7(),
      created_at: new Date().toISOString(),
      schema_version: 1,
    }
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 })
    cached = config
    return config
  }
}

export async function getInstallId(): Promise<InstallId> {
  const cfg = await loadOrCreateInstall()
  return cfg.install_id as InstallId
}

/** Test helper. */
export function resetInstallCache(): void {
  cached = null
}

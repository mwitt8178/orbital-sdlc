/**
 * drivers/registry.ts — singleton registry for LLM drivers.
 *
 * Drivers are registered at startup by index.ts. The routing engine and
 * fallback chain query this registry to resolve the active driver for a
 * given provider ID.
 */

import type { LLMDriver } from './types.js'

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const _registry = new Map<string, LLMDriver>()

export function registerDriver(driver: LLMDriver): void {
  _registry.set(driver.providerId, driver)
}

export function getDriver(providerId: string): LLMDriver | undefined {
  return _registry.get(providerId)
}

export function listDrivers(): LLMDriver[] {
  return [..._registry.values()]
}

export function clearDrivers(): void {
  _registry.clear()
}

/**
 * Get a driver or throw if not registered. Used by routing engine to fail
 * loudly rather than silently skip a configured provider.
 */
export function requireDriver(providerId: string): LLMDriver {
  const driver = _registry.get(providerId)
  if (!driver) {
    throw new Error(
      `STARTUP_ERROR: LLM driver '${providerId}' is not registered. ` +
        `Registered providers: [${[..._registry.keys()].join(', ')}]`,
    )
  }
  return driver
}

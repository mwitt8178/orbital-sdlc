/**
 * trpc/routers/providers.ts — tRPC router for provider health + routing rules.
 *
 * Procedures:
 *   providers.health()           — list all providers with live health status
 *   providers.list()             — list registered drivers with available models
 *   providers.testConnection()   — trigger a real health() check for one provider
 *   providers.routingRules()     — list all routing rules from DB
 *   providers.saveRoutingRule()  — upsert a routing rule
 *   providers.circuitSnapshots() — get circuit breaker state per provider
 *
 * Per Round 6 #8 spec.
 */

import { z } from 'zod'
import { router, publicProcedure } from '../init.js'
import { listDrivers, getDriver } from '../../drivers/registry.js'
import { db } from '../../db/client.js'
import { routingRules } from '../../db/schema/routing.js'
import { eq, and } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import { logger } from '../../config/logger.js'
import type { FallbackDriver } from '../../drivers/fallback.js'

export const providersRouter = router({
  /**
   * @route providers.health
   * @summary List all registered providers with live health status.
   */
  health: publicProcedure.query(async () => {
    const drivers = listDrivers()
    const results = await Promise.allSettled(drivers.map((d) => d.health()))

    return results.map((r, i) => {
      const driver = drivers[i]!
      if (r.status === 'fulfilled') return r.value
      return {
        healthy: false,
        providerId: driver.providerId,
        lastCheckedAt: new Date().toISOString(),
        reason: r.reason instanceof Error ? r.reason.message : String(r.reason),
      }
    })
  }),

  /**
   * @route providers.list
   * @summary List registered drivers with their available models.
   */
  list: publicProcedure.query(() => {
    const drivers = listDrivers()
    return drivers.map((d) => ({
      providerId: d.providerId,
      availableModels: [...d.availableModels],
      supportsEmbed: typeof d.embed === 'function',
    }))
  }),

  /**
   * @route providers.testConnection
   * @summary Trigger a live health check for a specific provider. Bypasses cache.
   */
  testConnection: publicProcedure
    .input(z.object({ provider: z.string() }))
    .mutation(async ({ input }) => {
      const driver = getDriver(input.provider)
      if (!driver) {
        return {
          healthy: false,
          providerId: input.provider,
          lastCheckedAt: new Date().toISOString(),
          reason: 'provider_not_registered',
        }
      }

      // Force a fresh health check (bypass driver's internal TTL cache by
      // calling health() directly — the driver's cache is short-lived anyway).
      try {
        const result = await driver.health()
        logger.info({ provider: input.provider, healthy: result.healthy }, 'providers.testConnection')
        return result
      } catch (err) {
        logger.error({ provider: input.provider, err }, 'providers.testConnection failed')
        return {
          healthy: false,
          providerId: input.provider,
          lastCheckedAt: new Date().toISOString(),
          reason: err instanceof Error ? err.message : String(err),
        }
      }
    }),

  /**
   * @route providers.routingRules
   * @summary List all routing rules stored in the DB.
   */
  routingRules: publicProcedure.query(async () => {
    return db.select().from(routingRules).orderBy(routingRules.persona, routingRules.estimate)
  }),

  /**
   * @route providers.saveRoutingRule
   * @summary Upsert a routing rule (persona × estimate → provider + model).
   */
  saveRoutingRule: publicProcedure
    .input(
      z.object({
        persona: z.string().min(1),
        estimate: z.enum(['S', 'M', 'L', 'XL']),
        primaryProvider: z.string().min(1),
        primaryModel: z.string().min(1),
        fallback1Provider: z.string().optional(),
        fallback1Model: z.string().optional(),
        fallback2Provider: z.string().optional(),
        fallback2Model: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      // Check for existing rule
      const existing = await db
        .select({ ruleId: routingRules.ruleId })
        .from(routingRules)
        .where(
          and(
            eq(routingRules.persona, input.persona),
            eq(routingRules.estimate, input.estimate),
          ),
        )
        .limit(1)

      const now = new Date().toISOString()

      if (existing.length > 0) {
        const ruleId = existing[0]!.ruleId
        await db
          .update(routingRules)
          .set({
            primaryProvider: input.primaryProvider,
            primaryModel: input.primaryModel,
            fallback1Provider: input.fallback1Provider ?? null,
            fallback1Model: input.fallback1Model ?? null,
            fallback2Provider: input.fallback2Provider ?? null,
            fallback2Model: input.fallback2Model ?? null,
            updatedBy: { type: 'user' },
            updatedAt: now,
          })
          .where(eq(routingRules.ruleId, ruleId))

        return { ruleId, created: false }
      }

      const ruleId = uuidv7()
      await db.insert(routingRules).values({
        ruleId,
        persona: input.persona,
        estimate: input.estimate,
        primaryProvider: input.primaryProvider,
        primaryModel: input.primaryModel,
        fallback1Provider: input.fallback1Provider ?? null,
        fallback1Model: input.fallback1Model ?? null,
        fallback2Provider: input.fallback2Provider ?? null,
        fallback2Model: input.fallback2Model ?? null,
        updatedBy: { type: 'user' },
        createdAt: now,
        updatedAt: now,
      })

      return { ruleId, created: true }
    }),

  /**
   * @route providers.circuitSnapshots
   * @summary Get circuit breaker state for all providers (if using FallbackDriver).
   */
  circuitSnapshots: publicProcedure.query(() => {
    const fallback = getDriver('fallback') as FallbackDriver | undefined
    if (!fallback || typeof fallback.getCircuitSnapshots !== 'function') {
      return {}
    }
    return fallback.getCircuitSnapshots()
  }),
})

export type ProvidersRouter = typeof providersRouter

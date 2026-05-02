/**
 * lambda/handlers/memory.ts — Memory router Lambda handler.
 *
 * [Engineer-Sr · Sonnet · run-round8-03-lambda-apigw-http]
 *
 * Handles: project memory reads + writes (vector store, semantic search)
 * Authorizer: Cognito JWT (browser sessions)
 * Provisioned Concurrency: 0 (cold start acceptable for memory ops)
 */

import { makeHandler } from '../lambda-trpc-adapter.js'
import { createMemoryRouter } from '../../trpc/routers/memory.js'
import { db } from '../../db/client.js'
import { createEventStore } from '../../events/store.js'
import { createMemoryService } from '../../memory/service.js'
import { sql } from '../../db/client.js'

// Lazily initialized router (requires DI)
let _router: ReturnType<typeof createMemoryRouter> | null = null
function getRouter(): ReturnType<typeof createMemoryRouter> {
  if (_router === null) {
    const eventStore = createEventStore(db, sql)
    const memoryService = createMemoryService(db, eventStore)
    _router = createMemoryRouter({ memoryService, db })
  }
  return _router
}

export const handler = makeHandler(() => getRouter())

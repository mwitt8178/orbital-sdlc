/**
 * lambda/handlers/defects.ts — Defects router Lambda handler.
 *
 * [Engineer-Sr · Sonnet · run-round8-03-lambda-apigw-http]
 *
 * Handles: UAT defect tracking (create, update, resolve)
 * Authorizer: Cognito JWT (browser sessions)
 * Provisioned Concurrency: 0
 */

import { makeHandler } from '../lambda-trpc-adapter.js'
import { createUATRouter } from '../../trpc/routers/uat.js'
import { db } from '../../db/client.js'
import { sql } from '../../db/client.js'
import { createEventStore } from '../../events/store.js'
import { createBacklogService } from '../../backlog/service.js'
import { createPersonaOfRecord } from '../../uat/persona-of-record.js'
import { createDefectService } from '../../uat/defects.js'
import { createUATService } from '../../uat/service.js'

let _router: ReturnType<typeof createUATRouter> | null = null
function getRouter(): ReturnType<typeof createUATRouter> {
  if (_router === null) {
    const eventStore = createEventStore(db, sql)
    const backlogService = createBacklogService(db, eventStore)
    const personaOfRecord = createPersonaOfRecord(db, eventStore)
    const defectService = createDefectService(db, eventStore, backlogService)
    const uatService = createUATService(db, eventStore, defectService, personaOfRecord)
    _router = createUATRouter({ uatService, defectService, db })
  }
  return _router
}

export const handler = makeHandler(() => getRouter())

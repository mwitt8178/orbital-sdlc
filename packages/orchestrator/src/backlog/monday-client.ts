/**
 * backlog/monday-client.ts — Real Monday.com API v2 GraphQL client.
 *
 * Per TRD-02 v0.2 §13.2 and Implementation Plan §8 Task 4B "Done when".
 *
 * Behavior:
 *   - GraphQL POST to https://api.monday.com/v2 with Authorization: Bearer <token>
 *   - Throws INTEGRATION_MONDAY_DOWN on 5xx / network failure (NOT mock data)
 *   - Throws INTEGRATION_MONDAY_AUTH on 401 / 403
 *   - Throws RATE_LIMIT_MONDAY_API on 429 (after exhausted retries)
 *   - Honors Retry-After (seconds), with exponential backoff capped at 60s
 *   - Throws STARTUP_ERROR if MONDAY_API_TOKEN missing in env
 *
 * Token resolution order:
 *   1. Constructor-injected `token` option (test surrogate)
 *   2. Keychain account 'monday_api_token' (production)
 *   3. process.env.MONDAY_API_TOKEN (dev fallback)
 *   4. Throw STARTUP_ERROR
 */

import { OrbitalError } from '@orbital/types'
import { logger } from '../config/logger.js'
import { getKeychain } from '../capabilities/keychain.js'
import { BACKLOG_ERROR_CODES } from './types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MondayClientOptions {
  /** Override token; bypasses keychain + env. */
  token?: string
  /** Override API endpoint (test). Default https://api.monday.com/v2 */
  apiUrl?: string
  /** Max retries before surfacing rate-limit error. Default 5. */
  maxRetries?: number
  /** Base backoff (ms) before exponentiation. Default 1000. */
  baseBackoffMs?: number
  /** Max backoff cap (ms). Default 60000. */
  maxBackoffMs?: number
  /** Optional fetch override (test). */
  fetchImpl?: typeof fetch
  /** Optional sleep override (test). */
  sleepFn?: (ms: number) => Promise<void>
}

export interface CreateSubitemParams {
  parentItemId: string
  itemName: string
  columnValues?: Record<string, unknown>
}

export interface MondayItem {
  id: string
  name: string
  columnValues: Array<{ id: string; value: string | null }>
}

export interface MondayClient {
  createSubitem(params: CreateSubitemParams): Promise<{ id: string }>
  getItem(itemId: string): Promise<MondayItem | null>
  getBoardItems(boardId: string): Promise<MondayItem[]>
  updateColumnValue(params: {
    boardId: string
    itemId: string
    columnId: string
    value: string
  }): Promise<{ id: string }>
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DefaultMondayClient implements MondayClient {
  private resolvedToken: string | null = null
  private readonly apiUrl: string
  private readonly maxRetries: number
  private readonly baseBackoffMs: number
  private readonly maxBackoffMs: number
  private readonly fetchImpl: typeof fetch
  private readonly sleepFn: (ms: number) => Promise<void>
  private readonly explicitToken?: string

  constructor(options: MondayClientOptions = {}) {
    this.apiUrl = options.apiUrl ?? 'https://api.monday.com/v2'
    this.maxRetries = options.maxRetries ?? 5
    this.baseBackoffMs = options.baseBackoffMs ?? 1000
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.sleepFn = options.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    if (options.token) this.explicitToken = options.token
  }

  // -------------------------------------------------------------------------
  // Token resolution
  // -------------------------------------------------------------------------

  private async resolveToken(): Promise<string> {
    if (this.resolvedToken) return this.resolvedToken

    if (this.explicitToken) {
      this.resolvedToken = this.explicitToken
      return this.resolvedToken
    }

    // Try keychain
    try {
      const kc = await getKeychain()
      const stored = await kc.getPassword('monday_api_token')
      if (stored && stored.length > 0) {
        this.resolvedToken = stored
        return stored
      }
    } catch (err) {
      logger.debug({ err }, 'MondayClient: keychain lookup failed; falling back to env')
    }

    // Fall back to env var
    const envToken = process.env['MONDAY_API_TOKEN']
    if (envToken && envToken.length > 0) {
      this.resolvedToken = envToken
      return envToken
    }

    throw new OrbitalError(
      BACKLOG_ERROR_CODES.STARTUP_ERROR,
      'MONDAY_API_TOKEN is not set; set it in env or store under keychain account monday_api_token',
    )
  }

  // -------------------------------------------------------------------------
  // GraphQL request with retry
  // -------------------------------------------------------------------------

  /**
   * Execute a raw GraphQL query/mutation against Monday. Public so that
   * BoardDiscoveryService and other introspection callers can issue custom
   * queries while reusing this client's auth, retry, and rate-limit pipeline.
   *
   * Most callers should prefer the high-level methods (createSubitem, getItem,
   * etc.). Use this only when you need a query shape not exposed there.
   */
  public async graphql<T = unknown>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    const token = await this.resolveToken()

    let lastErr: unknown = null
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await this.fetchImpl(this.apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'API-Version': '2024-01',
          },
          body: JSON.stringify({ query, variables }),
        })

        if (res.status === 401 || res.status === 403) {
          throw new OrbitalError(
            BACKLOG_ERROR_CODES.INTEGRATION_MONDAY_AUTH,
            `Monday auth failed: HTTP ${res.status}`,
            { status: res.status },
          )
        }

        if (res.status === 429) {
          // Rate limited: parse Retry-After
          const retryAfter = parseRetryAfter(res.headers.get('retry-after'))
          if (attempt >= this.maxRetries) {
            throw new OrbitalError(
              BACKLOG_ERROR_CODES.RATE_LIMIT_MONDAY_API,
              `Monday rate limit exhausted after ${this.maxRetries} retries`,
              { retry_after_ms: retryAfter },
            )
          }
          const backoff = this.computeBackoff(attempt, retryAfter)
          logger.warn({ attempt, backoff_ms: backoff }, 'MondayClient: 429; retrying')
          await this.sleepFn(backoff)
          continue
        }

        if (res.status >= 500) {
          if (attempt >= this.maxRetries) {
            throw new OrbitalError(
              BACKLOG_ERROR_CODES.INTEGRATION_MONDAY_DOWN,
              `Monday ${res.status} after ${this.maxRetries} retries`,
              { status: res.status },
            )
          }
          const backoff = this.computeBackoff(attempt)
          logger.warn(
            { attempt, status: res.status, backoff_ms: backoff },
            'MondayClient: 5xx; retrying',
          )
          await this.sleepFn(backoff)
          continue
        }

        if (!res.ok) {
          throw new OrbitalError(
            BACKLOG_ERROR_CODES.INTEGRATION_MONDAY_DOWN,
            `Monday request failed: HTTP ${res.status}`,
            { status: res.status },
          )
        }

        const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> }
        if (json.errors && json.errors.length > 0) {
          // Monday returns 200 with embedded errors (GraphQL convention).
          // These are deterministic — never retry.
          const message = json.errors.map((e) => e.message).join('; ')
          throw new OrbitalError(
            BACKLOG_ERROR_CODES.INTEGRATION_MONDAY_DOWN,
            `Monday GraphQL errors: ${message}`,
            { errors: json.errors, retryable: false },
          )
        }
        if (!json.data) {
          throw new OrbitalError(
            BACKLOG_ERROR_CODES.INTEGRATION_MONDAY_DOWN,
            'Monday response missing data field',
            { retryable: false },
          )
        }
        return json.data
      } catch (err) {
        lastErr = err
        // Re-throw OrbitalError to surface to caller for terminal conditions:
        //   - auth failure (don't retry; user must reauthorize)
        //   - rate-limit exhausted (already retried internally)
        //   - startup error (token missing)
        //   - INTEGRATION_MONDAY_DOWN with retryable=false (GraphQL-level errors)
        if (err instanceof OrbitalError) {
          if (
            err.code === BACKLOG_ERROR_CODES.INTEGRATION_MONDAY_AUTH ||
            err.code === BACKLOG_ERROR_CODES.RATE_LIMIT_MONDAY_API ||
            err.code === BACKLOG_ERROR_CODES.STARTUP_ERROR
          ) {
            throw err
          }
          if (
            err.code === BACKLOG_ERROR_CODES.INTEGRATION_MONDAY_DOWN &&
            err.details?.['retryable'] === false
          ) {
            throw err
          }
        }

        // Network error → treat as 5xx (retry)
        if (attempt >= this.maxRetries) {
          throw new OrbitalError(
            BACKLOG_ERROR_CODES.INTEGRATION_MONDAY_DOWN,
            `Monday request failed after ${this.maxRetries} retries: ${(err as Error).message}`,
            { cause: (err as Error).message },
          )
        }
        const backoff = this.computeBackoff(attempt)
        logger.warn({ attempt, err, backoff_ms: backoff }, 'MondayClient: network error; retrying')
        await this.sleepFn(backoff)
      }
    }

    // Should not reach here; surface lastErr defensively
    throw new OrbitalError(
      BACKLOG_ERROR_CODES.INTEGRATION_MONDAY_DOWN,
      `Monday request loop exited unexpectedly: ${(lastErr as Error)?.message ?? 'unknown'}`,
    )
  }

  private computeBackoff(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs && retryAfterMs > 0) {
      return Math.min(retryAfterMs, this.maxBackoffMs)
    }
    const exp = this.baseBackoffMs * Math.pow(2, attempt)
    return Math.min(exp, this.maxBackoffMs)
  }

  // -------------------------------------------------------------------------
  // High-level API
  // -------------------------------------------------------------------------

  async createSubitem(params: CreateSubitemParams): Promise<{ id: string }> {
    const query = `
      mutation CreateSubitem($parentItemId: ID!, $itemName: String!, $columnValues: JSON) {
        create_subitem(
          parent_item_id: $parentItemId,
          item_name: $itemName,
          column_values: $columnValues
        ) {
          id
        }
      }
    `
    const data = await this.graphql<{ create_subitem: { id: string } }>(query, {
      parentItemId: params.parentItemId,
      itemName: params.itemName,
      columnValues: params.columnValues ? JSON.stringify(params.columnValues) : null,
    })
    return { id: data.create_subitem.id }
  }

  async getItem(itemId: string): Promise<MondayItem | null> {
    const query = `
      query GetItem($itemId: [ID!]!) {
        items(ids: $itemId) {
          id
          name
          column_values {
            id
            value
          }
        }
      }
    `
    const data = await this.graphql<{
      items: Array<{
        id: string
        name: string
        column_values: Array<{ id: string; value: string | null }>
      }>
    }>(query, { itemId: [itemId] })
    const first = data.items[0]
    if (!first) return null
    return {
      id: first.id,
      name: first.name,
      columnValues: first.column_values,
    }
  }

  async getBoardItems(boardId: string): Promise<MondayItem[]> {
    const query = `
      query GetBoardItems($boardId: [ID!]!) {
        boards(ids: $boardId) {
          items_page {
            items {
              id
              name
              column_values {
                id
                value
              }
            }
          }
        }
      }
    `
    const data = await this.graphql<{
      boards: Array<{
        items_page: {
          items: Array<{
            id: string
            name: string
            column_values: Array<{ id: string; value: string | null }>
          }>
        }
      }>
    }>(query, { boardId: [boardId] })
    const items = data.boards[0]?.items_page.items ?? []
    return items.map((i) => ({
      id: i.id,
      name: i.name,
      columnValues: i.column_values,
    }))
  }

  async updateColumnValue(params: {
    boardId: string
    itemId: string
    columnId: string
    value: string
  }): Promise<{ id: string }> {
    const query = `
      mutation UpdateColumnValue($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
        change_column_value(
          board_id: $boardId,
          item_id: $itemId,
          column_id: $columnId,
          value: $value
        ) {
          id
        }
      }
    `
    const data = await this.graphql<{ change_column_value: { id: string } }>(query, {
      boardId: params.boardId,
      itemId: params.itemId,
      columnId: params.columnId,
      value: params.value,
    })
    return { id: data.change_column_value.id }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse Retry-After header. Supports seconds (int) or HTTP-date.
 * Returns milliseconds, or undefined if unparseable.
 */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined
  const asInt = Number.parseInt(header, 10)
  if (Number.isFinite(asInt) && asInt >= 0) return asInt * 1000
  const asDate = Date.parse(header)
  if (Number.isFinite(asDate)) {
    const diff = asDate - Date.now()
    return diff > 0 ? diff : 0
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMondayClient(options: MondayClientOptions = {}): MondayClient {
  return new DefaultMondayClient(options)
}

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
export interface MondayClientOptions {
    /** Override token; bypasses keychain + env. */
    token?: string;
    /** Override API endpoint (test). Default https://api.monday.com/v2 */
    apiUrl?: string;
    /** Max retries before surfacing rate-limit error. Default 5. */
    maxRetries?: number;
    /** Base backoff (ms) before exponentiation. Default 1000. */
    baseBackoffMs?: number;
    /** Max backoff cap (ms). Default 60000. */
    maxBackoffMs?: number;
    /** Optional fetch override (test). */
    fetchImpl?: typeof fetch;
    /** Optional sleep override (test). */
    sleepFn?: (ms: number) => Promise<void>;
}
export interface CreateSubitemParams {
    parentItemId: string;
    itemName: string;
    columnValues?: Record<string, unknown>;
}
export interface MondayItem {
    id: string;
    name: string;
    columnValues: Array<{
        id: string;
        value: string | null;
    }>;
}
export interface MondayClient {
    createSubitem(params: CreateSubitemParams): Promise<{
        id: string;
    }>;
    getItem(itemId: string): Promise<MondayItem | null>;
    getBoardItems(boardId: string): Promise<MondayItem[]>;
    updateColumnValue(params: {
        boardId: string;
        itemId: string;
        columnId: string;
        value: string;
    }): Promise<{
        id: string;
    }>;
    /**
     * Round 9 — generic GraphQL passthrough for the onboarding Monday
     * provisioner. Reuses the same auth + retry + 429-backoff pipeline as the
     * high-level methods. Public so callers needing endpoints not exposed by
     * the high-level surface (create_board, create_column, etc.) can issue
     * arbitrary queries without bypassing the auth/retry pipeline.
     * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
     */
    graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T>;
}
export declare class DefaultMondayClient implements MondayClient {
    private resolvedToken;
    private readonly apiUrl;
    private readonly maxRetries;
    private readonly baseBackoffMs;
    private readonly maxBackoffMs;
    private readonly fetchImpl;
    private readonly sleepFn;
    private readonly explicitToken?;
    constructor(options?: MondayClientOptions);
    private resolveToken;
    /**
     * Execute a raw GraphQL query/mutation against Monday. Public so that
     * BoardDiscoveryService and other introspection callers can issue custom
     * queries while reusing this client's auth, retry, and rate-limit pipeline.
     *
     * Most callers should prefer the high-level methods (createSubitem, getItem,
     * etc.). Use this only when you need a query shape not exposed there.
     */
    graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T>;
    private computeBackoff;
    createSubitem(params: CreateSubitemParams): Promise<{
        id: string;
    }>;
    getItem(itemId: string): Promise<MondayItem | null>;
    getBoardItems(boardId: string): Promise<MondayItem[]>;
    updateColumnValue(params: {
        boardId: string;
        itemId: string;
        columnId: string;
        value: string;
    }): Promise<{
        id: string;
    }>;
}
export declare function createMondayClient(options?: MondayClientOptions): MondayClient;
//# sourceMappingURL=monday-client.d.ts.map
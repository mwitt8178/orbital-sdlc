/**
 * projects/active-project-context.ts — request-scoped active project plumbing.
 *
 * Per Round 4 Projects Feature spec.
 *
 * The UI sends an `x-orbital-project-id` HTTP header on every tRPC request
 * (see packages/ui/src/services/trpc.ts). This module provides:
 *
 *   - readActiveProjectIdFromHeaders(headers): pluck the header value safely
 *   - requireActiveProject(ctx): throws ACTIVE_PROJECT_REQUIRED if missing
 *   - optionalActiveProject(ctx): returns string | null
 *
 * Other routers (sprint, vision, channel, etc.) wire active project filtering
 * by calling these helpers — see architecture.md "Wiring snippet" section.
 *
 * Why no tRPC middleware that mutates ctx? tRPC's middleware can't add fields
 * to the typed ctx without a refactor of init.ts (which we cannot do without
 * breaking other agents' routers). Instead, every helper reads `ctx.req.headers`
 * directly. The header is the single source of truth.
 */
import type { ReqContext } from '../../../orchestrator/src/trpc/init.js';
export declare const ACTIVE_PROJECT_HEADER = "x-orbital-project-id";
/**
 * Pluck the active-project header off a Fastify-style headers record.
 * Headers may be string | string[] | undefined depending on parser.
 * Returns null if absent or empty.
 */
export declare function readActiveProjectIdFromHeaders(headers: Record<string, unknown> | undefined): string | null;
/**
 * Read the active project id from the tRPC ctx, or null if absent.
 */
export declare function optionalActiveProject(ctx: ReqContext): string | null;
/**
 * Read the active project id from the tRPC ctx, throwing
 * ACTIVE_PROJECT_REQUIRED if absent. Use this in routes that are unsafe
 * without project scope (e.g. mutating ops).
 */
export declare function requireActiveProject(ctx: ReqContext): string;
//# sourceMappingURL=active-project-context.d.ts.map
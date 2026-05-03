/**
 * trpc/init.ts — tRPC bootstrap.
 *
 * Per Implementation Plan §6 Task 2C and SAO §5.8.
 *
 * Exports the shared tRPC primitives consumed by every router under
 * src/trpc/routers/. We intentionally use the default context (empty record);
 * authentication and capability checks happen at the MCP gateway layer for
 * agent traffic, and at the Fastify middleware layer for UI traffic.
 *
 * Round 3 S5 — idempotentProcedure
 * --------------------------------
 * `idempotentProcedure` wraps `publicProcedure` with the idempotency
 * middleware (see middleware/idempotency.ts). Mutations defined with this
 * procedure honour the `Idempotency-Key` HTTP header: a retry of the same
 * mutation with the same key returns the original result (or original error)
 * without re-executing the handler. Adoption is opt-in per mutation — switch
 * `publicProcedure.mutation(...)` to `idempotentProcedure.mutation(...)` in
 * any router that wants the guarantee.
 *
 * `publicProcedure` is unchanged so existing routers continue to work.
 */
/**
 * tRPC request-bound context. Exported so router return types can name it.
 * The tRPC Fastify adapter sets `req` on the context (we wire `createContext`
 * in `src/index.ts` to forward `req.headers`). All other layers use the
 * default empty record semantics — the field is optional.
 *
 * Round 7-01 — tenantId is injected by the tenant middleware (tenant.ts).
 * It is optional at the base context level; after the tenant middleware runs
 * it is always a string. Procedures that require tenant scoping should use
 * `tenantProcedure` from `trpc/middleware/tenant.ts`.
 * [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
 */
export interface ReqContext {
    /** Inbound HTTP request headers (Fastify). */
    req?: {
        headers?: Record<string, unknown>;
    };
    /**
     * Resolved tenant ID — populated by the tenant middleware.
     * Always a UUID string after tenant middleware runs.
     * In local mode: '00000000-0000-0000-0000-000000000000' (sentinel).
     * In hub mode: from X-Orbital-Tenant-ID header.
     */
    tenantId?: string;
}
export declare const t: import("@trpc/server").TRPCRootObject<ReqContext, object, import("@trpc/server").TRPCRuntimeConfigOptions<ReqContext, object>, {
    ctx: ReqContext;
    meta: object;
    errorShape: import("@trpc/server").TRPCDefaultErrorShape;
    transformer: false;
}>;
export declare const publicProcedure: import("@trpc/server").TRPCProcedureBuilder<ReqContext, object, object, import("@trpc/server").TRPCUnsetMarker, import("@trpc/server").TRPCUnsetMarker, import("@trpc/server").TRPCUnsetMarker, import("@trpc/server").TRPCUnsetMarker, false>;
export declare const router: import("@trpc/server").TRPCRouterBuilder<{
    ctx: ReqContext;
    meta: object;
    errorShape: import("@trpc/server").TRPCDefaultErrorShape;
    transformer: false;
}>;
export declare const middleware: <$ContextOverrides>(fn: import("@trpc/server").TRPCMiddlewareFunction<ReqContext, object, object, $ContextOverrides, unknown>) => import("@trpc/server").TRPCMiddlewareBuilder<ReqContext, object, $ContextOverrides, unknown>;
export declare const idempotentProcedure: import("@trpc/server").TRPCProcedureBuilder<ReqContext, object, {}, import("@trpc/server").TRPCUnsetMarker, import("@trpc/server").TRPCUnsetMarker, import("@trpc/server").TRPCUnsetMarker, import("@trpc/server").TRPCUnsetMarker, false>;
//# sourceMappingURL=init.d.ts.map
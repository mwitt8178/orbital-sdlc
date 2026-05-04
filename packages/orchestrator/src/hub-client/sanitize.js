/**
 * hub-client/sanitize.ts — re-export shim.
 *
 * Original implementation now lives in `@orbital/domain` at
 * `packages/domain/src/events/sanitize.ts` so the EventStore (which is in
 * the domain package) can import it without crossing package boundaries
 * via relative paths into another package's `src/` tree (which breaks at
 * runtime when only `dist/` is shipped — the daemon container hit this
 * exact bug).
 *
 * This shim keeps the existing import path working for orchestrator
 * consumers (hub-client/client.ts, tests). Prefer importing from
 * `@orbital/domain/events/sanitize` directly going forward.
 */
export { sanitizeForHub, resetSanitizerState, setKnownAnthropicKeyPrefix, LocalDataLeakError, } from '@orbital/domain/events/sanitize.js';
//# sourceMappingURL=sanitize.js.map
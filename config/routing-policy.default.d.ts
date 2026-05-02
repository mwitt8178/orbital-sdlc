/**
 * Default routing policy — ships with Orbital v1.
 *
 * Per TRD-08 §5.3:
 * - haiku for low-risk / high-volume personas (jr-dev, scrum-master)
 * - sonnet for default implementation and analysis personas
 * - opus for high-stakes roles (pm, architect, principal-dev, security)
 * - risk_class=high forces complex tier; risk_class=critical pins opus
 *
 * Model IDs per SAO §5.7: claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5
 */
import type { RoutingPolicy } from '../packages/orchestrator/src/routing/types.js';
declare const policy: RoutingPolicy;
export default policy;
//# sourceMappingURL=routing-policy.default.d.ts.map
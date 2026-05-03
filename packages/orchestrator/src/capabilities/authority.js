/**
 * CapabilityAuthority — issuance, verification, and revocation.
 *
 * Per TRD-06 §6.3 and §7.1.
 *
 * Every event is written through `EventStore.append`. Direct `db.insert(events)`
 * calls are forbidden by project rules and absent from this module.
 */
import { uuidv7 } from 'uuidv7';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { capabilityGrants, capabilityDenials, capabilityRevocations, } from '../db/schema/capabilities.js';
import { CapabilityBundleSchema, ScopesSchema, OrbitalError, } from '@orbital/types';
import { signBundle, bundleHash, verifyBundle as verifyBundleStandalone } from './bundle.js';
import { validateToolCall as gatewayValidate, extractTarget, } from './gateway.js';
import { checkIssue } from './sod.js';
import { logger } from '../config/logger.js';
const DEFAULT_TTL_MS = 30 * 60 * 1000;
export class CapabilityAuthority {
    eventStore;
    keyManager;
    constructor(eventStore, keyManager) {
        this.eventStore = eventStore;
        this.keyManager = keyManager;
    }
    // -------------------------------------------------------------------------
    // issue
    // -------------------------------------------------------------------------
    async issue(params) {
        if (!params.justification || params.justification.trim().length === 0) {
            throw new OrbitalError('VALIDATION_REQUIRED_FIELD_MISSING', 'justification is required (Primitives §14)');
        }
        const scopes = ScopesSchema.parse(params.scopes);
        // SoD check at issue time. Reject before signing.
        const sodViolation = checkIssue(params.persona_id, scopes, params.sod_context ?? {});
        if (sodViolation) {
            // Record the denial as audit. Note: this is a denied issuance, not a
            // denied tool call. We use the denial table to make the event auditable
            // and emit a CapabilityDenied event via EventStore.
            const denialId = uuidv7();
            const occurredAt = (params.now ?? new Date()).toISOString();
            await db.insert(capabilityDenials).values({
                denial_id: denialId,
                capability_id: null,
                task_id: params.task_id,
                session_id: params.session_id,
                persona_id: params.persona_id,
                attempted_tool: 'capability.issue',
                attempted_target: `${params.persona_id}/${params.task_id}`,
                reason_code: 'AUTH_SOD_VIOLATION',
                reason_detail: `${sodViolation.rule_id}: ${sodViolation.description}`,
                prompt_excerpt: null,
                trace_id: params.trace_id,
                occurred_at: new Date(occurredAt),
                schema_version: 1,
            });
            const ev = {
                aggregate_id: denialId,
                aggregate_type: 'capability',
                event_type: 'CapabilityDenied',
                payload: {
                    capability_id: null,
                    task_id: params.task_id,
                    session_id: params.session_id,
                    persona_id: params.persona_id,
                    attempted_tool: 'capability.issue',
                    attempted_target: `${params.persona_id}/${params.task_id}`,
                    reason_code: 'AUTH_SOD_VIOLATION',
                    reason_detail: `${sodViolation.rule_id}: ${sodViolation.description}`,
                    channel_post_target: '#capability-violations',
                },
                actor: params.actor,
                trace_id: params.trace_id,
                occurred_at: occurredAt,
                schema_version: 1,
            };
            await this.eventStore.append(ev);
            throw new OrbitalError('AUTH_SOD_VIOLATION', `${sodViolation.rule_id}: ${sodViolation.description}`, { rule_id: sodViolation.rule_id });
        }
        // Acquire (or create) sprint sub-key.
        const subKey = await this.keyManager.getOrCreateActiveSubKey(params.sprint_id, params.actor);
        const capabilityId = uuidv7();
        const now = params.now ?? new Date();
        const ttl = params.ttl_ms ?? DEFAULT_TTL_MS;
        const issuedAt = now.toISOString();
        const expiresAt = new Date(now.getTime() + ttl).toISOString();
        const unsigned = {
            capability_id: capabilityId,
            install_id: params.install_id,
            sprint_id: params.sprint_id,
            task_id: params.task_id,
            persona_id: params.persona_id,
            session_id: params.session_id,
            scopes,
            issued_at: issuedAt,
            expires_at: expiresAt,
            signing_key_id: subKey.keyId,
            schema_version: 1,
        };
        const hash = bundleHash(unsigned);
        const signed = await signBundle(unsigned, this.keyManager);
        // Persist grant. Do this BEFORE emitting events so the row is visible to
        // any cascading subscribers (Phase 1A's NOTIFY fan-out).
        await db.insert(capabilityGrants).values({
            capability_id: capabilityId,
            task_id: params.task_id,
            session_id: params.session_id,
            persona_id: params.persona_id,
            sprint_id: params.sprint_id,
            signing_sub_key_id: subKey.keyId,
            scopes,
            parent_capability_id: null,
            issued_at: now,
            expires_at: new Date(expiresAt),
            bundle_hash: hash,
            signature: signed.signature,
            status: 'issued',
            schema_version: 1,
        });
        const issuedEvent = {
            aggregate_id: capabilityId,
            aggregate_type: 'capability',
            event_type: 'CapabilityIssued',
            payload: {
                capability_id: capabilityId,
                task_id: params.task_id,
                session_id: params.session_id,
                persona_id: params.persona_id,
                sprint_id: params.sprint_id,
                signing_sub_key_id: subKey.keyId,
                bundle_hash: hash,
                scopes,
                expires_at: expiresAt,
                policy_version: 1,
            },
            actor: params.actor,
            capability_id: capabilityId,
            trace_id: params.trace_id,
            occurred_at: issuedAt,
            schema_version: 1,
        };
        await this.eventStore.append(issuedEvent);
        // CapabilityGranted is emitted per-tool-call in v1 of the spec; the
        // initial issuance grants the capability itself (no specific tool).
        // We emit a coarse-grained CapabilityGranted at issuance time to satisfy
        // the FR-6.1 "per agent invocation" telemetry; per-call grants are emitted
        // by the gateway via validateAndEmit.
        const grantedEvent = {
            aggregate_id: capabilityId,
            aggregate_type: 'capability',
            event_type: 'CapabilityGranted',
            payload: {
                capability_id: capabilityId,
                tool: 'capability.issue',
                target: `${params.persona_id}/${params.task_id}`,
                matched_scope: 'capability_lifecycle',
                matched_pattern: 'issue',
            },
            actor: params.actor,
            capability_id: capabilityId,
            trace_id: params.trace_id,
            occurred_at: issuedAt,
            schema_version: 1,
        };
        await this.eventStore.append(grantedEvent);
        logger.info({ capability_id: capabilityId, persona: params.persona_id, task: params.task_id }, 'CapabilityAuthority: issued');
        return { bundle: signed, capability_id: capabilityId };
    }
    // -------------------------------------------------------------------------
    // verify
    // -------------------------------------------------------------------------
    async verify(bundle, now, opts) {
        const parsed = CapabilityBundleSchema.safeParse(bundle);
        if (!parsed.success) {
            return {
                ok: false,
                reason_code: 'AUTH_INVALID_CAPABILITY_FORMAT',
                reason_detail: parsed.error.issues
                    .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
                    .join('; '),
            };
        }
        const r = await verifyBundleStandalone(bundle, this.keyManager, now, opts);
        if (!r.ok) {
            return { ok: false, reason_code: r.reasonCode, reason_detail: r.reasonDetail };
        }
        return { ok: true, bundle: parsed.data };
    }
    // -------------------------------------------------------------------------
    // revoke
    // -------------------------------------------------------------------------
    async revoke(capabilityId, params) {
        // Check capability exists.
        const grants = await db
            .select()
            .from(capabilityGrants)
            .where(eq(capabilityGrants.capability_id, capabilityId))
            .limit(1);
        const grant = grants[0];
        if (!grant) {
            throw new OrbitalError('NOT_FOUND_CAPABILITY', `capability ${capabilityId} not found`);
        }
        // Idempotency: if already revoked, return prior revocation.
        const existing = await db
            .select()
            .from(capabilityRevocations)
            .where(eq(capabilityRevocations.capability_id, capabilityId))
            .limit(1);
        if (existing[0]) {
            return;
        }
        const revocationId = uuidv7();
        const now = new Date();
        await db.insert(capabilityRevocations).values({
            revocation_id: revocationId,
            capability_id: capabilityId,
            reason: params.reason,
            reason_detail: params.reason_detail ?? null,
            revoked_by: params.actor,
            revoked_at: now,
            schema_version: 1,
        });
        // Update grant status.
        await db
            .update(capabilityGrants)
            .set({ status: 'revoked' })
            .where(eq(capabilityGrants.capability_id, capabilityId));
        const ev = {
            aggregate_id: capabilityId,
            aggregate_type: 'capability',
            event_type: 'CapabilityRevoked',
            payload: {
                capability_id: capabilityId,
                reason: params.reason,
                reason_detail: params.reason_detail,
            },
            actor: params.actor,
            capability_id: capabilityId,
            trace_id: params.trace_id,
            occurred_at: now.toISOString(),
            schema_version: 1,
        };
        await this.eventStore.append(ev);
        logger.info({ capability_id: capabilityId, reason: params.reason }, 'CapabilityAuthority: revoked');
    }
    // -------------------------------------------------------------------------
    // hasScope (synchronous helper for ad-hoc checks)
    // -------------------------------------------------------------------------
    hasScope(bundle, scope, resource) {
        // For exact key match (secrets), require exact membership.
        if (scope === 'secrets') {
            return bundle.scopes.secrets.includes(resource);
        }
        if (scope === 'spawn_subagent') {
            return bundle.scopes.spawn_subagent === true;
        }
        if (scope === 'ceremony_role') {
            // resource here is the required role name.
            return bundle.scopes.ceremony_role.includes(resource);
        }
        if (scope === 'git_commit') {
            // resource form "branch::path".
            const [branch, p] = resource.split('::', 2);
            if (!branch || !p)
                return false;
            const result = gatewayValidate(bundle, 'git.sign_commit', { branch, paths: [p] });
            return result.allowed;
        }
        if (scope === 'network_egress') {
            const result = gatewayValidate(bundle, 'network.fetch', { url: resource });
            if (!result.allowed) {
                // Treat resource as raw host as fallback.
                return gatewayValidate(bundle, 'network.fetch', { host: resource }).allowed;
            }
            return true;
        }
        if (scope === 'channel_read' || scope === 'channel_post') {
            const tool = scope === 'channel_read' ? 'channel.read' : 'channel.post';
            return gatewayValidate(bundle, tool, { channel: resource }).allowed;
        }
        if (scope === 'board_read' || scope === 'board_mutate') {
            const tool = scope === 'board_read' ? 'board.read' : 'board.mutate';
            // resource: "<target>" or "<target>.<field>"
            const idx = resource.lastIndexOf('.');
            if (idx > 0 && !resource.includes(':')) {
                // No colon; ambiguous — try as plain target.
                return gatewayValidate(bundle, tool, { target: resource }).allowed;
            }
            // Detect "ticket:ID.field" — split on the dot AFTER the colon.
            const colon = resource.indexOf(':');
            if (colon < 0)
                return false;
            const post = resource.slice(colon + 1);
            const dotIdx = post.indexOf('.');
            if (dotIdx > 0) {
                const target = `${resource.slice(0, colon + 1)}${post.slice(0, dotIdx)}`;
                const field = post.slice(dotIdx + 1);
                return gatewayValidate(bundle, tool, { target, field }).allowed;
            }
            return gatewayValidate(bundle, tool, { target: resource }).allowed;
        }
        if (scope === 'files_read' || scope === 'files_write') {
            const tool = scope === 'files_read' ? 'files.read' : 'files.write';
            return gatewayValidate(bundle, tool, { path: resource }).allowed;
        }
        return false;
    }
    // -------------------------------------------------------------------------
    // validateAndEmit — gateway helper that emits events
    // -------------------------------------------------------------------------
    async validateAndEmit(bundle, toolName, params, actor, traceId) {
        const result = gatewayValidate(bundle, toolName, params);
        const occurredAt = new Date().toISOString();
        if (result.allowed) {
            const ev = {
                aggregate_id: bundle.capability_id,
                aggregate_type: 'capability',
                event_type: 'CapabilityGranted',
                payload: {
                    capability_id: bundle.capability_id,
                    tool: toolName,
                    target: extractTarget(toolName, params),
                    matched_scope: result.matched_scope,
                    matched_pattern: result.matched_pattern,
                },
                actor,
                capability_id: bundle.capability_id,
                trace_id: traceId,
                occurred_at: occurredAt,
                schema_version: 1,
            };
            await this.eventStore.append(ev);
            return result;
        }
        // Denied — write denial row + emit event.
        const denialId = uuidv7();
        await db.insert(capabilityDenials).values({
            denial_id: denialId,
            capability_id: bundle.capability_id,
            task_id: bundle.task_id ?? null,
            session_id: bundle.session_id,
            persona_id: bundle.persona_id,
            attempted_tool: toolName,
            attempted_target: result.attempted_target,
            reason_code: result.reason_code,
            reason_detail: result.reason_detail,
            prompt_excerpt: null,
            trace_id: traceId,
            occurred_at: new Date(occurredAt),
            schema_version: 1,
        });
        const ev = {
            aggregate_id: denialId,
            aggregate_type: 'capability',
            event_type: 'CapabilityDenied',
            payload: {
                capability_id: bundle.capability_id,
                task_id: bundle.task_id,
                session_id: bundle.session_id,
                persona_id: bundle.persona_id,
                attempted_tool: toolName,
                attempted_target: result.attempted_target,
                reason_code: result.reason_code,
                reason_detail: result.reason_detail,
                channel_post_target: '#capability-violations',
            },
            actor,
            capability_id: bundle.capability_id,
            trace_id: traceId,
            occurred_at: occurredAt,
            schema_version: 1,
        };
        await this.eventStore.append(ev);
        return result;
    }
}
//# sourceMappingURL=authority.js.map
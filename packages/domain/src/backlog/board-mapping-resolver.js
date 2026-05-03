/**
 * backlog/board-mapping-resolver.ts — BoardMappingResolver.
 *
 * Per Round 5 Monday Board Discovery spec.
 *
 * Personas and the MondaySyncService need to know the project's confirmed
 * mapping at runtime so they write to the correct Monday columns. The resolver
 * is a thin caching wrapper over BoardMappingService.get(projectId), with
 * convenience helpers that surface common questions:
 *
 *   - resolveStatusColumn(projectId)  → { column_id, label_for_state(state) }
 *   - resolveACSource(projectId)      → { kind: 'column'|'subitem'|'none', ... }
 *   - resolveEstimateColumn(projectId)→ { column_id, unit }
 *
 * All methods return null/'none' when no confirmed mapping exists. The caller
 * decides whether to skip the write (graceful degradation) or surface an
 * error.
 *
 * Caching: a 60-second in-memory TTL keyed on projectId. The cache is small
 * (mappings are rare to confirm) and invalidated by calling invalidate(pid).
 */
// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
const DEFAULT_TTL_MS = 60_000;
export class DefaultBoardMappingResolver {
    mappingService;
    ttlMs;
    cache = new Map();
    constructor(mappingService, ttlMs = DEFAULT_TTL_MS) {
        this.mappingService = mappingService;
        this.ttlMs = ttlMs;
    }
    async getMapping(projectId) {
        const now = Date.now();
        const cached = this.cache.get(projectId);
        if (cached && cached.expires_at > now) {
            return cached.mapping;
        }
        const fresh = await this.mappingService.get(projectId);
        this.cache.set(projectId, { mapping: fresh, expires_at: now + this.ttlMs });
        return fresh;
    }
    async resolveStatusColumn(projectId) {
        const mapping = await this.getMapping(projectId);
        if (!mapping || !mapping.status_column_id)
            return null;
        const stateToLabel = invertLabelToState(mapping.status_label_to_state);
        const labels = Object.keys(mapping.status_label_to_state);
        return {
            column_id: mapping.status_column_id,
            label_for_state: (state) => stateToLabel.get(state) ?? null,
            state_for_label: (label) => mapping.status_label_to_state[label] ?? null,
            labels,
        };
    }
    async resolveACSource(projectId) {
        const mapping = await this.getMapping(projectId);
        if (!mapping)
            return { kind: 'none' };
        if (mapping.ac_subitem_template_id) {
            return { kind: 'subitem', subitem_template_id: mapping.ac_subitem_template_id };
        }
        if (mapping.ac_column_id) {
            return { kind: 'column', column_id: mapping.ac_column_id };
        }
        return { kind: 'none' };
    }
    async resolveEstimateColumn(projectId) {
        const mapping = await this.getMapping(projectId);
        if (!mapping || !mapping.estimate_column_id)
            return null;
        return {
            column_id: mapping.estimate_column_id,
            unit: mapping.story_points_unit,
        };
    }
    async resolvePriorityColumn(projectId) {
        const mapping = await this.getMapping(projectId);
        if (!mapping || !mapping.priority_column_id)
            return null;
        return { column_id: mapping.priority_column_id };
    }
    async resolveAssigneeColumn(projectId) {
        const mapping = await this.getMapping(projectId);
        if (!mapping || !mapping.assignee_column_id)
            return null;
        return { column_id: mapping.assignee_column_id };
    }
    invalidate(projectId) {
        this.cache.delete(projectId);
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function invertLabelToState(labelToState) {
    const out = new Map();
    // First label wins for each state — deterministic given Object.entries order.
    for (const [label, state] of Object.entries(labelToState)) {
        if (!out.has(state)) {
            out.set(state, label);
        }
    }
    return out;
}
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export function createBoardMappingResolver(mappingService, ttlMs) {
    return new DefaultBoardMappingResolver(mappingService, ttlMs);
}
//# sourceMappingURL=board-mapping-resolver.js.map
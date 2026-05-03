/**
 * dag.ts — DAG construction and ready-set computation.
 *
 * Per TRD-04 v0.2 §7.1, §7.2.2, §7.2.3.
 *
 * Public API:
 *   - buildDAG(tasks, dependencies)               → topological sort + cycle detection
 *   - computeReadySet(tasks, dependencies)        → tasks whose blocking predecessors are all done
 *   - assertAcyclic(tasks, edges)                 → throws INTERNAL_DAG_CYCLE on a cycle
 *
 * The Scheduler consumes computeReadySet on every tick. buildDAG is used by
 * the SprintService (Phase 4B) when it builds a fresh DAG from a sprint commitment.
 */
export interface DagNode {
    taskId: string;
    state?: string;
}
export interface DagEdge {
    predecessorTaskId: string;
    successorTaskId: string;
    /** Defaults to true if absent. */
    blocking?: boolean;
}
export interface DagBuildResult {
    /** Tasks in topological order (predecessors first). */
    topoOrder: string[];
    /** Tasks with no predecessors — initial ready-set candidates. */
    roots: string[];
    /** taskId → ids of its (incoming) predecessor edges (blocking only). */
    predecessorsOf: Map<string, Set<string>>;
    /** taskId → ids of its (outgoing) successor edges. */
    successorsOf: Map<string, Set<string>>;
}
/**
 * Per TRD-04 §7.2.2. Computes a topological order over the given nodes/edges,
 * raising INTERNAL_DAG_CYCLE if a cycle exists.
 *
 * Only edges where blocking !== false participate in topology — informational
 * edges are recorded in successorsOf but not enforced.
 */
export declare function buildDAG(nodes: DagNode[], edges: DagEdge[]): DagBuildResult;
export declare function assertAcyclic(nodes: DagNode[], edges: DagEdge[]): void;
/**
 * Per TRD-04 §7.1 (transition table row pending -> ready).
 *
 * @param tasks  Tasks to consider; only those in state 'pending' or 'ready' are returned.
 * @param edges  Dependency edges across the relevant tasks.
 * @returns      taskIds whose blocking predecessors are all in state 'done'.
 */
export declare function computeReadySet(tasks: DagNode[], edges: DagEdge[]): string[];
//# sourceMappingURL=dag.d.ts.map
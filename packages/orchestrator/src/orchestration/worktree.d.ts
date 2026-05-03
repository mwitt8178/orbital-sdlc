/**
 * worktree.ts — WorktreeManager.
 *
 * Per TRD-04 v0.2 §10.
 *
 * Real implementation:
 *   - create(taskId, branch) shells out to `git worktree add` against a real
 *     parent repo. The created path exists on disk.
 *   - cleanup(taskId) runs `git worktree remove --force` and `git branch -D`.
 *   - conflict(setA, setB) → boolean, checks glob overlap using micromatch.
 *
 * The parent repository is configurable; tests use os.tmpdir() with a freshly
 * `git init`-ed bare repo.
 */
import type { DB } from '../db/client.js';
import type { WorktreeRow } from '../db/schema/orchestration.js';
export interface CreateWorktreeParams {
    taskId: string;
    branchName: string;
    parentBranch: string;
    declaredWritePaths: string[];
}
export interface WorktreeManagerOptions {
    /** Path to the parent git repo. Defaults to ~/.orbital/repo */
    parentRepoPath?: string;
    /** Override the worktree root. Defaults to ~/.orbital/worktrees */
    worktreeRoot?: string;
    /** Custom git executable, defaults to 'git'. */
    gitBin?: string;
}
export interface IWorktreeManager {
    create(params: CreateWorktreeParams): Promise<WorktreeRow>;
    cleanup(taskId: string): Promise<void>;
    conflict(filesA: string[], filesB: string[]): boolean;
    getActiveWorktrees(): Promise<WorktreeRow[]>;
}
export declare class WorktreeManager implements IWorktreeManager {
    private readonly db;
    private readonly parentRepoPath;
    private readonly worktreeRoot;
    private readonly gitBin;
    constructor(db: DB, options?: WorktreeManagerOptions);
    create(params: CreateWorktreeParams): Promise<WorktreeRow>;
    cleanup(taskId: string): Promise<void>;
    conflict(filesA: string[], filesB: string[]): boolean;
    /**
     * True if globs `a` and `b` share at least one matching concrete path.
     *
     * Strategy: for each side, derive a deterministic "literal preimage"
     * (treating ** and * as wildcard segments), then test it against the
     * other side using micromatch.isMatch. Symmetric.
     *
     * Example: 'src/**' overlaps 'src/billing/**' because both include
     * 'src/billing/index.ts'.
     */
    private globsOverlap;
    getActiveWorktrees(): Promise<WorktreeRow[]>;
    private assertParentRepo;
    private runGit;
}
export declare function createWorktreeManager(db: DB, options?: WorktreeManagerOptions): WorktreeManager;
//# sourceMappingURL=worktree.d.ts.map
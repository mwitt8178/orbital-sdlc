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
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { uuidv7 } from 'uuidv7';
import { eq, and, isNull } from 'drizzle-orm';
import micromatch from 'micromatch';
import { OrbitalError } from '@orbital/types';
import { worktrees } from '../db/schema/orchestration.js';
import { logger } from '../config/logger.js';
import { getOrbitalHome } from '../config/env.js';
// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
export class WorktreeManager {
    db;
    parentRepoPath;
    worktreeRoot;
    gitBin;
    constructor(db, options = {}) {
        this.db = db;
        const home = getOrbitalHome();
        this.parentRepoPath = options.parentRepoPath ?? path.join(home, 'repo');
        this.worktreeRoot = options.worktreeRoot ?? path.join(home, 'worktrees');
        this.gitBin = options.gitBin ?? 'git';
    }
    // -------------------------------------------------------------------------
    // create
    // -------------------------------------------------------------------------
    async create(params) {
        const { taskId, branchName, parentBranch, declaredWritePaths } = params;
        // Idempotency: if an active worktree already exists for this task, return it.
        const existing = await this.db
            .select()
            .from(worktrees)
            .where(and(eq(worktrees.taskId, taskId), isNull(worktrees.releasedAt)))
            .limit(1);
        if (existing[0]) {
            return existing[0];
        }
        // Verify parent repo path exists; fail loudly per TRD-04 §17.5.
        await this.assertParentRepo();
        await fs.mkdir(this.worktreeRoot, { recursive: true });
        const worktreeId = uuidv7();
        const targetPath = path.join(this.worktreeRoot, taskId);
        // Insert row in 'creating' state.
        await this.db.insert(worktrees).values({
            worktreeId,
            taskId,
            path: targetPath,
            branchName,
            parentBranch,
            state: 'creating',
            declaredWritePaths,
        });
        // Run `git worktree add -b <branch> <path> <parent_branch>` against parent repo.
        try {
            await this.runGit(['worktree', 'add', '-b', branchName, targetPath, parentBranch]);
        }
        catch (err) {
            // Compensating: mark released so the partial unique-active-uq slot frees up.
            await this.db
                .update(worktrees)
                .set({ state: 'released', releasedAt: new Date() })
                .where(eq(worktrees.worktreeId, worktreeId));
            throw err;
        }
        // Transition to active.
        await this.db
            .update(worktrees)
            .set({ state: 'active' })
            .where(eq(worktrees.worktreeId, worktreeId));
        const rows = await this.db
            .select()
            .from(worktrees)
            .where(eq(worktrees.worktreeId, worktreeId))
            .limit(1);
        const row = rows[0];
        if (!row) {
            throw new OrbitalError('INTERNAL_DB_ERROR', `worktree row vanished after insert: ${worktreeId}`);
        }
        return row;
    }
    // -------------------------------------------------------------------------
    // cleanup
    // -------------------------------------------------------------------------
    async cleanup(taskId) {
        const rows = await this.db
            .select()
            .from(worktrees)
            .where(and(eq(worktrees.taskId, taskId), isNull(worktrees.releasedAt)));
        const row = rows[0];
        if (!row)
            return; // nothing to clean
        // Mark draining first so the audit trail shows the cleanup phase.
        await this.db
            .update(worktrees)
            .set({ state: 'draining' })
            .where(eq(worktrees.worktreeId, row.worktreeId));
        // Real `git worktree remove --force <path>`.
        try {
            await this.runGit(['worktree', 'remove', '--force', row.path]);
        }
        catch (err) {
            // Worktree directory may already be gone; treat as best-effort.
            logger.warn({ err, taskId, path: row.path }, 'WorktreeManager: git worktree remove failed; continuing cleanup');
        }
        // Best-effort branch delete (may fail if branch already gone).
        try {
            await this.runGit(['branch', '-D', row.branchName]);
        }
        catch {
            // ignore
        }
        // Best-effort fs cleanup of any orphan dir.
        try {
            await fs.rm(row.path, { recursive: true, force: true });
        }
        catch {
            // ignore
        }
        await this.db
            .update(worktrees)
            .set({ state: 'released', releasedAt: new Date() })
            .where(eq(worktrees.worktreeId, row.worktreeId));
    }
    // -------------------------------------------------------------------------
    // conflict — overlapping glob detection
    // -------------------------------------------------------------------------
    conflict(filesA, filesB) {
        if (filesA.length === 0 || filesB.length === 0)
            return false;
        // Two sets of globs overlap if any concrete path matched by one set
        // would also be matched by the other. For glob-vs-glob overlap we use a
        // pairwise check: for each pattern p in A, ask whether p (treated as a
        // path-like string) matches any pattern in B, and vice versa. This is
        // the same approach micromatch.contains uses internally.
        for (const a of filesA) {
            for (const b of filesB) {
                if (this.globsOverlap(a, b))
                    return true;
            }
        }
        return false;
    }
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
    globsOverlap(a, b) {
        // Trivial equality
        if (a === b)
            return true;
        // Both literal (no wildcards) — equality already handled
        const aHasGlob = /[*?[\]{}!]/.test(a);
        const bHasGlob = /[*?[\]{}!]/.test(b);
        if (!aHasGlob && !bHasGlob)
            return a === b;
        if (!aHasGlob)
            return micromatch.isMatch(a, b);
        if (!bHasGlob)
            return micromatch.isMatch(b, a);
        // Both globs — use directory-prefix overlap as the canonical test.
        // Convert ** segments to a single deep wildcard and check with
        // micromatch.contains, plus a structural prefix check.
        const aPrefix = literalPrefix(a);
        const bPrefix = literalPrefix(b);
        if (aPrefix === '' || bPrefix === '') {
            // One side rooted at top-level (e.g. '**'); the other will always overlap.
            return true;
        }
        // If one prefix contains the other, they can both match a common path.
        if (aPrefix.startsWith(bPrefix) || bPrefix.startsWith(aPrefix))
            return true;
        // Otherwise no overlap.
        return false;
    }
    // -------------------------------------------------------------------------
    // getActiveWorktrees
    // -------------------------------------------------------------------------
    async getActiveWorktrees() {
        return this.db.select().from(worktrees).where(isNull(worktrees.releasedAt));
    }
    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------
    async assertParentRepo() {
        try {
            await fs.access(path.join(this.parentRepoPath, '.git'));
        }
        catch {
            throw new OrbitalError('INTERNAL_SPAWN_ABORTED', `Parent git repository not found at ${this.parentRepoPath}. ` +
                `Run 'git init' there or set parentRepoPath in WorktreeManager options.`, { parentRepoPath: this.parentRepoPath });
        }
    }
    runGit(args) {
        return new Promise((resolve, reject) => {
            const child = spawn(this.gitBin, args, { cwd: this.parentRepoPath });
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (chunk) => {
                stdout += chunk.toString();
            });
            child.stderr.on('data', (chunk) => {
                stderr += chunk.toString();
            });
            child.on('error', (err) => {
                if (err.code === 'ENOENT') {
                    reject(new OrbitalError('INTERNAL_SPAWN_ABORTED', `git executable not found: ${this.gitBin}`, { code: 'ENOENT' }));
                    return;
                }
                reject(err);
            });
            child.on('close', (code) => {
                if (code === 0) {
                    resolve(stdout);
                }
                else {
                    reject(new OrbitalError('INTERNAL_SPAWN_ABORTED', `git ${args.join(' ')} failed (exit ${code}): ${stderr.trim()}`, { args, exit_code: code, stderr: stderr.trim() }));
                }
            });
        });
    }
}
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export function createWorktreeManager(db, options = {}) {
    return new WorktreeManager(db, options);
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Return the literal directory prefix of a glob — everything up to the first
 * wildcard segment. Trailing slash dropped.
 *
 *   'src/**'           -> 'src'
 *   'src/billing/**'   -> 'src/billing'
 *   'src/**\/*.ts'     -> 'src'
 *   '**'               -> ''
 *   'a/b/c'            -> 'a/b/c'
 */
function literalPrefix(glob) {
    const idx = glob.search(/[*?[\]{}!]/);
    if (idx < 0)
        return glob;
    const head = glob.slice(0, idx);
    // Drop trailing slash
    if (head.endsWith('/'))
        return head.slice(0, -1);
    // If we cut mid-segment ('src/foo*' -> 'src/foo'), keep the partial; treat
    // as a parent-directory prefix by stripping back to last '/'.
    const slash = head.lastIndexOf('/');
    if (slash < 0)
        return '';
    return head.slice(0, slash);
}
//# sourceMappingURL=worktree.js.map
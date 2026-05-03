/**
 * skill-loader.ts — Copy a persona's referenced skill files into a worktree.
 *
 * Per Round5B brief — every spawn writes the skill markdown files the persona
 * needs to {worktree}/.orbital/skills/, so the running worker can read them
 * with the Bash/Read tools.
 *
 * Two-stage resolution:
 *   1. Look for {SKILLS_ROOT}/{slug}.md exactly. This is the canonical home.
 *   2. If not found, consult SKILL_ALIASES for an alternate filename.
 *      Persona definitions sometimes use slug aliases (e.g. `tdd-cycle`)
 *      that map to a single starter file (`tdd-workflow.md`).
 *
 * Missing skills are LOGGED but never throw — a stale persona slug must not
 * prevent a worker from spawning. The persona brief always lists the
 * intended skills regardless of whether the file was copied.
 */
import type { Persona } from './types.js';
import type { EventStore } from '../events/store.js';
export interface SkillsBundleResult {
    /** Absolute path to the worktree skills dir. */
    skillsDir: string;
    /** Files actually copied. */
    copied: string[];
    /** Slugs the persona referenced but whose markdown could not be found. */
    missing: string[];
}
export interface BundleSkillsOptions {
    /**
     * Optional: if provided, emits SkillLoaded events for each skill bundled.
     * Round 6 #10 inspection instrumentation.
     */
    eventStore?: EventStore;
    /** Worker id for SkillLoaded event payloads. */
    workerId?: string;
}
/**
 * Copy every skill markdown the persona references into
 * {worktreePath}/.orbital/skills/{slug}.md.
 *
 * Returns the list of files copied and any slugs that were missing
 * (logged at warn level — never throws).
 *
 * When options.eventStore is provided, emits SkillLoaded events for each
 * successfully copied skill (Round 6 #10 inspection instrumentation).
 */
export declare function bundleSkillsForWorker(persona: Persona, worktreePath: string, options?: BundleSkillsOptions): Promise<SkillsBundleResult>;
/** Test-only: return the bundled skills root so tests can list available files. */
export declare function _getSkillsRootForTests(): string;
/** Test-only: return a snapshot of the alias map. */
export declare function _getSkillAliasesForTests(): Record<string, string>;
//# sourceMappingURL=skill-loader.d.ts.map
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
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { uuidv7 } from 'uuidv7';
import { logger } from '../config/logger.js';
import { BASELINE_PERSONAS } from './library/index.js';
const SYSTEM_ACTOR = { type: 'system', component: 'orchestrator' };
// ---------------------------------------------------------------------------
// Resolution paths
// ---------------------------------------------------------------------------
/** Compute the absolute path of the bundled skills directory.
 *
 * Resolution order:
 *  1. {dirname(this-file)}/skills/                 — works under tsx in src/
 *  2. {dirname(this-file)}/../../src/personas/skills/  — when running from dist/
 *
 * tsc by design does not copy non-TS files; the markdown files live only in
 * src/personas/skills/. We try the local sibling first (dev / tsx flow) and
 * fall back to the src/ tree (production build).
 */
function getSkillsRoot() {
    const here = fileURLToPath(import.meta.url);
    const dir = path.dirname(here);
    const local = path.join(dir, 'skills');
    // Caller checks file presence individually; we just return the most likely
    // root. Multi-root resolution is handled in resolveSkillFile() below.
    return local;
}
/**
 * Candidate roots to search for {slug}.md. We always check the dev sibling
 * first; if that fails we walk up to src/personas/skills/. This keeps the
 * loader working in both `npm run dev` (tsx, src/) and `npm run start`
 * (node, dist/) modes.
 */
function getSkillsSearchRoots() {
    const here = fileURLToPath(import.meta.url);
    const dir = path.dirname(here);
    // Walk up from dist/personas/ to find a sibling src/personas/skills/.
    // Worst case we hit packages/orchestrator/ (4 levels up from
    // dist/personas/skills) — be conservative with 5 levels of walk-up.
    const candidates = [path.join(dir, 'skills')];
    let cur = dir;
    for (let i = 0; i < 5; i++) {
        cur = path.dirname(cur);
        candidates.push(path.join(cur, 'src', 'personas', 'skills'));
    }
    return candidates;
}
/**
 * Skill-slug aliases. The 6 starter skill files have canonical filenames;
 * persona definitions historically reference different slugs that mean the
 * same thing. This map lets a persona's `tdd-cycle` skill resolve to
 * `tdd-workflow.md` without forcing every persona file to be edited.
 *
 * Entries are LITERAL slug → filename (without .md extension).
 */
const SKILL_ALIASES = {
    // TDD discipline
    'tdd-cycle': 'tdd-workflow',
    'tdd': 'tdd-workflow',
    // Commit message rules
    'conventional-commits': 'commit-message-conventions',
    'commit-conventions': 'commit-message-conventions',
    // DSQL constraints
    'dsql-constraints': 'aws-dsql-constraints',
    // Tailwind v4 patterns
    'tailwind-v4': 'react-tailwind-v4',
    'react-tailwind': 'react-tailwind-v4',
    // PR template
    'pull-request-template': 'pr-template',
    // Verifier (file shipped by Round5C)
    'verify-ac-strict': 'verify-ac-evidence-protocol',
};
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
export async function bundleSkillsForWorker(persona, worktreePath, options = {}) {
    const skillsRoot = getSkillsRoot();
    const targetDir = path.join(worktreePath, '.orbital', 'skills');
    await fs.mkdir(targetDir, { recursive: true, mode: 0o755 });
    const copied = [];
    const missing = [];
    // The loader currently writes 'unknown' as the skill slug when assembling
    // the Persona from DB rows (the join doesn't carry the slug). Fall back to
    // the BASELINE_PERSONAS source-of-truth so we still have the real slugs.
    const personaSkills = resolveSkillRefs(persona);
    // Order skills so the worker reads them in the persona's stated order.
    const ordered = [...personaSkills].sort((a, b) => a.ordering - b.ordering);
    for (const ref of ordered) {
        const resolved = await resolveSkillFile(skillsRoot, ref.slug);
        if (!resolved) {
            missing.push(ref.slug);
            continue;
        }
        const targetName = `${ref.slug}.md`;
        const targetPath = path.join(targetDir, targetName);
        try {
            const body = await fs.readFile(resolved, 'utf-8');
            await fs.writeFile(targetPath, body, { mode: 0o644 });
            copied.push(targetName);
            // Round 6 #10: emit SkillLoaded event if an event store was provided.
            if (options.eventStore) {
                const workerId = options.workerId ?? 'unknown';
                const sha256 = crypto.createHash('sha256').update(body).digest('hex');
                const skillPayload = {
                    worker_id: workerId,
                    skill_id: ref.slug,
                    loaded_at: new Date().toISOString(),
                    source_sha256: sha256,
                };
                await options.eventStore.append({
                    aggregate_id: workerId,
                    aggregate_type: 'orchestration',
                    event_type: 'SkillLoaded',
                    payload: skillPayload,
                    actor: SYSTEM_ACTOR,
                    trace_id: uuidv7(),
                    occurred_at: new Date().toISOString(),
                    schema_version: 1,
                }).catch((err) => {
                    logger.warn({ err, slug: ref.slug, workerId }, 'skill-loader: failed to emit SkillLoaded');
                });
            }
        }
        catch (err) {
            logger.warn({ err, slug: ref.slug, source: resolved, target: targetPath }, 'skill-loader: failed to copy skill file');
            missing.push(ref.slug);
        }
    }
    if (missing.length > 0) {
        logger.warn({ personaSlug: persona.slug, missingSkills: missing }, 'skill-loader: persona references skills with no markdown file');
    }
    return {
        skillsDir: targetDir,
        copied,
        missing,
    };
}
/**
 * Resolve a slug to an absolute markdown file path. Returns null if no file
 * matches in any candidate root.
 *
 * The signature still takes a `skillsRoot` for the dev-mode happy path, but
 * we also walk the search roots so the loader works after tsc build (where
 * the markdown files only exist in src/, not dist/).
 */
async function resolveSkillFile(skillsRoot, slug) {
    const roots = [skillsRoot, ...getSkillsSearchRoots().filter((r) => r !== skillsRoot)];
    for (const root of roots) {
        // 1. Direct hit on {slug}.md
        const direct = path.join(root, `${slug}.md`);
        if (await exists(direct))
            return direct;
        // 2. Aliased filename
        const alias = SKILL_ALIASES[slug];
        if (alias) {
            const aliased = path.join(root, `${alias}.md`);
            if (await exists(aliased))
                return aliased;
        }
    }
    return null;
}
async function exists(p) {
    try {
        await fs.access(p);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Return the persona's skill references with real slugs. If the Persona
 * arrives with 'unknown' slugs (the existing loader.assemblePersona stub),
 * fall back to BASELINE_PERSONAS keyed by slug so we still know which
 * skills to copy.
 */
function resolveSkillRefs(persona) {
    const allUnknown = persona.skills.length > 0 && persona.skills.every((s) => s.slug === 'unknown');
    if (!allUnknown)
        return persona.skills;
    const baseline = BASELINE_PERSONAS.find((p) => p.slug === persona.slug);
    if (!baseline)
        return persona.skills;
    // Preserve the ordering values from the persisted persona (they should
    // match between DB and definition; we still pick whichever arrives first).
    return baseline.skills;
}
// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
/** Test-only: return the bundled skills root so tests can list available files. */
export function _getSkillsRootForTests() {
    return getSkillsRoot();
}
/** Test-only: return a snapshot of the alias map. */
export function _getSkillAliasesForTests() {
    return { ...SKILL_ALIASES };
}
//# sourceMappingURL=skill-loader.js.map
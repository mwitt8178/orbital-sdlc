/**
 * Persona-of-record reasoning prompt.
 *
 * Used by `uat/persona-of-record.ts` when the four-step attestation chain
 * walks all the way to the tasks.persona_id fallback. Before settling on the
 * task's assigned persona, we do one cheap LLM call to ask: "given this
 * defect description and the recent commit log for these files, who is the
 * most likely persona-of-record?"
 *
 * The model sees the candidate personas (typically: pm, sr-dev, jr-dev,
 * principal-dev, qa, architect, security) along with a short blurb about
 * each, plus the defect description and file paths. It returns a persona_id
 * with a confidence score 0-100. When confidence < 60 we discard the
 * suggestion and fall back to tasks.persona_id; when ≥ 60 we use it.
 */
import { z } from 'zod';
export declare const PersonaOfRecordResponseSchema: z.ZodObject<{
    persona_id: z.ZodString;
    confidence_score: z.ZodNumber;
    rationale: z.ZodString;
}, "strip", z.ZodTypeAny, {
    persona_id: string;
    rationale: string;
    confidence_score: number;
}, {
    persona_id: string;
    rationale: string;
    confidence_score: number;
}>;
export type PersonaOfRecordResponse = z.infer<typeof PersonaOfRecordResponseSchema>;
export interface PersonaOfRecordContext {
    /** AC id we're trying to attribute. */
    acId: string;
    /** Story id. */
    storyId: string;
    /** Defect description (free text from the UAT submitter). */
    defectDescription: string;
    /** Files associated with the defect (from worktree or task metadata). */
    filePaths: string[];
    /** Recent commits touching these files, oldest first. */
    recentCommits: Array<{
        sha: string;
        message: string;
        author: string;
        files: string[];
    }>;
    /** Candidate persona slugs available in the install. */
    candidatePersonaSlugs: string[];
    /** The tasks.persona_id fallback — what we'd use if this LLM call fails. */
    tasksFallbackPersonaId: string;
}
export declare function buildPersonaOfRecordSystemPrompt(): string;
export declare function buildPersonaOfRecordUserPrompt(ctx: PersonaOfRecordContext): string;
//# sourceMappingURL=persona-of-record.d.ts.map
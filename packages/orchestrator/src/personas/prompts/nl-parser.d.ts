/**
 * NL ticket parser persona system prompt.
 *
 * Used by `backlog/nl-parser.ts` in real-LLM mode. The parser's job is to
 * classify a single user prompt as a story / bug / epic and produce a
 * structured Proposal with title, description, ACs, suggested epic, priority,
 * and story points.
 */
import { z } from 'zod';
export declare const NLParserResponseSchema: z.ZodObject<{
    kind: z.ZodEnum<["story", "bug", "epic"]>;
    title: z.ZodString;
    description: z.ZodString;
    ac_titles: z.ZodArray<z.ZodString, "many">;
    /** Must match an existing epic title from the input list, or null. */
    suggested_epic_title: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    /** 0=critical, 100=normal, 200=low. */
    priority: z.ZodNumber;
    /** Fibonacci: 1, 2, 3, 5, 8, 13. Null for epics. */
    story_points: z.ZodNullable<z.ZodNumber>;
    /** Required when kind === 'bug'. */
    severity: z.ZodOptional<z.ZodEnum<["low", "medium", "high", "critical"]>>;
    rationale: z.ZodArray<z.ZodString, "many">;
}, "strip", z.ZodTypeAny, {
    description: string;
    kind: "epic" | "story" | "bug";
    title: string;
    rationale: string[];
    priority: number;
    story_points: number | null;
    ac_titles: string[];
    severity?: "low" | "high" | "critical" | "medium" | undefined;
    suggested_epic_title?: string | null | undefined;
}, {
    description: string;
    kind: "epic" | "story" | "bug";
    title: string;
    rationale: string[];
    priority: number;
    story_points: number | null;
    ac_titles: string[];
    severity?: "low" | "high" | "critical" | "medium" | undefined;
    suggested_epic_title?: string | null | undefined;
}>;
export type NLParserResponse = z.infer<typeof NLParserResponseSchema>;
export interface NLParserContext {
    /** Vision title; empty when no locked vision exists. */
    visionTitle: string;
    /** Vision summary truncated. */
    visionSummary: string;
    /** Up to 5 top goals. */
    topGoals: string[];
    /** Existing epic titles (so the parser can suggest one). */
    existingEpicTitles: string[];
    /** Force-classification override from the UI ("+ Bug" button etc.). */
    forceKind?: 'story' | 'bug' | 'epic';
}
export declare function buildNLParserSystemPrompt(): string;
export declare function buildNLParserUserPrompt(prompt: string, ctx: NLParserContext): string;
//# sourceMappingURL=nl-parser.d.ts.map
/**
 * NL ticket parser persona system prompt.
 *
 * Used by `backlog/nl-parser.ts` in real-LLM mode. The parser's job is to
 * classify a single user prompt as a story / bug / epic and produce a
 * structured Proposal with title, description, ACs, suggested epic, priority,
 * and story points.
 */
import { z } from 'zod';
// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------
export const NLParserResponseSchema = z.object({
    kind: z.enum(['story', 'bug', 'epic']),
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(4000),
    ac_titles: z.array(z.string().min(1).max(500)).min(1).max(5),
    /** Must match an existing epic title from the input list, or null. */
    suggested_epic_title: z.string().nullable().optional(),
    /** 0=critical, 100=normal, 200=low. */
    priority: z.number().int().min(0).max(200),
    /** Fibonacci: 1, 2, 3, 5, 8, 13. Null for epics. */
    story_points: z.number().int().nullable(),
    /** Required when kind === 'bug'. */
    severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    rationale: z.array(z.string().min(1).max(500)).min(1).max(5),
});
// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------
const STATIC_SYSTEM = `# Role: Backlog Triage

You classify a single user prompt into a backlog ticket for an agile product
team. Your output is structured: kind, title, description, acceptance
criteria, suggested epic, priority, and story points.

## Classification rules

- \`bug\`: something is broken, regressed, or producing errors. Bug language:
  "broken", "doesn't work", "crashes", "500/400/404 error", "blank screen",
  "regression", "production down".
- \`epic\`: a multi-feature initiative or theme. Epic language: "epic",
  "theme", "initiative", "milestone", "overhaul".
- \`story\`: anything else — typically "I want…", "as a user…", "add X",
  "build Y", "implement Z".

When the user explicitly forces a kind (forceKind) you respect that; classifier
output is overridden.

## Title

Strip filler ("I want to", "as a user, please") and trailing punctuation.
Capitalise first letter. Aim for 6-8 words.

## Description

Restate the user's prompt in one paragraph plus a one-line clarification
(e.g. "Captured as a user story.").

## Acceptance criteria

- 2-3 ACs for stories and bugs.
- Bug ACs MUST cover: reproducibility, regression test, and post-fix
  non-reproduction.
- Epic ACs MUST cover: that the epic decomposes into 3-7 stories with shared
  user-facing outcome.
- Story ACs should be observable behaviour ("user can do X", "system rejects
  Y with clear error").

## Suggested epic

Compare the prompt to the list of existing epic titles. If word overlap is
clearly meaningful (≥1 strong content token shared), set
\`suggested_epic_title\` to that title VERBATIM. Otherwise set it to null.

## Priority

- Bug critical: 0
- Bug high: 10
- Bug medium: 100
- Bug low: 200
- Stories and epics: 100

## Story points (Fibonacci: 1, 2, 3, 5, 8, 13)

- Bug low: 1
- Bug other: 2
- Story typical: 3
- Story complex: 5 or 8
- Epic: null

## Severity (bug only)

Match the user's language:
- "production down", "every user", "data loss", "security": critical
- "high", "major", "users blocked", "crashes always": high
- default: medium
- "minor", "typo", "cosmetic": low

## Rationale

1-2 short bullets explaining the classification. The first bullet should
state the engine ("anthropic-driver/<model>" — the driver fills this in).
You add 1-2 bullets describing why this kind, why this severity (if bug),
and any noteworthy ambiguity.

Respond now via the respond_with_json tool.`;
export function buildNLParserSystemPrompt() {
    return STATIC_SYSTEM;
}
export function buildNLParserUserPrompt(prompt, ctx) {
    const lines = [];
    lines.push('## Vision context');
    if (ctx.visionTitle)
        lines.push(`Title: ${ctx.visionTitle}`);
    if (ctx.visionSummary)
        lines.push(`Summary: ${ctx.visionSummary}`);
    if (ctx.topGoals.length > 0) {
        lines.push('Goals:');
        for (const g of ctx.topGoals)
            lines.push(`  - ${g}`);
    }
    if (!ctx.visionTitle && !ctx.visionSummary && ctx.topGoals.length === 0) {
        lines.push('(no locked vision)');
    }
    lines.push('');
    lines.push('## Existing epics');
    if (ctx.existingEpicTitles.length === 0) {
        lines.push('(none)');
    }
    else {
        for (const t of ctx.existingEpicTitles)
            lines.push(`- ${t}`);
    }
    if (ctx.forceKind) {
        lines.push('');
        lines.push(`## Forced kind`);
        lines.push(`The UI has classified this as \`${ctx.forceKind}\`. Honour that.`);
    }
    lines.push('');
    lines.push('## User prompt');
    lines.push('"""');
    lines.push(prompt.slice(0, 4000));
    lines.push('"""');
    lines.push('');
    lines.push('Classify and structure this prompt now.');
    return lines.join('\n');
}
//# sourceMappingURL=nl-parser.js.map
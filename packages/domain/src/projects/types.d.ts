/**
 * projects/types.ts — Zod schemas + error codes for the projects bounded
 * context.
 *
 * Per Round 4 Projects Feature spec.
 */
import { z } from 'zod';
export declare const projectSlugSchema: z.ZodString;
export declare const CreateProjectInputSchema: z.ZodObject<{
    name: z.ZodString;
    slug: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    /** Optional: connect Monday board on create. */
    mondayBoardId: z.ZodOptional<z.ZodString>;
    /** Optional: connect Github repo on create. */
    githubOwner: z.ZodOptional<z.ZodString>;
    githubRepo: z.ZodOptional<z.ZodString>;
    githubDefaultBranch: z.ZodOptional<z.ZodString>;
    /**
     * Round 9 — onboarding flow A. Captures the operator's intent for the
     * router's provisioner step (the router does the actual Monday + GitHub
     * API calls; this flag is recorded on the ProjectCreated event for audit
     * traceability).
     * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
     */
    provisioning: z.ZodOptional<z.ZodObject<{
        monday: z.ZodDefault<z.ZodBoolean>;
        github: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        monday: boolean;
        github: boolean;
    }, {
        monday?: boolean | undefined;
        github?: boolean | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    name: string;
    slug: string;
    description?: string | undefined;
    mondayBoardId?: string | undefined;
    githubOwner?: string | undefined;
    githubRepo?: string | undefined;
    githubDefaultBranch?: string | undefined;
    provisioning?: {
        monday: boolean;
        github: boolean;
    } | undefined;
}, {
    name: string;
    slug: string;
    description?: string | undefined;
    mondayBoardId?: string | undefined;
    githubOwner?: string | undefined;
    githubRepo?: string | undefined;
    githubDefaultBranch?: string | undefined;
    provisioning?: {
        monday?: boolean | undefined;
        github?: boolean | undefined;
    } | undefined;
}>;
export type CreateProjectInput = z.infer<typeof CreateProjectInputSchema>;
export declare const UpdateProjectInputSchema: z.ZodObject<{
    projectId: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    projectId: string;
    name?: string | undefined;
    description?: string | null | undefined;
}, {
    projectId: string;
    name?: string | undefined;
    description?: string | null | undefined;
}>;
export type UpdateProjectInput = z.infer<typeof UpdateProjectInputSchema>;
export declare const ConnectMondayInputSchema: z.ZodObject<{
    projectId: z.ZodString;
    boardId: z.ZodString;
}, "strip", z.ZodTypeAny, {
    projectId: string;
    boardId: string;
}, {
    projectId: string;
    boardId: string;
}>;
export type ConnectMondayInput = z.infer<typeof ConnectMondayInputSchema>;
export declare const ConnectGithubInputSchema: z.ZodObject<{
    projectId: z.ZodString;
    owner: z.ZodString;
    repo: z.ZodString;
    defaultBranch: z.ZodDefault<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    projectId: string;
    owner: string;
    repo: string;
    defaultBranch: string;
}, {
    projectId: string;
    owner: string;
    repo: string;
    defaultBranch?: string | undefined;
}>;
export type ConnectGithubInput = z.infer<typeof ConnectGithubInputSchema>;
export declare const ProjectOutputSchema: z.ZodObject<{
    projectId: z.ZodString;
    installId: z.ZodString;
    name: z.ZodString;
    slug: z.ZodString;
    description: z.ZodNullable<z.ZodString>;
    mondayBoardId: z.ZodNullable<z.ZodString>;
    githubOwner: z.ZodNullable<z.ZodString>;
    githubRepo: z.ZodNullable<z.ZodString>;
    githubDefaultBranch: z.ZodString;
    archivedAt: z.ZodNullable<z.ZodString>;
    createdByEventId: z.ZodNullable<z.ZodString>;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
    schemaVersion: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    name: string;
    schemaVersion: number;
    description: string | null;
    createdAt: string;
    archivedAt: string | null;
    projectId: string;
    updatedAt: string;
    installId: string;
    createdByEventId: string | null;
    slug: string;
    mondayBoardId: string | null;
    githubOwner: string | null;
    githubRepo: string | null;
    githubDefaultBranch: string;
}, {
    name: string;
    schemaVersion: number;
    description: string | null;
    createdAt: string;
    archivedAt: string | null;
    projectId: string;
    updatedAt: string;
    installId: string;
    createdByEventId: string | null;
    slug: string;
    mondayBoardId: string | null;
    githubOwner: string | null;
    githubRepo: string | null;
    githubDefaultBranch: string;
}>;
export type ProjectOutput = z.infer<typeof ProjectOutputSchema>;
export declare const PROJECTS_ERROR_CODES: {
    /** Project not found by id. */
    readonly NOT_FOUND_PROJECT: "NOT_FOUND_PROJECT";
    /** Slug already in use within this install. */
    readonly CONFLICT_SLUG: "CONFLICT_SLUG";
    /** Active project required by this procedure but missing from request. */
    readonly ACTIVE_PROJECT_REQUIRED: "ACTIVE_PROJECT_REQUIRED";
    /** Validation error on input. */
    readonly VALIDATION_ERROR: "VALIDATION_ERROR";
    /** Internal DB error. */
    readonly INTERNAL_DB_ERROR: "INTERNAL_DB_ERROR";
    /** Monday board connect failed (board not found / wrong permissions). */
    readonly MONDAY_CONNECT_FAILED: "MONDAY_CONNECT_FAILED";
    /** Github repo connect failed (repo not found / wrong permissions). */
    readonly GITHUB_CONNECT_FAILED: "GITHUB_CONNECT_FAILED";
};
export type ProjectsErrorCode = (typeof PROJECTS_ERROR_CODES)[keyof typeof PROJECTS_ERROR_CODES];
//# sourceMappingURL=types.d.ts.map
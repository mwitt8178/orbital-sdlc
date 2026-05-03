/**
 * github/types.ts — Github integration types + error codes.
 *
 * Per Round 4 Projects Feature spec.
 *
 * Error codes mirror MondayClient (INTEGRATION_GITHUB_DOWN /
 * INTEGRATION_GITHUB_AUTH / RATE_LIMIT_GITHUB_API / STARTUP_ERROR) so the UI
 * can render consistent integration banners.
 */
export const GITHUB_ERROR_CODES = {
    /** Github 5xx / network failure. Retryable with backoff. */
    INTEGRATION_GITHUB_DOWN: 'INTEGRATION_GITHUB_DOWN',
    /** Github 401 / 403 with auth issue (token invalid or scopes missing). */
    INTEGRATION_GITHUB_AUTH: 'INTEGRATION_GITHUB_AUTH',
    /** Github primary or secondary rate limit hit. */
    RATE_LIMIT_GITHUB_API: 'RATE_LIMIT_GITHUB_API',
    /** Token missing entirely; surface to user. */
    STARTUP_ERROR: 'STARTUP_ERROR',
    /** 404 from the Github API — repo / branch / user not found. */
    NOT_FOUND_GITHUB: 'NOT_FOUND_GITHUB',
    /** Validation error on input. */
    VALIDATION_ERROR: 'VALIDATION_ERROR',
};
//# sourceMappingURL=types.js.map
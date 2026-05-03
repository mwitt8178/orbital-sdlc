/**
 * drivers/types.ts — shared interface contract for all LLM provider drivers.
 *
 * Every driver (Anthropic, OpenAI, Bedrock) must implement LLMDriver.
 * The FallbackDriver wraps multiple LLMDriver instances.
 *
 * Per Round 6 #8 spec.
 */
// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------
export class ProviderError extends Error {
    providerId;
    retriable;
    httpStatus;
    constructor(providerId, retriable, httpStatus, message) {
        super(message ?? `Provider ${providerId} error${httpStatus ? ` (HTTP ${httpStatus})` : ''}`);
        this.providerId = providerId;
        this.retriable = retriable;
        this.httpStatus = httpStatus;
        this.name = 'ProviderError';
    }
}
//# sourceMappingURL=types.js.map
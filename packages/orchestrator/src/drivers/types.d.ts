/**
 * drivers/types.ts — shared interface contract for all LLM provider drivers.
 *
 * Every driver (Anthropic, OpenAI, Bedrock) must implement LLMDriver.
 * The FallbackDriver wraps multiple LLMDriver instances.
 *
 * Per Round 6 #8 spec.
 */
export interface TextBlock {
    type: 'text';
    text: string;
}
export interface ToolUseBlock {
    type: 'tool_use';
    id: string;
    name: string;
    input: unknown;
}
export type ContentBlock = TextBlock | ToolUseBlock;
export interface Message {
    role: 'user' | 'assistant';
    content: string | ContentBlock[];
}
export interface ToolDef {
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
}
export interface LLMRequest {
    model: string;
    system?: string | Array<{
        type: 'text';
        text: string;
        cache_control?: {
            type: 'ephemeral';
        };
    }>;
    messages: Message[];
    tools?: ToolDef[];
    tool_choice?: {
        type: 'tool';
        name: string;
    } | {
        type: 'auto';
    };
    maxTokens?: number;
    temperature?: number;
}
export interface LLMResponse {
    content: ContentBlock[];
    usage: {
        input_tokens: number;
        output_tokens: number;
        cache_read?: number;
        cache_write?: number;
    };
    /** Provider-shaped raw body for replay capture. */
    raw?: unknown;
}
export interface EmbedRequest {
    model: string;
    input: string | string[];
}
export interface EmbedResponse {
    embeddings: number[][];
    usage: {
        input_tokens: number;
    };
}
export interface ProviderHealth {
    healthy: boolean;
    providerId: string;
    latencyMs?: number;
    lastCheckedAt: string;
    reason?: string;
}
export interface LLMDriver {
    readonly providerId: string;
    readonly availableModels: readonly string[];
    send(req: LLMRequest): Promise<LLMResponse>;
    embed?(req: EmbedRequest): Promise<EmbedResponse>;
    health(): Promise<ProviderHealth>;
}
export declare class ProviderError extends Error {
    readonly providerId: string;
    readonly retriable: boolean;
    readonly httpStatus?: number | undefined;
    constructor(providerId: string, retriable: boolean, httpStatus?: number | undefined, message?: string);
}
export interface ModelChoice {
    provider: string;
    model: string;
}
export type CircuitState = 'closed' | 'open' | 'half-open';
export interface CircuitBreakerState {
    state: CircuitState;
    consecutiveFailures: number;
    lastFailureAt?: string;
    openedAt?: string;
    nextProbeAt?: string;
}
//# sourceMappingURL=types.d.ts.map
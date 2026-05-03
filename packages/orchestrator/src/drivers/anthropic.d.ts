/**
 * drivers/anthropic.ts — Anthropic provider driver.
 *
 * Implements the LLMDriver interface using the @anthropic-ai/sdk.
 * Extracted from personas/anthropic-driver.ts (which becomes a thin wrapper
 * that delegates here for backwards compatibility).
 *
 * Per Round 6 #8 spec.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { LLMDriver, LLMRequest, LLMResponse, EmbedRequest, EmbedResponse, ProviderHealth } from './types.js';
export declare class AnthropicDriver implements LLMDriver {
    readonly providerId = "anthropic";
    readonly availableModels: readonly string[];
    private _healthCache;
    /** Test seam — override the SDK constructor. */
    private readonly _clientFactory;
    constructor(opts?: {
        clientFactory?: (apiKey: string, timeoutMs: number) => Anthropic;
    });
    send(req: LLMRequest): Promise<LLMResponse>;
    embed(_req: EmbedRequest): Promise<EmbedResponse>;
    health(): Promise<ProviderHealth>;
}
export declare function createAnthropicDriver(opts?: {
    clientFactory?: (apiKey: string, timeoutMs: number) => Anthropic;
}): AnthropicDriver;
//# sourceMappingURL=anthropic.d.ts.map
import pino from 'pino';
export declare const logger: pino.Logger<never, boolean>;
export type Logger = typeof logger;
export interface LogContext {
    actor_type?: string;
    capability_id?: string;
    [key: string]: unknown;
}
export declare function loggerWithContext(ctx?: LogContext): pino.Logger;
//# sourceMappingURL=logger.d.ts.map
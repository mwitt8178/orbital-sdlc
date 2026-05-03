import { z } from 'zod';
/** Branded install ID — UUIDv7. */
export type InstallId = string & {
    readonly __brand: 'InstallId';
};
declare const installSchema: z.ZodObject<{
    install_id: z.ZodString;
    created_at: z.ZodString;
    schema_version: z.ZodLiteral<1>;
}, "strip", z.ZodTypeAny, {
    schema_version: 1;
    install_id: string;
    created_at: string;
}, {
    schema_version: 1;
    install_id: string;
    created_at: string;
}>;
export type InstallConfig = z.infer<typeof installSchema>;
export declare function loadOrCreateInstall(): Promise<InstallConfig>;
export declare function getInstallId(): Promise<InstallId>;
/** Test helper. */
export declare function resetInstallCache(): void;
export {};
//# sourceMappingURL=install.d.ts.map
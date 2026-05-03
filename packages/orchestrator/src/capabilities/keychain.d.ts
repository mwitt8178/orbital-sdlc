/**
 * OS keychain wrapper for storing private key bytes.
 *
 * Production path uses `keytar`, which talks to the OS-native credential
 * service (macOS Keychain, Linux libsecret, Windows DPAPI). The `keytar`
 * package is loaded lazily so the test path works on machines without the
 * native binary built.
 *
 * Test path (env: `ORBITAL_TEST_KEYCHAIN=1`) writes to a file at
 * `~/.orbital-test-keychain.json` with mode 0600. This is ONLY used in
 * test mode — never in production code paths.
 *
 * Per Implementation Plan §13: the file shim must never be touched in
 * production. Production startup MUST fail loudly if keytar cannot load
 * its native module (we surface the error rather than silently falling
 * back to the shim).
 */
declare const SERVICE_NAME = "orbital";
export interface Keychain {
    setPassword(account: string, secret: string): Promise<void>;
    getPassword(account: string): Promise<string | null>;
    deletePassword(account: string): Promise<boolean>;
    /** List all accounts under the orbital service. Test helper. */
    listAccounts(): Promise<string[]>;
}
declare class FileShimKeychain implements Keychain {
    private readonly path;
    constructor(filePath?: string);
    setPassword(account: string, secret: string): Promise<void>;
    getPassword(account: string): Promise<string | null>;
    deletePassword(account: string): Promise<boolean>;
    listAccounts(): Promise<string[]>;
    private readSafe;
    private writeAtomic;
    /** Verify the shim file is mode 0600. Throws if not. Test helper. */
    assertSecure(): Promise<void>;
    /** Test-only: remove the shim file entirely. */
    purge(): Promise<void>;
    /** Expose path for assertions. */
    get filePath(): string;
}
/**
 * Get the active keychain. Returns the file shim when ORBITAL_TEST_KEYCHAIN=1,
 * a noop in AWS deploy mode (no OS keychain in Lambda), otherwise the real
 * keytar-backed keychain.
 *
 * The first call instantiates and caches the result. Production startup is
 * expected to call this once at boot to surface keytar load errors.
 *
 * In test mode, an optional `ORBITAL_TEST_KEYCHAIN_PATH` env var overrides
 * the default `~/.orbital-test-keychain.json` location. This permits parallel
 * test workers to isolate their keychains.
 */
export declare function getKeychain(): Promise<Keychain>;
/** Reset the cached keychain. Test helper. */
export declare function resetKeychainCache(): void;
/** Test-only access to the file shim's helpers (assertSecure, purge). */
export declare function getTestShimKeychain(): Promise<FileShimKeychain>;
/** Service name constant — exported for diagnostics and tests. */
export { SERVICE_NAME as KEYCHAIN_SERVICE_NAME };
//# sourceMappingURL=keychain.d.ts.map
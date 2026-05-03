/**
 * keys/install-key.ts — This install's Ed25519 keypair lifecycle.
 *
 * Round 7-03 — Federation Auth (Identity & Pairing)
 * [Engineer-Principal · Opus · run-round7-03-federation-auth]
 *
 * Each laptop has exactly one Ed25519 keypair used to sign every outbound
 * request to the hub. The pair is generated on first need and persisted to
 * disk at `~/.orbital/keys/install.json` (mode 0600). The install_id is the
 * UUIDv7 stamped at first generation; it never changes for the lifetime of
 * the install (key rotation generates a new public_key but preserves install_id).
 *
 * Persistence rationale: we use a 0600 file rather than the OS keychain for
 * the install key because (a) hub-mode deployments run in containers without
 * a system keychain, and (b) the install key is operator-confidential, not
 * per-tenant — its scope is the laptop. Cap-bundle sub-keys still use the
 * OS keychain via `capabilities/keychain.ts`.
 *
 * Test path: `ORBITAL_INSTALL_KEY_PATH` env var overrides the on-disk location
 * for parallel test isolation.
 *
 * Critical invariant: the private key bytes NEVER appear in a log line, an
 * HTTP body, or an audit event. Only `bytesToBase64Url(publicKey)` is allowed
 * to leave this module.
 */
export interface InstallKey {
    installId: string;
    publicKey: Uint8Array;
    privateKey: Uint8Array;
    createdAt: string;
}
/** Default path: `<ORBITAL_HOME or ~/.orbital>/keys/install.json`. Overridable. */
export declare function defaultInstallKeyPath(): string;
/**
 * Load the install key from disk. Returns null if no file exists (caller
 * should call generateAndPersist).
 *
 * Throws on parse error or wrong file format — never silently regenerates,
 * because regeneration would invalidate the hub's known_installs row for
 * this install_id and lock the operator out.
 */
export declare function loadInstallKey(filePath?: string): Promise<InstallKey | null>;
/**
 * Generate a new Ed25519 keypair and persist to disk. Used on first run
 * (or first `orbital join`).
 *
 * The directory is created with mode 0700; the file with mode 0600. The
 * write is atomic (tmp → rename) to avoid leaving a half-written file on
 * crash.
 *
 * NEVER logs the private key. The `info` log line below contains only the
 * install_id and a fingerprint of the public key.
 */
export declare function generateAndPersistInstallKey(opts: {
    filePath?: string;
    /** Optional pre-supplied install_id (e.g. matched to a hub join request). */
    installId?: string;
}): Promise<InstallKey>;
/**
 * Load the existing install key, or generate one if no file exists. The
 * canonical "give me my key" entrypoint for hub-client/auth.ts and the CLI.
 */
export declare function getOrCreateInstallKey(opts?: {
    filePath?: string;
}): Promise<InstallKey>;
/**
 * Wipe the on-disk install key. Test-only — production paths must never
 * call this. Throws if the file doesn't exist.
 */
export declare function _purgeInstallKey(filePath?: string): Promise<void>;
//# sourceMappingURL=install-key.d.ts.map
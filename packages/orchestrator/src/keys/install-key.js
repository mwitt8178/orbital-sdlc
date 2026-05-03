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
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as ed from '@noble/ed25519';
import { uuidv7 } from 'uuidv7';
import { logger } from '../config/logger.js';
import { bytesToBase64Url, base64UrlToBytes } from './envelope.js';
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------
/** Default path: `<ORBITAL_HOME or ~/.orbital>/keys/install.json`. Overridable. */
export function defaultInstallKeyPath() {
    const override = process.env['ORBITAL_INSTALL_KEY_PATH'];
    if (override && override.length > 0)
        return override;
    const orbitalHome = process.env['ORBITAL_HOME'] ?? path.join(os.homedir(), '.orbital');
    return path.join(orbitalHome, 'keys', 'install.json');
}
// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------
/**
 * Load the install key from disk. Returns null if no file exists (caller
 * should call generateAndPersist).
 *
 * Throws on parse error or wrong file format — never silently regenerates,
 * because regeneration would invalidate the hub's known_installs row for
 * this install_id and lock the operator out.
 */
export async function loadInstallKey(filePath) {
    const target = filePath ?? defaultInstallKeyPath();
    let raw;
    try {
        raw = await fs.readFile(target, 'utf-8');
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return null;
        throw err;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (err) {
        throw new Error(`install-key: ${target} is corrupt (JSON parse failed: ${err.message}). ` +
            `Delete and re-run \`orbital join\`, or restore from backup. ` +
            `DO NOT auto-regenerate — that would invalidate the hub's record of this install.`);
    }
    if (typeof parsed.install_id !== 'string' ||
        typeof parsed.public_key !== 'string' ||
        typeof parsed.private_key !== 'string' ||
        typeof parsed.created_at !== 'string') {
        throw new Error(`install-key: ${target} is missing required fields. ` +
            `Expected install_id / public_key / private_key / created_at.`);
    }
    return {
        installId: parsed.install_id,
        publicKey: base64UrlToBytes(parsed.public_key),
        privateKey: base64UrlToBytes(parsed.private_key),
        createdAt: parsed.created_at,
    };
}
// ---------------------------------------------------------------------------
// Generate + persist
// ---------------------------------------------------------------------------
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
export async function generateAndPersistInstallKey(opts) {
    const target = opts.filePath ?? defaultInstallKeyPath();
    const installId = opts.installId ?? uuidv7();
    const privateKey = ed.utils.randomPrivateKey();
    const publicKey = await ed.getPublicKeyAsync(privateKey);
    const createdAt = new Date().toISOString();
    const fileShape = {
        install_id: installId,
        created_at: createdAt,
        public_key: bytesToBase64Url(publicKey),
        private_key: bytesToBase64Url(privateKey),
    };
    // Ensure parent dir exists with secure mode
    const dir = path.dirname(target);
    await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
    // chmod is best-effort — mkdir's `mode` is honoured only if the dir doesn't
    // already exist. Set explicitly for safety.
    try {
        await fs.chmod(dir, DIR_MODE);
    }
    catch {
        // If we can't chmod the parent (e.g. someone else owns it), that's a
        // deployment concern — we still proceed but log warn.
        logger.warn({ dir }, 'install-key: could not chmod 0700 on parent dir');
    }
    // Atomic write
    const tmp = `${target}.tmp.${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(fileShape, null, 2), { mode: FILE_MODE });
    await fs.rename(tmp, target);
    await fs.chmod(target, FILE_MODE);
    // Log only safe metadata. Never the private key.
    const fingerprint = bytesToBase64Url(publicKey).slice(0, 12);
    logger.info({ installId, fingerprint, path: target }, 'install-key: generated new Ed25519 keypair');
    return {
        installId,
        publicKey,
        privateKey,
        createdAt,
    };
}
// ---------------------------------------------------------------------------
// Get-or-create
// ---------------------------------------------------------------------------
/**
 * Load the existing install key, or generate one if no file exists. The
 * canonical "give me my key" entrypoint for hub-client/auth.ts and the CLI.
 */
export async function getOrCreateInstallKey(opts = {}) {
    const existing = await loadInstallKey(opts.filePath);
    if (existing)
        return existing;
    return generateAndPersistInstallKey({ filePath: opts.filePath });
}
// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
/**
 * Wipe the on-disk install key. Test-only — production paths must never
 * call this. Throws if the file doesn't exist.
 */
export async function _purgeInstallKey(filePath) {
    if (process.env['NODE_ENV'] === 'production') {
        throw new Error('install-key: _purgeInstallKey is forbidden in production');
    }
    const target = filePath ?? defaultInstallKeyPath();
    try {
        await fs.unlink(target);
    }
    catch (err) {
        if (err.code !== 'ENOENT')
            throw err;
    }
}
//# sourceMappingURL=install-key.js.map
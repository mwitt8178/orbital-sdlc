/**
 * KeyManager — two-tier Ed25519 key hierarchy.
 *
 * Per TRD-06 §11.1 and SAO §5.4:
 * - Master key (KEK): Ed25519 keypair generated at orbital init.
 * - Sub-keys (DEKs): Ed25519 keypair per sprint at sprint-start. Master signs
 *   `H(sub_pub_key || sub.created_at || install_id || sprint_id)` to bind the
 *   sub-key into the chain.
 * - Private bytes live in the OS keychain. Public bytes live in `signing_keys`.
 * - Sub-key private retention: 30 days after sprint close, then zeroized.
 *
 * Real cryptography only — `@noble/ed25519` v2 with SHA-512 wired in.
 */
import { type Actor } from '@orbital/types';
import type { EventStore } from '../events/store.js';
export interface MasterKey {
    keyId: string;
    publicKey: Uint8Array;
    installId: string;
    createdAt: string;
    status: 'active' | 'retired' | 'archived' | 'compromised';
}
export interface SubKey {
    keyId: string;
    parentKeyId: string;
    publicKey: Uint8Array;
    installId: string;
    sprintId: string;
    parentSignature: string;
    createdAt: string;
    activeFrom: string;
    activeUntil: string | null;
    status: 'active' | 'retired' | 'archived' | 'compromised';
}
export interface SignedMessage {
    signature: string;
    signingKeyId: string;
}
/** The bytes the master signs to bind a sub-key into the chain. */
declare function subKeyChainMessage(subPublicKey: Uint8Array, createdAt: string, installId: string, sprintId: string): Uint8Array;
export declare class KeyManager {
    private readonly installId;
    private readonly eventStore;
    constructor(installId: string, eventStore: EventStore);
    /**
     * Generate a new master keypair, persist private to keychain, public + metadata
     * to signing_keys, and record in key_history. No event is emitted for the
     * initial bootstrap; rotation events emit KeyRotated.
     */
    generateMaster(actor: Actor): Promise<MasterKey>;
    /** Get the active master key. Returns null if none. */
    getActiveMaster(): Promise<MasterKey | null>;
    /** Get or create the active master key. */
    getOrCreateActiveMaster(actor: Actor): Promise<MasterKey>;
    /**
     * Generate a new sprint sub-key. Master signs the sub-key public component
     * to bind it into the chain. Records key_history `signed_sub` transition.
     */
    generateSubKey(sprintId: string, actor: Actor): Promise<SubKey>;
    /** Get the active sub-key for the sprint, or null if none. */
    getActiveSubKey(sprintId: string): Promise<SubKey | null>;
    /** Get or generate the active sub-key for the sprint. */
    getOrCreateActiveSubKey(sprintId: string, actor: Actor): Promise<SubKey>;
    /** Lookup any sub-key by id, including retired/archived for historical verify. */
    getSubKeyById(keyId: string): Promise<SubKey | null>;
    /** Lookup any master by id. */
    getMasterById(keyId: string): Promise<MasterKey | null>;
    /** Sign arbitrary message bytes with the named sub-key's private. */
    signWithSubKey(keyId: string, message: Uint8Array): Promise<SignedMessage>;
    /** Verify a signature against a sub-key's public component. */
    verifyWithSubKey(keyId: string, message: Uint8Array, signatureB64: string): Promise<boolean>;
    /**
     * Verify the chain: a sub-key is valid for a given timestamp if it was
     * signed by a master that was active at that time and the sub-key itself
     * was active.
     */
    verifySubKeyChain(keyId: string, atTime: string): Promise<boolean>;
    /**
     * Rotate: generate a new sub-key for the sprint, retire the old, emit
     * `KeyRotated` event. Old key's public component remains for historical
     * verification; private retained for the 30-day retention window.
     */
    rotate(sprintId: string, actor: Actor): Promise<{
        retiredKeyId: string;
        newKeyId: string;
    }>;
    /**
     * Archive: zeroize private component, emit `KeyArchived` event, leave public
     * component for historical verification. Idempotent — re-archiving a key
     * already archived is a no-op.
     */
    archive(keyId: string, retentionBasis: 'sprint_close_30d' | 'master_rotation' | 'compromise', actor: Actor): Promise<void>;
    private loadMasterPrivate;
    private loadSubPrivate;
    private recordHistory;
    private emitKeyRotated;
}
export { subKeyChainMessage };
//# sourceMappingURL=keys.d.ts.map
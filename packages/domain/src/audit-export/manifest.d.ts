/**
 * audit-export/manifest.ts — ManifestBuilder and SOC2 control mapping.
 *
 * Per TRD-12 §4.4, §4.5:
 *   - PackageManifest Zod schema
 *   - SOC2ControlMapping with hard-coded table covering CC6.1–CC9.2
 *   - ManifestBuilder: constructs manifest.json from export metadata + artifact records
 *
 * Event-type → SOC2 control mapping covers EVERY event_type in the system
 * (per task requirement). The mapping is validated by tests.
 *
 * Primitives §8.1 + TRD-00 v0.2 event catalog is the authoritative source
 * for all known event_types.
 */
import { z } from 'zod';
export declare const ArtifactRecordSchema: z.ZodObject<{
    path: z.ZodString;
    type: z.ZodEnum<["events_jsonl", "capability_grants_jsonl", "capability_denials_jsonl", "ceremony_record", "ceremony_transcript", "adr_markdown", "retro_report", "retro_proposal", "retro_outcome", "uat_session", "uat_defect", "channel_posts_jsonl", "drift_event", "persona_version", "verifier_result", "key_history", "index", "readme", "control_mapping"]>;
    range_start: z.ZodOptional<z.ZodString>;
    range_end: z.ZodOptional<z.ZodString>;
    record_count: z.ZodNumber;
    byte_length: z.ZodNumber;
    sha256: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "uat_session" | "retro_outcome" | "key_history" | "events_jsonl" | "capability_grants_jsonl" | "capability_denials_jsonl" | "ceremony_record" | "ceremony_transcript" | "adr_markdown" | "retro_report" | "retro_proposal" | "uat_defect" | "channel_posts_jsonl" | "drift_event" | "persona_version" | "verifier_result" | "index" | "readme" | "control_mapping";
    path: string;
    sha256: string;
    byte_length: number;
    record_count: number;
    range_start?: string | undefined;
    range_end?: string | undefined;
}, {
    type: "uat_session" | "retro_outcome" | "key_history" | "events_jsonl" | "capability_grants_jsonl" | "capability_denials_jsonl" | "ceremony_record" | "ceremony_transcript" | "adr_markdown" | "retro_report" | "retro_proposal" | "uat_defect" | "channel_posts_jsonl" | "drift_event" | "persona_version" | "verifier_result" | "index" | "readme" | "control_mapping";
    path: string;
    sha256: string;
    byte_length: number;
    record_count: number;
    range_start?: string | undefined;
    range_end?: string | undefined;
}>;
export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;
export declare const PackageManifestSchema: z.ZodObject<{
    schema_version: z.ZodLiteral<1>;
    export_id: z.ZodString;
    install_id: z.ZodString;
    package_id: z.ZodString;
    generated_at: z.ZodString;
    generator: z.ZodObject<{
        product: z.ZodLiteral<"Orbital">;
        version: z.ZodString;
        component: z.ZodLiteral<"audit-export">;
    }, "strip", z.ZodTypeAny, {
        version: string;
        component: "audit-export";
        product: "Orbital";
    }, {
        version: string;
        component: "audit-export";
        product: "Orbital";
    }>;
    range: z.ZodObject<{
        start: z.ZodString;
        end: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        start: string;
        end: string;
    }, {
        start: string;
        end: string;
    }>;
    scope: z.ZodObject<{
        kind: z.ZodString;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        kind: z.ZodString;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        kind: z.ZodString;
    }, z.ZodTypeAny, "passthrough">>;
    cutoff: z.ZodObject<{
        cutoff_event_id: z.ZodString;
        cutoff_rule: z.ZodLiteral<"inclusive_through_AuditExportRequested">;
        explanation: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        cutoff_event_id: string;
        cutoff_rule: "inclusive_through_AuditExportRequested";
        explanation: string;
    }, {
        cutoff_event_id: string;
        cutoff_rule: "inclusive_through_AuditExportRequested";
        explanation: string;
    }>;
    requested_by: z.ZodObject<{
        type: z.ZodString;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodString;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodString;
    }, z.ZodTypeAny, "passthrough">>;
    capability_id: z.ZodString;
    justification: z.ZodString;
    artifacts: z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        type: z.ZodEnum<["events_jsonl", "capability_grants_jsonl", "capability_denials_jsonl", "ceremony_record", "ceremony_transcript", "adr_markdown", "retro_report", "retro_proposal", "retro_outcome", "uat_session", "uat_defect", "channel_posts_jsonl", "drift_event", "persona_version", "verifier_result", "key_history", "index", "readme", "control_mapping"]>;
        range_start: z.ZodOptional<z.ZodString>;
        range_end: z.ZodOptional<z.ZodString>;
        record_count: z.ZodNumber;
        byte_length: z.ZodNumber;
        sha256: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: "uat_session" | "retro_outcome" | "key_history" | "events_jsonl" | "capability_grants_jsonl" | "capability_denials_jsonl" | "ceremony_record" | "ceremony_transcript" | "adr_markdown" | "retro_report" | "retro_proposal" | "uat_defect" | "channel_posts_jsonl" | "drift_event" | "persona_version" | "verifier_result" | "index" | "readme" | "control_mapping";
        path: string;
        sha256: string;
        byte_length: number;
        record_count: number;
        range_start?: string | undefined;
        range_end?: string | undefined;
    }, {
        type: "uat_session" | "retro_outcome" | "key_history" | "events_jsonl" | "capability_grants_jsonl" | "capability_denials_jsonl" | "ceremony_record" | "ceremony_transcript" | "adr_markdown" | "retro_report" | "retro_proposal" | "uat_defect" | "channel_posts_jsonl" | "drift_event" | "persona_version" | "verifier_result" | "index" | "readme" | "control_mapping";
        path: string;
        sha256: string;
        byte_length: number;
        record_count: number;
        range_start?: string | undefined;
        range_end?: string | undefined;
    }>, "many">;
    totals: z.ZodObject<{
        artifact_count: z.ZodNumber;
        event_count: z.ZodNumber;
        total_bytes: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        total_bytes: number;
        artifact_count: number;
        event_count: number;
    }, {
        total_bytes: number;
        artifact_count: number;
        event_count: number;
    }>;
    signing: z.ZodObject<{
        algo: z.ZodLiteral<"Ed25519">;
        master_key_id: z.ZodString;
        master_key_pub_b64: z.ZodString;
        signed_at: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        algo: "Ed25519";
        master_key_id: string;
        master_key_pub_b64: string;
        signed_at: string;
    }, {
        algo: "Ed25519";
        master_key_id: string;
        master_key_pub_b64: string;
        signed_at: string;
    }>;
    control_mapping_path: z.ZodLiteral<"soc2_control_mapping.json">;
    readme_path: z.ZodLiteral<"README.md">;
}, "strip", z.ZodTypeAny, {
    capability_id: string;
    schema_version: 1;
    scope: {
        kind: string;
    } & {
        [k: string]: unknown;
    };
    export_id: string;
    install_id: string;
    requested_by: {
        type: string;
    } & {
        [k: string]: unknown;
    };
    package_id: string;
    justification: string;
    generated_at: string;
    generator: {
        version: string;
        component: "audit-export";
        product: "Orbital";
    };
    range: {
        start: string;
        end: string;
    };
    cutoff: {
        cutoff_event_id: string;
        cutoff_rule: "inclusive_through_AuditExportRequested";
        explanation: string;
    };
    artifacts: {
        type: "uat_session" | "retro_outcome" | "key_history" | "events_jsonl" | "capability_grants_jsonl" | "capability_denials_jsonl" | "ceremony_record" | "ceremony_transcript" | "adr_markdown" | "retro_report" | "retro_proposal" | "uat_defect" | "channel_posts_jsonl" | "drift_event" | "persona_version" | "verifier_result" | "index" | "readme" | "control_mapping";
        path: string;
        sha256: string;
        byte_length: number;
        record_count: number;
        range_start?: string | undefined;
        range_end?: string | undefined;
    }[];
    totals: {
        total_bytes: number;
        artifact_count: number;
        event_count: number;
    };
    signing: {
        algo: "Ed25519";
        master_key_id: string;
        master_key_pub_b64: string;
        signed_at: string;
    };
    control_mapping_path: "soc2_control_mapping.json";
    readme_path: "README.md";
}, {
    capability_id: string;
    schema_version: 1;
    scope: {
        kind: string;
    } & {
        [k: string]: unknown;
    };
    export_id: string;
    install_id: string;
    requested_by: {
        type: string;
    } & {
        [k: string]: unknown;
    };
    package_id: string;
    justification: string;
    generated_at: string;
    generator: {
        version: string;
        component: "audit-export";
        product: "Orbital";
    };
    range: {
        start: string;
        end: string;
    };
    cutoff: {
        cutoff_event_id: string;
        cutoff_rule: "inclusive_through_AuditExportRequested";
        explanation: string;
    };
    artifacts: {
        type: "uat_session" | "retro_outcome" | "key_history" | "events_jsonl" | "capability_grants_jsonl" | "capability_denials_jsonl" | "ceremony_record" | "ceremony_transcript" | "adr_markdown" | "retro_report" | "retro_proposal" | "uat_defect" | "channel_posts_jsonl" | "drift_event" | "persona_version" | "verifier_result" | "index" | "readme" | "control_mapping";
        path: string;
        sha256: string;
        byte_length: number;
        record_count: number;
        range_start?: string | undefined;
        range_end?: string | undefined;
    }[];
    totals: {
        total_bytes: number;
        artifact_count: number;
        event_count: number;
    };
    signing: {
        algo: "Ed25519";
        master_key_id: string;
        master_key_pub_b64: string;
        signed_at: string;
    };
    control_mapping_path: "soc2_control_mapping.json";
    readme_path: "README.md";
}>;
export type PackageManifest = z.infer<typeof PackageManifestSchema>;
export declare const Soc2ControlIdSchema: z.ZodEnum<["CC6.1", "CC6.2", "CC6.3", "CC6.7", "CC7.1", "CC7.2", "CC7.3", "CC8.1", "CC9.1", "CC9.2"]>;
export type Soc2ControlId = z.infer<typeof Soc2ControlIdSchema>;
export interface ControlEvidence {
    control_id: Soc2ControlId;
    description: string;
    evidence_paths: string[];
    evidence_types: string[];
    query_hints: string[];
}
export interface Soc2ControlMapping {
    schema_version: 1;
    controls: ControlEvidence[];
    notes?: string;
}
/**
 * Hard-coded SOC2 control mapping shipped in every package.
 * Per TRD-12 §4.5 and task requirement: every event_type MUST map to ≥ 1 control.
 */
export declare const DEFAULT_SOC2_CONTROL_MAPPING: Soc2ControlMapping;
/**
 * All known event_types emitted by the Orbital system, per Primitives §8.1
 * and TRD-00 v0.2.
 *
 * Each maps to the controls it provides evidence for.
 * Tests assert that every entry here has at least one control.
 */
export declare const EVENT_TYPE_CONTROL_MAP: Record<string, Soc2ControlId[]>;
export interface ManifestBuildInput {
    exportId: string;
    installId: string;
    packageId: string;
    rangeStart: string;
    rangeEnd: string;
    scope: {
        kind: string;
    } & Record<string, unknown>;
    cutoffEventId: string;
    requestedBy: {
        type: string;
    } & Record<string, unknown>;
    capabilityId: string;
    justification: string;
    artifacts: ArtifactRecord[];
    totalEventCount: number;
    /** Ed25519 signing context — leave as stub values for v1 (manifest signed by node:crypto ed25519) */
    signingKeyId: string;
    masterKeyPubB64: string;
    signedAt: string;
}
export declare class ManifestBuilder {
    /**
     * Build the PackageManifest in-memory from export metadata and artifact records.
     * Computes totals automatically from artifacts array.
     */
    build(input: ManifestBuildInput): PackageManifest;
    /**
     * Serialize the manifest to canonical JSON (sorted keys for determinism).
     */
    serialize(manifest: PackageManifest): Buffer;
    /**
     * Compute SHA-256 hex of the manifest JSON bytes.
     */
    hash(manifestBytes: Buffer): string;
    /**
     * Build the SOC2 control mapping JSON for inclusion in the package.
     */
    buildControlMapping(): Buffer;
    /**
     * Build the auditor README.md for inclusion in the package.
     */
    buildReadme(params: {
        installId: string;
        rangeStart: string;
        rangeEnd: string;
        scopeSummary: string;
        cutoffEventId: string;
    }): Buffer;
}
//# sourceMappingURL=manifest.d.ts.map
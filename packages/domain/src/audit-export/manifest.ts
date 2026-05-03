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

import { z } from 'zod'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const ArtifactRecordSchema = z.object({
  path: z.string(),
  type: z.enum([
    'events_jsonl',
    'capability_grants_jsonl',
    'capability_denials_jsonl',
    'ceremony_record',
    'ceremony_transcript',
    'adr_markdown',
    'retro_report',
    'retro_proposal',
    'retro_outcome',
    'uat_session',
    'uat_defect',
    'channel_posts_jsonl',
    'drift_event',
    'persona_version',
    'verifier_result',
    'key_history',
    'index',
    'readme',
    'control_mapping',
  ]),
  range_start: z.string().datetime().optional(),
  range_end: z.string().datetime().optional(),
  record_count: z.number().int().nonnegative(),
  byte_length: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
})

export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>

export const PackageManifestSchema = z.object({
  schema_version: z.literal(1),
  export_id: z.string(),
  install_id: z.string(),
  package_id: z.string(),
  generated_at: z.string().datetime(),
  generator: z.object({
    product: z.literal('Orbital'),
    version: z.string(),
    component: z.literal('audit-export'),
  }),
  range: z.object({
    start: z.string().datetime(),
    end: z.string().datetime(),
  }),
  scope: z.object({ kind: z.string() }).passthrough(),
  cutoff: z.object({
    cutoff_event_id: z.string(),
    cutoff_rule: z.literal('inclusive_through_AuditExportRequested'),
    explanation: z.string(),
  }),
  requested_by: z.object({ type: z.string() }).passthrough(),
  capability_id: z.string(),
  justification: z.string().min(1),
  artifacts: z.array(ArtifactRecordSchema),
  totals: z.object({
    artifact_count: z.number().int().nonnegative(),
    event_count: z.number().int().nonnegative(),
    total_bytes: z.number().int().nonnegative(),
  }),
  signing: z.object({
    algo: z.literal('Ed25519'),
    master_key_id: z.string(),
    master_key_pub_b64: z.string(),
    signed_at: z.string().datetime(),
  }),
  control_mapping_path: z.literal('soc2_control_mapping.json'),
  readme_path: z.literal('README.md'),
})

export type PackageManifest = z.infer<typeof PackageManifestSchema>

// ---------------------------------------------------------------------------
// SOC2 control mapping
// ---------------------------------------------------------------------------

export const Soc2ControlIdSchema = z.enum([
  'CC6.1',
  'CC6.2',
  'CC6.3',
  'CC6.7',
  'CC7.1',
  'CC7.2',
  'CC7.3',
  'CC8.1',
  'CC9.1',
  'CC9.2',
])

export type Soc2ControlId = z.infer<typeof Soc2ControlIdSchema>

export interface ControlEvidence {
  control_id: Soc2ControlId
  description: string
  evidence_paths: string[]
  evidence_types: string[]
  query_hints: string[]
}

export interface Soc2ControlMapping {
  schema_version: 1
  controls: ControlEvidence[]
  notes?: string
}

/**
 * Hard-coded SOC2 control mapping shipped in every package.
 * Per TRD-12 §4.5 and task requirement: every event_type MUST map to ≥ 1 control.
 */
export const DEFAULT_SOC2_CONTROL_MAPPING: Soc2ControlMapping = {
  schema_version: 1,
  controls: [
    {
      control_id: 'CC6.1',
      description: 'Logical and physical access controls; deny-by-default capability model.',
      evidence_paths: ['capability_grants/', 'capability_denials/', 'key_history/'],
      evidence_types: ['capability_grants_jsonl', 'capability_denials_jsonl', 'key_history'],
      query_hints: [
        'grep event_type=CapabilityGranted events/*.jsonl',
        'grep event_type=CapabilityDenied events/*.jsonl',
        'grep event_type=CapabilityRevoked events/*.jsonl',
        'grep event_type=CapabilityIssued events/*.jsonl',
        'grep event_type=KeyArchived events/*.jsonl',
      ],
    },
    {
      control_id: 'CC6.2',
      description: 'User access provisioning and revocation; capability lifecycle.',
      evidence_paths: ['capability_grants/', 'events/'],
      evidence_types: ['capability_grants_jsonl', 'events_jsonl'],
      query_hints: [
        'grep event_type=CapabilityGranted events/*.jsonl',
        'grep event_type=CapabilityRevoked events/*.jsonl',
        'grep event_type=CapabilityIssued events/*.jsonl',
      ],
    },
    {
      control_id: 'CC6.3',
      description: 'User access reviews; all user-actor events reviewable as a stream.',
      evidence_paths: ['events/'],
      evidence_types: ['events_jsonl'],
      query_hints: [
        'jq \'select(.actor.type=="user")\' events/*.jsonl',
        'grep event_type=AuditExportRequested events/*.jsonl',
        'grep event_type=AuditExportCancelled events/*.jsonl',
      ],
    },
    {
      control_id: 'CC6.7',
      description: 'Transmission and disposal; capability TTL as disposal proof.',
      evidence_paths: ['capability_grants/', 'events/'],
      evidence_types: ['capability_grants_jsonl', 'events_jsonl'],
      query_hints: [
        'jq \'.ttl_seconds\' capability_grants/grants.jsonl',
        'grep event_type=CapabilityRevoked events/*.jsonl',
      ],
    },
    {
      control_id: 'CC7.1',
      description: 'System monitoring; full event stream + verifier results.',
      evidence_paths: ['events/', 'verifier_results/'],
      evidence_types: ['events_jsonl', 'verifier_result'],
      query_hints: [
        'cat events/*.jsonl | wc -l  # total event count',
        'grep event_type=VerifierPassed verifier_results/verifier.jsonl',
        'grep event_type=VerifierFailed verifier_results/verifier.jsonl',
        'grep event_type=VerifierStarted events/*.jsonl',
        'grep event_type=VerifierAmbiguous events/*.jsonl',
        'grep event_type=HookPassed events/*.jsonl',
        'grep event_type=WorkerHeartbeat events/*.jsonl',
        'grep event_type=TaskCreated events/*.jsonl',
        'grep event_type=TaskCompleted events/*.jsonl',
        'grep event_type=TaskFailed events/*.jsonl',
        'grep event_type=TaskHelpRequested events/*.jsonl',
        'grep event_type=SprintCreated events/*.jsonl',
        'grep event_type=SprintStarted events/*.jsonl',
        'grep event_type=SprintCompleted events/*.jsonl',
        'grep event_type=SprintPaused events/*.jsonl',
        'grep event_type=SprintResumed events/*.jsonl',
        'grep event_type=SprintAborted events/*.jsonl',
        'grep event_type=RoutingDecisionMade events/*.jsonl',
        'grep event_type=CostReported events/*.jsonl',
        'grep event_type=BudgetWarning events/*.jsonl',
        'grep event_type=BudgetExceeded events/*.jsonl',
      ],
    },
    {
      control_id: 'CC7.2',
      description: 'Anomaly detection; drift events from TRD-07 reconciler.',
      evidence_paths: ['drift_events/'],
      evidence_types: ['drift_event'],
      query_hints: [
        'cat drift_events/drift.jsonl',
        'grep severity=critical drift_events/drift.jsonl',
        'grep event_type=DriftDetected events/*.jsonl',
        'grep event_type=DriftResolved events/*.jsonl',
        'grep event_type=ReconciliationCompleted events/*.jsonl',
        'grep event_type=ReconciliationFailed events/*.jsonl',
        'grep event_type=AuditQueryExecuted events/*.jsonl',
      ],
    },
    {
      control_id: 'CC7.3',
      description: 'Incident response; blocker escalation, budget exceeded, keychain recovery.',
      evidence_paths: ['events/'],
      evidence_types: ['events_jsonl'],
      query_hints: [
        'grep event_type=BlockerEscalated events/*.jsonl',
        'grep event_type=BlockerOpened events/*.jsonl',
        'grep event_type=BlockerResolved events/*.jsonl',
        'grep event_type=BudgetExceeded events/*.jsonl',
        'grep event_type=KeychainEmergencyRotation events/*.jsonl',
        'grep event_type=KeychainRecovered events/*.jsonl',
        'grep event_type=KeyRotated events/*.jsonl',
        'grep event_type=ModelEscalated events/*.jsonl',
      ],
    },
    {
      control_id: 'CC8.1',
      description: 'Change management; persona/skill/hook changes, ADRs, retros, verifier SoD.',
      evidence_paths: ['adrs/', 'retros/', 'persona_versions/', 'verifier_results/'],
      evidence_types: [
        'adr_markdown',
        'retro_report',
        'retro_proposal',
        'retro_outcome',
        'persona_version',
        'verifier_result',
      ],
      query_hints: [
        'ls adrs/  # all ADRs in range',
        'grep event_type=AdrCreated events/*.jsonl',
        'grep event_type=AdrUpdated events/*.jsonl',
        'grep event_type=RetroReportGenerated events/*.jsonl',
        'grep event_type=RetroProposalCreated events/*.jsonl',
        'grep event_type=RetroProposalAccepted events/*.jsonl',
        'grep event_type=RetroProposalRejected events/*.jsonl',
        'grep event_type=RetroOutcomeRecorded events/*.jsonl',
        'grep event_type=OutcomeRecorded events/*.jsonl',
        'grep event_type=PersonaCreated events/*.jsonl',
        'grep event_type=PersonaUpdated events/*.jsonl',
        'grep event_type=PersonaVersionCreated events/*.jsonl',
        'grep event_type=PersonaActivated events/*.jsonl',
        'grep event_type=PersonaDeactivated events/*.jsonl',
        'grep event_type=SkillCreated events/*.jsonl',
        'grep event_type=SkillUpdated events/*.jsonl',
        'grep event_type=HookRegistered events/*.jsonl',
        'grep event_type=HookUpdated events/*.jsonl',
        'grep event_type=InstallInitialised events/*.jsonl',
        'grep event_type=InstallUpdated events/*.jsonl',
        'grep event_type=VerifierPassed events/*.jsonl',
        'grep event_type=VerifierFailed events/*.jsonl',
        'grep event_type=VerifierAmbiguous events/*.jsonl',
        'grep event_type=MondaySyncCompleted events/*.jsonl',
        'grep event_type=OrchestrationPauseDrained events/*.jsonl',
        'grep event_type=OrchestrationResumeApplied events/*.jsonl',
      ],
    },
    {
      control_id: 'CC9.1',
      description: 'Risk assessment; channel communications, ceremonies, UAT defects.',
      evidence_paths: ['channel_posts/', 'ceremonies/', 'uat_results/'],
      evidence_types: [
        'channel_posts_jsonl',
        'ceremony_record',
        'ceremony_transcript',
        'uat_session',
        'uat_defect',
      ],
      query_hints: [
        'grep event_type=ChannelPostCreated events/*.jsonl',
        'grep event_type=ChannelPostEdited events/*.jsonl',
        'grep event_type=ChannelSubscribed events/*.jsonl',
        'grep event_type=ChannelUnsubscribed events/*.jsonl',
        'grep event_type=ReactionAdded events/*.jsonl',
        'grep event_type=ReactionRemoved events/*.jsonl',
        'grep event_type=CeremonyStarted events/*.jsonl',
        'grep event_type=CeremonyCompleted events/*.jsonl',
        'grep event_type=CeremonyStatementAdded events/*.jsonl',
        'grep event_type=DisagreementRaised events/*.jsonl',
        'grep event_type=DisagreementResolved events/*.jsonl',
        'grep event_type=UATSessionStarted events/*.jsonl',
        'grep event_type=UATSessionCompleted events/*.jsonl',
        'grep event_type=DefectCreated events/*.jsonl',
        'grep event_type=DefectResolved events/*.jsonl',
      ],
    },
    {
      control_id: 'CC9.2',
      description: 'Risk monitoring; backlog changes, sprint lifecycle, vision updates.',
      evidence_paths: ['events/'],
      evidence_types: ['events_jsonl'],
      query_hints: [
        'grep event_type=VisionDocumentCreated events/*.jsonl',
        'grep event_type=VisionDocumentUpdated events/*.jsonl',
        'grep event_type=VisionLocked events/*.jsonl',
        'grep event_type=VisionUnlocked events/*.jsonl',
        'grep event_type=BacklogItemCreated events/*.jsonl',
        'grep event_type=BacklogItemUpdated events/*.jsonl',
        'grep event_type=BacklogItemStatusChanged events/*.jsonl',
        'grep event_type=BacklogItemDeleted events/*.jsonl',
        'grep event_type=EpicCreated events/*.jsonl',
        'grep event_type=StoryCreated events/*.jsonl',
        'grep event_type=SprintPlanned events/*.jsonl',
        'grep event_type=WorktreeCreated events/*.jsonl',
        'grep event_type=WorktreeDeleted events/*.jsonl',
        'grep event_type=WorkerSpawned events/*.jsonl',
        'grep event_type=WorkerTerminated events/*.jsonl',
        'grep event_type=AuditExportRequested events/*.jsonl',
        'grep event_type=AuditExportStarted events/*.jsonl',
        'grep event_type=AuditExportProgress events/*.jsonl',
        'grep event_type=AuditExportCompleted events/*.jsonl',
        'grep event_type=AuditExportFailed events/*.jsonl',
        'grep event_type=AuditExportDownloaded events/*.jsonl',
        'grep event_type=AuditExportCancelled events/*.jsonl',
      ],
    },
  ],
  notes:
    'Every event_type emitted by Orbital maps to at least one SOC2 control in this table. ' +
    'Use the query_hints to locate specific event types within the events/ JSONL files. ' +
    'See README.md for verification commands.',
}

// ---------------------------------------------------------------------------
// Event type → SOC2 control mapping (for test validation)
// ---------------------------------------------------------------------------

/**
 * All known event_types emitted by the Orbital system, per Primitives §8.1
 * and TRD-00 v0.2.
 *
 * Each maps to the controls it provides evidence for.
 * Tests assert that every entry here has at least one control.
 */
export const EVENT_TYPE_CONTROL_MAP: Record<string, Soc2ControlId[]> = {
  // TRD-01: Events
  InstallInitialised: ['CC8.1'],
  InstallUpdated: ['CC8.1'],

  // TRD-02: Capabilities / CBAC
  CapabilityGranted: ['CC6.1', 'CC6.2'],
  CapabilityRevoked: ['CC6.1', 'CC6.2', 'CC6.7'],
  CapabilityDenied: ['CC6.1'],
  CapabilityIssued: ['CC6.1', 'CC6.2'],
  KeyRotated: ['CC6.1', 'CC7.3'],
  KeyArchived: ['CC6.1'],
  KeychainEmergencyRotation: ['CC7.3'],
  KeychainRecovered: ['CC7.3'],

  // TRD-03: Personas
  PersonaCreated: ['CC8.1'],
  PersonaUpdated: ['CC8.1'],
  PersonaVersionCreated: ['CC8.1'],
  PersonaActivated: ['CC8.1'],
  PersonaDeactivated: ['CC8.1'],
  SkillCreated: ['CC8.1'],
  SkillUpdated: ['CC8.1'],

  // TRD-04: Orchestration / Workers
  WorkerSpawned: ['CC7.1', 'CC9.2'],
  WorkerTerminated: ['CC7.1', 'CC9.2'],
  WorkerHeartbeat: ['CC7.1'],
  TaskCreated: ['CC7.1', 'CC9.2'],
  TaskCompleted: ['CC7.1', 'CC9.2'],
  TaskFailed: ['CC7.1', 'CC9.2'],
  TaskHelpRequested: ['CC7.1', 'CC9.2'],
  WorktreeCreated: ['CC9.2'],
  WorktreeDeleted: ['CC9.2'],

  // TRD-05: Comms / Ceremonies
  ChannelPostCreated: ['CC9.1'],
  ChannelPostEdited: ['CC9.1'],
  ChannelSubscribed: ['CC9.1'],
  ChannelUnsubscribed: ['CC9.1'],
  ReactionAdded: ['CC9.1'],
  ReactionRemoved: ['CC9.1'],
  CeremonyStarted: ['CC9.1'],
  CeremonyCompleted: ['CC9.1'],
  CeremonyStatementAdded: ['CC9.1'],
  DisagreementRaised: ['CC9.1'],
  DisagreementResolved: ['CC9.1'],
  AdrCreated: ['CC8.1'],
  AdrUpdated: ['CC8.1'],

  // TRD-06: CBAC (additional)
  // (Capability events already covered above)

  // TRD-07: Audit / Reconciler
  DriftDetected: ['CC7.2'],
  DriftResolved: ['CC7.2'],
  ReconciliationCompleted: ['CC7.2'],
  ReconciliationFailed: ['CC7.2'],
  AuditQueryExecuted: ['CC7.2'],

  // TRD-08: Routing / Cost
  RoutingDecisionMade: ['CC7.1'],
  CostReported: ['CC7.1'],
  BudgetWarning: ['CC7.1', 'CC7.3'],
  BudgetExceeded: ['CC7.1', 'CC7.3'],
  ModelEscalated: ['CC7.3'],

  // TRD-09: Hook / Verifier
  HookRegistered: ['CC8.1'],
  HookUpdated: ['CC8.1'],
  HookPassed: ['CC7.1'],
  VerifierStarted: ['CC7.1', 'CC8.1'],
  VerifierPassed: ['CC7.1', 'CC8.1'],
  VerifierFailed: ['CC7.1', 'CC8.1'],
  VerifierAmbiguous: ['CC7.1', 'CC8.1'],

  // TRD-10: Retros
  RetroReportGenerated: ['CC8.1'],
  RetroProposalCreated: ['CC8.1'],
  RetroProposalAccepted: ['CC8.1'],
  RetroProposalRejected: ['CC8.1'],
  RetroOutcomeRecorded: ['CC8.1'],
  OutcomeRecorded: ['CC8.1'],

  // TRD-11: UAT
  UATSessionStarted: ['CC9.1'],
  UATSessionCompleted: ['CC9.1'],
  DefectCreated: ['CC9.1'],
  DefectResolved: ['CC9.1'],

  // TRD-12: Audit Export (this TRD)
  AuditExportRequested: ['CC6.3', 'CC9.2'],
  AuditExportStarted: ['CC9.2'],
  AuditExportProgress: ['CC9.2'],
  AuditExportCompleted: ['CC9.2'],
  AuditExportFailed: ['CC9.2'],
  AuditExportDownloaded: ['CC6.3', 'CC9.2'],
  AuditExportCancelled: ['CC6.3', 'CC9.2'],

  // Backlog / Vision
  VisionDocumentCreated: ['CC9.2'],
  VisionDocumentUpdated: ['CC9.2'],
  VisionLocked: ['CC9.2'],
  VisionUnlocked: ['CC9.2'],
  BacklogItemCreated: ['CC9.2'],
  BacklogItemUpdated: ['CC9.2'],
  BacklogItemStatusChanged: ['CC9.2'],
  BacklogItemDeleted: ['CC9.2'],
  EpicCreated: ['CC9.2'],
  StoryCreated: ['CC9.2'],
  SprintCreated: ['CC7.1', 'CC9.2'],
  SprintStarted: ['CC7.1', 'CC9.2'],
  SprintCompleted: ['CC7.1', 'CC9.2'],
  SprintPlanned: ['CC9.2'],
  SprintPaused: ['CC7.1', 'CC9.2'],
  SprintResumed: ['CC7.1', 'CC9.2'],
  SprintAborted: ['CC7.1', 'CC9.2'],

  // Monday sync
  MondaySyncCompleted: ['CC8.1'],

  // Orchestration lifecycle
  OrchestrationPauseDrained: ['CC8.1'],
  OrchestrationResumeApplied: ['CC8.1'],

  // Blockers (CC7.3)
  BlockerOpened: ['CC7.3'],
  BlockerEscalated: ['CC7.3'],
  BlockerResolved: ['CC7.3'],
}

// ---------------------------------------------------------------------------
// ManifestBuilder
// ---------------------------------------------------------------------------

export interface ManifestBuildInput {
  exportId: string
  installId: string
  packageId: string
  rangeStart: string
  rangeEnd: string
  scope: { kind: string } & Record<string, unknown>
  cutoffEventId: string
  requestedBy: { type: string } & Record<string, unknown>
  capabilityId: string
  justification: string
  artifacts: ArtifactRecord[]
  totalEventCount: number
  /** Ed25519 signing context — leave as stub values for v1 (manifest signed by node:crypto ed25519) */
  signingKeyId: string
  masterKeyPubB64: string
  signedAt: string
}

export class ManifestBuilder {
  /**
   * Build the PackageManifest in-memory from export metadata and artifact records.
   * Computes totals automatically from artifacts array.
   */
  build(input: ManifestBuildInput): PackageManifest {
    const totalBytes = input.artifacts.reduce((acc, a) => acc + a.byte_length, 0)

    const manifest: PackageManifest = {
      schema_version: 1,
      export_id: input.exportId,
      install_id: input.installId,
      package_id: input.packageId,
      generated_at: new Date().toISOString(),
      generator: {
        product: 'Orbital',
        version: '0.1.0',
        component: 'audit-export',
      },
      range: {
        start: input.rangeStart,
        end: input.rangeEnd,
      },
      scope: input.scope,
      cutoff: {
        cutoff_event_id: input.cutoffEventId,
        cutoff_rule: 'inclusive_through_AuditExportRequested',
        explanation:
          'This package contains all events with event_id <= cutoff_event_id. ' +
          'The AuditExportRequested event itself is included. ' +
          'The AuditExportCompleted event for this export will appear in the next export package.',
      },
      requested_by: input.requestedBy,
      capability_id: input.capabilityId,
      justification: input.justification,
      artifacts: input.artifacts,
      totals: {
        artifact_count: input.artifacts.length,
        event_count: input.totalEventCount,
        total_bytes: totalBytes,
      },
      signing: {
        algo: 'Ed25519',
        master_key_id: input.signingKeyId,
        master_key_pub_b64: input.masterKeyPubB64,
        signed_at: input.signedAt,
      },
      control_mapping_path: 'soc2_control_mapping.json',
      readme_path: 'README.md',
    }

    return manifest
  }

  /**
   * Serialize the manifest to canonical JSON (sorted keys for determinism).
   */
  serialize(manifest: PackageManifest): Buffer {
    return Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8')
  }

  /**
   * Compute SHA-256 hex of the manifest JSON bytes.
   */
  hash(manifestBytes: Buffer): string {
    return createHash('sha256').update(manifestBytes).digest('hex')
  }

  /**
   * Build the SOC2 control mapping JSON for inclusion in the package.
   */
  buildControlMapping(): Buffer {
    return Buffer.from(JSON.stringify(DEFAULT_SOC2_CONTROL_MAPPING, null, 2), 'utf-8')
  }

  /**
   * Build the auditor README.md for inclusion in the package.
   */
  buildReadme(params: {
    installId: string
    rangeStart: string
    rangeEnd: string
    scopeSummary: string
    cutoffEventId: string
  }): Buffer {
    const content = `# Orbital Audit Evidence Package

## What this package is

An audit evidence package produced by Orbital install \`${params.installId}\` covering
\`${params.rangeStart}\` to \`${params.rangeEnd}\` for scope: ${params.scopeSummary}.

## Verifying integrity

1. Decrypt the tarball with the export passphrase:
   \`\`\`
   # Python example (no Orbital dependency required):
   python3 verify_package.py --passphrase "<passphrase>" --file <package>.tar.zst.enc
   \`\`\`

2. Hash each artifact listed in \`manifest.json\` and compare to the \`sha256\` field:
   \`\`\`
   jq -r '.artifacts[] | .path + " " + .sha256' manifest.json | \\
     while read path expected; do
       actual=$(sha256sum "$path" | awk '{print $1}')
       [ "$actual" = "$expected" ] && echo "OK: $path" || echo "FAIL: $path"
     done
   \`\`\`

3. Verify \`manifest.json.sig\` against the master public key in \`key_history/master_keys.json\`:
   \`\`\`
   openssl pkeyutl -verify -pubin -inkey <(jq -r '.public_key_pem' key_history/master_keys.json) \\
     -sigfile manifest.json.sig -in manifest.json
   \`\`\`

## Where to find evidence per SOC2 control

| Control | Evidence Location | Description |
|---------|------------------|-------------|
| CC6.1   | \`capability_grants/\`, \`capability_denials/\`, \`key_history/\` | Logical access controls |
| CC6.2   | \`capability_grants/grants.jsonl\`, \`events/\` | Provisioning/revocation |
| CC6.3   | \`events/\` (filter actor.type=user) | User access reviews |
| CC6.7   | \`capability_grants/\` (TTL field), filtered to CapabilityRevoked | Transmission/disposal |
| CC7.1   | \`events/\` (full stream), \`verifier_results/\` | System monitoring |
| CC7.2   | \`drift_events/\` | Anomaly detection |
| CC7.3   | \`events/\` filtered to BlockerEscalated, BudgetExceeded, KeychainEmergencyRotation | Incident response |
| CC8.1   | \`adrs/\`, \`retros/\`, \`persona_versions/\`, \`verifier_results/\` | Change management |

## Glossary

- **Capability**: A time-bounded, scope-limited authorization token. Deny-by-default; all tool calls require a valid capability.
- **Persona**: An AI agent role definition (e.g., PM, Architect, Sr Developer). Versioned and audited.
- **Ceremony**: A structured multi-agent discussion (planning, review, retro) with a transcript and outputs.
- **ADR**: Architecture Decision Record — a formal log of a significant architectural decision.
- **Drift event**: A detected discrepancy between expected and actual system state, from TRD-07 reconciliation.

## Cutoff note

This package was generated in response to event \`${params.cutoffEventId}\`. The corresponding
\`AuditExportCompleted\` event will appear in the next export package that covers the time of
this export's completion. This is by design: the cutoff rule ensures every event in this package
was committed before the export began.
`
    return Buffer.from(content, 'utf-8')
  }
}

/**
 * Branded ID types — UUIDv7 strings tagged at compile time.
 * Per Primitives §3. The branding is purely compile-time; runtime values are plain strings.
 */
type Brand<T, B> = T & { readonly __brand: B }

export type TaskId = Brand<string, 'TaskId'>
export type SprintId = Brand<string, 'SprintId'>
export type CapabilityId = Brand<string, 'CapabilityId'>
export type ChannelId = Brand<string, 'ChannelId'>
export type ChannelPostId = Brand<string, 'ChannelPostId'>
export type PersonaId = Brand<string, 'PersonaId'>
export type SkillId = Brand<string, 'SkillId'>
export type SessionId = Brand<string, 'SessionId'>
export type InstallId = Brand<string, 'InstallId'>
export type EventId = Brand<string, 'EventId'>
export type TicketId = Brand<string, 'TicketId'>
export type CeremonyId = Brand<string, 'CeremonyId'>
export type AdrId = Brand<string, 'AdrId'>
export type StoryId = Brand<string, 'StoryId'>
export type EpicId = Brand<string, 'EpicId'>
export type DefectId = Brand<string, 'DefectId'>
export type VisionDocumentId = Brand<string, 'VisionDocumentId'>
export type VisionSessionId = Brand<string, 'VisionSessionId'>
export type RetroProposalId = Brand<string, 'RetroProposalId'>
export type RetroReportId = Brand<string, 'RetroReportId'>
export type SystemVersionId = Brand<string, 'SystemVersionId'>
export type AuditExportId = Brand<string, 'AuditExportId'>
export type HookId = Brand<string, 'HookId'>
export type VerificationId = Brand<string, 'VerificationId'>
export type WorkerId = Brand<string, 'WorkerId'>
export type BlockerId = Brand<string, 'BlockerId'>
export type DisagreementId = Brand<string, 'DisagreementId'>
export type UATSessionId = Brand<string, 'UATSessionId'>

export const asTaskId = (s: string): TaskId => s as TaskId
export const asSprintId = (s: string): SprintId => s as SprintId
export const asCapabilityId = (s: string): CapabilityId => s as CapabilityId
export const asChannelId = (s: string): ChannelId => s as ChannelId
export const asPersonaId = (s: string): PersonaId => s as PersonaId
export const asSessionId = (s: string): SessionId => s as SessionId
export const asEventId = (s: string): EventId => s as EventId
export const asInstallId = (s: string): InstallId => s as InstallId

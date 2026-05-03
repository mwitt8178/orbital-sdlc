/**
 * backlog-grooming rule.
 *
 * Fires on:
 *   - SprintCompleted (the trailing wake-up)
 *   - StoryCreated (new work landing)
 *
 * Match condition:
 *   ready_story_count < 1.5 * next_planning_sprint_capacity
 *   OR ungroomed_story_count > 5 (stories with no ACs OR no estimate)
 *
 * Spec: invite PM + Architect for backlog grooming.
 */
import type { CeremonyTriggerRule } from '../ceremony-scheduler.js';
export declare const backlogGroomingRule: CeremonyTriggerRule;
//# sourceMappingURL=backlog-grooming.d.ts.map
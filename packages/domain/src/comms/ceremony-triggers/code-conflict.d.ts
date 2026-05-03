/**
 * code-conflict rule.
 *
 * Fires on: SchedulerTick (synthetic event emitted by Scheduler at tick start).
 *
 * Match condition: two ready tasks have overlapping `declared_write_paths`
 * (the file globs the persona declared at task-creation time). This is the
 * static analog of the Scheduler.feasible() runtime check — surfacing a
 * conflict before either task is allocated lets a ceremony resolve who owns
 * the path.
 *
 * Spec: invite the persona-of-record from each conflicting task.
 */
import type { CeremonyTriggerRule } from '../ceremony-scheduler.js';
export declare const codeConflictRule: CeremonyTriggerRule;
//# sourceMappingURL=code-conflict.d.ts.map
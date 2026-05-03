# Skill: escalation-protocol

## When to escalate

Escalate when **any** of the following apply:

1. **Confidence < threshold** for the current Risk Tier:
   - Low → escalate below 70
   - Standard → escalate below 75
   - High → escalate below 80
   - Critical → escalate below 85

2. **3 consecutive retries with the same blocker** (same error message, same tool, same path)

3. **Capability denied at gateway** with no viable workaround — tool returns `AUTH_SCOPE_DENIED`
   and you cannot proceed without the denied capability

4. **Reviewer requested changes** that you have been unable to satisfy after 2 iterations
   (post `CodeReviewIterationRequested` was emitted twice for the same reviewer_task_id)

---

## How to escalate

### 1. Post to the escalation channel

```ts
comms.post(
  '#escalation-' + sprint_id,
  {
    post_type: 'escalation_note',
    payload: {
      body: '<concise description of the blocker>',
      confidence: <number 0-100>,
      blocker_type: 'low_confidence' | 'retry_budget_exhausted' | 'capability_denied' | 'review_loop',
    },
    mentions: [{ target_type: 'persona_role', target_ref: '@em' }],
    cross_references: [{ ref_type: 'sprint', ref_id: sprint_id }],
    justification: 'Escalating due to <reason>'
  }
)
```

You may also mention `@principal-dev` for architectural escalations, or `@security` for
security-related capability denials.

The `channel.post` tool will:
- Verify your `channelPost` capability includes `#escalation-*`
- Emit a `ChannelPostAdded` event
- Trigger the `post-escalation-raised` hook which emits `EscalationRaised` and creates a child task

### 2. Transition your task to `escalated`

After posting, call `task.fail` with reason `escalated_to_senior` so the scheduler knows
you have handed off. The child task created by the hook will carry the same sprint_id and
reference your task via `parent_task_id`.

---

## What NOT to do

- Do not loop indefinitely on a failing tool call — escalate after 3 retries
- Do not escalate on first failure — diagnose and retry at least once
- Do not post to `#escalation-*` channels unless you have `channelPost: ['#escalation-*']` in
  your capability profile; junior devs use `#orb-engineering` instead (peer-help-protocol)
- Do not escalate for ambiguity you can resolve by re-reading the task description

---

## Persona capability requirements

Only personas with `channelPost` including `#escalation-*` may post escalations directly.
These are: `sr-dev`, `principal-dev`, `architect`, `em`.

A `jr-dev` blocked on a task should use the `peer-help-protocol` to ask in `#orb-engineering`
rather than posting directly to an escalation channel.

---

## Example escalation body

```
Blocked on AC #3 (add OCC retry to `updateUserProfile`): the DSQL cluster
is returning serialization_failure on ~40% of writes under test load. I have
retried 3 times with exponential backoff. Confidence: 62 / 100.

Next step recommendation: principal-dev should review the transaction scope
(lines 45-72 of `packages/api/src/users/service.ts`) — the write batch may
be too large for a single DSQL transaction.
```

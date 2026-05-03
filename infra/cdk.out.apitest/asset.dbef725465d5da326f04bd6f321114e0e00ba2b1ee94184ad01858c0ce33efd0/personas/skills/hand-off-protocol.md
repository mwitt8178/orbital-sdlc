# Skill: hand-off-protocol

## When to hand off

A hand-off is appropriate when, **during implementation**, you discover that completing
the task requires work in a **different bounded context** that is outside your persona scope
or declared file-write paths.

Examples:
- A UI task (sr-dev) discovers it needs a new DB column → hand off schema work to sr-dev
  or principal-dev with the `multi-tenant-migrations` skill loaded
- A backend task discovers it needs a new CDK stack resource → hand off infra work to
  an architect persona
- A task hits a security boundary that requires a capability review → hand off to security persona

**Do NOT** use hand-off for:
- Work you can do yourself within your existing capability profile
- Trivial adjacent file edits (just do them if within your `filesWrite` glob)
- Escalations due to confidence or blocking errors (use `escalation-protocol` instead)

---

## How to hand off

### 1. Post to the sprint channel

```ts
comms.post(
  '#sprint-' + sprint_id,
  {
    post_type: 'handoff_note',
    payload: {
      body: '<what needs to be done + context>',
      target_persona: 'sr-dev' | 'principal-dev' | 'architect' | 'security',
      handoff_reason: '<why you cannot do this yourself>',
    },
    mentions: [{ target_type: 'persona_role', target_ref: '@<target_persona>' }],
    cross_references: [
      { ref_type: 'sprint', ref_id: sprint_id },
      { ref_type: 'ticket', ref_id: ticket_id },
    ],
    justification: 'Hand-off: work outside bounded context'
  }
)
```

The `channel.post` tool will emit a `ChannelPostAdded` event. The `post-handoff-requested`
hook detects `post_type: 'handoff_note'` and emits `HandOffRequested`, which causes the
scheduler to create a child task targeting the `target_persona`.

### 2. Continue your own work

Unlike escalation, a hand-off does NOT require you to `task.fail`. You post the hand-off,
the scheduler creates a dependent child task, and you continue working on your own bounded
context. If your task has a dependency on the child task's output, note it in a follow-up
post and pause/await the dependency.

---

## Hand-off note payload schema

```ts
{
  body: string                   // What the child task should do (min 20 chars)
  target_persona: string         // Persona slug for the child task
  handoff_reason: string         // Why you cannot do it (min 10 chars)
  suggested_title?: string       // Optional short title for the child task
  suggested_description?: string // Longer context for the child task brief
}
```

---

## Capability requirements

Only personas with `channelPost` including `#sprint-*` may post hand-offs.
These are: `sr-dev`, `principal-dev`, `architect`, `em`.

---

## Example hand-off

```
I am implementing the user-profile avatar upload (ticket ORB-0042). The upload
handler needs a new `avatars` S3 bucket + IAM policy. This is outside my
filesWrite glob (src/**). Handing off infra work to architect.

Child task: Create S3 bucket + IAM policy for avatar storage per
packages/infra/src/stacks/storage.ts pattern. Must follow security-serverless
skill constraints (least-privilege, no wildcard s3:*).
```

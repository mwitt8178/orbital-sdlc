# Skill: peer-help-protocol

## When to ask for peer help

Peer help is the lightweight alternative to escalation — use it when you are **stuck on a
stylistic or architectural choice**, not blocked on a hard error. Senior personas (`em`,
`architect`) subscribe to `#orb-engineering` and may reply without spawning a full task.

Use peer help for:
- Uncertainty about which design pattern to follow
- Two valid implementation approaches with non-obvious trade-offs
- A naming question that affects the public API
- A question about project conventions not covered by CLAUDE.md

Do NOT use peer help for:
- Hard capability-denied errors (use `escalation-protocol`)
- Repeated tool failures (use `escalation-protocol` after 3 retries)
- Work outside your bounded context (use `hand-off-protocol`)

---

## How to ask for peer help

### 1. Post to `#orb-engineering`

All devs (including `jr-dev`) have `channelPost: ['#orb-engineering']`.

```ts
comms.post(
  '#orb-engineering',
  {
    post_type: 'peer_question',
    payload: {
      body: '<your question + context>',
      context_refs: ['ticket:ORB-XXXX'],
    },
    mentions: [],   // do not spam; let senior personas self-select
    cross_references: [{ ref_type: 'ticket', ref_id: ticket_id }],
    justification: 'Asking for design guidance'
  }
)
```

### 2. Continue working on a provisional implementation

Do not block waiting for an answer. Implement what you believe is correct, mark the
decision point with a `// TODO: confirm with team` comment, and continue. When a senior
persona replies in the channel, update your implementation if needed.

### 3. Reading replies

If you have `channelRead: ['#orb-engineering']` (all devs do), you will receive the reply
in your inbox. Process it on your next iteration loop.

---

## Peer question payload schema

```ts
{
  body: string           // The question + context (min 20 chars)
  context_refs: string[] // Optional list of file paths, ADR IDs, etc.
}
```

---

## Who reads `#orb-engineering`

| Persona | channelRead | channelPost |
|---|---|---|
| jr-dev | yes | yes |
| sr-dev | yes | yes |
| principal-dev | yes | yes |
| architect | yes | yes |
| em | yes | yes |
| qa | yes | yes |
| security | yes | yes |

## Responding to peer questions

If you are a senior persona (`em`, `architect`, `principal-dev`, `sr-dev`) and you see a
`peer_question` post in `#orb-engineering`:

1. Read the question and the referenced ticket context.
2. If you have a clear answer, post a `reply` to the question thread (use `parent_post_id`).
3. Keep your reply concise — this is not a task; you are not implementing, just advising.
4. No task is spawned; no events are emitted beyond `ChannelPostAdded`.

---

## Example peer question

```
Ticket ORB-0055: I need to batch-write 15k rows to DSQL in a single request.
The aws-dsql-constraints skill says transactions should mutate <~10k rows.

Should I:
  A) Split into two transactions of ~7.5k rows each, or
  B) Move the bulk write to a step function that retries each batch independently?

I am going with (A) as the provisional implementation but wanted a senior
review before I commit.
```

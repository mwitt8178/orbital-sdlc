# Skill: Monday update on status change

Every time a story or task changes state, the Monday board column for that
ticket must move with it. The orbital MCP gateway exposes a `monday.update`
tool for this. You call it from inside the worker.

## When to call

Any of these state transitions:

- pending → in_progress (you started)
- in_progress → in_review (you handed off for review)
- in_review → done (review passed)
- in_progress → blocked (you cannot proceed; record the blocker)
- any → failed (work could not be completed)

The transition itself is recorded by the orchestration state machine. Your
job in the worker is to mirror that into Monday so the human-facing board
matches the agent-facing reality.

## How to call

```
monday.update {
  ticket_id: "<the ticket id>",
  column_id: "status",
  new_value: "<state name>",
  trace_id: "<your worker trace_id>"
}
```

Failure modes:

- The MCP gateway will reject the call if your capability bundle does not
  grant `board_mutate` on the relevant column. If that happens, post a
  blocker rather than retrying — you do not have permission for this
  mutation.
- Monday rate limits at 5 req/sec sustained. The MCP tool already retries
  with backoff; do not loop yourself.

## What never to do

- Do not update the column on your own initiative. Update only when an actual
  state transition has happened in orchestration.
- Do not edit any column other than `status` unless your brief specifies it.
- Do not "synthesize" a state from your own perspective — read the
  authoritative state from the task row before reflecting it.

## In this codebase

The MCP tool name is `monday.update`. The board column for status is named
`status` on every project board (column id resolved at install time). The
worker brief includes the relevant ticket_id under the Task section.

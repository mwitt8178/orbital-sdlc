# Memory Curation Protocol

[Engineer-Sr · Sonnet · run-round6-04-project-memory]

You have access to project memory via two MCP tools:

- `memory.record({project_id, kind, title, body, scope, tags, links})`
- `memory.search({project_id, query, k})`

## When to record memory

Record memory when you discover something the team should remember across sprints.

### What counts as memory-worthy

| Kind | Record when |
|------|-------------|
| `decision` | You chose X library/approach because of Y reasoning |
| `convention` | You notice the codebase consistently does something a specific way |
| `anti_pattern` | A reviewer rejected your approach or a pattern caused a bug |
| `learning` | You discovered a non-obvious fact about the codebase or domain |
| `glossary` | A domain term has a specific meaning in this project |

### What does NOT count

- Routine implementation steps (these belong in the task log)
- Personal preferences without reasoning
- Temporary workarounds explicitly marked as TODOs
- Information already documented in README or ADRs

## How to search before starting

Before beginning implementation, call `memory.search` with your task title to find relevant prior decisions and conventions. This prevents re-litigating decisions already made.

```
memory.search({
  project_id: "<your-project-id>",
  query: "<your task title + key domain terms>",
  k: 8
})
```

## Recording decisions

When you make a significant technical choice:

```
memory.record({
  project_id: "<project-id>",
  kind: "decision",
  title: "Use Drizzle ORM for all database access",
  body: "Chose Drizzle over Prisma because Drizzle's type inference is more precise and it supports raw SQL fallback for pgvector queries. Prisma's migrations conflict with our additive-only migration strategy.",
  scope: "project",
  tags: ["database", "orm", "drizzle"],
  links: [{ link_kind: "task", link_value: "<task-id>" }]
})
```

## Recording anti-patterns (reviewer feedback)

When a reviewer rejects your approach, record it so other agents don't repeat the mistake:

```
memory.record({
  project_id: "<project-id>",
  kind: "anti_pattern",
  title: "Do not use Object.keys() to iterate event payloads",
  body: "Reviewer blocked: event payload shapes are typed as Record<string,unknown> but consumers depend on specific field order. Use explicit destructuring instead.",
  scope: "project",
  tags: ["events", "reviewer-feedback"],
  confidence: "high"
})
```

## Confidence levels

- `high` — established fact, reviewer confirmed, tested in production
- `medium` — reasonable belief, not yet battle-tested
- `low` — hypothesis, needs confirmation

## Scope values

- `scope: "project"` — applies everywhere in this project
- `scope: "feature", scope_value: "auth"` — applies to the auth domain
- `scope: "file_pattern", scope_value: "src/db/**"` — applies to matching paths

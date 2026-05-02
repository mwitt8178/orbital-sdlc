# Round 6 — #4 Cross-Sprint Project Memory

## Persona / Risk
Engineer-Senior · Sonnet · Risk Tier: Medium · Estimate: L

## Why
`ls packages/orchestrator/src/ | grep -iE "memo|knowl|context|history"` returns nothing. Personas spawn cold every time. For a multi-week product factory, agents need: prior decisions (ADRs), project conventions, what reviewer blocked on last time, prior PRs they wrote. Without it, every sprint re-litigates the same patterns and the system can't accumulate institutional taste — the moat over single-shot tools.

## Independent of other waves
Pure new module — no overlap with #1/#5/#10's hot files. Safe to run in Wave 1.

## Bounded contexts touched
| Context | Files | Change |
|--|--|--|
| `memory` (NEW) | `packages/orchestrator/src/memory/{service.ts,types.ts,brief-injector.ts,retrieval.ts}` | Memory CRUD + similarity retrieval |
| `db schema` | NEW `packages/orchestrator/src/db/schema/memory.ts`, migration `0023_project_memory.sql` | Tables: `project_memory_entries`, `project_memory_tags`, `project_memory_links` |
| `personas/brief.ts` | existing | Brief builder calls `memory.retrieveTopN(taskBrief, projectId, n=8)` and includes formatted entries in the brief |
| `events` | new types: `MemoryEntryRecorded`, `MemoryEntryCurated`, `MemoryEntryArchived`, `MemoryRetrievedForBrief` | Audit who/what/when |
| `trpc` | NEW `packages/orchestrator/src/trpc/routers/memory.ts` | CRUD + search + curate-mutation |
| `mcp` | NEW tool: `memory.record({entry})`, `memory.search({query, k})` | Agents can write/search memory mid-task |
| `personas/skills/` | NEW `memory-curation-protocol.md` | When to record memory, what counts as memory-worthy |
| `ui` | NEW `pages/Memory.tsx`, NEW `components/features/memory/*`, modify `App.tsx` (route), `components/Sidebar.tsx` (nav entry) | Operator-facing memory browser + curator |

## Data model
```sql
-- migration 0023_project_memory.sql (additive, idempotent)
CREATE TABLE IF NOT EXISTS project_memory_entries (
  entry_id     uuid        PRIMARY KEY,
  project_id   uuid        NOT NULL,           -- logical FK → projects
  kind         text        NOT NULL CHECK (kind IN ('decision','convention','learning','anti_pattern','glossary')),
  title        text        NOT NULL,
  body         text        NOT NULL,           -- markdown
  source_kind  text        NOT NULL CHECK (source_kind IN ('agent','operator','reviewer','retro','vision')),
  source_id    uuid,                            -- task_id, retro_id, etc. — nullable for operator-authored
  confidence   text        NOT NULL DEFAULT 'medium' CHECK (confidence IN ('low','medium','high')),
  scope        text        NOT NULL DEFAULT 'project' CHECK (scope IN ('project','feature','file_pattern')),
  scope_value  text,                            -- e.g. 'auth' for feature, 'src/api/**' for file_pattern
  status       text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','superseded')),
  superseded_by uuid,
  embedding    vector(1536),                    -- pgvector for similarity (Postgres extension); fallback: NULL + tag-based retrieval
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pm_entries_project_idx ON project_memory_entries (project_id, status);
CREATE INDEX IF NOT EXISTS pm_entries_kind_idx ON project_memory_entries (project_id, kind, status);
CREATE INDEX IF NOT EXISTS pm_entries_embedding_idx ON project_memory_entries USING ivfflat (embedding vector_cosine_ops) WITH (lists=100);

CREATE TABLE IF NOT EXISTS project_memory_tags (
  entry_id uuid NOT NULL,
  tag      text NOT NULL,
  PRIMARY KEY (entry_id, tag)
);

CREATE TABLE IF NOT EXISTS project_memory_links (
  link_id    uuid PRIMARY KEY,
  entry_id   uuid NOT NULL,
  link_kind  text NOT NULL CHECK (link_kind IN ('pr','task','retro','vision','adr')),
  link_value text NOT NULL,                     -- pr_url, task_id, etc.
  created_at timestamptz NOT NULL DEFAULT now()
);
```

**pgvector requirement:** the project uses real Postgres (not DSQL — per README). Postgres 16-alpine in docker-compose. The pgvector extension is widely available; install with `CREATE EXTENSION IF NOT EXISTS vector;` at migration top. If it fails (not installed), retrieval falls back to tag + keyword matching only — feature still works, just less precise.

## Retrieval algorithm (`memory/retrieval.ts`)
Given a task brief + project_id, return top-k memory entries:
1. Compute embedding of brief.title + brief.description (calls AnthropicDriver.embed or sentence-transformers in-process — for now, use the OpenAI-compatible embeddings API on Anthropic if available, else fall back to deterministic hash-based bag-of-tags).
2. Vector similarity search → top 20 candidates (filtering on `project_id`, `status='active'`, scope-applicable).
3. Re-rank by recency + kind preference (decisions > anti_patterns > conventions > learnings > glossary).
4. Return top-k (default 8).

For v1, embedding is OPTIONAL — if not configured, retrieval falls back to: tag overlap + recency. This must NOT break the system when no embedding provider is configured.

## Brief injection (`personas/brief.ts`)
After building the existing brief sections, append:
```markdown
## Project memory (top {k} relevant entries)
{for each entry:}
### [{kind}] {title}
{body}
_Source: {source_kind}, recorded {created_at}, confidence {confidence}_
```
Emit `MemoryRetrievedForBrief` with the entry IDs included.

## Memory recording (`memory/service.ts`)
- Agents call `memory.record({...})` MCP tool when they discover something noteworthy:
  - "We chose X library because Y" → kind=decision
  - "This codebase always uses pino for logging" → kind=convention
  - "Reviewer rejected my approach Z because of W" → kind=anti_pattern
- Operator can curate via UI (edit, archive, supersede)
- Retro Agent can promote retro learnings to memory

## Frontend UX

### Sidebar nav (`components/Sidebar.tsx`)
- New entry "Memory" between "Audit" and "Settings"

### `pages/Memory.tsx` (new)
- Top: search bar + filter chips (kind, scope, status, source)
- Left: list of entries (paginated, sortable by recency / confidence / kind)
- Right: detail panel
  - Read mode: rendered markdown body + metadata (kind, scope, source, links)
  - Edit mode (capability-gated): markdown editor + tag manager + scope/scope_value editor
  - Actions: Archive, Supersede with [pick another entry], Promote to ADR (links to docs/decisions/)
- Top-right: "+ New entry" button (operator-authored)

### `components/features/memory/MemoryReferences.tsx` (new) — embedded in TaskDetail / PRDetailPanel
- Shows memory entries that were INJECTED into this task's brief
- Click → expands to show full body
- Reveals the agent's "context" — operator can see what the agent knew

### Settings → "Memory" tab (new)
- Embedding provider config (OpenAI / Anthropic / disabled)
- Retrieval params (k, recency boost, kind weights)
- Memory size: total entries, by kind, by scope

## MCP tool: `memory.record` and `memory.search`
- `memory.record({kind, title, body, scope, scope_value?, tags[], links[]})` → returns entry_id
- `memory.search({query, k, filter?})` → returns entries
- Both are capability-gated: agents need `memory_read` / `memory_write` in their capability profile (default: read=true for all personas, write=true for sr-dev/principal/architect/reviewer/retro-analyst).

## Acceptance criteria
1. `grep -rE "from '.*memory/" packages/orchestrator/src/personas/brief.ts` returns ≥1 hit (brief injection wired).
2. `grep -E "registerProcedure.*memory" packages/orchestrator/src/trpc/router.ts` (or however routers register) returns 1 hit.
3. Migration 0023 applies cleanly (with pgvector fallback if extension missing).
4. Integration test: record 5 entries → spawn a task → assert `MemoryRetrievedForBrief` event written with at least 1 entry → assert brief text contains the entry title.
5. UI: Memory page renders, supports search + edit; MemoryReferences renders in TaskDetail.
6. Capability check: an agent without `memory_write` capability calling `memory.record` is rejected by gateway.
7. Embedding-disabled path: when `EMBEDDING_PROVIDER=none`, retrieval still returns sensible results (tag-based) — covered by integration test.

## What "wired up" means
- `personas/brief.ts` actually imports and calls `memory.retrieve()` — `grep` proves it.
- `pages/Memory.tsx` is route-registered in `App.tsx` (`grep "Memory" packages/ui/src/App.tsx` ≥1).
- Sidebar shows the entry — visible in dev mode.

## Persona evidence prefix
`[Engineer-Sr · Sonnet · run-round6-04-project-memory]`

# Skill: AWS Aurora DSQL constraints

DSQL is not Postgres-with-extras. It is a distributed SQL surface with strict
limits. If your query violates one, the cluster will reject it at execution
time. Plan up front.

## Hard NO list

You cannot use any of these:

- **Foreign keys** — no `REFERENCES` clause anywhere. Enforce relationships in
  application code.
- **Triggers** — no `CREATE TRIGGER`, no rule-based DML.
- **Sequences / `SERIAL`** — generate IDs in the application (UUIDv7 or ULID).
- **Materialized views** — only regular views.
- **Stored procedures / functions** — no `CREATE FUNCTION`, no `PL/pgSQL`.
- **Extensions** — no `CREATE EXTENSION`. The available set is fixed by AWS.
- **GIN / SP-GiST indexes** — only B-tree (and GIST in some configurations).
- **`SELECT FOR UPDATE`** — DSQL uses optimistic concurrency; pessimistic locks
  are unavailable.

## OCC retry is mandatory

Every mutating transaction must retry on `serialization_failure` (SQLSTATE
40001). Use exponential backoff with jitter, cap at 5 attempts.

```ts
async function withOCCRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (isSerializationFailure(err) && attempt < 4) {
        const backoff = Math.min(2 ** attempt * 25, 250) + Math.random() * 50
        await sleep(backoff)
        continue
      }
      throw err
    }
  }
  throw new Error('OCC retry budget exhausted')
}
```

## Transaction limits

- **< 5 minutes** wall-clock per transaction.
- **< ~10,000 rows** mutated per transaction.
- DDL **must be in its own transaction**. Never combine DDL + DML.

If you need to modify millions of rows: chunk into batches of < 10k, each its
own transaction. Use idempotent batch markers so you can resume safely.

## ID generation

- IDs are **UUIDv7** or ULID. Time-ordered, k-sortable, 64-bit prefix sortable.
- Generate in application code, never via `gen_random_uuid()` inside the DB.
- The library `uuidv7` is canonical here.

## Time

- `CURRENT_TIMESTAMP` returns **transaction-start** time. For wall-clock
  ordering inside a long transaction, use `clock_timestamp()`.
- Audit timestamps must capture both: the application-supplied `occurred_at`
  AND the row-insert `ingested_at`.

## Auth

- Connect via the **IAM token generator**: short-lived (~15 min) tokens minted
  by the AWS SDK.
- Never hard-code credentials or use a long-lived password.

## Migrations are four-phase additive

- Phase 1: add new column, new index, with `NULL` allowed.
- Phase 2: dual-write (new code reads/writes both old and new).
- Phase 3: backfill in chunks.
- Phase 4: drop the old column.

Never combine phases. Each phase ships independently.

## When to escalate

If a feature appears to require any banned construct, do not work around it
silently. Post to `#architecture-decisions` and wait for the Architect's
guidance.

## In this codebase

This project uses real Postgres locally and DSQL in production. The schema
files in `packages/orchestrator/src/db/schema/` already comply. New schemas
must too — the `multi-tenant-migrations` skill covers the migration pattern.

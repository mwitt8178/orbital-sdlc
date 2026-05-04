# architecture: real-claude-daemon

## Goal
Replace `fake-claude.js` worker surrogate with real `@anthropic-ai/sdk` integration in
`@orbital/story-executor` (consumed by `@orbital/orchestrator-daemon`). Persona-tiered
model routing, real tool-use loop (file_read / file_write / bash) with worktree-scoped
sandbox, real cost ledger writes, streaming logs.

## Bounded contexts touched
- `packages/story-executor` (worker process; previously `fake` only). New module
  `claude-client.js` owns the Anthropic SDK loop; `spawn-worker.js` keeps fake mode
  for unit tests but real mode now runs in-process (no child shell-out to a CLI).
- `packages/orchestrator-daemon` (no source change required for the SDK; it spawns
  the executor as a child or imports it). Dockerfile gains `@orbital/story-executor`
  in the runtime image so the daemon can spawn real workers.
- `infra/lib/constructs/daemon-fargate.ts` — task def gains `ANTHROPIC_API_KEY` as a
  Secrets Manager–backed `secret`, and the task role gets `secretsmanager:GetSecretValue`
  on the new secret ARN. (Construct already supports `secretEnvVars`, but the secret
  is injected via `secrets:` in the container definition for proper redaction.)

## Aggregate boundaries
- `WorkerRun` aggregate (in `worker_runs` table — migration 0038) is the unit of cost
  truth. Cost / token writes happen on `updateWorkerRun` after every Claude response,
  not just on terminal exit, so partial runs are accounted for.
- `Story` aggregate stays untouched.

## Persona → model map
| Persona | Model ID |
|---|---|
| `pm`, `product` | `claude-haiku-4-5` |
| `engineer-jr` | `claude-haiku-4-5` |
| `engineer-sr` | `claude-sonnet-4-6` |
| `engineer-principal` | `claude-opus-4-7` |
| `qa` | `claude-sonnet-4-6` |
| `review` | `claude-opus-4-7` |
| `security` | `claude-opus-4-7` |

Model IDs resolved via env-var override (`ANTHROPIC_MODEL_<PERSONA>`) for test/staging,
defaults baked into `persona-model-map.js`.

## Tool-use loop
Tools registered: `file_read(path)`, `file_write(path, contents)`, `bash(cmd, cwd?)`.
Loop terminates when:
1. `stop_reason === 'end_turn'`
2. `turns >= max_turns` (default 20)
3. Budget kill (cost cap reached via `BudgetTracker`)
4. Wall-clock timeout

Each turn: send conversation, receive `content` (text + tool_use blocks), execute
tool calls in the worktree CWD, append `tool_result` to conversation, loop. Tool
execution is sandboxed: paths are resolved against the run's worktree root, attempts
to escape (`..`) are rejected.

## Worktree-scoped execution
Each story run gets `git worktree add /tmp/orbital-runs/<run_id> <branch>` against
the cloned repo. Claude tools operate only inside that worktree. On run completion
(success or fail), worktree is removed via `git worktree remove --force`.

## Event flow
1. SQS msg `story.ready` → daemon → spawns executor child with run_id + persona.
2. Executor: clones target repo to `/tmp/orbital-runs/<run_id>`; opens Anthropic
   client; runs tool-use loop streaming each assistant turn to CloudWatch via
   stdout JSON lines (daemon's awslogs driver picks them up).
3. After each turn: `updateWorkerRun(runId, {prompt_tokens, output_tokens, cost_usd_cents})`.
4. On `end_turn`: tests run → PR opened (existing path).

## IAM diff
- New secret: `orbital-mwitt/anthropic-api-key` (created via AWS CLI, stored value
  manually placed by operator).
- Daemon `TaskRole` gains `secretsmanager:GetSecretValue` on that ARN.
- Daemon container `secrets:` injects the secret value as `ANTHROPIC_API_KEY` env var.

## DSQL schema diff
None. `worker_runs` columns (`prompt_tokens`, `output_tokens`, `cost_usd_cents`)
already exist (migration 0038).

## cost_ledger writes
For this iteration, `worker_runs` IS the cost ledger (per-run granularity). Existing
column writes are extended to fire after every turn, not only on terminal exit.
A future task can fan these into a separate `cost_ledger` table with aggregations.

## Blast radius
- `fake-claude.js` deletion breaks the `fake` mode of `spawn-worker.js`, which is
  used by `verify-loop.js` (verification harness only — not prod). Mitigation:
  keep `fake-claude.js` available behind `mode: 'fake'`, add new `mode: 'real-sdk'`
  as the new default. `mode: 'real'` (CLI shell-out) is removed — replaced by
  `mode: 'real-sdk'` which uses the SDK.
- Daemon image gains ~5MB (anthropic-ai/sdk). Acceptable.
- New egress dependency: `api.anthropic.com`. Daemon SG already allows all outbound;
  no SG change.

## Rollback strategy
- Image: ECS service can be rolled back to prior task def revision (revision 15)
  via `aws ecs update-service --task-definition orbital-mwitt-daemon:15`.
- Secret: leave in place; harmless if unreferenced.
- Code: revert `feat/real-claude-daemon` branch — `consolidated/main-2026-05-04`
  remains untouched until merge.

## Confidence
- Architecture: 95
- Local code + tests: 95
- AWS deploy (Docker build + ECR push + ECS update): 80 — depends on docker buildx
  ARM64 emulation perf locally and operator placing the secret value (Anthropic key)
  manually. The deploy script is real and idempotent; it will fail loudly if the
  secret value is missing.

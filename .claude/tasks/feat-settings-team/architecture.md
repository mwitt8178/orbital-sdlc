# feat/settings-team — Architecture

[Engineer-Principal · Opus · run-feat-settings-team]

## Bounded contexts touched
- **projects** (existing): new aggregates project_members + project_invites scoped by project_id (and tenant_id).
- **identity / auth**: Cognito user pool `us-east-1_R89dMIxXb` becomes the system of record for invited member identity. `project_members.cognito_sub` is the logical foreign key.
- **audit**: new team_audit append-only stream (separate from existing audit.events to keep payload narrow).

## Aggregate boundaries
- `project_members(project_id, user_id)` PK. user_id is a UUIDv7 minted by the orchestrator, mapped to Cognito sub via `cognito_sub` column. tenant_id stamped from project.
- `project_invites(invite_id)` PK. Bound to (project_id, email). `token` is a 32-byte URL-safe nonce; `expires_at` = invited_at + 7 days.
- `team_audit(audit_id)` PK; append-only via app discipline (DSQL: no triggers).

## Event flow
1. UI POST `team.invite` → orchestrator
   - INSERT `project_invites` (status='sent', token, expires_at)
   - Cognito `AdminCreateUser` (DesiredDeliveryMediums=EMAIL, UserAttributes email + email_verified=false). Cognito sends its own invite email — simpler than self-hosting templates.
   - INSERT `team_audit` (event_type='member_invited').
2. UI `team.changeRole` → UPDATE project_members + audit row (event_type='member_role_changed').
3. UI `team.remove` → UPDATE project_members.removed_at + Cognito `AdminDisableUser` + audit.
4. UI `team.revokeInvite` → UPDATE project_invites.status='revoked' + Cognito `AdminDeleteUser` (only if user was created and never accepted) + audit.
5. UI `team.resendInvite` → Cognito `AdminCreateUser` with `MessageAction='RESEND'` + audit.

## IAM diff (api-lambda role)
Inline policy additions (documented; CDK follow-up PR):
```
cognito-idp:AdminCreateUser
cognito-idp:AdminUpdateUserAttributes
cognito-idp:AdminDisableUser
cognito-idp:AdminEnableUser
cognito-idp:AdminDeleteUser
cognito-idp:AdminGetUser
```
Resource: `arn:aws:cognito-idp:us-east-1:403001214246:userpool/us-east-1_R89dMIxXb`

**SAFETY GATE**: per "no solo decisions on stateful resources" rule, the Cognito calls are gated by `ORBITAL_TEAM_COGNITO_ENABLED=true`. When unset (default until human approves IAM), the service writes invite rows + queues an outbox event and surfaces a clear "pending IAM" status in UI. The DB layer is fully real; only the Cognito SDK call is feature-flagged. This avoids a runtime IAM denial while preserving the deploy.

## DSQL schema diff
New migration `0045_team.sql`:
- `project_members(project_id uuid, user_id uuid, tenant_id uuid, email text, cognito_sub text, role text, joined_at timestamptz, last_active_at timestamptz, removed_at timestamptz, PRIMARY KEY(project_id, user_id))`
- `project_invites(invite_id uuid PK, project_id uuid, tenant_id uuid, email text, role text, status text, invited_at timestamptz, invited_by uuid, token text, expires_at timestamptz, cognito_sub text)`
- `team_audit(audit_id uuid PK, project_id uuid, tenant_id uuid, event_type text, actor_user_id uuid, target_user_id uuid, target_email text, payload jsonb, created_at timestamptz)`
- Indexes: `(project_id, removed_at)`, `(project_id, status)`, `(project_id, created_at desc)` for audit log range queries.
- No FKs, no triggers, no sequences, no SERIAL — DSQL-portable. UUIDv7 minted in app.

## Blast radius
- Read-mostly for first 95% of users — pure SELECT on new tables.
- Write paths bounded to one project at a time; no cross-project mutation.
- Cognito feature-flagged behind env — if disabled, no AWS-side state change; flips to "pending" status visible in UI.
- Multi-tenant isolation: every query filters by `tenant_id` AND `project_id`. Inputs validate that `project_id` belongs to caller's tenant via existing `projectScopedProcedure` helper if available, else inline join check.

## Rollback strategy
- DDL is additive-only. Rollback = stop reading from new tables. Drop migration is safe (no other table references them).
- UI feature: ship behind nothing; the route /settings/team simply falls back to ComingSoonState if `team.list` 500s.
- IAM: never granted broad pool deletion; `AdminDeleteUser` is restricted to invites that haven't accepted.

## OCC retry
Every mutation in team service wrapped in `withOccRetry(tx, ...)` per existing helper.

## Test strategy
1. Integration test: invite flow end-to-end with Cognito stubbed (env flag off).
2. Multi-tenant bleed: create members in tenant A, query as tenant B → empty.
3. Role-change downgrade requires confirm in UI.
4. Audit log returns rows ordered desc and filterable.

## Confidence
85 — reduced because (a) Cognito IAM is human-approved follow-up, (b) we ship behind a feature flag for the AWS call. DB + UI + tRPC are real and unflagged.

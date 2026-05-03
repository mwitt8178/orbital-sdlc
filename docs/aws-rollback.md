# Orbital AWS Rollback Procedures

> Round 8-09 — Cutover + Multi-env Smoke + Deploy Scripts
> [Engineer-Principal · Opus · run-round8-09-cutover-smoke]

Procedures for rolling back AWS environments, recovering from a bad deploy, and restoring data. These are operator-driven manual playbooks; nothing automated will ever delete or restore production data without human confirmation.

If you are mid-incident, jump to the section that matches your scenario. The procedures are designed to be executable line-by-line.

---

## Table of contents

1. [Cutover rollback (revert DNS)](#1-cutover-rollback-revert-dns)
2. [Bad deploy rollback (CloudFormation rollback)](#2-bad-deploy-rollback-cloudformation-rollback)
3. [Aurora point-in-time recovery](#3-aurora-point-in-time-recovery)
4. [Aurora snapshot restore](#4-aurora-snapshot-restore)
5. [Cognito user pool recovery](#5-cognito-user-pool-recovery)
6. [S3 replay bucket recovery](#6-s3-replay-bucket-recovery)
7. [Production teardown (manual procedure)](#7-production-teardown-manual-procedure)
8. [Compromised secret rotation](#8-compromised-secret-rotation)

Common preconditions for every procedure:

- AWS CLI v2 configured with credentials for the target account
- `AWS_PROFILE=orbital-<env>` set, OR direct credentials exported
- `jq` installed
- Current working directory is the Orbital repo root

---

## 1. Cutover rollback (revert DNS)

Use when: you've cut over from self-host to AWS, and within minutes you discover the AWS env is broken (smoke fails, errors spike, customers paged). The DNS rollback window is approximately 5 minutes — the original TTL plus a margin for resolver caches.

### Procedure

1. **Decide.** Don't dither. If smoke is failing or alarms are red, roll back. You can investigate after.

2. **Revert DNS.** Point your hub domain back at the self-host IP.

   ```bash
   # Cloudflare example
   curl -X PATCH "https://api.cloudflare.com/client/v4/zones/<zoneid>/dns_records/<recordid>" \
     -H "Authorization: Bearer ${CF_TOKEN}" \
     -H "Content-Type: application/json" \
     --data '{"type":"A","name":"hub.example.com","content":"<self-host-ip>","ttl":60}'

   # Route 53 example
   aws route53 change-resource-record-sets \
     --hosted-zone-id <zoneid> \
     --change-batch '{
       "Changes":[{"Action":"UPSERT","ResourceRecordSet":{
         "Name":"hub.example.com.","Type":"A","TTL":60,
         "ResourceRecords":[{"Value":"<self-host-ip>"}]
       }}]
     }'
   ```

3. **Take self-host out of read-only mode.**

   ```bash
   curl -X POST -H "x-orbital-owner-token: ${ORBITAL_HUB_OWNER_TOKEN}" \
     -H 'content-type: application/json' \
     -d '{"readonly":false}' \
     ${ORBITAL_HUB_URL}/admin/readonly
   ```

   Or, if your hub doesn't expose that endpoint, edit `.env` and restart:

   ```bash
   sed -i 's/^ORBITAL_HUB_READONLY=.*/ORBITAL_HUB_READONLY=0/' .env
   docker compose -f docker-compose.hub.yml restart orbital-hub
   ```

4. **Verify operators reconnect.**

   ```bash
   bash scripts/hub-smoke.sh
   ```

5. **Capture AWS-side writes.** Any `events` written between cutover and rollback are now stranded in Aurora. Extract them:

   ```bash
   # Find the cutover timestamp (usually within the last 30 min)
   CUTOVER_TS="2026-05-02T14:00:00Z"

   psql "${ORBITAL_AURORA_PG_URL}" -At -c "
     SELECT event_id, tenant_id, kind, content
     FROM events
     WHERE created_at > '${CUTOVER_TS}'
     ORDER BY created_at ASC
   " > stranded-events.tsv
   ```

6. **Replay stranded events into self-host** using the existing event-append API. Each stranded event is dispatched once; the orchestrator's idempotency keys (signed envelope + event_id) prevent duplicates if any operator already retried.

   ```bash
   while IFS=$'\t' read -r event_id tenant_id kind content; do
     curl -X POST -H "x-orbital-owner-token: ${ORBITAL_HUB_OWNER_TOKEN}" \
       -H 'content-type: application/json' \
       -d "$(jq -nc --arg id "$event_id" --arg tid "$tenant_id" \
         --arg kind "$kind" --argjson c "$content" \
         '{event_id:$id, tenant_id:$tid, kind:$kind, content:$c}')" \
       "${ORBITAL_HUB_URL}/admin/replay-event"
   done < stranded-events.tsv
   ```

7. **Decide what to do with the AWS env.** Two options:
   - Leave it deployed, fix the bug, schedule a new cutover window. Cost is ~$5/day idle.
   - Tear it down via `scripts/teardown-env.sh <env>` and re-deploy fresh.

### Why this works within 5 minutes

The cutover lowered the DNS TTL to 60 seconds 24h before the cutover window. The maximum time any client should be pinned to the AWS endpoint is `60s + ~30s margin`. Most clients refresh sooner.

If the rollback window has elapsed (>5 min, operators are actively writing), prefer "fix forward" instead of rolling back. Two-way data reconciliation gets nasty fast.

---

## 2. Bad deploy rollback (CloudFormation rollback)

Use when: a `cdk deploy` introduced a change that broke things and you need the previous resource configuration back.

CloudFormation automatically rolls back failed deploys. If the deploy succeeded but the resource configuration is bad, manual rollback is required.

### Procedure

```bash
# 1. Identify the bad change set (most recent)
aws cloudformation list-change-sets \
  --stack-name OrbitalHub-mwitt \
  --region us-east-1

# 2. Find the previous template that was deployed
aws cloudformation list-stack-events \
  --stack-name OrbitalHub-mwitt \
  --region us-east-1 \
  --max-items 50

# 3. Check out the previous Git commit (the one that produced the working stack)
git log --oneline -- infra/
git checkout <previous-good-sha> -- infra/

# 4. Re-deploy that version
ORBITAL_AUTO_APPROVE_DEPLOY=1 ./scripts/deploy-env.sh mwitt

# 5. Run smoke
./scripts/aws-smoke-test.sh mwitt

# 6. Restore current Git state once verified
git checkout HEAD -- infra/
```

### When CloudFormation refuses to roll back

This happens when a stateful resource (Aurora, Cognito user pool, S3 bucket) is in an inconsistent state. Symptoms: the stack is in `UPDATE_ROLLBACK_FAILED`.

```bash
# Identify the resource(s) blocking rollback
aws cloudformation describe-stack-events \
  --stack-name OrbitalHub-mwitt \
  --region us-east-1 \
  --query "StackEvents[?ResourceStatus=='UPDATE_FAILED']|[0:10]"

# Skip the offending resources during rollback
aws cloudformation continue-update-rollback \
  --stack-name OrbitalHub-mwitt \
  --region us-east-1 \
  --resources-to-skip <LogicalId1> <LogicalId2>
```

This leaves the skipped resources in their failed state. After rollback completes, re-import or recreate them manually.

---

## 3. Aurora point-in-time recovery

Use when: data was corrupted or accidentally deleted (within the last 7 days for non-prod, 35 days for prod).

### Procedure

```bash
ENV=mwitt
REGION=us-east-1
SOURCE_CLUSTER=orbital-${ENV}
TARGET_CLUSTER=orbital-${ENV}-pitr-$(date +%s)
RESTORE_TIME=2026-05-02T13:45:00Z

# 1. Restore to a new cluster at the target time
aws rds restore-db-cluster-to-point-in-time \
  --region "${REGION}" \
  --source-db-cluster-identifier "${SOURCE_CLUSTER}" \
  --db-cluster-identifier "${TARGET_CLUSTER}" \
  --restore-to-time "${RESTORE_TIME}" \
  --serverless-v2-scaling-configuration MinCapacity=0.5,MaxCapacity=4

# 2. Add an instance to the cluster (Aurora Serverless v2 needs at least one)
aws rds create-db-instance \
  --region "${REGION}" \
  --db-instance-identifier "${TARGET_CLUSTER}-instance-1" \
  --db-instance-class db.serverless \
  --engine aurora-postgresql \
  --db-cluster-identifier "${TARGET_CLUSTER}"

# 3. Wait for the instance to be available (~10 min)
aws rds wait db-instance-available \
  --region "${REGION}" \
  --db-instance-identifier "${TARGET_CLUSTER}-instance-1"

# 4. Get the endpoint
PITR_ENDPOINT=$(aws rds describe-db-clusters \
  --region "${REGION}" \
  --db-cluster-identifier "${TARGET_CLUSTER}" \
  --query 'DBClusters[0].Endpoint' --output text)

# 5. Connect, verify the data is correct, dump what you need
psql "postgres://admin:<pw>@${PITR_ENDPOINT}:5432/orbital" -c "SELECT COUNT(*) FROM events;"

# 6. Either swap the cluster (downtime) OR copy specific rows back to live
# For event-level recovery (no downtime):
pg_dump --data-only --table=events \
  "postgres://admin:<pw>@${PITR_ENDPOINT}:5432/orbital" \
  > recovered-events.sql
psql "${ORBITAL_AURORA_PG_URL}" --file=recovered-events.sql

# 7. Tear down the PITR cluster (it bills like a normal Aurora cluster!)
aws rds delete-db-instance \
  --region "${REGION}" \
  --db-instance-identifier "${TARGET_CLUSTER}-instance-1" \
  --skip-final-snapshot

aws rds delete-db-cluster \
  --region "${REGION}" \
  --db-cluster-identifier "${TARGET_CLUSTER}" \
  --skip-final-snapshot
```

Always tear down the PITR cluster — leaving it running is the most common cost surprise after a recovery exercise.

---

## 4. Aurora snapshot restore

Use when: PITR is outside its window, or you need to restore from a manual snapshot.

```bash
# 1. List available snapshots
aws rds describe-db-cluster-snapshots \
  --region us-east-1 \
  --db-cluster-identifier orbital-mwitt \
  --snapshot-type automated \
  --query 'DBClusterSnapshots[].[DBClusterSnapshotIdentifier,SnapshotCreateTime]' \
  --output table

# 2. Restore (creates a new cluster — the original is untouched)
aws rds restore-db-cluster-from-snapshot \
  --region us-east-1 \
  --snapshot-identifier <snapshot-id> \
  --db-cluster-identifier orbital-mwitt-restored \
  --engine aurora-postgresql \
  --serverless-v2-scaling-configuration MinCapacity=0.5,MaxCapacity=4

# Then follow steps 2–7 of the PITR procedure above.
```

---

## 5. Cognito user pool recovery

User pools cannot be backed up natively. If a user pool is accidentally deleted (only possible by disabling deletion protection first), users must be re-imported.

### Periodic export (run weekly)

```bash
ENV=mwitt
USER_POOL_ID=$(aws cognito-idp list-user-pools --max-results 60 \
  --query "UserPools[?Name=='orbital-${ENV}'].Id" --output text)

aws cognito-idp list-users \
  --user-pool-id "${USER_POOL_ID}" \
  --output json > "users-${ENV}-$(date +%Y%m%d).json"
```

Store these exports in the `orbital-archive` S3 bucket with KMS encryption.

### Re-import after loss

Cognito does not support full credential restore — passwords are hashed with a per-pool secret that is destroyed with the pool. Each user must reset their password on first sign-in:

```bash
# 1. Recreate the user pool via cdk redeploy
./scripts/deploy-env.sh mwitt

# 2. For each user in the export, admin-create-user with FORCE_CHANGE_PASSWORD
jq -c '.Users[]' users-mwitt-<date>.json | while read user; do
  email=$(echo "$user" | jq -r '.Attributes[] | select(.Name=="email") | .Value')
  aws cognito-idp admin-create-user \
    --user-pool-id <new-pool-id> \
    --username "$email" \
    --user-attributes Name=email,Value="$email" Name=email_verified,Value=true \
    --message-action RESEND
done
```

Each user receives an invite email and chooses a new password.

---

## 6. S3 replay bucket recovery

The replay bucket has versioning enabled. Deleted objects are recoverable until the lifecycle rule deletes the version.

### Recover a specific deleted blob

```bash
BUCKET=orbital-replays-mwitt-<account>
KEY=tenant-abc/2026-05-01/event-xyz.json

# 1. List versions including delete markers
aws s3api list-object-versions \
  --bucket "${BUCKET}" \
  --prefix "${KEY}" \
  --query 'Versions[?Key==`'"${KEY}"'`].[VersionId,LastModified,IsLatest]'

# 2. Get the version ID immediately preceding the delete marker
VERSION_ID=<from-step-1>

# 3. Restore by copying the old version onto the current key
aws s3api copy-object \
  --bucket "${BUCKET}" \
  --key "${KEY}" \
  --copy-source "${BUCKET}/${KEY}?versionId=${VERSION_ID}"

# 4. Delete the delete marker
aws s3api delete-object \
  --bucket "${BUCKET}" \
  --key "${KEY}" \
  --version-id <delete-marker-version-id>
```

### Bulk recovery (many objects)

If a tenant's replay history was wiped, use S3 Batch Operations with the inventory report. See AWS docs: "Restoring previous versions with S3 Batch Operations".

---

## 7. Production teardown (manual procedure)

Production teardown is NEVER scripted — it requires explicit, manual intent.

### Procedure

1. **Get written approval from at least two Engineers.** Production teardown should never be a single-person decision. Capture the approvals in a Monday ticket comment thread.

2. **Take a final manual snapshot of Aurora.**

   ```bash
   aws rds create-db-cluster-snapshot \
     --region us-east-1 \
     --db-cluster-identifier orbital-prod \
     --db-cluster-snapshot-identifier orbital-prod-final-$(date +%Y%m%d)
   ```

3. **Export Cognito users (see section 5).**

4. **Sync replay bucket to archive.**

   ```bash
   aws s3 sync \
     s3://orbital-replays-prod-<account>/ \
     s3://orbital-archive/replays-prod-<date>/ \
     --sse aws:kms --sse-kms-key-id alias/orbital-archive
   ```

5. **Disable termination protection.**

   ```bash
   aws cloudformation update-termination-protection \
     --region us-east-1 \
     --no-enable-termination-protection \
     --stack-name OrbitalHub-prod
   ```

6. **Run cdk destroy with double confirmation.**

   ```bash
   cd infra
   AWS_PROFILE=orbital-prod npx cdk destroy --context env=prod
   # CDK will prompt: "Are you sure you want to delete: OrbitalHub-prod (y/n)?"
   ```

7. **Verify nothing remains:**

   ```bash
   aws cloudformation list-stacks \
     --region us-east-1 \
     --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
     --query 'StackSummaries[?starts_with(StackName, `OrbitalHub-prod`)]'
   ```

   Expected output: `[]`.

8. **Document the teardown in `docs/decisions/`** with timestamp, approvers, and reason.

---

## 8. Compromised secret rotation

Use when: a secret in Secrets Manager has been exposed (stolen credentials, accidental commit to public repo, etc.).

### Hub master key

```bash
# Trigger an immediate rotation via the rotation Lambda
aws secretsmanager rotate-secret \
  --region us-east-1 \
  --secret-id orbital/mwitt/hub-master-key \
  --rotate-immediately
```

The rotation Lambda generates a new Ed25519 keypair, marks the old key as PREVIOUS in `secrets/hub_master_key.prev`, and updates the in-process cache TTL. All clients receive the new public key on their next signed-envelope handshake.

### DB master credentials

```bash
aws secretsmanager rotate-secret \
  --region us-east-1 \
  --secret-id /orbital/mwitt/aurora/master-credentials \
  --rotate-immediately
```

The 30-day rotation Lambda is a single-user PG rotation; the rotation triggers an Aurora password change followed by a Lambda env-var refresh. Brief connection blips during rotation are expected.

### GitHub webhook secret

GitHub's webhook secret is a one-way HMAC; rotation requires:

1. Generate new secret:
   ```bash
   NEW_SECRET=$(openssl rand -hex 32)
   ```

2. Update in Secrets Manager:
   ```bash
   aws secretsmanager put-secret-value \
     --secret-id orbital/mwitt/github-webhook-secret \
     --secret-string "${NEW_SECRET}"
   ```

3. Update each repo webhook in GitHub UI (Settings → Webhooks → Edit) to use `${NEW_SECRET}`.

4. Restart the `prs` Lambda to invalidate cached secrets:
   ```bash
   aws lambda update-function-configuration \
     --function-name orbital-mwitt-trpc-prs \
     --environment "Variables={ROTATION_TS=$(date +%s)}"
   ```

GitHub starts using the new secret on the next webhook delivery.

---

## Final checklist before declaring "rolled back"

- [ ] Smoke (`scripts/aws-smoke-test.sh`) is green for the affected env (or self-host smoke if reverted).
- [ ] All CloudWatch alarms in `OrbitalHub-<env>` are in `OK` state.
- [ ] No SQS DLQs have non-zero depth.
- [ ] At least 30 minutes have elapsed without new errors.
- [ ] An incident note is posted on the relevant Monday ticket linking to this doc and capturing the timeline.

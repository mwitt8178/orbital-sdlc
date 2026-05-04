#!/usr/bin/env node
/**
 * smoke-e2e.mjs — End-to-end smoke test for the Orbital daemon SNS→SQS→handler chain.
 *
 * Publishes a real `system.smoke_test` domain event to the SNS topic
 * (with `consumer=daemon` message attribute so the daemon SQS filter passes it),
 * then tails the daemon CloudWatch log group for up to 60 seconds, looking for
 * evidence that the daemon processed the message.
 *
 * Detection tiers:
 *   Tier 1 — explicit smoke_test_handled log: { $.correlationId = "<id>" }
 *             Emitted after the smoke_test handler is deployed (new image).
 *   Tier 2 — sqs-consumer dispatching debug log: { $.event.correlationId = "<id>" }
 *             Emitted by the existing SqsConsumer at debug level. Proves the full
 *             SNS→SQS→daemon chain regardless of image version.
 *
 * Usage:
 *   node scripts/smoke-e2e.mjs
 *   npm run smoke:daemon -w @orbital/orchestrator-daemon
 *
 * Config resolution order:
 *   1. Environment variables (EVENTS_TOPIC_ARN, DAEMON_WORK_QUEUE_URL,
 *      DAEMON_LOG_GROUP, ORBITAL_ENV, AWS_REGION)
 *   2. .env.smoke file in the package root (KEY=VALUE, no interpolation)
 *   3. CloudFormation stack outputs (auto-resolved from ORBITAL_ENV or "mwitt" default)
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SNSClient, PublishCommand } from '@aws-sdk/client-sns'
import { ECSClient, DescribeServicesCommand } from '@aws-sdk/client-ecs'
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs'
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(__dirname, '..')

/** Parse a minimal subset of dotenv format (KEY=VALUE, no interpolation). */
function parseDotenv(filePath) {
  const result = {}
  if (!existsSync(filePath)) return result
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx < 1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    let val = trimmed.slice(eqIdx + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    result[key] = val
  }
  return result
}

// Merge .env.smoke into process.env (non-destructive)
const dotenvSmoke = parseDotenv(join(PKG_ROOT, '.env.smoke'))
for (const [k, v] of Object.entries(dotenvSmoke)) {
  if (!process.env[k]) process.env[k] = v
}

const AWS_REGION = process.env['AWS_REGION'] ?? 'us-east-1'
const ORBITAL_ENV = process.env['ORBITAL_ENV'] ?? 'mwitt'
const CFN_STACK_NAME = process.env['CFN_STACK_NAME'] ?? `OrbitalHub-${ORBITAL_ENV}`

const cfn = new CloudFormationClient({ region: AWS_REGION })
const ecs = new ECSClient({ region: AWS_REGION })
const sns = new SNSClient({ region: AWS_REGION })
const cwl = new CloudWatchLogsClient({ region: AWS_REGION })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RESET = '\x1b[0m'
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const CYAN = '\x1b[36m'

function ok(msg) { console.log(`${GREEN}✓${RESET} ${msg}`) }
function fail(msg) { console.error(`${RED}✗${RESET} ${msg}`) }
function info(msg) { console.log(`${CYAN}  ${msg}${RESET}`) }
function warn(msg) { console.log(`${YELLOW}! ${msg}${RESET}`) }

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function exit1(msg) {
  fail(msg)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Step 1 — Resolve config from CFN outputs
// ---------------------------------------------------------------------------

async function resolveCfnOutputs() {
  info(`Resolving config from CloudFormation stack: ${CFN_STACK_NAME}`)
  let outputs
  try {
    const res = await cfn.send(new DescribeStacksCommand({ StackName: CFN_STACK_NAME }))
    outputs = res.Stacks?.[0]?.Outputs ?? []
  } catch (err) {
    throw new Error(`CFN DescribeStacks failed for "${CFN_STACK_NAME}": ${err.message}`)
  }
  const map = {}
  for (const o of outputs) {
    if (o.OutputKey) map[o.OutputKey] = o.OutputValue
  }
  return map
}

function pickCfn(outputs, ...keys) {
  for (const k of keys) {
    if (outputs[k]) return outputs[k]
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Step 2 — Check daemon ECS service is running
// ---------------------------------------------------------------------------

async function checkDaemonRunning(clusterName, serviceName) {
  let res
  try {
    res = await ecs.send(new DescribeServicesCommand({
      cluster: clusterName,
      services: [serviceName],
    }))
  } catch (err) {
    throw new Error(`ECS DescribeServices failed: ${err.message}`)
  }
  const svc = res.services?.[0]
  if (!svc || svc.status !== 'ACTIVE') {
    return { running: false, reason: `Service "${serviceName}" not found or not ACTIVE` }
  }
  if ((svc.runningCount ?? 0) < 1) {
    return {
      running: false,
      reason:
        `Service "${serviceName}" has 0 running tasks (desired=${svc.desiredCount}). ` +
        `Scale up the ECS service first:\n` +
        `  aws ecs update-service --cluster ${clusterName} --service ${serviceName} --desired-count 1`,
    }
  }
  return { running: true, runningCount: svc.runningCount }
}

// ---------------------------------------------------------------------------
// Step 3 — Publish smoke event to SNS
// ---------------------------------------------------------------------------

async function publishSmokeEvent(topicArn, correlationId) {
  const payload = {
    kind: 'system.smoke_test',
    correlationId,
    tenant_id: 'system',
    timestamp: new Date().toISOString(),
    source: 'smoke-e2e.mjs',
  }
  const res = await sns.send(new PublishCommand({
    TopicArn: topicArn,
    Message: JSON.stringify(payload),
    // SNS message attributes used by the daemon SQS subscription filter policy.
    // The policy is: {"consumer":["daemon"]} — must set consumer=daemon here.
    MessageAttributes: {
      consumer: {
        DataType: 'String',
        StringValue: 'daemon',
      },
    },
    Subject: 'system.smoke_test',
  }))
  return res.MessageId
}

// ---------------------------------------------------------------------------
// Step 4 — Tail CloudWatch Logs for daemon processing evidence
// ---------------------------------------------------------------------------

/**
 * Poll CW Logs for up to `timeoutMs`, checking two detection tiers in parallel:
 *
 *   Tier 1: { $.correlationId = "<id>" }
 *     Emitted by the explicit smoke_test_handled handler in main.ts.
 *     Requires a freshly built and deployed daemon image.
 *
 *   Tier 2: { $.event.correlationId = "<id>" }
 *     Emitted by sqs-consumer.ts at debug level ("sqs-consumer: dispatching").
 *     Present in any deployed image — proves the full SNS→SQS→daemon chain.
 *
 * Returns { logLine, tier, description } on success, throws on timeout.
 */
async function waitForDaemonLog(logGroupName, correlationId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  // Look back 10s to catch any log that arrived before we started polling.
  const startTime = Date.now() - 10_000
  let pollCount = 0

  const tier1Pattern = `{ $.correlationId = "${correlationId}" }`
  const tier2Pattern = `{ $.event.correlationId = "${correlationId}" }`

  while (Date.now() < deadline) {
    pollCount++

    const [t1, t2] = await Promise.allSettled([
      cwl.send(new FilterLogEventsCommand({
        logGroupName,
        startTime,
        filterPattern: tier1Pattern,
        limit: 10,
      })),
      cwl.send(new FilterLogEventsCommand({
        logGroupName,
        startTime,
        filterPattern: tier2Pattern,
        limit: 10,
      })),
    ])

    // Tier 1 — explicit smoke_test_handled
    if (t1.status === 'fulfilled') {
      for (const event of t1.value.events ?? []) {
        try {
          const parsed = JSON.parse(event.message ?? '')
          if (parsed.correlationId === correlationId) {
            return {
              logLine: parsed,
              tier: 1,
              description: 'smoke_test_handled explicit log (handler code running in deployed image)',
            }
          }
        } catch { /* skip non-JSON */ }
      }
    } else {
      warn(`Tier-1 poll ${pollCount} failed: ${t1.reason?.message}`)
    }

    // Tier 2 — sqs-consumer dispatching debug log
    if (t2.status === 'fulfilled') {
      for (const event of t2.value.events ?? []) {
        try {
          const parsed = JSON.parse(event.message ?? '')
          if (parsed?.event?.correlationId === correlationId) {
            return {
              logLine: parsed,
              tier: 2,
              description:
                'sqs-consumer dispatching log ($.event.correlationId match) — ' +
                'chain proven end-to-end. ' +
                'NOTE: smoke_test_handled explicit log requires daemon image rebuild+redeploy.',
            }
          }
        } catch { /* skip non-JSON */ }
      }
    } else {
      warn(`Tier-2 poll ${pollCount} failed: ${t2.reason?.message}`)
    }

    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const wait = Math.min(3000, remaining)
    info(`  [poll ${pollCount}] No match yet, ${Math.round(remaining / 1000)}s remaining...`)
    await sleep(wait)
  }

  throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for daemon log in ${logGroupName}`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n=== Orbital Daemon SNS->SQS->Handler Smoke Test ===\n')

  // ---- Resolve config ----
  let cfnOutputs
  try {
    cfnOutputs = await resolveCfnOutputs()
  } catch (err) {
    exit1(`[STEP 1 FAILED] Config resolution: ${err.message}`)
  }

  const topicArn =
    process.env['EVENTS_TOPIC_ARN'] ??
    pickCfn(cfnOutputs, 'EventBusSnsTopicArnA6726405', 'EventsTopicArn')

  const queueUrl =
    process.env['DAEMON_WORK_QUEUE_URL'] ??
    pickCfn(cfnOutputs, 'DaemonWorkQueueUrlA07BA949', 'DaemonWorkQueueUrl')

  const logGroupName =
    process.env['DAEMON_LOG_GROUP'] ??
    `/orbital/${ORBITAL_ENV}/daemon`

  const clusterName = `orbital-${ORBITAL_ENV}-daemon`
  const serviceName = `orbital-${ORBITAL_ENV}-daemon`

  if (!topicArn) exit1('[STEP 1 FAILED] Could not resolve EVENTS_TOPIC_ARN from env or CFN outputs')
  if (!queueUrl) exit1('[STEP 1 FAILED] Could not resolve DAEMON_WORK_QUEUE_URL from env or CFN outputs')

  info(`SNS topic ARN   : ${topicArn}`)
  info(`Daemon queue URL: ${queueUrl}`)
  info(`Log group       : ${logGroupName}`)
  info(`ECS cluster     : ${clusterName}`)
  console.log()

  // ---- Step 1: Check daemon is running ----
  console.log('Step 1: Checking daemon ECS service...')
  let daemonStatus
  try {
    daemonStatus = await checkDaemonRunning(clusterName, serviceName)
  } catch (err) {
    exit1(`[STEP 1 FAILED] ${err.message}`)
  }
  if (!daemonStatus.running) {
    exit1(`[STEP 1 FAILED] Daemon not running -- ${daemonStatus.reason}`)
  }
  ok(`Daemon service is running (${daemonStatus.runningCount} task(s))`)

  // ---- Step 2: Publish smoke event ----
  const correlationId = randomUUID()
  console.log('\nStep 2: Publishing system.smoke_test event to SNS...')
  info(`correlationId = ${correlationId}`)

  let snsMessageId
  try {
    snsMessageId = await publishSmokeEvent(topicArn, correlationId)
  } catch (err) {
    exit1(`[STEP 2 FAILED] SNS publish failed: ${err.message}`)
  }
  ok(`Published correlationId=${correlationId} (SNS MessageId=${snsMessageId})`)

  // ---- Step 3: Wait for daemon log ----
  console.log('\nStep 3: Tailing daemon CloudWatch log group (up to 60s)...')
  const t0 = Date.now()

  let result
  try {
    result = await waitForDaemonLog(logGroupName, correlationId, 60_000)
  } catch (err) {
    console.log()
    fail(`[STEP 3 FAILED] ${err.message}`)
    console.log()
    console.log('Diagnostics:')
    console.log(`  SNS topic     : ${topicArn}`)
    console.log(`  Queue URL     : ${queueUrl}`)
    console.log(`  Log group     : ${logGroupName}`)
    console.log(`  correlationId : ${correlationId}`)
    console.log()
    console.log('Troubleshooting:')
    console.log('  1. Was the message delivered to SQS?')
    console.log(`     aws sqs get-queue-attributes --queue-url "${queueUrl}" --attribute-names ApproximateNumberOfMessages`)
    console.log('  2. Is the daemon consuming from SQS?')
    console.log(`     aws logs tail "${logGroupName}" --follow`)
    console.log('  3. Does the daemon run at debug log level?')
    console.log(`     (Tier-2 detection requires LOG_LEVEL=debug on the ECS task)`)
    process.exit(1)
  }

  const elapsed = Math.round((Date.now() - t0) / 1000)
  console.log()
  ok(`Daemon log observed at T+${elapsed}s (detection tier ${result.tier})`)
  ok(`correlationId=${result.logLine?.correlationId ?? result.logLine?.event?.correlationId ?? correlationId}`)
  if (result.tier === 2) {
    warn(`Note: ${result.description}`)
  } else {
    ok(result.description)
  }
  console.log()
  console.log('Matched log line:')
  console.log(JSON.stringify(result.logLine, null, 2))
  console.log()
  console.log(`${GREEN}=== SMOKE TEST PASSED ===${RESET}`)
  console.log()
  process.exit(0)
}

main().catch((err) => {
  fail(`Unexpected error: ${err.stack ?? err.message}`)
  process.exit(1)
})

# Round 8-08 — Observability + WAF + Alarms

## Persona / Risk
Engineer-Senior · Sonnet · Risk Tier: Low · Estimate: M

## Depends on
All prior 8-* tasks (instruments them)

## Why
You can't run a production SaaS without real observability. CloudWatch + X-Ray + WAF + alarms wired to ops alerts.

## Bounded contexts touched
| Context | Files | Change |
|--|--|--|
| `infra/lib/constructs/observability.ts` | NEW | Dashboards, alarms, log groups, X-Ray |
| `infra/lib/constructs/waf.ts` | NEW | WebACL + rules + association |
| `packages/orchestrator/src/lambda/init.ts` | extend | X-Ray SDK instrumentation |
| `packages/orchestrator/src/lambda/handlers/*.ts` | extend | Structured logging via existing pino config |

## CloudWatch Logs
- One log group per Lambda function: `/aws/lambda/orbital-${env}-${functionName}`
- Retention: per env config (30d non-prod, 90d prod)
- Subscription filter to OpenSearch (Round 9 — defer; v1 is just CloudWatch)
- Structured JSON logs (existing pino config; in Lambda, pino writes to stdout which CloudWatch captures)

Per-Lambda log group naming convention guarantees Amazon Q and CloudWatch Insights queries work cleanly.

## X-Ray
- Enabled on every Lambda (`Tracing: Active`)
- Lambda init wraps AWS SDK clients with X-Ray instrumentation
- Aurora calls show as downstream segments
- API Gateway → Lambda → Aurora end-to-end trace visible

## CloudWatch Dashboard: `orbital-${env}`
Single dashboard, sections:
1. **API health** — HTTP API 4xx/5xx rates, p50/p99 latency, request count
2. **WS health** — connection count, message throughput, fanout latency
3. **Lambda** — error rate, throttles, duration, cold-start rate per function
4. **Aurora** — CPU, connections, replication lag, slow queries
5. **RDS Proxy** — connection borrows, query rate, error rate
6. **SQS** — queue depth, age of oldest message, DLQ depth (per queue)
7. **SNS** — publish rate, delivery failures
8. **Cognito** — sign-in rate, sign-up rate, MFA adoption
9. **WAF** — blocked requests by rule, rate-limited IPs

## Alarms (rate-based, not threshold)
All alarms publish to SNS topic `orbital-alarms-${env}` which fans out to email + (optional) Slack via subscribed Lambda.

| Alarm | Condition |
|---|---|
| API 5xx rate | > 1% over 5 min |
| Lambda error rate | > 5% over 5 min (per function) |
| Lambda throttle | > 0 in 1 min |
| Aurora CPU | > 80% sustained 5 min |
| Aurora connections | > 90% of max |
| RDS Proxy connection borrows | > 90% of pool |
| SQS DLQ depth | > 0 (immediate) |
| SQS oldest message age | > 5 min |
| WAF blocked requests | rate > 100/min from single IP |
| Cognito sign-in failures | rate > 10/min |
| WS fanout failures | > 1% over 5 min |
| Replay blob corrupt | any (immediate — emitted as ReplayCorrupt event from store) |

## WAF
**Web ACL: `orbital-${env}-acl`**
- AWS Managed Rule Sets:
  - `AWSManagedRulesCommonRuleSet` (OWASP)
  - `AWSManagedRulesKnownBadInputsRuleSet`
  - `AWSManagedRulesAmazonIpReputationList`
- Custom rules:
  - Rate limit: 1000 req/min per IP (general)
  - Rate limit: 50 sign-in attempts/15min per IP (auth endpoint)
  - Block requests with no User-Agent header (likely bots)
- Logging: WAF logs → CloudWatch Logs → metric filters → alarms
- Association: HTTP API + WebSocket API + CloudFront distribution

## SLO targets (documented; alarms enforce)
- API availability: 99.9% (error budget: ~43 min/month)
- API p99 latency (warm): 200ms
- WS reconnect success: 99%
- Event fanout latency p99: 1s

## Acceptance criteria
1. CloudWatch Dashboard renders all 9 sections after deploy.
2. Trigger a 5xx burst (synthetic) → alarm fires within 5 min → email received.
3. X-Ray trace map shows API GW → Lambda → Aurora end-to-end for a real request.
4. WAF blocks a request with SQL-injection payload (negative test against test endpoint).
5. WAF rate limits exceeded → request returns 429.
6. SQS DLQ alarm fires immediately when a message lands in DLQ.
7. Logs queryable via CloudWatch Insights with structured fields (`level`, `tenant_id`, `event_id`).

## Hard-stop checks
```
grep -E "WafConstruct|WebAcl" infra/lib/constructs/waf.ts
grep -E "Dashboard|MetricFilter" infra/lib/constructs/observability.ts
grep -E "Tracing.*ACTIVE" infra/lib/constructs/lambda-trpc.ts
grep -E "SubscriptionFilter|OpenSearch" infra/lib/constructs/observability.ts || echo "Round 9 deferred — OK"
```

## Persona evidence prefix
`[Engineer-Sr · Sonnet · run-round8-08-observability]`

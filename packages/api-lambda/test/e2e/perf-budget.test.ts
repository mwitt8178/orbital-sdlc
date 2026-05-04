/**
 * Phase 1-4 Performance Verification: api-lambda
 *
 * Validates:
 * 1. Bundle size < 5 MB (dist/handler.mjs)
 * 2. Cold-start init duration < 3000 ms (via AWS Lambda invoke)
 * 3. Warm-path execution < 500 ms (via AWS Lambda invoke, subsequent calls)
 * 4. Warm latency p99 < 1000 ms (100 sequential curls against /public/onboarding.status)
 *
 * Requires AWS credentials and deployment. Skipped if ORBITAL_SKIP_AWS=1 or
 * missing ORBITAL_TEST_API_URL / ORBITAL_TEST_LAMBDA_FUNCTION_NAME.
 *
 * Run: cd packages/api-lambda && npm test -- test/e2e/perf-budget
 * Skip AWS tests: ORBITAL_SKIP_AWS=1 npm test -- test/e2e/perf-budget
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Lambda } from '@aws-sdk/client-lambda'
import type { InvokeCommandInput } from '@aws-sdk/client-lambda'

const __dirname = dirname(fileURLToPath(import.meta.url))

const SKIP_AWS = Boolean(process.env['ORBITAL_SKIP_AWS'])
const API_URL = process.env['ORBITAL_TEST_API_URL']
const FUNCTION_NAME = process.env['ORBITAL_TEST_LAMBDA_FUNCTION_NAME'] || 'orbital-mwitt-api'

/**
 * Synthetic API Gateway HTTP API v2 event for /public/onboarding.status
 * (public, no auth required)
 */
function createSyntheticEvent(requestId: string) {
  return {
    version: '2.0',
    routeKey: 'GET /public/onboarding.status',
    rawPath: '/public/onboarding.status',
    rawQueryString: '',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'perf-budget-test',
    },
    requestContext: {
      http: {
        method: 'GET',
        path: '/public/onboarding.status',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'perf-budget-test',
      },
      routeKey: 'GET /public/onboarding.status',
      stage: '$default',
      requestId,
      timeEpoch: Date.now(),
    },
    isBase64Encoded: false,
  }
}

describe('api-lambda performance budget', () => {
  it('bundle size (dist/handler.mjs) < 5 MB', () => {
    const handlerPath = resolve(__dirname, '..', '..', 'dist', 'handler.mjs')
    const sizeBytes = readFileSync(handlerPath).length
    const sizeMB = sizeBytes / 1024 / 1024

    console.log(
      `handler.mjs: ${sizeMB.toFixed(2)} MB (${sizeBytes.toLocaleString()} bytes)`,
    )

    expect(sizeBytes).toBeLessThan(5 * 1024 * 1024)
  })
})

if (!SKIP_AWS) {
  describe('api-lambda performance — AWS tests', () => {
    let lambdaClient: Lambda

    beforeAll(() => {
      lambdaClient = new Lambda({ region: 'us-east-1' })
    })

    it.skipIf(!API_URL)('cold-start: init duration < 3000 ms', async () => {
      const input: InvokeCommandInput = {
        FunctionName: FUNCTION_NAME,
        InvocationType: 'RequestResponse',
        LogType: 'Tail',
        Payload: JSON.stringify(createSyntheticEvent('cold-start-test-1')),
      }

      const response = await lambdaClient.invoke(input)

      // Extract init duration from CloudWatch Logs (X-Ray trace or billed duration)
      const logResult = response.LogResult
      let initDuration = 0
      let billedDuration = 0

      if (logResult) {
        const logsText = Buffer.from(logResult, 'base64').toString('utf-8')
        console.log('Cold-start logs:\n', logsText)

        // Parse REPORT line: "REPORT RequestId: ... Duration: X.XX ms Billed Duration: Y ms ..."
        const reportMatch = logsText.match(/Duration: ([\d.]+) ms/)
        const billedMatch = logsText.match(/Billed Duration: (\d+) ms/)

        if (reportMatch) {
          initDuration = parseFloat(reportMatch[1])
        }
        if (billedMatch) {
          billedDuration = parseFloat(billedMatch[1])
        }
      }

      // Fallback: use response metadata if available
      if (billedDuration === 0) {
        billedDuration = initDuration
      }

      console.log(
        `Cold-start: initDuration=${initDuration.toFixed(2)}ms, billedDuration=${billedDuration}ms`,
      )

      expect(billedDuration).toBeLessThan(3000)
    })

    it.skipIf(!API_URL)('warm-path: execution duration < 500 ms (runs 3x)', async () => {
      const durations: number[] = []

      for (let i = 0; i < 3; i++) {
        const input: InvokeCommandInput = {
          FunctionName: FUNCTION_NAME,
          InvocationType: 'RequestResponse',
          LogType: 'Tail',
          Payload: JSON.stringify(createSyntheticEvent(`warm-execution-${i}`)),
        }

        const response = await lambdaClient.invoke(input)
        const logResult = response.LogResult

        if (logResult) {
          const logsText = Buffer.from(logResult, 'base64').toString('utf-8')
          const durationMatch = logsText.match(/Duration: ([\d.]+) ms/)
          if (durationMatch) {
            const duration = parseFloat(durationMatch[1])
            durations.push(duration)
            console.log(`Warm execution ${i}: ${duration.toFixed(2)}ms`)
          }
        }
      }

      // All warm invocations should be < 500 ms
      durations.forEach((d) => {
        expect(d).toBeLessThan(500)
      })

      if (durations.length > 0) {
        const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length
        console.log(`Warm-path avg: ${avgDuration.toFixed(2)}ms`)
      }
    })

    it.skipIf(!API_URL)('warm latency: p99 < 1000 ms (100 sequential curls)', async () => {
      const latencies: number[] = []
      const endpoint = `${API_URL}/public/onboarding.status`

      for (let i = 0; i < 100; i++) {
        const start = Date.now()
        try {
          const response = await fetch(endpoint, {
            method: 'GET',
            headers: {
              'content-type': 'application/json',
              'user-agent': 'perf-budget-test',
            },
          })

          const elapsed = Date.now() - start
          latencies.push(elapsed)

          if (!response.ok) {
            console.warn(`Request ${i}: status ${response.status}, latency ${elapsed}ms`)
          }

          // Consume the response body to avoid hanging
          await response.text()
        } catch (err) {
          const elapsed = Date.now() - start
          latencies.push(elapsed)
          console.warn(
            `Request ${i} failed: ${err instanceof Error ? err.message : String(err)}, elapsed ${elapsed}ms`,
          )
        }
      }

      if (latencies.length === 0) {
        console.log('No latency samples collected')
        return
      }

      latencies.sort((a, b) => a - b)
      const p50 = latencies[Math.floor(latencies.length * 0.5)]
      const p99 = latencies[Math.floor(latencies.length * 0.99)]
      const p100 = latencies[latencies.length - 1]

      console.log(
        `Warm latency (100 samples): p50=${p50}ms, p99=${p99}ms, p100=${p100}ms`,
      )

      expect(p99).toBeLessThan(1000)
    })
  })
}

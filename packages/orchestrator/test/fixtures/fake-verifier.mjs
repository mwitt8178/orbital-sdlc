#!/usr/bin/env node
/**
 * fake-verifier.mjs — Test fixture for verifier integration tests.
 *
 * Simulates a verifier worker. It:
 *   1. Reads the capability bundle from ORBITAL_CAPABILITY_PATH.
 *   2. Reads ORBITAL_VERIFICATION_ID + ORBITAL_TASK_ID from env.
 *   3. Submits a canned verification result to the VerifierService via a
 *      direct HTTP POST to ORBITAL_VERIFIER_SUBMIT_URL (if set), or
 *      writes a result file to ORBITAL_VERIFIER_RESULT_FILE.
 *   4. Exits 0.
 *
 * Optional knobs (env vars):
 *   FAKE_VERIFIER_VERDICT       'pass'|'fail'|'ambiguous' (default: 'pass')
 *   FAKE_VERIFIER_AC_COUNT      number of ACs to simulate (default: 1)
 *   FAKE_VERIFIER_RESULT_FILE   path to write the JSON result to (for test assertion)
 *   FAKE_VERIFIER_DEBUG=1       emit log lines to stderr
 */

import { promises as fs } from 'node:fs'
import process from 'node:process'

const debug = process.env.FAKE_VERIFIER_DEBUG === '1'
function log(msg) {
  if (debug) process.stderr.write(`[fake-verifier] ${msg}\n`)
}

async function main() {
  const verificationId = process.env.ORBITAL_VERIFICATION_ID
  const taskId = process.env.ORBITAL_TASK_ID
  const resultFile = process.env.FAKE_VERIFIER_RESULT_FILE
  const verdict = process.env.FAKE_VERIFIER_VERDICT ?? 'pass'
  const acCount = Number(process.env.FAKE_VERIFIER_AC_COUNT ?? '1')

  log(`verificationId=${verificationId} taskId=${taskId} verdict=${verdict} acCount=${acCount}`)

  if (!verificationId) {
    process.stderr.write('fake-verifier: ORBITAL_VERIFICATION_ID not set\n')
    process.exit(1)
  }

  const results = []
  for (let i = 1; i <= acCount; i++) {
    results.push({
      ac_index: i,
      ac_text: `AC ${i}: Acceptance criterion ${i} text`,
      verdict,
      reason: `Fake verifier result for AC ${i}: ${verdict}`,
      evidence_refs: [],
    })
  }

  const submission = {
    verification_id: verificationId,
    results,
    summary: `Fake verifier completed: ${verdict} on ${acCount} AC(s)`,
  }

  log(`submission: ${JSON.stringify(submission)}`)

  if (resultFile) {
    await fs.writeFile(resultFile, JSON.stringify(submission, null, 2), 'utf-8')
    log(`wrote result to ${resultFile}`)
  }

  // If a submit URL is set, POST the result
  const submitUrl = process.env.ORBITAL_VERIFIER_SUBMIT_URL
  if (submitUrl) {
    const { default: http } = await import('node:http')
    await new Promise((resolve, reject) => {
      const body = JSON.stringify(submission)
      const url = new URL(submitUrl)
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          res.resume()
          resolve(res.statusCode)
        },
      )
      req.on('error', reject)
      req.write(body)
      req.end()
    })
    log(`submitted result to ${submitUrl}`)
  }

  process.exit(0)
}

main().catch((err) => {
  process.stderr.write(`fake-verifier fatal: ${err?.message ?? err}\n`)
  process.exit(1)
})

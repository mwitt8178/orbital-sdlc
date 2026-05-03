// esbuild config for @orbital/api-lambda — produces a single ESM bundle
// suitable for AWS Lambda nodejs22.x runtime.
//
// Externals: anything provided by the Lambda runtime (AWS SDK v3, aws-xray-sdk-core),
// plus optional runtime deps the Lambda doesn't actually need (keytar — daemon only,
// pino-pretty — dev only, drizzle-kit — build-time only).
//
// Outputs:
//   dist/handler.mjs   — the Lambda entry (export const handler)
//   dist/handler.mjs.map — sourcemap
//
// Bundle size budget: < 5 MB. Anything larger blocks Phase 1.1 gate.

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(__dirname, 'dist')

await fs.rm(distDir, { recursive: true, force: true })
await fs.mkdir(distDir, { recursive: true })

const externals = [
  // AWS SDK v3 — provided by the Lambda runtime, never bundle.
  '@aws-sdk/client-secrets-manager',
  '@aws-sdk/client-sns',
  '@aws-sdk/client-dynamodb',
  '@aws-sdk/client-s3',
  '@aws-sdk/client-kms',
  '@aws-sdk/client-apigatewaymanagementapi',
  '@aws-sdk/rds-signer',
  // X-Ray — wrapped optionally via dynamic import in init.ts; provided by runtime.
  'aws-xray-sdk-core',
  // Daemon-only / dev-only — must NEVER reach a Lambda bundle.
  'keytar',
  'pino-pretty',
  'drizzle-kit',
  // OpenTelemetry — Lambda uses managed instrumentation layer, not bundled SDK.
  '@opentelemetry/api',
  '@opentelemetry/auto-instrumentations-node',
  '@opentelemetry/exporter-trace-otlp-http',
  '@opentelemetry/sdk-node',
  // Native bindings the Lambda runtime doesn't need.
  'zstd-napi',
]

const result = await build({
  entryPoints: ['src/handler.ts'],
  outfile: 'dist/handler.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // Lambda needs CJS-compatible exports for `handler` to be discoverable by the
  // Node runtime when format is ESM. We emit `.mjs` and use `handler.handler`
  // path in CDK; that works under nodejs22.x.
  sourcemap: true,
  minify: false, // keep stack traces readable; gzip handles size
  treeShaking: true,
  legalComments: 'none',
  banner: {
    // Polyfill __dirname / __filename / require for transitive CJS deps under ESM.
    js: [
      "import { createRequire as __orbitalCreateRequire } from 'module';",
      "import { fileURLToPath as __orbitalFileURLToPath } from 'url';",
      "import { dirname as __orbitalDirname } from 'path';",
      "const require = __orbitalCreateRequire(import.meta.url);",
      "const __filename = __orbitalFileURLToPath(import.meta.url);",
      "const __dirname = __orbitalDirname(__filename);",
    ].join('\n'),
  },
  external: externals,
  logLevel: 'info',
  metafile: true,
})

await fs.writeFile(
  path.join(distDir, 'metafile.json'),
  JSON.stringify(result.metafile, null, 2),
)

const stats = await fs.stat(path.join(distDir, 'handler.mjs'))
const sizeMb = (stats.size / 1024 / 1024).toFixed(2)
console.log(`bundle: ${sizeMb} MB`)

if (stats.size > 5 * 1024 * 1024) {
  console.error(`FAIL: bundle exceeds 5 MB budget (${sizeMb} MB)`)
  process.exit(1)
}

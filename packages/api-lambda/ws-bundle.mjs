// One-shot esbuild bundle for the ws-connect / ws-disconnect / ws-default Lambdas.
import { build } from 'esbuild'
import path from 'node:path'

const ROOT = '/Users/matthewwitt/AI SDLC/orbital'
const ENTRIES = {
  connect: `${ROOT}/packages/orchestrator/src/lambda/ws/connect.ts`,
  disconnect: `${ROOT}/packages/orchestrator/src/lambda/ws/disconnect.ts`,
  default: `${ROOT}/packages/orchestrator/src/lambda/ws/default.ts`,
}

for (const [name, entry] of Object.entries(ENTRIES)) {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: `/tmp/ws-${name}.mjs`,
    external: ['@aws-sdk/*'],
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    logLevel: 'error',
    sourcemap: false,
  })
  console.log('built', name)
}

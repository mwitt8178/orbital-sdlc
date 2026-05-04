import { build } from 'esbuild'
const ROOT = '/Users/matthewwitt/AI SDLC/orbital'
for (const [name, entry] of Object.entries({
  connect: `${ROOT}/packages/orchestrator/src/lambda/ws/connect.ts`,
  disconnect: `${ROOT}/packages/orchestrator/src/lambda/ws/disconnect.ts`,
  default: `${ROOT}/packages/orchestrator/src/lambda/ws/default.ts`,
})) {
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: `/tmp/ws-${name}.mjs`, external: ['@aws-sdk/*'], banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }, logLevel: 'error' })
  console.log('built', name)
}

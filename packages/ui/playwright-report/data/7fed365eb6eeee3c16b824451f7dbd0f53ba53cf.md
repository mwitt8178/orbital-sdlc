# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: backlog-audit-memory.spec.ts >> API smoke — backlog / audit / memory router init >> memory.list → 200 or 401 (NOT 500)
- Location: test/e2e/backlog-audit-memory.spec.ts:118:3

# Error details

```
Error: expect: Property 'toSatisfy' not found.
```

# Test source

```ts
  25  | 
  26  | // ---------------------------------------------------------------------------
  27  | // Helpers
  28  | // ---------------------------------------------------------------------------
  29  | 
  30  | /**
  31  |  * Attach console-error and pageerror listeners to `page`.
  32  |  * Returns a ref whose `.errors` array is populated as events arrive.
  33  |  * Known-acceptable noise (favicon, preload, WebSocket) is filtered out.
  34  |  */
  35  | function trackConsoleErrors(page: import('@playwright/test').Page): { errors: string[] } {
  36  |   const errors: string[] = []
  37  |   const ignoreSubstrings = ['favicon', 'preload', 'Failed to load resource', 'WebSocket']
  38  | 
  39  |   page.on('console', (msg: ConsoleMessage) => {
  40  |     if (msg.type() !== 'error') return
  41  |     const text = msg.text()
  42  |     if (ignoreSubstrings.some((s) => text.includes(s))) return
  43  |     errors.push(text)
  44  |   })
  45  | 
  46  |   page.on('pageerror', (err) => {
  47  |     errors.push(`pageerror: ${err.message}`)
  48  |   })
  49  | 
  50  |   return { errors }
  51  | }
  52  | 
  53  | /**
  54  |  * Build a tRPC GET URL for a batch-1 query with an optional input payload.
  55  |  * Encodes the input object as the standard tRPC batch query string.
  56  |  */
  57  | function trpcGet(procedure: string, input: unknown = {}): string {
  58  |   const encoded = encodeURIComponent(JSON.stringify({ '0': input }))
  59  |   return `${API_BASE}/trpc/${procedure}?batch=1&input=${encoded}`
  60  | }
  61  | 
  62  | // ---------------------------------------------------------------------------
  63  | // Browser: SetupGate redirect + wizard rendering
  64  | // ---------------------------------------------------------------------------
  65  | 
  66  | test.describe('SetupGate redirects for protected pages', () => {
  67  |   const protectedPages = ['/backlog', '/audit', '/memory'] as const
  68  | 
  69  |   for (const path of protectedPages) {
  70  |     test(`${path} → redirects to /welcome and renders wizard heading`, async ({ page }) => {
  71  |       const { errors } = trackConsoleErrors(page)
  72  | 
  73  |       await page.goto(path)
  74  | 
  75  |       // SetupGate must redirect to /welcome.
  76  |       await expect(page).toHaveURL(/\/welcome$/, { timeout: 20_000 })
  77  | 
  78  |       // The wizard must render its heading — proves it's not stuck on the
  79  |       // FullScreenLoader (the bug fixed in Phase 1.10).
  80  |       await expect(
  81  |         page.getByRole('heading', { name: /Welcome to Orbital/i }),
  82  |       ).toBeVisible({ timeout: 15_000 })
  83  | 
  84  |       expect(
  85  |         errors,
  86  |         `${path} → uncaught console errors:\n${errors.join('\n')}`,
  87  |       ).toEqual([])
  88  |     })
  89  |   }
  90  | })
  91  | 
  92  | // ---------------------------------------------------------------------------
  93  | // Direct API smoke: assert NOT 500 on these routes
  94  | // ---------------------------------------------------------------------------
  95  | 
  96  | test.describe('API smoke — backlog / audit / memory router init', () => {
  97  |   test('backlog.epics.list → 200 or 401 (NOT 500)', async ({ request }) => {
  98  |     const r = await request.get(trpcGet('backlog.epics.list', {}))
  99  |     const status = r.status()
  100 | 
  101 |     expect(
  102 |       status,
  103 |       `backlog.epics.list returned ${status} — expected 200 or 401, not a 5xx`,
  104 |     ).toSatisfy((s: number) => s === 200 || s === 401)
  105 |   })
  106 | 
  107 |   test('audit.events.query → 200 or 401 (NOT 500)', async ({ request }) => {
  108 |     // audit.events.query is a publicProcedure with an optional filters input.
  109 |     const r = await request.get(trpcGet('audit.events.query', { filters: {} }))
  110 |     const status = r.status()
  111 | 
  112 |     expect(
  113 |       status,
  114 |       `audit.events.query returned ${status} — expected 200 or 401, not a 5xx`,
  115 |     ).toSatisfy((s: number) => s === 200 || s === 401)
  116 |   })
  117 | 
  118 |   test('memory.list → 200 or 401 (NOT 500)', async ({ request }) => {
  119 |     const r = await request.get(trpcGet('memory.list', {}))
  120 |     const status = r.status()
  121 | 
  122 |     expect(
  123 |       status,
  124 |       `memory.list returned ${status} — expected 200 or 401, not a 5xx`,
> 125 |     ).toSatisfy((s: number) => s === 200 || s === 401)
      |      ^ Error: expect: Property 'toSatisfy' not found.
  126 |   })
  127 | 
  128 |   test('API smoke responses carry no tRPC INTERNAL_SERVER_ERROR body', async ({ request }) => {
  129 |     // Even when the API returns 200, a tRPC INTERNAL_SERVER_ERROR in the body
  130 |     // means the procedure itself crashed. Assert the body does NOT contain one.
  131 |     const endpoints: Array<{ proc: string; input: unknown }> = [
  132 |       { proc: 'backlog.epics.list', input: {} },
  133 |       { proc: 'audit.events.query', input: { filters: {} } },
  134 |       { proc: 'memory.list', input: {} },
  135 |     ]
  136 | 
  137 |     for (const { proc, input } of endpoints) {
  138 |       const r = await request.get(trpcGet(proc, input))
  139 |       const body = await r.text()
  140 | 
  141 |       // If the response is 401 the body is the tRPC error JSON — that's fine.
  142 |       // If it is 200, the body must not contain INTERNAL_SERVER_ERROR.
  143 |       if (r.status() === 200) {
  144 |         expect(
  145 |           body,
  146 |           `${proc} returned 200 but body contains INTERNAL_SERVER_ERROR`,
  147 |         ).not.toContain('INTERNAL_SERVER_ERROR')
  148 |       }
  149 |     }
  150 |   })
  151 | })
  152 | 
```
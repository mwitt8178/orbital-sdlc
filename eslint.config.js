import js from '@eslint/js'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import reactPlugin from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import prettier from 'eslint-config-prettier'
import boundaries from 'eslint-plugin-boundaries'

// ---------------------------------------------------------------------------
// eslint-plugin-boundaries — Phase 3.6 package dependency enforcement
//
// Element definitions map directory globs to logical "element types". Each
// type's `allow` list states which other types it may import from.
//
// Transitional note: orchestrator (legacy) is still present as an element so
// that existing imports are *visible* to the rule. Once Phase 3.7 removes it,
// delete the 'orchestrator' element and any 'orchestrator' entries in allow[].
// ---------------------------------------------------------------------------

const BOUNDARIES_SETTINGS = {
  'boundaries/elements': [
    // Stateless API lambda — served by API Gateway
    // Patterns use **/prefix/** so they match regardless of CWD-relative resolution.
    {
      type: 'api-lambda',
      pattern: '**/packages/api-lambda/src/**',
    },
    // Future install lambda — same restrictions as api-lambda
    {
      type: 'install-lambda',
      pattern: '**/packages/install-lambda/src/**',
    },
    // Long-running ECS Fargate daemon
    {
      type: 'orchestrator-daemon',
      pattern: '**/packages/orchestrator-daemon/src/**',
    },
    // Event-worker Lambdas (SNS consumers)
    {
      type: 'event-workers',
      pattern: '**/packages/event-workers/**',
    },
    // Legacy orchestrator monolith — transitional, to be deleted in Phase 3.7
    {
      type: 'orchestrator',
      pattern: '**/packages/orchestrator/src/**',
    },
    // Leaf packages — may NOT import from downstream packages
    { type: 'domain', pattern: '**/packages/domain/src/**' },
    { type: 'db', pattern: '**/packages/db/src/**' },
    { type: 'auth', pattern: '**/packages/auth/src/**' },
    { type: 'types', pattern: '**/packages/types/src/**' },
  ],
  'boundaries/ignore': [
    '**/*.test.{ts,tsx}',
    '**/test/**',
    '**/__fixtures__/**',
    '**/node_modules/**',
    '**/dist/**',
  ],
}

// Which element types each element type is allowed to import FROM.
// Rule config using boundaries/dependencies (v6 canonical name).
// The `from` and `allow` fields use the string-based element-type syntax
// which remains valid in v6 alongside the new object-based selectors.
const DEPENDENCIES_RULE = [
  'error',
  {
    // Default: forbid cross-boundary imports unless explicitly allowed.
    default: 'disallow',
    rules: [
      // api-lambda: may use types, auth, db, domain, orchestrator (transitional)
      // MUST NOT import orchestrator-daemon, event-workers, or install-lambda
      {
        from: 'api-lambda',
        allow: ['types', 'auth', 'db', 'domain', 'orchestrator'],
      },
      // install-lambda: same as api-lambda
      {
        from: 'install-lambda',
        allow: ['types', 'auth', 'db', 'domain', 'orchestrator'],
      },
      // orchestrator-daemon: may use types, auth, db, domain, orchestrator (transitional)
      // MUST NOT import api-lambda or install-lambda
      {
        from: 'orchestrator-daemon',
        allow: ['types', 'auth', 'db', 'domain', 'orchestrator'],
      },
      // event-workers: only leaf packages (no orchestrator transitional allowance)
      {
        from: 'event-workers',
        allow: ['types', 'auth', 'db', 'domain'],
      },
      // Legacy orchestrator: may import types only (guards against circular deps)
      {
        from: 'orchestrator',
        allow: ['types'],
      },
      // Leaf packages: pure — no downstream imports
      { from: 'domain', allow: ['types', 'db'] },
      { from: 'db', allow: ['types'] },
      { from: 'auth', allow: ['types'] },
      { from: 'types', allow: [] },
    ],
  },
]

export default [
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        WebSocket: 'readonly',
        fetch: 'readonly',
        crypto: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        global: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        // DOM types used in React component type annotations
        HTMLButtonElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLDivElement: 'readonly',
        HTMLElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        HTMLSelectElement: 'readonly',
        KeyboardEvent: 'readonly',
        MessageEvent: 'readonly',
        Event: 'readonly',
        MouseEvent: 'readonly',
        FocusEvent: 'readonly',
        Element: 'readonly',
        Node: 'readonly',
      },
    },
    plugins: { '@typescript-eslint': tsPlugin, react: reactPlugin, 'react-hooks': reactHooks },
    settings: { react: { version: 'detect' } },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...reactPlugin.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-var': 'error',
      'prefer-const': 'error',
      'eqeqeq': ['error', 'always'],
      'no-throw-literal': 'error',
      'no-duplicate-imports': 'error',
    },
  },
  {
    files: ['**/*.test.{ts,tsx}', '**/test/**/*.{ts,tsx}', '**/__fixtures__/**'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // The UI bundle runs in the browser. Importing server-only tRPC entry points
    // (initTRPC, server-side procedure builders) throws at runtime even before
    // any code calls them. Restrict to type-only imports.
    files: ['packages/ui/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@trpc/server',
              importNames: ['initTRPC'],
              message:
                'initTRPC is server-only and breaks the browser bundle. Use type-only imports (`import type { AnyTRPCRouter } from "@trpc/server"`).',
            },
          ],
        },
      ],
    },
  },
  // ---------------------------------------------------------------------------
  // Boundary element-type rules — applied to all TS files across the monorepo.
  // Settings are declared here; the rule config references them.
  // ---------------------------------------------------------------------------
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { boundaries },
    settings: BOUNDARIES_SETTINGS,
    rules: {
      'boundaries/dependencies': DEPENDENCIES_RULE,
    },
  },
  // ---------------------------------------------------------------------------
  // api-lambda — additional forbidden node built-ins that can crash Lambda init
  // ---------------------------------------------------------------------------
  {
    files: ['packages/api-lambda/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['child_process', 'node:child_process'],
              message: 'api-lambda must not use child_process — Lambda init will crash.',
            },
            {
              group: ['node:fs', 'node:fs/promises'],
              message:
                'api-lambda must not import node:fs directly — use the db package or a Lambda-safe alternative.',
            },
          ],
          paths: [
            {
              name: 'keytar',
              message: 'keytar is desktop-only and breaks Lambda.',
            },
            {
              name: 'pino-pretty',
              message:
                'pino-pretty is dev-only. It is already externalized from the esbuild bundle; do not import it directly.',
            },
          ],
        },
      ],
    },
  },
  {
    ignores: [
      'node_modules/**',
      '**/node_modules/**',
      'dist/**',
      '**/dist/**',
      'build/**',
      '**/build/**',
      '**/*.generated.*',
      'coverage/**',
      '.vitest-cache/**',
      'packages/orchestrator/src/db/migrations/**',
      '**/*.d.ts',
      'infra/cdk.out/**',
      'packages/api-lambda/dist/**',
    ],
  },
  prettier,
]

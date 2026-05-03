/**
 * onboarding/github-provisioner.ts — creates a GitHub repo with a CI workflow,
 * initial files (README, .gitignore, LICENSE), labels, and a webhook
 * pointing at this Orbital install.
 *
 * Round 9 — Onboarding UX Overhaul
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
 *
 * On success:
 *   1. Repo created (private by default, public toggle visible).
 *   2. README.md, .gitignore, LICENSE committed via Contents API (forms the
 *      first commit on `main`).
 *   3. CI workflow `.github/workflows/ci.yml` committed to match the detected
 *      stack (Node.js + TypeScript by default, Go for Go projects, etc.).
 *   4. Standard label set created (enhancement / bug / agent-work / human-review
 *      / risk:low / risk:medium / risk:high / risk:critical).
 *   5. Webhook registered against `${webhookUrl}` (the operator's Orbital
 *      install) for `push`, `pull_request`, `check_run`, `workflow_run`.
 *   6. Emits GitRepoProvisioned event.
 *
 * Real GitHub API calls only — no mocks in src/.
 */

import { uuidv7 } from 'uuidv7'
import type { Actor } from '@orbital/types'
import type { DB } from '../db/client.js'
import type { EventStore } from '../events/store.js'
import type { GithubClient } from '../github/client.js'
import type { GithubRepo } from '../github/types.js'
import type { GitRepoProvisionedPayload } from '../events/types.js'
import { logger } from '../config/logger.js'

const SYSTEM_ACTOR: Actor = { type: 'system', component: 'orchestrator' }

// ---------------------------------------------------------------------------
// Spec interface
// ---------------------------------------------------------------------------

export type DetectedStack = 'nodejs' | 'go' | 'python' | 'generic'

export interface ProvisionGithubRepoInput {
  sessionId: string
  projectId: string
  /** Repo name. Per GitHub, must be 1-100 chars, alphanumeric + - + _ + .. */
  name: string
  /** If org is set, repo is created under that org; else under authenticated user. */
  org?: string | null
  description?: string
  isPrivate?: boolean
  /** Stack the CI workflow + .gitignore should match. */
  stack?: DetectedStack
  /** License id to bundle. 'mit' is the default. */
  license?: 'mit' | 'apache-2.0' | 'unlicense' | null
  /** Webhook target. Falls back to skipping the webhook step. */
  webhookUrl?: string | null
  /** Webhook signing secret (HMAC). */
  webhookSecret?: string | null
}

export interface ProvisionGithubRepoResult {
  owner: string
  repo: string
  htmlUrl: string
  defaultBranch: string
  isPrivate: boolean
  ciWorkflowCommitted: boolean
  webhookConfigured: boolean
  labelsCreated: string[]
}

export interface GithubProvisioner {
  provision(input: ProvisionGithubRepoInput): Promise<ProvisionGithubRepoResult>
}

// ---------------------------------------------------------------------------
// Standard labels
// ---------------------------------------------------------------------------

const STANDARD_LABELS: Array<{ name: string; color: string; description: string }> = [
  { name: 'enhancement', color: 'a2eeef', description: 'New feature or improvement' },
  { name: 'bug', color: 'd73a4a', description: 'Something is broken' },
  { name: 'agent-work', color: '7057ff', description: 'Worked on by an Orbital agent' },
  { name: 'human-review', color: 'f9d71c', description: 'Needs a human to look at it' },
  { name: 'risk:low', color: '0e8a16', description: 'Risk Tier: Low' },
  { name: 'risk:medium', color: 'fbca04', description: 'Risk Tier: Medium' },
  { name: 'risk:high', color: 'd93f0b', description: 'Risk Tier: High' },
  { name: 'risk:critical', color: 'b60205', description: 'Risk Tier: Critical' },
]

// ---------------------------------------------------------------------------
// File templates
// ---------------------------------------------------------------------------

function readmeTemplate(name: string, description: string): string {
  return `# ${name}\n\n${description || 'Created by Orbital.'}\n\nThis repository is wired into an Orbital install.\nTickets live in Monday; PRs live here; agents handle the SDLC.\n\n## Getting started\n\n\`\`\`bash\n# Install\nnpm install\n\n# Develop\nnpm run dev\n\`\`\`\n`
}

function gitignoreFor(stack: DetectedStack): string {
  switch (stack) {
    case 'nodejs':
      return `node_modules/\ndist/\nbuild/\n.next/\ncoverage/\n.env\n.env.*\n!.env.example\n*.log\n.DS_Store\n.vite/\n.cache/\n`
    case 'go':
      return `*.exe\n*.test\n*.out\nvendor/\nbin/\ndist/\n.idea/\n.vscode/\n*.log\n`
    case 'python':
      return `__pycache__/\n*.pyc\n*.pyo\n*.egg-info/\n.venv/\nvenv/\ndist/\nbuild/\n.env\n.coverage\n`
    case 'generic':
    default:
      return `.DS_Store\n.env\nnode_modules/\ndist/\nbuild/\n*.log\n`
  }
}

function licenseTemplate(license: 'mit' | 'apache-2.0' | 'unlicense', owner: string): string {
  const year = new Date().getUTCFullYear()
  if (license === 'mit') {
    return `MIT License\n\nCopyright (c) ${year} ${owner}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n`
  }
  if (license === 'apache-2.0') {
    return `Apache License\nVersion 2.0, January 2004\n\nCopyright ${year} ${owner}\n\nLicensed under the Apache License, Version 2.0 (the "License");\nyou may not use this file except in compliance with the License.\nYou may obtain a copy of the License at\n\n    http://www.apache.org/licenses/LICENSE-2.0\n\nUnless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.\n`
  }
  return `This is free and unencumbered software released into the public domain.\n`
}

function ciWorkflowFor(stack: DetectedStack): string {
  if (stack === 'go') {
    return `name: CI\non:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-go@v5\n        with:\n          go-version: '1.23'\n      - run: go vet ./...\n      - run: go test ./...\n      - run: go build ./...\n`
  }
  if (stack === 'python') {
    return `name: CI\non:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-python@v5\n        with:\n          python-version: '3.12'\n      - run: pip install -r requirements.txt\n      - run: python -m pytest\n`
  }
  // Default: Node.js + TypeScript matrix.
  return `name: CI\non:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n  quality:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: lts/*\n          cache: npm\n      - run: npm ci\n      - run: npx eslint .\n      - run: npx prettier --check .\n      - run: npm test -- --run\n      - run: npm run build\n`
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * The high-level GithubClient used elsewhere does not expose every method the
 * provisioner needs (createFile, createLabel, createWebhook). Instead of
 * widening that interface (and impacting all callers), we accept a
 * `LowLevelGithubRequest` adapter that issues raw HTTP. The provisioner
 * remains DI-friendly and testable, and the GithubClient core stays minimal.
 */
export interface LowLevelGithubRequest {
  /**
   * Issue a request via the GithubClient's authenticated pipeline.
   * Returns the parsed JSON response (or null for 204 / 404 with allow404).
   */
  request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    options?: { allow404?: boolean },
  ): Promise<T | null>
}

export class DefaultGithubProvisioner implements GithubProvisioner {
  constructor(
    private readonly _db: DB,
    private readonly eventStore: EventStore,
    private readonly client: GithubClient,
    private readonly raw: LowLevelGithubRequest,
  ) {}

  async provision(input: ProvisionGithubRepoInput): Promise<ProvisionGithubRepoResult> {
    const stack = input.stack ?? 'nodejs'
    const license = input.license ?? 'mit'
    const isPrivate = input.isPrivate ?? true

    // Step 1: create the repo. Use auto-init so the API creates the initial
    // empty commit on `main`; we then commit additional files via Contents API.
    const repo: GithubRepo = await this.createRepoWithAutoInit({
      org: input.org ?? null,
      name: input.name,
      isPrivate,
      description: input.description ?? `Created by Orbital`,
    })

    const owner = repo.owner.login
    const defaultBranch = repo.defaultBranch || 'main'

    // Step 2: commit README / .gitignore / LICENSE / CI workflow via Contents API.
    let ciWorkflowCommitted = false
    try {
      await this.putFile(owner, input.name, 'README.md', readmeTemplate(input.name, input.description ?? ''), 'chore: initial README')
      await this.putFile(owner, input.name, '.gitignore', gitignoreFor(stack), 'chore: initial .gitignore')
      if (license !== null) {
        await this.putFile(
          owner,
          input.name,
          'LICENSE',
          licenseTemplate(license, owner),
          `chore: add ${license} license`,
        )
      }
      await this.putFile(
        owner,
        input.name,
        '.github/workflows/ci.yml',
        ciWorkflowFor(stack),
        'chore: add CI workflow',
      )
      ciWorkflowCommitted = true
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), owner, repo: input.name },
        'github-provisioner: failed to commit one or more initial files',
      )
    }

    // Step 3: create labels.
    const labelsCreated: string[] = []
    for (const label of STANDARD_LABELS) {
      try {
        await this.raw.request<unknown>(
          'POST',
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(input.name)}/labels`,
          label,
        )
        labelsCreated.push(label.name)
      } catch (err) {
        // 422 = label already exists. Best effort.
        logger.debug(
          { err: err instanceof Error ? err.message : String(err), label: label.name },
          'github-provisioner: label create skipped',
        )
      }
    }

    // Step 4: webhook (optional).
    let webhookConfigured = false
    if (input.webhookUrl) {
      try {
        const config: Record<string, unknown> = {
          url: input.webhookUrl,
          content_type: 'json',
          insecure_ssl: '0',
        }
        if (input.webhookSecret) config['secret'] = input.webhookSecret
        await this.raw.request<unknown>(
          'POST',
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(input.name)}/hooks`,
          {
            name: 'web',
            active: true,
            events: ['push', 'pull_request', 'check_run', 'workflow_run'],
            config,
          },
        )
        webhookConfigured = true
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), owner, repo: input.name },
          'github-provisioner: webhook registration failed',
        )
      }
    }

    // Step 5: emit event.
    const now = new Date()
    const payload: GitRepoProvisionedPayload = {
      session_id: input.sessionId,
      project_id: input.projectId,
      owner,
      repo: input.name,
      html_url: repo.htmlUrl,
      default_branch: defaultBranch,
      is_private: isPrivate,
      ci_workflow_committed: ciWorkflowCommitted,
      webhook_configured: webhookConfigured,
      labels_created: labelsCreated,
      provisioned_at: now.toISOString(),
    }
    await this.eventStore.append({
      aggregate_id: input.projectId,
      aggregate_type: 'install',
      event_type: 'GitRepoProvisioned',
      payload: payload as unknown as Record<string, unknown>,
      actor: SYSTEM_ACTOR,
      trace_id: uuidv7(),
      occurred_at: now.toISOString(),
      schema_version: 1,
    })

    return {
      owner,
      repo: input.name,
      htmlUrl: repo.htmlUrl,
      defaultBranch,
      isPrivate,
      ciWorkflowCommitted,
      webhookConfigured,
      labelsCreated,
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * The high-level GithubClient.createRepo does not pass `auto_init`; we need
   * the initial commit to exist before the Contents API can PUT files. So we
   * issue the create directly via the low-level request adapter and re-shape
   * the response.
   */
  private async createRepoWithAutoInit(opts: {
    org: string | null
    name: string
    isPrivate: boolean
    description: string
  }): Promise<GithubRepo> {
    const path = opts.org
      ? `/orgs/${encodeURIComponent(opts.org)}/repos`
      : `/user/repos`
    const body = {
      name: opts.name,
      private: opts.isPrivate,
      description: opts.description,
      auto_init: true,
      license_template: 'mit',
    }
    const data = await this.raw.request<{
      id: number
      name: string
      full_name: string
      owner: { login: string }
      private: boolean
      default_branch: string
      html_url: string
    }>('POST', path, body)
    if (!data) {
      throw new Error('GitHub createRepo returned no body')
    }
    return {
      id: data.id,
      name: data.name,
      fullName: data.full_name,
      owner: { login: data.owner.login },
      private: data.private,
      defaultBranch: data.default_branch,
      htmlUrl: data.html_url,
    }
  }

  /** PUT /repos/{owner}/{repo}/contents/{path} — create or update a file. */
  private async putFile(
    owner: string,
    repo: string,
    filePath: string,
    content: string,
    message: string,
  ): Promise<void> {
    // Look up existing file (for update sha) — 404 = new file path.
    const existing = await this.raw.request<{ sha: string }>(
      'GET',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURI(filePath)}`,
      undefined,
      { allow404: true },
    )
    const body: Record<string, unknown> = {
      message,
      content: Buffer.from(content, 'utf-8').toString('base64'),
    }
    if (existing && existing.sha) body['sha'] = existing.sha
    await this.raw.request<unknown>(
      'PUT',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURI(filePath)}`,
      body,
    )
  }

  /**
   * Convenience accessor for the underlying client so the system-teacher can
   * commit an additional CLAUDE.md after the repo exists. Public so the tRPC
   * router can pass the same provisioner instance into both the GitHub-create
   * and the system-teach steps.
   */
  async commitFile(
    owner: string,
    repo: string,
    filePath: string,
    content: string,
    message: string,
  ): Promise<string | null> {
    try {
      await this.putFile(owner, repo, filePath, content, message)
      // Re-read to get the new sha.
      const after = await this.raw.request<{ sha: string }>(
        'GET',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURI(filePath)}`,
        undefined,
        { allow404: true },
      )
      return after?.sha ?? null
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), owner, repo, filePath },
        'github-provisioner.commitFile failed',
      )
      return null
    }
  }

  /** Expose the underlying client for callers that need it (e.g. webhooks). */
  get githubClient(): GithubClient {
    return this.client
  }
}

export function createGithubProvisioner(
  db: DB,
  eventStore: EventStore,
  client: GithubClient,
  raw: LowLevelGithubRequest,
): DefaultGithubProvisioner {
  return new DefaultGithubProvisioner(db, eventStore, client, raw)
}

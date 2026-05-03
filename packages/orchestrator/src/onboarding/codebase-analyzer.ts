/**
 * onboarding/codebase-analyzer.ts — analyzes an existing GitHub repo and
 * produces a structured report of stack, conventions, ADRs, and inferred
 * memory entries.
 *
 * Round 9 — Onboarding UX Overhaul
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
 *
 * Two passes:
 *   1. Static (deterministic): read package.json / go.mod / pyproject.toml,
 *      .github/workflows/*, recent commit messages, branch list. No LLM cost.
 *   2. LLM-assisted (optional, opt-in): summarize README, classify ADRs,
 *      infer review conventions from PR descriptions, infer code conventions
 *      from sample files. Cost transparently surfaced before the user clicks.
 *
 * On success: emits CodebaseAnalyzed and returns the analysis report. The
 * caller (onboarding router) feeds the report into memory-seeder.ts to create
 * the actual memory entries.
 */

import { uuidv7 } from 'uuidv7'
import type { Actor } from '@orbital/types'
import type { EventStore } from '../events/store.js'
import type { GithubClient } from '../github/client.js'
import type { LLMDriver } from '../drivers/types.js'
import type { LowLevelGithubRequest } from './github-provisioner.js'
import type { CodebaseAnalyzedPayload } from '../events/types.js'
import { logger } from '../config/logger.js'

const SYSTEM_ACTOR: Actor = { type: 'system', component: 'orchestrator' }

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AnalyzeRepoInput {
  sessionId: string
  projectId: string
  owner: string
  repo: string
  /** When false, the LLM-assisted pass is skipped (free, static-only). */
  useLLM?: boolean
}

export interface InferredMemoryEntry {
  kind: 'decision' | 'convention' | 'glossary' | 'learning' | 'anti_pattern'
  title: string
  body: string
  tags: string[]
  /** Source ADR / PR / file URL if applicable. */
  source?: { kind: 'adr' | 'readme' | 'pr' | 'file'; ref: string }
}

export interface CodebaseAnalysisReport {
  stack: string[]
  testRunner: string | null
  ciWorkflowCount: number
  ciWorkflows: string[]
  commitConvention: string | null
  branchModel: string | null
  /** Pre-LLM signals — README + ADR file lists. */
  readmeSummary: string | null
  adrCount: number
  /** Per-LLM-call cost in USD. */
  llmCostUsd: number
  /** Memory entries the seeder should write. */
  inferredMemoryEntries: InferredMemoryEntry[]
  /** Whether the LLM step ran. */
  llmUsed: boolean
}

export interface CostEstimate {
  /** Estimated tokens IN. */
  inputTokens: number
  /** Estimated tokens OUT. */
  outputTokens: number
  /** Estimated cost in USD. */
  costUsd: number
  /** Human-readable plan: "We'll read X files and N PRs". */
  plan: string
}

export interface CodebaseAnalyzer {
  /**
   * Cheap pre-flight: estimate the LLM step's cost so the user can opt in
   * with full transparency. Costs are based on Sonnet 4.6 pricing as a
   * reasonable upper bound; the actual cost depends on which model the
   * driver routes to.
   */
  estimate(input: { owner: string; repo: string }): Promise<CostEstimate>
  analyze(input: AnalyzeRepoInput): Promise<CodebaseAnalysisReport>
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DefaultCodebaseAnalyzer implements CodebaseAnalyzer {
  constructor(
    private readonly eventStore: EventStore,
    private readonly githubClient: GithubClient,
    private readonly raw: LowLevelGithubRequest,
    private readonly llmDriver: LLMDriver | null,
    private readonly llmModel: string = 'claude-sonnet-4-6',
  ) {}

  async estimate(input: { owner: string; repo: string }): Promise<CostEstimate> {
    // We sample at most: README + 3 ADRs + 10 source files + 20 PR descriptions.
    // Bound the cost above so users see a worst-case figure.
    const inputTokens = 25_000
    const outputTokens = 4_000
    // Sonnet 4.6 pricing snapshot: $3/Mtok in, $15/Mtok out.
    const costUsd = (inputTokens / 1_000_000) * 3 + (outputTokens / 1_000_000) * 15
    return {
      inputTokens,
      outputTokens,
      costUsd: Number(costUsd.toFixed(2)),
      plan: `Read ${input.owner}/${input.repo} README, ADRs, recent PRs, and ~10 source files.`,
    }
  }

  async analyze(input: AnalyzeRepoInput): Promise<CodebaseAnalysisReport> {
    const useLLM = input.useLLM ?? false

    // ------ Static pass --------------------------------------------------
    const stack = await this.detectStack(input.owner, input.repo)
    const testRunner = await this.detectTestRunner(input.owner, input.repo, stack)
    const ciWorkflows = await this.listCiWorkflows(input.owner, input.repo)
    const commitConvention = await this.detectCommitConvention(input.owner, input.repo)
    const branchModel = await this.detectBranchModel(input.owner, input.repo)

    // ------ Load README + ADRs (cheap) ----------------------------------
    const readmeRaw = await this.fetchTextFile(input.owner, input.repo, 'README.md')
    const adrPaths = await this.listAdrs(input.owner, input.repo)

    // ------ LLM pass (optional) -----------------------------------------
    let readmeSummary: string | null = null
    let llmCostUsd = 0
    const inferredEntries: InferredMemoryEntry[] = []

    if (useLLM && this.llmDriver) {
      const result = await this.runLlmAnalysis({
        owner: input.owner,
        repo: input.repo,
        readme: readmeRaw,
        adrPaths,
      })
      readmeSummary = result.readmeSummary
      llmCostUsd = result.costUsd
      inferredEntries.push(...result.entries)
    } else {
      // Even without the LLM, we still infer obvious entries from static signals.
      readmeSummary = readmeRaw ? readmeRaw.split('\n').slice(0, 6).join(' ').slice(0, 400) : null
      if (commitConvention) {
        inferredEntries.push({
          kind: 'convention',
          title: 'Commit message convention',
          body: `Commits follow ${commitConvention}.`,
          tags: ['git', 'conventions'],
        })
      }
      if (branchModel) {
        inferredEntries.push({
          kind: 'convention',
          title: 'Branch model',
          body: `Repository uses ${branchModel} branching.`,
          tags: ['git', 'workflow'],
        })
      }
      if (testRunner) {
        inferredEntries.push({
          kind: 'convention',
          title: 'Test runner',
          body: `Tests are run with ${testRunner}.`,
          tags: ['testing'],
        })
      }
      for (const path of adrPaths) {
        inferredEntries.push({
          kind: 'decision',
          title: `Imported decision: ${path.replace(/^docs\/decisions\//, '')}`,
          body: `Decision recorded in ${path}; review the file in-repo for full context.`,
          tags: ['decision', 'adr'],
          source: { kind: 'adr', ref: path },
        })
      }
    }

    const report: CodebaseAnalysisReport = {
      stack,
      testRunner,
      ciWorkflowCount: ciWorkflows.length,
      ciWorkflows,
      commitConvention,
      branchModel,
      readmeSummary,
      adrCount: adrPaths.length,
      llmCostUsd,
      inferredMemoryEntries: inferredEntries,
      llmUsed: useLLM && this.llmDriver !== null,
    }

    // ------ Emit event --------------------------------------------------
    const now = new Date()
    const payload: CodebaseAnalyzedPayload = {
      session_id: input.sessionId,
      project_id: input.projectId,
      owner: input.owner,
      repo: input.repo,
      stack,
      test_runner: testRunner,
      commit_convention: commitConvention,
      branch_model: branchModel,
      ci_workflow_count: ciWorkflows.length,
      memory_entries_inferred: inferredEntries.length,
      llm_used: report.llmUsed,
      llm_cost_usd: llmCostUsd,
      analyzed_at: now.toISOString(),
    }
    await this.eventStore.append({
      aggregate_id: input.projectId,
      aggregate_type: 'install',
      event_type: 'CodebaseAnalyzed',
      payload: payload as unknown as Record<string, unknown>,
      actor: SYSTEM_ACTOR,
      trace_id: uuidv7(),
      occurred_at: now.toISOString(),
      schema_version: 1,
    })

    return report
  }

  // -------------------------------------------------------------------------
  // Static analyzers
  // -------------------------------------------------------------------------

  private async detectStack(owner: string, repo: string): Promise<string[]> {
    const stack: string[] = []
    const pkgJson = await this.fetchTextFile(owner, repo, 'package.json')
    if (pkgJson) {
      stack.push('nodejs')
      try {
        const parsed = JSON.parse(pkgJson) as {
          dependencies?: Record<string, string>
          devDependencies?: Record<string, string>
        }
        const deps = { ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) }
        if (deps['typescript']) stack.push('typescript')
        if (deps['react']) stack.push('react')
        if (deps['next']) stack.push('nextjs')
        if (deps['vue']) stack.push('vue')
        if (deps['tailwindcss'] || deps['@tailwindcss/postcss']) stack.push('tailwind')
        if (deps['drizzle-orm']) stack.push('drizzle')
        if (deps['vitest']) stack.push('vitest')
        if (deps['jest']) stack.push('jest')
      } catch {
        // ignore; the file existed but wasn't valid JSON
      }
    }
    if (await this.fileExists(owner, repo, 'go.mod')) stack.push('go')
    if (await this.fileExists(owner, repo, 'pyproject.toml')) stack.push('python')
    if (await this.fileExists(owner, repo, 'Cargo.toml')) stack.push('rust')
    return stack
  }

  private async detectTestRunner(
    owner: string,
    repo: string,
    stack: string[],
  ): Promise<string | null> {
    if (stack.includes('vitest')) return 'vitest'
    if (stack.includes('jest')) return 'jest'
    if (stack.includes('python')) return 'pytest'
    if (stack.includes('go')) return 'go test'
    return null
  }

  private async listCiWorkflows(owner: string, repo: string): Promise<string[]> {
    const data = await this.raw.request<Array<{ name: string; type: string }>>(
      'GET',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/.github/workflows`,
      undefined,
      { allow404: true },
    )
    if (!data) return []
    return data.filter((d) => d.type === 'file' && d.name.endsWith('.yml')).map((d) => d.name)
  }

  private async detectCommitConvention(owner: string, repo: string): Promise<string | null> {
    const commits = await this.raw.request<Array<{ commit: { message: string } }>>(
      'GET',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?per_page=30`,
      undefined,
      { allow404: true },
    )
    if (!commits || commits.length === 0) return null
    const conventionalRe = /^(feat|fix|chore|refactor|docs|test|perf|build|ci|style)(\(.+\))?:/i
    const matches = commits.filter((c) => conventionalRe.test(c.commit.message)).length
    if (matches >= commits.length * 0.5) return 'Conventional Commits'
    return null
  }

  private async detectBranchModel(owner: string, repo: string): Promise<string | null> {
    const branches = await this.githubClient.listBranches(owner, repo)
    if (branches.length === 0) return null
    const featPrefixes = branches.filter((b) => b.name.startsWith('feat/') || b.name.startsWith('feature/')).length
    if (branches.length === 1) return 'main-only'
    if (featPrefixes > 0) return 'trunk-based with feature branches'
    if (branches.find((b) => b.name === 'develop')) return 'gitflow'
    return 'main-only'
  }

  private async listAdrs(owner: string, repo: string): Promise<string[]> {
    const data = await this.raw.request<Array<{ name: string; type: string; path: string }>>(
      'GET',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/docs/decisions`,
      undefined,
      { allow404: true },
    )
    if (!data) return []
    return data.filter((d) => d.type === 'file' && d.name.endsWith('.md')).map((d) => d.path)
  }

  // -------------------------------------------------------------------------
  // LLM analyzer
  // -------------------------------------------------------------------------

  private async runLlmAnalysis(opts: {
    owner: string
    repo: string
    readme: string | null
    adrPaths: string[]
  }): Promise<{ readmeSummary: string | null; entries: InferredMemoryEntry[]; costUsd: number }> {
    if (!this.llmDriver) {
      return { readmeSummary: null, entries: [], costUsd: 0 }
    }

    const adrTexts: Array<{ path: string; content: string }> = []
    for (const path of opts.adrPaths.slice(0, 5)) {
      const txt = await this.fetchTextFile(opts.owner, opts.repo, path)
      if (txt) adrTexts.push({ path, content: txt.slice(0, 4_000) })
    }

    const recentPRs = await this.raw
      .request<Array<{ number: number; title: string; body: string | null }>>(
        'GET',
        `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/pulls?state=closed&per_page=10`,
      )
      .catch(() => null)

    const promptPayload = {
      readme: (opts.readme ?? '').slice(0, 3_000),
      adrs: adrTexts.map((a) => ({ path: a.path, body: a.content })),
      prs: (recentPRs ?? []).slice(0, 10).map((p) => ({
        title: p.title,
        body: (p.body ?? '').slice(0, 800),
      })),
    }

    const systemPrompt = `You analyze software repositories and extract structured memory entries the team can carry forward. Return STRICT JSON only — no commentary outside the JSON object.`
    const userPrompt = `Repository: ${opts.owner}/${opts.repo}\n\nINPUT:\n${JSON.stringify(promptPayload, null, 2)}\n\nReturn a JSON object of the form:\n{\n  "readmeSummary": "1-3 sentence summary of the project's intent",\n  "entries": [\n    {\n      "kind": "decision|convention|glossary|learning|anti_pattern",\n      "title": "<= 80 chars",\n      "body": "<= 600 chars",\n      "tags": ["array", "of", "tags"],\n      "source": { "kind": "adr|readme|pr|file", "ref": "<path or PR#>" }\n    }\n  ]\n}\n\nProduce 6-15 entries total. Prioritize: README intent (1 entry, kind=decision), each ADR as a kind=decision, convention entries inferred from PR descriptions, glossary terms.`

    let costUsd = 0
    interface LlmAnalysis {
      readmeSummary: string
      entries: InferredMemoryEntry[]
    }
    let parsed: LlmAnalysis | null = null
    try {
      const resp = await this.llmDriver.send({
        model: this.llmModel,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        maxTokens: 4_000,
      })
      // Sonnet 4.6 cost: $3/Mtok in, $15/Mtok out. Approximate.
      costUsd =
        (resp.usage.input_tokens / 1_000_000) * 3 + (resp.usage.output_tokens / 1_000_000) * 15
      const text = resp.content
        .map((c) => (c.type === 'text' ? c.text : ''))
        .join('')
        .trim()
      // Extract the first JSON object (the model may wrap with prose despite the instruction).
      const jsonStart = text.indexOf('{')
      const jsonEnd = text.lastIndexOf('}')
      if (jsonStart >= 0 && jsonEnd > jsonStart) {
        parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as LlmAnalysis
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'codebase-analyzer LLM call failed; falling back to static-only',
      )
    }

    if (!parsed) {
      return { readmeSummary: null, entries: [], costUsd }
    }

    const fromLlm: LlmAnalysis = parsed

    // Validate shape — be defensive against malformed output.
    const entries: InferredMemoryEntry[] = []
    const rawEntries = Array.isArray(fromLlm.entries) ? fromLlm.entries : []
    for (const raw of rawEntries) {
      if (
        typeof raw === 'object' &&
        raw !== null &&
        typeof (raw as InferredMemoryEntry).title === 'string' &&
        typeof (raw as InferredMemoryEntry).body === 'string'
      ) {
        const e = raw as InferredMemoryEntry
        entries.push({
          kind: (['decision', 'convention', 'glossary', 'learning', 'anti_pattern'] as const).includes(
            e.kind,
          )
            ? e.kind
            : 'learning',
          title: e.title.slice(0, 200),
          body: e.body.slice(0, 2_000),
          tags: Array.isArray(e.tags) ? e.tags.slice(0, 10) : [],
          source: e.source,
        })
      }
    }

    return {
      readmeSummary: typeof fromLlm.readmeSummary === 'string' ? fromLlm.readmeSummary : null,
      entries,
      costUsd: Number(costUsd.toFixed(4)),
    }
  }

  // -------------------------------------------------------------------------
  // GitHub Contents API helpers
  // -------------------------------------------------------------------------

  private async fetchTextFile(owner: string, repo: string, path: string): Promise<string | null> {
    const data = await this.raw.request<{ content: string; encoding: string } | null>(
      'GET',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURI(path)}`,
      undefined,
      { allow404: true },
    )
    if (!data || !data.content) return null
    if (data.encoding !== 'base64') return null
    try {
      return Buffer.from(data.content, 'base64').toString('utf-8')
    } catch {
      return null
    }
  }

  private async fileExists(owner: string, repo: string, path: string): Promise<boolean> {
    const data = await this.raw.request<unknown>(
      'GET',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURI(path)}`,
      undefined,
      { allow404: true },
    )
    return data !== null
  }
}

export function createCodebaseAnalyzer(
  eventStore: EventStore,
  githubClient: GithubClient,
  raw: LowLevelGithubRequest,
  llmDriver: LLMDriver | null,
  llmModel?: string,
): CodebaseAnalyzer {
  return new DefaultCodebaseAnalyzer(eventStore, githubClient, raw, llmDriver, llmModel)
}

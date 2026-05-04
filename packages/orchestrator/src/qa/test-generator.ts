/**
 * qa/test-generator.ts — QA persona: generate failing tests from story ACs.
 *
 * [Engineer-Sr · Sonnet · run-ac-test-generation]
 *
 * Called when a story transitions to 'ready'. The QA persona (claude-sonnet-4-6):
 *   1. Reads the story + all acceptance criteria.
 *   2. Sniffs the project repo for language + framework.
 *   3. Generates real failing tests (one file per story, named by story slug).
 *   4. Commits tests to branch 'orbital/tests-<storyId>'.
 *   5. Writes a story_test_artifacts row with status=pending.
 *
 * The tests MUST fail against current code — they are pre-conditions, not
 * post-conditions. The engineer-sr agent's prompt is updated to reference
 * these tests and is responsible for making them pass.
 *
 * Multi-tenant: every DB write includes tenant_id. Real Claude API call.
 * No mocks in application code (only in test fixtures).
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

import Anthropic from '@anthropic-ai/sdk'
import { and, eq } from 'drizzle-orm'

import { db as defaultDb } from '../db/client.js'
import { stories, storyAcceptanceCriteria } from '../db/schema/backlog.js'
import { projects } from '../db/schema/projects.js'
import { storyTestArtifacts } from '../db/schema/story-test-artifacts.js'
import { loadEnv } from '../config/env.js'
import { logger } from '../config/logger.js'
import { detectFramework, type DetectedFramework } from './framework-detector.js'

const execFileP = promisify(execFile)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GenerateTestsInput {
  tenantId: string
  projectId: string
  storyId: string
}

export interface GenerateTestsResult {
  artifactId: string
  branch: string
  testPath: string
  language: string
  framework: string
  /** true = tests were committed; false = no ACs or generation skipped */
  committed: boolean
  /** Human-readable summary of what was generated. */
  summary: string
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  return `You are Orbital QA Engineer. Your job is to write failing tests that will pass ONLY when the story's acceptance criteria are correctly implemented.

Rules:
1. Write tests that FAIL against the CURRENT (unimplemented) code.
2. Tests must be real, runnable code — no placeholders, no TODOs, no pseudocode.
3. Each acceptance criterion gets at least one test case.
4. Test behaviour through the public API, not implementation details.
5. Include edge cases (empty input, boundary values, error paths) for each AC.
6. Do NOT modify any source files. Only generate test files.
7. If the codebase does not yet have the module under test, import it from the path it WILL exist at (the engineer will create it). The import itself will cause the test to fail (module not found) which is the desired red state.

Output format: respond with ONLY a JSON object, no other text:
{
  "test_file": "<the complete test file content as a string>",
  "test_path": "<relative path where the file should be written>",
  "rationale": "<one paragraph explaining what ACs are covered and why these tests will fail currently>"
}`
}

function buildUserPrompt(
  storyTitle: string,
  storyDescription: string,
  acs: Array<{ ordinal: number; text: string; verifierHint?: string | null }>,
  detected: DetectedFramework,
  existingFiles: string[],
): string {
  const acText = acs
    .map((ac) => `AC${ac.ordinal}: ${ac.text}${ac.verifierHint ? ` (hint: ${ac.verifierHint})` : ''}`)
    .join('\n')

  const relevantFiles = existingFiles
    .filter(
      (f) =>
        f.endsWith('.ts') ||
        f.endsWith('.js') ||
        f.endsWith('.py') ||
        f.endsWith('.go') ||
        f === 'package.json' ||
        f === 'go.mod' ||
        f === 'pyproject.toml',
    )
    .slice(0, 50)
    .join('\n')

  return `Story: ${storyTitle}

Description: ${storyDescription}

Acceptance Criteria:
${acText}

Test framework: ${detected.framework} (${detected.language})
Test directory convention: ${detected.testDir}/
Test file suffix: ${detected.testFileSuffix}
Existing files in repo (for context on module paths):
${relevantFiles || '(empty repo — new project)'}

Write failing tests that will pass when ALL acceptance criteria above are implemented.`
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

async function cloneRepo(cloneUrl: string, targetDir: string): Promise<void> {
  await execFileP('git', ['clone', '--depth=1', '-q', cloneUrl, targetDir])
}

async function checkoutBranch(repoDir: string, branch: string, base: string): Promise<void> {
  // Try to check out existing branch first; create if it doesn't exist.
  try {
    await execFileP('git', ['checkout', '-b', branch, `origin/${base}`], { cwd: repoDir })
  } catch {
    // Base branch may not exist for brand-new repos; fall back to empty orphan.
    await execFileP('git', ['checkout', '--orphan', branch], { cwd: repoDir })
    await execFileP('git', ['rm', '-rf', '.'], { cwd: repoDir }).catch(() => {})
  }
}

async function commitAndPush(
  repoDir: string,
  filePath: string,
  commitMessage: string,
  branch: string,
): Promise<void> {
  await execFileP('git', ['add', filePath], { cwd: repoDir })
  await execFileP(
    'git',
    [
      '-c',
      'user.email=orbital-qa@orbital.local',
      '-c',
      'user.name=Orbital QA',
      'commit',
      '-m',
      commitMessage,
    ],
    { cwd: repoDir },
  )
  await execFileP('git', ['push', '-u', 'origin', branch], { cwd: repoDir })
}

// ---------------------------------------------------------------------------
// Core generator
// ---------------------------------------------------------------------------

/**
 * Generate failing tests for a story's ACs and commit them to a branch.
 *
 * @param input  Tenant-scoped story + project IDs.
 * @param db     Drizzle DB client (injectable for tests).
 */
export async function generateTests(
  input: GenerateTestsInput,
  db = defaultDb,
): Promise<GenerateTestsResult> {
  const { tenantId, projectId, storyId } = input
  const env = loadEnv()

  // -------------------------------------------------------------------------
  // 1. Load story + ACs
  // -------------------------------------------------------------------------
  const storyRows = await db
    .select()
    .from(stories)
    .where(and(eq(stories.storyId, storyId), eq(stories.tenantId, tenantId)))
    .limit(1)
  const story = storyRows[0]
  if (!story) {
    throw new Error(`generateTests: story ${storyId} not found for tenant ${tenantId}`)
  }

  const acRows = await db
    .select()
    .from(storyAcceptanceCriteria)
    .where(
      and(
        eq(storyAcceptanceCriteria.storyId, storyId),
        eq(storyAcceptanceCriteria.tenantId, tenantId),
      ),
    )
    .orderBy(storyAcceptanceCriteria.ordinal)

  if (acRows.length === 0) {
    logger.info({ tenantId, storyId }, 'qa.generateTests: no ACs — skipping test generation')
    return {
      artifactId: '',
      branch: '',
      testPath: '',
      language: 'typescript',
      framework: 'vitest',
      committed: false,
      summary: 'No acceptance criteria — skipping test generation.',
    }
  }

  // -------------------------------------------------------------------------
  // 2. Load project + repo config
  // -------------------------------------------------------------------------
  const projectRows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.projectId, projectId), eq(projects.tenantId, tenantId)))
    .limit(1)
  const project = projectRows[0]
  if (!project) {
    throw new Error(`generateTests: project ${projectId} not found for tenant ${tenantId}`)
  }

  const cloneUrl = project.repoCloneUrl ?? null
  const defaultBranch = project.githubDefaultBranch ?? 'main'
  const branch = `orbital/tests-${storyId}`

  // -------------------------------------------------------------------------
  // 3. Clone repo and detect framework
  // -------------------------------------------------------------------------
  const workDir = path.join(os.tmpdir(), `orbital-qa-${randomUUID()}`)
  await fs.mkdir(workDir, { recursive: true })

  let detected: DetectedFramework = {
    language: 'typescript',
    framework: 'vitest',
    testDir: 'src/__tests__',
    testFilePattern: 'src/__tests__/**/*.test.ts',
    testFileSuffix: '.test.ts',
  }
  let existingFiles: string[] = []

  if (cloneUrl) {
    try {
      await cloneRepo(cloneUrl, workDir)
      detected = await detectFramework(workDir, `origin/${defaultBranch}`)
      const { stdout: lsOut } = await execFileP('git', ['ls-tree', '-r', '--name-only', 'HEAD'], {
        cwd: workDir,
      })
      existingFiles = lsOut.split('\n').filter(Boolean)
    } catch (err) {
      logger.warn({ err, cloneUrl }, 'qa.generateTests: clone/detect failed; using defaults')
    }
  } else {
    logger.info({ tenantId, projectId }, 'qa.generateTests: no clone URL; using defaults')
  }

  // -------------------------------------------------------------------------
  // 4. Call Claude to generate tests
  // -------------------------------------------------------------------------
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is required for qa.generateTests')
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })

  const systemPrompt = buildSystemPrompt()
  const userPrompt = buildUserPrompt(
    story.title,
    story.description,
    acRows.map((ac) => ({ ordinal: ac.ordinal, text: ac.text, verifierHint: ac.verifierHint })),
    detected,
    existingFiles,
  )

  logger.info(
    { tenantId, storyId, framework: detected.framework, acCount: acRows.length },
    'qa.generateTests: calling Claude',
  )

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  })

  const rawText =
    message.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('') ?? ''

  // Parse JSON response from Claude
  let testFileContent: string
  let testPath: string
  let rationale: string

  try {
    // Claude sometimes wraps JSON in ```json ``` blocks
    const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
    const jsonStr = jsonMatch && jsonMatch[1] ? jsonMatch[1] : rawText.trim()
    const parsed = JSON.parse(jsonStr) as {
      test_file: string
      test_path: string
      rationale: string
    }
    testFileContent = parsed.test_file
    testPath = parsed.test_path
    rationale = parsed.rationale
  } catch (err) {
    logger.error({ err, rawText: rawText.slice(0, 500) }, 'qa.generateTests: failed to parse Claude response')
    throw new Error(`qa.generateTests: Claude returned non-JSON response: ${rawText.slice(0, 200)}`)
  }

  // -------------------------------------------------------------------------
  // 5. Write test file and commit to branch
  // -------------------------------------------------------------------------
  let committed = false

  if (cloneUrl) {
    try {
      await checkoutBranch(workDir, branch, defaultBranch)

      const absTestPath = path.join(workDir, testPath)
      await fs.mkdir(path.dirname(absTestPath), { recursive: true })
      await fs.writeFile(absTestPath, testFileContent, 'utf8')

      const commitMsg = [
        `test(qa): generated failing tests for story ${storyId}`,
        '',
        `Story: ${story.title}`,
        `ACs covered: ${acRows.length}`,
        `Framework: ${detected.framework} (${detected.language})`,
        '',
        rationale,
        '',
        'Co-Authored-By: Orbital QA <orbital-qa@orbital.local>',
      ].join('\n')

      await commitAndPush(workDir, testPath, commitMsg, branch)
      committed = true

      logger.info(
        { tenantId, storyId, branch, testPath },
        'qa.generateTests: committed test file to branch',
      )
    } catch (err) {
      logger.error({ err, tenantId, storyId, branch }, 'qa.generateTests: commit/push failed')
      // Do not throw — persist the artifact row without a branch; reviewer can
      // approve the content and manually merge.
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {})
    }
  } else {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {})
  }

  // -------------------------------------------------------------------------
  // 6. Persist story_test_artifacts row
  // -------------------------------------------------------------------------
  const artifactId = randomUUID()
  await db.insert(storyTestArtifacts).values({
    id: artifactId,
    tenantId,
    projectId,
    storyId,
    testPath,
    language: detected.language,
    framework: detected.framework,
    branch: committed ? branch : null,
    status: 'pending',
  })

  logger.info(
    { tenantId, storyId, artifactId, committed },
    'qa.generateTests: artifact row written',
  )

  return {
    artifactId,
    branch: committed ? branch : '',
    testPath,
    language: detected.language,
    framework: detected.framework,
    committed,
    summary: rationale,
  }
}

/**
 * Approve an artifact and merge the test branch into the story branch.
 *
 * @param artifactId  UUID of the story_test_artifacts row.
 * @param tenantId    Calling tenant — enforced before any mutation.
 * @param storyBranch Target branch to merge into (e.g. 'feat/story-<id>').
 * @param db          Drizzle client (injectable for tests).
 */
export async function approveArtifact(
  artifactId: string,
  tenantId: string,
  storyBranch: string,
  db = defaultDb,
): Promise<void> {
  const rows = await db
    .select()
    .from(storyTestArtifacts)
    .where(
      and(eq(storyTestArtifacts.id, artifactId), eq(storyTestArtifacts.tenantId, tenantId)),
    )
    .limit(1)

  const artifact = rows[0]
  if (!artifact) {
    throw new Error(`approveArtifact: artifact ${artifactId} not found for tenant ${tenantId}`)
  }
  if (artifact.status !== 'pending') {
    throw new Error(`approveArtifact: artifact ${artifactId} is ${artifact.status}, expected pending`)
  }

  // Mark merged (actual git merge happens in the engineer-sr worktree setup).
  await db
    .update(storyTestArtifacts)
    .set({ status: 'merged' })
    .where(
      and(eq(storyTestArtifacts.id, artifactId), eq(storyTestArtifacts.tenantId, tenantId)),
    )

  logger.info(
    { tenantId, artifactId, storyBranch },
    'qa.approveArtifact: artifact marked merged',
  )
}

/**
 * Reject an artifact and re-queue generation.
 *
 * The old row is deleted and a new pending row will be created by the caller
 * re-invoking generateTests.
 */
export async function rejectArtifact(
  artifactId: string,
  tenantId: string,
  db = defaultDb,
): Promise<void> {
  const rows = await db
    .select()
    .from(storyTestArtifacts)
    .where(
      and(eq(storyTestArtifacts.id, artifactId), eq(storyTestArtifacts.tenantId, tenantId)),
    )
    .limit(1)

  const artifact = rows[0]
  if (!artifact) {
    throw new Error(`rejectArtifact: artifact ${artifactId} not found for tenant ${tenantId}`)
  }
  if (artifact.status !== 'pending') {
    throw new Error(`rejectArtifact: artifact ${artifactId} is ${artifact.status}, expected pending`)
  }

  // Hard-delete the rejected artifact; caller re-queues generateTests.
  await db
    .delete(storyTestArtifacts)
    .where(
      and(eq(storyTestArtifacts.id, artifactId), eq(storyTestArtifacts.tenantId, tenantId)),
    )

  logger.info({ tenantId, artifactId }, 'qa.rejectArtifact: artifact deleted; caller should regenerate')
}

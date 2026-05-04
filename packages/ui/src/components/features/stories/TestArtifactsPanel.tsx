/**
 * TestArtifactsPanel — shows QA-generated failing tests for a story.
 *
 * [Engineer-Sr · Sonnet · run-ac-test-generation]
 *
 * Displayed in StoryDetail below the action bar. Each artifact card shows:
 *   - Test path + language/framework badge
 *   - Branch link
 *   - Expand/collapse for generated test content (fetched lazily)
 *   - "Approve" button → merges to story branch + marks artifact merged
 *   - "Reject + regenerate" button → deletes artifact + calls generate again
 *
 * Status lifecycle: pending → approved (merged) | regenerating
 */

import { useState } from 'react'
import clsx from 'clsx'
import { trpc } from '../../../services/trpc.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'
import { Button } from '../../ui/Button.js'
import { Badge } from '../../ui/Badge.js'
import { EmptyState } from '../../ui/EmptyState.js'

// ---------------------------------------------------------------------------
// Types (mirror server-side schema)
// ---------------------------------------------------------------------------

interface TestArtifact {
  id: string
  storyId: string
  projectId: string
  tenantId: string
  testPath: string
  language: string
  framework: string
  branch: string | null
  generatedAt: string | Date
  status: 'pending' | 'approved' | 'merged'
}

interface TestArtifactsPanelProps {
  storyId: string
  projectId: string | null
  /** Branch the engineer-sr will use — tests approved into this branch. */
  storyBranch?: string
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TestArtifactsPanel({
  storyId,
  projectId,
  storyBranch = 'main',
}: TestArtifactsPanelProps) {
  const utils = trpc.useUtils()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)

  const listQuery = trpc.testArtifacts.list.useQuery(
    { story_id: storyId },
    { enabled: !!storyId, staleTime: 10_000 },
  )

  const approveMut = trpc.testArtifacts.approve.useMutation({
    onSuccess: () => utils.testArtifacts.list.invalidate({ story_id: storyId }),
  })

  const rejectMut = trpc.testArtifacts.reject.useMutation({
    onSuccess: () => {
      utils.testArtifacts.list.invalidate({ story_id: storyId })
    },
  })

  const generateMut = trpc.testArtifacts.generate.useMutation({
    onMutate: () => {
      setGenerating(true)
      setGenerateError(null)
    },
    onError: (err) => {
      setGenerating(false)
      setGenerateError(err.message)
    },
    onSuccess: () => {
      setGenerating(false)
      utils.testArtifacts.list.invalidate({ story_id: storyId })
    },
  })

  const artifacts = (listQuery.data?.artifacts ?? []) as TestArtifact[]
  const pendingCount = artifacts.filter((a) => a.status === 'pending').length

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function handleRejectAndRegenerate(artifactId: string) {
    if (!projectId) return
    rejectMut.mutate(
      { artifact_id: artifactId },
      {
        onSuccess: () => {
          generateMut.mutate({ story_id: storyId, project_id: projectId })
        },
      },
    )
  }

  return (
    <section
      aria-label="QA generated tests"
      className="rounded-lg border border-slate-200 bg-white"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-slate-900">QA Generated Tests</h2>
          {pendingCount > 0 && (
            <Badge color="amber" data-testid="pending-badge">
              {pendingCount} pending
            </Badge>
          )}
          {artifacts.length > 0 && artifacts.every((a) => a.status === 'merged') && (
            <Badge color="emerald" data-testid="all-merged-badge">
              all merged
            </Badge>
          )}
        </div>
        {projectId && (
          <Button
            variant="secondary"
            disabled={generating || generateMut.isPending}
            onClick={() => generateMut.mutate({ story_id: storyId, project_id: projectId })}
            data-testid="btn-generate-tests"
          >
            {generating || generateMut.isPending ? 'Generating…' : 'Generate tests'}
          </Button>
        )}
      </div>

      {/* Body */}
      <div className="p-4">
        {listQuery.isLoading && <Skeleton className="h-16 w-full" />}
        {listQuery.isError && (
          <ErrorMessage message={listQuery.error?.message ?? 'Failed to load test artifacts'} />
        )}
        {generateError && <ErrorMessage message={generateError} />}
        {approveMut.error && <ErrorMessage message={approveMut.error.message} />}
        {rejectMut.error && <ErrorMessage message={rejectMut.error.message} />}

        {!listQuery.isLoading && artifacts.length === 0 && (
          <EmptyState
            title="No generated tests yet"
            description={
              projectId
                ? 'Click "Generate tests" to have the QA persona write failing tests from the ACs.'
                : 'Story has no project linked — cannot generate tests.'
            }
          />
        )}

        {artifacts.length > 0 && (
          <ul className="flex flex-col gap-3" data-testid="artifact-list">
            {artifacts.map((artifact) => {
              const isExpanded = expanded.has(artifact.id)
              const isPending = artifact.status === 'pending'
              const isMerged = artifact.status === 'merged'

              return (
                <li
                  key={artifact.id}
                  className={clsx(
                    'rounded-md border p-3',
                    isPending
                      ? 'border-amber-200 bg-amber-50/30'
                      : isMerged
                        ? 'border-emerald-200 bg-emerald-50/30'
                        : 'border-slate-200 bg-white',
                  )}
                  data-testid={`artifact-${artifact.id}`}
                >
                  {/* Artifact header row */}
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      color={
                        artifact.status === 'merged'
                          ? 'emerald'
                          : artifact.status === 'approved'
                            ? 'slate'
                            : 'amber'
                      }
                    >
                      {artifact.status}
                    </Badge>
                    <span
                      className="font-mono text-xs text-slate-800"
                      data-testid="artifact-path"
                    >
                      {artifact.testPath}
                    </span>
                    <Badge color="slate">{artifact.language}</Badge>
                    <Badge color="slate">{artifact.framework}</Badge>
                    {artifact.branch && (
                      <span
                        className="font-mono text-[10px] text-slate-500"
                        data-testid="artifact-branch"
                      >
                        {artifact.branch}
                      </span>
                    )}
                    <span className="ml-auto text-[10px] text-slate-400">
                      {new Date(artifact.generatedAt).toLocaleString()}
                    </span>
                  </div>

                  {/* Expand/collapse toggle */}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className="rounded border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-600 transition hover:bg-slate-50"
                      onClick={() => toggleExpand(artifact.id)}
                      data-testid={`toggle-artifact-${artifact.id}`}
                    >
                      {isExpanded ? 'Collapse' : 'Expand'}
                    </button>

                    {isPending && (
                      <>
                        <Button
                          variant="primary"
                          disabled={approveMut.isPending}
                          onClick={() =>
                            approveMut.mutate({
                              artifact_id: artifact.id,
                              story_branch: storyBranch,
                            })
                          }
                          data-testid={`btn-approve-${artifact.id}`}
                        >
                          {approveMut.isPending ? 'Approving…' : 'Approve'}
                        </Button>
                        <Button
                          variant="danger"
                          disabled={rejectMut.isPending || generating}
                          onClick={() => handleRejectAndRegenerate(artifact.id)}
                          data-testid={`btn-reject-${artifact.id}`}
                        >
                          {rejectMut.isPending ? 'Rejecting…' : 'Reject + regenerate'}
                        </Button>
                      </>
                    )}
                  </div>

                  {/* Expanded test file content */}
                  {isExpanded && (
                    <TestArtifactContent
                      storyId={storyId}
                      testPath={artifact.testPath}
                      branch={artifact.branch}
                    />
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Test content inline view — raw file content from the branch via stories router
// We don't have a dedicated "get file" endpoint, so we show test path + branch
// and rely on the user navigating to the branch on GitHub / CodeCommit.
// ---------------------------------------------------------------------------

function TestArtifactContent({
  testPath,
  branch,
}: {
  storyId: string
  testPath: string
  branch: string | null
}) {
  return (
    <div
      className="mt-3 rounded-md border border-slate-200 bg-slate-950 p-3 text-xs"
      data-testid="artifact-content"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2 text-slate-400">
        <span className="font-mono">{testPath}</span>
        {branch && (
          <span className="font-mono text-[10px] text-slate-500">on branch {branch}</span>
        )}
      </div>
      <p className="text-slate-400">
        {branch
          ? `Test file committed to branch "${branch}". Check out the branch to view the failing tests locally, or open the branch in your SCM provider.`
          : 'Tests were generated but could not be committed (no clone URL configured for this project). The test content is saved in the artifact record.'}
      </p>
    </div>
  )
}

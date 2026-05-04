/**
 * Ambient declaration for the plain-JS @orbital/story-executor entry point.
 * The package itself ships JS only; the daemon loads it via dynamic import.
 */
declare module '@orbital/story-executor/src/main.js' {
  export function executeStory(
    story: { storyId: string; title: string; description: string; status: string },
    opts?: Record<string, unknown>,
  ): Promise<{
    storyStatus: string
    reason: string
    lastRunId?: string
    pr_url?: string
  }>
  export function registerStory(s: {
    storyId: string
    title: string
    description: string
    status?: string
  }): { storyId: string; title: string; description: string; status: string }
  export function getStory(id: string): unknown
  export function listWorkerRuns(storyId: string): Promise<unknown[]>
  export function shutdown(): Promise<void>
}

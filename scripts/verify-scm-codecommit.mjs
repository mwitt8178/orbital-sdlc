/**
 * verify-scm-codecommit.mjs — Live end-to-end verify of the CodeCommit
 * ScmClient against the mwitt account.
 *
 * [Engineer-Principal · Opus · run-scm-codecommit]
 *
 * Steps:
 *  1. createRepo          — orbital-mwitt-verify-<ts>
 *  2. commitFiles(main)   — README.md initial commit
 *  3. createBranch        — feat/verify off main
 *  4. commitFiles(feat)   — change README on feature branch
 *  5. openPullRequest     — PR feat -> main
 *  6. getDifferences      — diff main..feat
 *  7. addPRComment        — sanity comment
 *  8. getPullRequestStatus — confirm open
 *
 * Run with:  node scripts/verify-scm-codecommit.mjs
 */

import {
  CodeCommitClient,
  CreateRepositoryCommand,
  GetRepositoryCommand,
  PutFileCommand,
  CreateCommitCommand,
  CreateBranchCommand,
  GetBranchCommand,
  CreatePullRequestCommand,
  GetPullRequestCommand,
  GetDifferencesCommand,
  PostCommentForPullRequestCommand,
} from '@aws-sdk/client-codecommit'

const REGION = process.env.AWS_REGION || 'us-east-1'
const sdk = new CodeCommitClient({ region: REGION })
const ts = Date.now()
const repoName = `orbital-mwitt-verify-${ts}`

const out = {
  repoName,
  region: REGION,
  steps: [],
}

function step(name, data) {
  out.steps.push({ name, data })
  console.log(`[ok] ${name}`, JSON.stringify(data))
}

try {
  // 1. createRepo
  const created = await sdk.send(
    new CreateRepositoryCommand({
      repositoryName: repoName,
      repositoryDescription: 'Orbital SCM verify run',
    }),
  )
  step('createRepo', {
    arn: created.repositoryMetadata?.Arn ?? created.repositoryMetadata?.arn,
    cloneUrlHttp: created.repositoryMetadata?.cloneUrlHttp,
  })

  // 2. initial README commit on main via PutFile (empty repo path).
  const initial = await sdk.send(
    new PutFileCommand({
      repositoryName: repoName,
      branchName: 'main',
      filePath: 'README.md',
      fileContent: new TextEncoder().encode(`# ${repoName}\n\nInitial commit.\n`),
      commitMessage: 'chore: initial commit',
      name: 'Orbital',
      email: 'noreply@orbital.local',
    }),
  )
  step('commitFiles:main', { commitSha: initial.commitId })

  // 3. createBranch off main
  const main = await sdk.send(
    new GetBranchCommand({ repositoryName: repoName, branchName: 'main' }),
  )
  await sdk.send(
    new CreateBranchCommand({
      repositoryName: repoName,
      branchName: 'feat/verify',
      commitId: main.branch?.commitId,
    }),
  )
  step('createBranch', { name: 'feat/verify', from: main.branch?.commitId })

  // 4. commit on feat/verify
  const featCommit = await sdk.send(
    new CreateCommitCommand({
      repositoryName: repoName,
      branchName: 'feat/verify',
      parentCommitId: main.branch?.commitId,
      authorName: 'Orbital',
      email: 'noreply@orbital.local',
      commitMessage: 'feat: add scm-verify marker',
      putFiles: [
        {
          filePath: 'verify.md',
          fileMode: 'NORMAL',
          fileContent: new TextEncoder().encode(`scm-verify ${ts}\n`),
        },
      ],
    }),
  )
  step('commitFiles:feat', { commitSha: featCommit.commitId })

  // 5. PR
  const pr = await sdk.send(
    new CreatePullRequestCommand({
      title: 'verify: scm-codecommit end-to-end',
      description: 'End-to-end verify of CodeCommit ScmClient.',
      targets: [
        {
          repositoryName: repoName,
          sourceReference: 'feat/verify',
          destinationReference: 'main',
        },
      ],
    }),
  )
  const prId = pr.pullRequest?.pullRequestId
  step('openPullRequest', {
    prId,
    url: `https://${REGION}.console.aws.amazon.com/codesuite/codecommit/repositories/${repoName}/pull-requests/${prId}/details?region=${REGION}`,
  })

  // 6. getDifferences
  const diffs = await sdk.send(
    new GetDifferencesCommand({
      repositoryName: repoName,
      beforeCommitSpecifier: 'main',
      afterCommitSpecifier: 'feat/verify',
    }),
  )
  step('getDifferences', {
    fileCount: diffs.differences?.length ?? 0,
    files: (diffs.differences ?? []).map((d) => ({
      path: d.afterBlob?.path ?? d.beforeBlob?.path,
      changeType: d.changeType,
    })),
  })

  // 7. comment
  await sdk.send(
    new PostCommentForPullRequestCommand({
      pullRequestId: prId,
      repositoryName: repoName,
      beforeCommitId: main.branch?.commitId,
      afterCommitId: featCommit.commitId,
      content: '[scm-verify] automated comment from verify run',
    }),
  )
  step('addPRComment', { prId })

  // 8. status
  const status = await sdk.send(new GetPullRequestCommand({ pullRequestId: prId }))
  step('getPullRequestStatus', {
    state: status.pullRequest?.pullRequestStatus,
    title: status.pullRequest?.title,
  })

  // 9. confirm via GetRepository (post-create)
  const got = await sdk.send(new GetRepositoryCommand({ repositoryName: repoName }))
  step('getRepository', {
    cloneUrlHttp: got.repositoryMetadata?.cloneUrlHttp,
    defaultBranch: got.repositoryMetadata?.defaultBranch,
  })

  console.log('\n=== VERIFY OK ===')
  console.log(JSON.stringify(out, null, 2))
} catch (err) {
  console.error('\n=== VERIFY FAILED ===')
  console.error(err)
  console.log(JSON.stringify(out, null, 2))
  process.exit(1)
}

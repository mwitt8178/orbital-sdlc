// github-oidc-role.ts
//
// CDK construct that provisions OrbitalGitHubDeployRole-<env> + the
// associated GitHub OIDC provider (if the account doesn't already have one).
//
// Trust: GitHub OIDC, sub constrained to release/<env> + environment:<env>.
// Permissions: explicit, minimal — see docs/releases.md for the full list.
//
// Owner: Engineer-Principal (orbital-pipeline-2026-05-04)

import { Construct } from 'constructs'
import { Duration, Stack } from 'aws-cdk-lib'
import {
  Effect,
  OpenIdConnectProvider,
  PolicyStatement,
  Role,
  WebIdentityPrincipal,
} from 'aws-cdk-lib/aws-iam'

export interface GitHubOidcRoleProps {
  /** GitHub repo in the form `owner/repo`, e.g. `mwitt8178/orbital-sdlc`. */
  readonly githubRepo: string

  /** Environment name (mwitt, rreed, prod). Drives release branch + role name. */
  readonly envName: string

  /** Lambda function name for the API. */
  readonly apiLambdaName: string

  /** Lambda function name for the migration runner. */
  readonly migrationLambdaName: string

  /** S3 bucket name hosting the UI. */
  readonly uiBucketName: string

  /** CloudFront distribution ID. */
  readonly cloudfrontDistributionId: string

  /**
   * Existing GitHub OIDC provider. If omitted, a new provider is created.
   * Pass an existing one if multiple stacks in the same account create roles.
   */
  readonly oidcProvider?: OpenIdConnectProvider
}

export class GitHubOidcRole extends Construct {
  public readonly role: Role
  public readonly oidcProvider: OpenIdConnectProvider

  constructor(scope: Construct, id: string, props: GitHubOidcRoleProps) {
    super(scope, id)

    const account = Stack.of(this).account
    const region = Stack.of(this).region

    this.oidcProvider =
      props.oidcProvider ??
      new OpenIdConnectProvider(this, 'GitHubOidcProvider', {
        url: 'https://token.actions.githubusercontent.com',
        clientIds: ['sts.amazonaws.com'],
      })

    const releaseBranchSub = `repo:${props.githubRepo}:ref:refs/heads/release/${props.envName}`
    const environmentSub = `repo:${props.githubRepo}:environment:${props.envName}`
    const pullRequestSub = `repo:${props.githubRepo}:pull_request`

    const principal = new WebIdentityPrincipal(this.oidcProvider.openIdConnectProviderArn, {
      StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      },
      StringLike: {
        'token.actions.githubusercontent.com:sub': [
          releaseBranchSub,
          environmentSub,
          pullRequestSub,
        ],
      },
    })

    this.role = new Role(this, 'Role', {
      roleName: `OrbitalGitHubDeployRole-${props.envName}`,
      assumedBy: principal,
      maxSessionDuration: Duration.minutes(60),
      description: `OIDC-assumed role for GitHub Actions deploys to ${props.envName}.`,
    })

    // ------------------------------------------------------------------
    // Lambda — api function: code update, version, alias
    // ------------------------------------------------------------------
    const apiFnArn = `arn:aws:lambda:${region}:${account}:function:${props.apiLambdaName}`
    this.role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'lambda:UpdateFunctionCode',
          'lambda:PublishVersion',
          'lambda:UpdateAlias',
          'lambda:GetFunction',
          'lambda:GetFunctionConfiguration',
          'lambda:GetAlias',
          'lambda:ListVersionsByFunction',
        ],
        resources: [apiFnArn, `${apiFnArn}:*`],
      }),
    )

    // ------------------------------------------------------------------
    // Lambda — migration-runner: invoke only
    // ------------------------------------------------------------------
    const migrationFnArn = `arn:aws:lambda:${region}:${account}:function:${props.migrationLambdaName}`
    this.role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['lambda:InvokeFunction'],
        resources: [migrationFnArn],
      }),
    )

    // ------------------------------------------------------------------
    // S3 — UI bucket: read/write objects, list bucket
    // ------------------------------------------------------------------
    const bucketArn = `arn:aws:s3:::${props.uiBucketName}`
    this.role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['s3:ListBucket', 's3:GetBucketLocation'],
        resources: [bucketArn],
      }),
    )
    this.role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject', 's3:PutObjectAcl'],
        resources: [`${bucketArn}/*`],
      }),
    )

    // ------------------------------------------------------------------
    // CloudFront — invalidations only
    // ------------------------------------------------------------------
    this.role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'],
        resources: [
          `arn:aws:cloudfront::${account}:distribution/${props.cloudfrontDistributionId}`,
        ],
      }),
    )

    // ------------------------------------------------------------------
    // STS — caller identity (used by deploy script for assertion)
    // ------------------------------------------------------------------
    this.role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['sts:GetCallerIdentity'],
        resources: ['*'], // sts:GetCallerIdentity does not support resource-level
      }),
    )
  }
}

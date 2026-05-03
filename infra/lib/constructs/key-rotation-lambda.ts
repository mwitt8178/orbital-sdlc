// [Engineer-Principal · Opus · run-round8-07-secrets-kms]
/**
 * key-rotation-lambda.ts
 *
 * KeyRotationLambdaConstruct - Lambda that rotates the hub master Ed25519
 * keypair stored in `orbital/${env}/hub-master-key`, with EventBridge schedule
 * + Secrets Manager rotation wiring.
 *
 * Rotation cadence: 90 days. The previous keypair is preserved in
 * `orbital/${env}/hub-master-key.prev` for 24h to allow verification of
 * signed envelopes that were signed before the rotation moment.
 *
 * Behaviour:
 *   1. EventBridge rule fires every 90 days → invokes Lambda with Step="full".
 *   2. Lambda:
 *        a. Generates new Ed25519 keypair
 *        b. PutSecretValue (AWSPENDING) on the hub-master-key secret
 *        c. Verifies the new keypair signs+verifies a probe
 *        d. Promotes AWSPENDING → AWSCURRENT atomically
 *        e. Stashes the previous keypair into the .prev companion secret
 *
 * IAM scope (least-privilege):
 *   - secretsmanager:GetSecretValue, PutSecretValue, DescribeSecret,
 *     UpdateSecretVersionStage on the hub-master-key + hub-master-key.prev
 *   - secretsmanager:CreateSecret on the hub-master-key.prev resource ARN
 *   - kms:Encrypt/Decrypt/GenerateDataKey on the hubMasterKeyEncryptionKey
 *
 * Secrets Manager rotation registration is done by the Stack via
 * `secret.addRotationSchedule({ rotationLambda })`. We expose the lambda
 * function and let the stack wire it.
 */

import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as events from 'aws-cdk-lib/aws-events'
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as kms from 'aws-cdk-lib/aws-kms'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import * as path from 'path'
import { Construct } from 'constructs'

export interface KeyRotationLambdaConstructProps {
  /** e.g. "mwitt" | "rreed" | "prod" */
  readonly envName: string
  /** Hub master key secret to rotate. */
  readonly hubMasterKeySecret: secretsmanager.Secret
  /** KMS CMK that encrypts the secret. The Lambda needs decrypt + encrypt. */
  readonly encryptionKey: kms.IKey
  /** CloudWatch log retention in days. */
  readonly logRetentionDays: number
  /** Optional VPC + SG - required if Lambda must reach Secrets Manager via VPC endpoints. */
  readonly vpc?: ec2.IVpc
  /** Optional security group for the Lambda. */
  readonly securityGroup?: ec2.ISecurityGroup
  /**
   * Rotation interval. Defaults to 90 days per architecture spec.
   * Tests can override to verify scheduling.
   */
  readonly rotationDays?: number
}

/**
 * KeyRotationLambdaConstruct provisions the Lambda function + EventBridge
 * schedule + IAM grants for hub master key rotation.
 */
export class KeyRotationLambdaConstruct extends Construct {
  /** The rotation Lambda function. Stack wires it as a Secrets Manager rotation Lambda. */
  readonly fn: lambda.Function

  /** EventBridge rule that triggers rotation every N days. */
  readonly schedule: events.Rule

  /** Rotation interval (days). */
  readonly rotationDays: number

  constructor(scope: Construct, id: string, props: KeyRotationLambdaConstructProps) {
    super(scope, id)

    const isProd = props.envName === 'prod'
    this.rotationDays = props.rotationDays ?? 90

    // ------------------------------------------------------------------
    // CloudWatch log group
    // ------------------------------------------------------------------
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/orbital/${props.envName}/lambda/key-rotation`,
      retention: props.logRetentionDays as logs.RetentionDays,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    })

    // ------------------------------------------------------------------
    // IAM execution role - least privilege
    // ------------------------------------------------------------------
    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Orbital ${props.envName} hub master key rotation Lambda role`,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    })

    // Grant write access to the hub master key secret + decrypt on the CMK.
    props.hubMasterKeySecret.grantRead(executionRole)
    props.hubMasterKeySecret.grantWrite(executionRole)
    props.encryptionKey.grantEncryptDecrypt(executionRole)

    // The Lambda also needs to UpdateSecretVersionStage and DescribeSecret -
    // grantWrite includes PutSecretValue but not UpdateSecretVersionStage on
    // some CDK versions, so add it explicitly.
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'secretsmanager:UpdateSecretVersionStage',
          'secretsmanager:DescribeSecret',
        ],
        resources: [props.hubMasterKeySecret.secretArn],
      }),
    )

    // The .prev companion secret may not exist yet; the Lambda must be able
    // to create + write to it. Restrict by ARN pattern.
    const prevSecretArnPattern = `${props.hubMasterKeySecret.secretArn}.prev*`
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'secretsmanager:CreateSecret',
          'secretsmanager:PutSecretValue',
          'secretsmanager:GetSecretValue',
          'secretsmanager:DescribeSecret',
        ],
        // Use the secret name pattern (resource arn supports * suffix).
        resources: [
          // Match same-stack region/account as the parent secret. The pattern
          // `${arn}.prev*` is sufficient: Secrets Manager ARNs end with a
          // 6-character random suffix, so anchoring on `${arn}.prev` and
          // allowing wildcard at the end captures any future versions.
          prevSecretArnPattern,
        ],
      }),
    )
    // CreateSecret needs `*` resource at the action level since the secret
    // doesn't exist yet - but we further constrain by name prefix via condition.
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:CreateSecret'],
        resources: ['*'],
        conditions: {
          StringLike: {
            'secretsmanager:Name': `orbital/${props.envName}/hub-master-key.prev*`,
          },
        },
      }),
    )

    // ------------------------------------------------------------------
    // Lambda function
    // ------------------------------------------------------------------
    const lambdaSourceDir = path.resolve(__dirname, '../lambdas/key-rotation')

    this.fn = new lambda.Function(this, 'Fn', {
      functionName: `orbital-${props.envName}-key-rotation`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(lambdaSourceDir, {
        bundling: {
          local: {
            tryBundle(outputDir: string): boolean {
              const { execSync } = require('child_process') as typeof import('child_process')
              const fs = require('fs') as typeof import('fs')
              const _path = require('path') as typeof import('path')
              const cdkSafeEnv = {
                ...process.env,
                HOME: process.env.HOME || require('os').homedir(),
              }
              try {
                execSync('npm install --omit=dev', {
                  cwd: lambdaSourceDir,
                  stdio: ['ignore', 'inherit', 'inherit'],
                  env: cdkSafeEnv,
                })
                // Quote outputDir to handle paths with spaces (e.g. "AI SDLC").
                const quotedOut = JSON.stringify(outputDir)
                execSync(
                  `npx tsc --target ES2022 --module CommonJS --moduleResolution node ` +
                    `--esModuleInterop true --skipLibCheck true --outDir ${quotedOut} index.ts`,
                  {
                    cwd: lambdaSourceDir,
                    stdio: ['ignore', 'inherit', 'inherit'],
                    env: cdkSafeEnv,
                  },
                )
                const srcModules = _path.join(lambdaSourceDir, 'node_modules')
                const dstModules = _path.join(outputDir, 'node_modules')
                if (fs.existsSync(srcModules)) {
                  execSync(`cp -r "${srcModules}" "${dstModules}"`, { stdio: 'inherit' })
                }
                return true
              } catch (err) {
                console.error('Local bundling failed for key-rotation Lambda:', err)
                return false
              }
            },
          },
          image: lambda.Runtime.NODEJS_22_X.bundlingImage,
          command: [
            'bash',
            '-c',
            [
              'npm install --omit=dev',
              'npx tsc --target ES2022 --module CommonJS --moduleResolution node --esModuleInterop true --skipLibCheck true --outDir /asset-output index.ts',
              'cp -r node_modules /asset-output/',
            ].join(' && '),
          ],
        },
      }),
      role: executionRole,
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      logGroup,
      tracing: lambda.Tracing.ACTIVE,
      ...(props.vpc
        ? {
            vpc: props.vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            ...(props.securityGroup ? { securityGroups: [props.securityGroup] } : {}),
          }
        : {}),
    })

    // ------------------------------------------------------------------
    // EventBridge schedule - every N days
    //
    // Use a rate expression. Daily resolution is fine for 90-day rotation.
    // ------------------------------------------------------------------
    this.schedule = new events.Rule(this, 'Schedule', {
      ruleName: `orbital-${props.envName}-key-rotation-schedule`,
      description: `Rotate the Orbital hub master key every ${this.rotationDays} days.`,
      schedule: events.Schedule.rate(cdk.Duration.days(this.rotationDays)),
    })

    this.schedule.addTarget(
      new eventsTargets.LambdaFunction(this.fn, {
        // Synthetic Step="full" event for the rotation Lambda's batch path.
        event: events.RuleTargetInput.fromObject({
          Step: 'full',
          SecretId: props.hubMasterKeySecret.secretArn,
          ClientRequestToken: events.EventField.eventId,
        }),
      }),
    )

    // ------------------------------------------------------------------
    // Outputs
    // ------------------------------------------------------------------
    new cdk.CfnOutput(this, 'KeyRotationLambdaArn', {
      value: this.fn.functionArn,
      description: `Orbital ${props.envName} key-rotation Lambda ARN`,
      exportName: `OrbitalHub-${props.envName}-KeyRotationLambdaArn`,
    })

    new cdk.CfnOutput(this, 'KeyRotationScheduleName', {
      value: this.schedule.ruleName,
      description: `Orbital ${props.envName} key-rotation EventBridge schedule rule`,
      exportName: `OrbitalHub-${props.envName}-KeyRotationScheduleName`,
    })

    cdk.Tags.of(this).add('orbital:component', 'key-rotation')
  }
}

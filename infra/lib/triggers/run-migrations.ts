// [Engineer-Sr · Sonnet · run-round8-02-aurora]
import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as rds from 'aws-cdk-lib/aws-rds'
import * as cr from 'aws-cdk-lib/custom-resources'
import * as path from 'path'
import { Construct } from 'constructs'

export interface RunMigrationsProps {
  /**
   * Environment name.
   */
  readonly envName: string
  /**
   * VPC containing the RDS Proxy (Lambda must be in private-with-egress subnet).
   */
  readonly vpc: ec2.IVpc
  /**
   * RDS Proxy the migration runner connects to (via IAM auth).
   */
  readonly proxy: rds.DatabaseProxy
  /**
   * RDS Proxy endpoint hostname.
   */
  readonly proxyEndpoint: string
  /**
   * Aurora cluster - migration runner calls grantConnect on this.
   */
  readonly cluster: rds.DatabaseCluster
  /**
   * Secrets Manager secret with master credentials.
   * The migration runner reads the secret to know the username; password
   * is replaced by the IAM auth token at runtime.
   */
  readonly masterSecret: rds.DatabaseSecret
  /**
   * Security group for the migration runner Lambda.
   * Must be the placeholder Lambda SG (orbital-{env}-lambda) so the RDS
   * Proxy SG allows inbound connections from it.
   */
  readonly lambdaSg: ec2.ISecurityGroup
  /**
   * CloudWatch log retention in days.
   */
  readonly logRetentionDays: number
}

/**
 * RunMigrationsTrigger - CDK custom resource that invokes the migration runner
 * Lambda on every `cdk deploy`.
 *
 * How it works:
 *  1. A Lambda function (migration-runner) is created with the migration SQL
 *     files bundled alongside the handler via `Code.fromAsset` + build hook.
 *  2. A CDK CustomResource with `serviceToken` pointing to the Lambda is
 *     added to the stack. CDK calls the Lambda on Create + Update (every deploy).
 *  3. The Lambda applies any pending migrations and returns the count.
 *  4. If the Lambda throws, CDK rolls back the deploy.
 *
 * IAM grants:
 *  - Lambda role: rds-db:connect to the proxy (IAM DB auth)
 *  - Lambda role: secretsmanager:GetSecretValue for the master secret
 *    (to retrieve the username; password is replaced by IAM token)
 *  - Lambda role: standard CloudWatch Logs write
 */
export class RunMigrationsTrigger extends Construct {
  readonly migrationRunnerFn: lambda.Function

  constructor(scope: Construct, id: string, props: RunMigrationsProps) {
    super(scope, id)

    const isProd = props.envName === 'prod'

    // ------------------------------------------------------------------
    // CloudWatch log group - explicit retention
    // ------------------------------------------------------------------
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/orbital/${props.envName}/lambda/migration-runner`,
      retention: props.logRetentionDays as logs.RetentionDays,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    })

    // ------------------------------------------------------------------
    // IAM role for the migration runner Lambda
    // ------------------------------------------------------------------
    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Orbital ${props.envName} migration runner Lambda execution role`,
      managedPolicies: [
        // Basic Lambda execution (CloudWatch Logs write)
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaVPCAccessExecutionRole',
        ),
      ],
    })

    // Grant RDS IAM authentication (rds-db:connect) — kept for future use
    // even though the migration runner now uses password auth direct to
    // the cluster. Hub Lambdas (Round 8-03) still IAM-auth via the proxy.
    props.proxy.grantConnect(executionRole, 'orbital_admin')

    // Grant read access to the master secret (password auth direct path).
    props.masterSecret.grantRead(executionRole)

    // Allow the migration runner Lambda SG to connect directly to Aurora
    // on port 5432 (in addition to the RDS Proxy SG already in place).
    // The migration runner bypasses the proxy because the master user
    // cannot IAM-auth on a fresh cluster.
    props.cluster.connections.allowFrom(
      props.lambdaSg,
      ec2.Port.tcp(5432),
      'Migration runner direct connect (password auth)',
    )

    // ------------------------------------------------------------------
    // Migration runner Lambda
    //
    // Code is bundled from the migration-runner source directory.
    // The migrations SQL files from packages/orchestrator/src/db/migrations/
    // are copied into the bundle under /migrations/ so the handler can
    // read them at runtime.
    //
    // We use Code.fromAsset with a shell bundling command so the Lambda
    // package is self-contained and has the right node_modules.
    // ------------------------------------------------------------------
    const migrationsSourceDir = path.resolve(
      __dirname,
      // Path from infra/lib/triggers/ → orbital/ = 3 levels up.
      '../../../packages/orchestrator/src/db/migrations',
    )

    const lambdaSourceDir = path.resolve(__dirname, '../lambdas/migration-runner')

    this.migrationRunnerFn = new lambda.Function(this, 'Fn', {
      functionName: `orbital-${props.envName}-migration-runner`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(lambdaSourceDir, {
        // Hash based on the BUNDLED OUTPUT so changes to migration SQL files
        // (which live outside lambdaSourceDir but are copied into the bundle)
        // trigger a new asset hash and a re-deploy of the Lambda. Without
        // this, edits to the SQL would be invisible to CDK and Lambda code
        // would stay at the previously-deployed version.
        assetHashType: cdk.AssetHashType.OUTPUT,
        bundling: {
          // Use local bundling - runs on the host machine at synth time.
          // This avoids needing Docker for CDK bundling.
          local: {
            tryBundle(outputDir: string): boolean {
              const { execSync } = require('child_process') as typeof import('child_process')
              const fs = require('fs') as typeof import('fs')
              const path = require('path') as typeof import('path')

              // Force HOME to a writable location so npm doesn't try to use
              // /.npm when invoked from a CDK subprocess that loses HOME.
              const cdkSafeEnv = {
                ...process.env,
                HOME: process.env.HOME || require('os').homedir(),
              }

              try {
                // Install npm deps for the Lambda function
                execSync('npm install --omit=dev', {
                  cwd: lambdaSourceDir,
                  stdio: ['ignore', 'inherit', 'inherit'],
                  env: cdkSafeEnv,
                })

                // Compile TypeScript to JavaScript.
                // Use shell-quoted outputDir (it can contain spaces, e.g. "AI SDLC").
                const quotedOut = JSON.stringify(outputDir) // double-quoted, escapes safely
                execSync(
                  `npx tsc --target ES2022 --module CommonJS --moduleResolution node ` +
                  `--esModuleInterop true --skipLibCheck true --outDir ${quotedOut} index.ts`,
                  {
                    cwd: lambdaSourceDir,
                    stdio: ['ignore', 'inherit', 'inherit'],
                    env: cdkSafeEnv,
                  },
                )

                // Copy node_modules into the output directory
                const srcModules = path.join(lambdaSourceDir, 'node_modules')
                const dstModules = path.join(outputDir, 'node_modules')
                if (fs.existsSync(srcModules)) {
                  execSync(`cp -r "${srcModules}" "${dstModules}"`, { stdio: 'inherit' })
                }

                // Copy migration SQL files into /migrations/ inside the bundle
                const migrationsDst = path.join(outputDir, 'migrations')
                fs.mkdirSync(migrationsDst, { recursive: true })
                if (fs.existsSync(migrationsSourceDir)) {
                  const files = fs.readdirSync(migrationsSourceDir)
                  for (const file of files) {
                    if (file.endsWith('.sql')) {
                      fs.copyFileSync(
                        path.join(migrationsSourceDir, file),
                        path.join(migrationsDst, file),
                      )
                    }
                  }
                }

                return true
              } catch (err) {
                console.error('Local bundling failed:', err)
                return false
              }
            },
          },
          // Fallback Docker bundling (used in CI if local bundling fails)
          image: lambda.Runtime.NODEJS_22_X.bundlingImage,
          command: [
            'bash',
            '-c',
            [
              'npm install --omit=dev',
              // Compile TS
              'npx tsc --target ES2022 --module CommonJS --moduleResolution node --esModuleInterop true --skipLibCheck true --outDir /asset-output index.ts',
              // Copy deps
              'cp -r node_modules /asset-output/',
              // Copy migrations
              `mkdir -p /asset-output/migrations && cp -r "${migrationsSourceDir}"/*.sql /asset-output/migrations/ 2>/dev/null || true`,
            ].join(' && '),
          ],
        },
      }),
      role: executionRole,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.lambdaSg],
      timeout: cdk.Duration.minutes(10), // large migration sets can take a few minutes
      memorySize: 256,
      environment: {
        // Migration runner connects DIRECTLY to Aurora (bypass proxy) using
        // password auth from the master secret — see the comment in
        // index.ts for the rationale (master user can't IAM-auth without
        // first being granted rds_iam, which only the migration runner
        // can do).
        CLUSTER_ENDPOINT: props.cluster.clusterEndpoint.hostname,
        CLUSTER_PORT: cdk.Token.asString(props.cluster.clusterEndpoint.port),
        AURORA_DB_NAME: 'orbital_hub',
        MASTER_SECRET_ARN: props.masterSecret.secretArn,
        // Kept for legacy reference; not used by the new connection path.
        RDS_PROXY_HOSTNAME: props.proxyEndpoint,
        RDS_PROXY_PORT: '5432',
        AURORA_USERNAME: 'orbital_admin',
      },
      logGroup,
      // X-Ray tracing (8-08 will add the full dashboard; tracing here for free)
      tracing: lambda.Tracing.ACTIVE,
    })

    // ------------------------------------------------------------------
    // CDK Custom Resource - invokes the Lambda on every deploy
    //
    // ServiceToken is the Lambda ARN.
    // CDK calls Create on first deploy, Update on subsequent deploys.
    // The physicalId must be stable to signal an update vs replace.
    // We use a fixed-format physicalId in the Lambda handler.
    // ------------------------------------------------------------------
    const provider = new cr.Provider(this, 'Provider', {
      onEventHandler: this.migrationRunnerFn,
      logGroup,
    })

    new cdk.CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::OrbitalMigrationRunner',
      properties: {
        // Increment this version to force re-invocation even when nothing else changed.
        // Change it manually to force migrations to re-run.
        TriggerVersion: '1',
        // Include a hash of all migration file names so any new migration
        // automatically triggers the custom resource on Update.
        MigrationsHash: computeMigrationsHash(migrationsSourceDir),
      },
    })

    // ------------------------------------------------------------------
    // Outputs
    // ------------------------------------------------------------------
    new cdk.CfnOutput(this, 'MigrationRunnerArn', {
      value: this.migrationRunnerFn.functionArn,
      description: `Orbital ${props.envName} migration runner Lambda ARN`,
      exportName: `OrbitalHub-${props.envName}-MigrationRunnerArn`,
    })

    cdk.Tags.of(this).add('orbital:component', 'migration-runner')
  }
}

/**
 * Compute a deterministic hash of all .sql filenames in the migrations directory.
 * Used as a CustomResource property so CDK triggers an Update call whenever
 * new migration files are added (even if nothing else in the stack changed).
 */
function computeMigrationsHash(migrationsDir: string): string {
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')

  let files: string[] = []
  try {
    files = fs
      .readdirSync(migrationsDir)
      .filter((f: string) => f.endsWith('.sql'))
      .sort()
  } catch {
    // Directory doesn't exist yet (first synth before orchestrator is built)
    return 'no-migrations'
  }

  const hash = require('crypto') as typeof import('crypto')
  return hash
    .createHash('sha256')
    .update(files.join('\n'))
    .digest('hex')
    .slice(0, 12)
}

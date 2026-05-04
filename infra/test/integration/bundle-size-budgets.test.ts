/**
 * Phase 1-4 Performance Verification: Infrastructure
 *
 * Validates Phase 1-4 performance gates:
 * 1. Provisioned Concurrency status = READY (allocated=2, available=2)
 * 2. Daemon Fargate service desiredCount == runningCount == 1
 *
 * Requires AWS credentials. Skipped if ORBITAL_SKIP_AWS=1.
 *
 * Run: cd infra && npm test -- bundle-size-budgets
 */

import { Lambda as LambdaClient } from '@aws-sdk/client-lambda'
import { ECS, DescribeServicesCommand } from '@aws-sdk/client-ecs'

const SKIP_AWS = Boolean(process.env['ORBITAL_SKIP_AWS'])

const LAMBDA_FUNCTION_NAME = process.env['ORBITAL_TEST_LAMBDA_FUNCTION_NAME'] || 'orbital-mwitt-api'
const ECS_CLUSTER = process.env['ORBITAL_TEST_ECS_CLUSTER'] || 'orbital-mwitt-daemon'
const ECS_SERVICE = process.env['ORBITAL_TEST_ECS_SERVICE'] || 'orbital-mwitt-daemon'

const describeBlock = SKIP_AWS ? describe.skip : describe

describeBlock('Phase 1-4 infrastructure performance gates', () => {
  let lambdaClient: LambdaClient
  let ecsClient: ECS

  beforeAll(() => {
    lambdaClient = new LambdaClient({ region: 'us-east-1' })
    ecsClient = new ECS({ region: 'us-east-1' })
  })

  it('provisioned concurrency: status=READY, allocated=2, available=2', async () => {
    const response = await lambdaClient.listProvisionedConcurrencyConfigs({
      FunctionName: LAMBDA_FUNCTION_NAME,
    })

    const configs = response.ProvisionedConcurrencyConfigs || []
    expect(configs.length).toBeGreaterThan(0)

    const latest = configs[configs.length - 1]
    if (!latest) {
      throw new Error('No provisioned concurrency config found')
    }

    expect(latest.RequestedProvisionedConcurrentExecutions).toBe(2)
    expect(latest.AvailableProvisionedConcurrentExecutions).toBe(2)
    expect(latest.Status).toBe('READY')

    console.log(
      `Provisioned Concurrency: allocated=${latest.RequestedProvisionedConcurrentExecutions}, available=${latest.AvailableProvisionedConcurrentExecutions}, status=${latest.Status}`,
    )
  })

  it('daemon Fargate service: desiredCount == runningCount == 1', async () => {
    const cmd = new DescribeServicesCommand({
      cluster: ECS_CLUSTER,
      services: [ECS_SERVICE],
    })

    const response = await ecsClient.send(cmd)
    const services = response.services || []

    expect(services.length).toBe(1)

    const service = services[0]
    if (!service) {
      throw new Error('No service found')
    }

    expect(service.desiredCount).toBe(1)
    expect(service.runningCount).toBe(1)

    console.log(
      `Daemon Fargate service: desiredCount=${service.desiredCount}, runningCount=${service.runningCount}, status=${service.status}`,
    )
  })
})

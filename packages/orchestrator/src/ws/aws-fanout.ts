/**
 * ws/aws-fanout.ts — AWS API Gateway Management API fanout helper.
 *
 * [Engineer-Sr · Sonnet · run-round8-04-websocket-api]
 *
 * Hub-side helper: when ORBITAL_DEPLOY_TARGET='aws', this module replaces
 * the in-process WS broadcast with API GW Mgmt API calls.
 *
 * The existing ws/hub.ts stays in place for self-hosted mode.
 * Factory selection (in-process vs AWS) is based on ORBITAL_DEPLOY_TARGET:
 *   'aws'  → AWS fanout via this module (publish to SNS or direct DDB + APIGW)
 *   else   → In-process WebSocketHub / HubModeWebSocketHub
 *
 * Architecture (AWS mode):
 *   After store.append(), the event store calls broadcastEvent().
 *   broadcastEvent() either:
 *     (a) Publishes the event to SNS `orbital-events-${env}` (when SNS_TOPIC_ARN is set)
 *         → fanout Lambda picks it up asynchronously
 *     (b) Calls pushToWs() directly from lambda/ws/fanout.ts (for low-latency paths)
 *
 * The SNS path is the production path (decoupled, resilient).
 * The direct DynamoDB+APIGW path is the test-harness path.
 *
 * Tenant isolation:
 *   The event must carry tenant_id in payload (set by EventStore before calling
 *   broadcastEvent). The fanout Lambda validates tenant_id from DynamoDB, not
 *   from the SNS message attributes — defense in depth.
 */

import { SNSClient, PublishCommand } from '@aws-sdk/client-sns'
import { logger } from '../config/logger.js'
import type { EventEnvelope } from '@orbital/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AwsFanoutOptions {
  /**
   * SNS topic ARN for event fanout. If set, events are published to SNS.
   * The fanout Lambda processes them asynchronously.
   */
  snsTopicArn?: string

  /**
   * DynamoDB connections table name — used for direct-invoke path (tests).
   */
  connectionsTable?: string

  /**
   * AWS region.
   */
  region?: string
}

export interface IEventFanout {
  broadcastEvent(event: EventEnvelope): Promise<void>
}

// ---------------------------------------------------------------------------
// Module-scoped SNS client
// ---------------------------------------------------------------------------

let _snsClient: SNSClient | null = null

function getSnsClient(region: string): SNSClient {
  if (!_snsClient) {
    _snsClient = new SNSClient({ region })
  }
  return _snsClient
}

// ---------------------------------------------------------------------------
// AWS fanout implementation
// ---------------------------------------------------------------------------

/**
 * AwsEventFanout — publishes events to SNS for asynchronous WS fanout.
 *
 * The fanout Lambda is subscribed to the SNS topic and handles delivery
 * to connected WebSocket clients via API GW Management API.
 */
export class AwsEventFanout implements IEventFanout {
  private readonly snsTopicArn?: string
  private readonly connectionsTable?: string
  private readonly region: string

  constructor(opts: AwsFanoutOptions = {}) {
    this.snsTopicArn = opts.snsTopicArn ?? process.env['SNS_TOPIC_ARN']
    this.connectionsTable = opts.connectionsTable ?? process.env['CONNECTIONS_TABLE']
    this.region =
      opts.region ??
      process.env['AWS_REGION'] ??
      process.env['AWS_DEFAULT_REGION'] ??
      'us-east-1'
  }

  /**
   * Broadcast an event to all subscribed WebSocket clients for the event's tenant.
   *
   * SNS path (production): publish to SNS → fanout Lambda processes asynchronously.
   * Direct path (tests/fallback): call pushToWs() inline.
   */
  async broadcastEvent(event: EventEnvelope): Promise<void> {
    const payload = event.payload as Record<string, unknown>
    const tenantId = typeof payload['tenant_id'] === 'string' ? payload['tenant_id'] : undefined

    if (!tenantId) {
      logger.warn(
        { eventId: event.event_id, eventType: event.event_type },
        'aws-fanout: event has no tenant_id — skipping WS broadcast',
      )
      return
    }

    if (this.snsTopicArn) {
      await this.publishToSns(event, tenantId)
    } else if (this.connectionsTable) {
      await this.directFanout(event)
    } else {
      logger.warn(
        { eventId: event.event_id },
        'aws-fanout: no SNS_TOPIC_ARN or CONNECTIONS_TABLE — WS broadcast skipped',
      )
    }
  }

  private async publishToSns(event: EventEnvelope, tenantId: string): Promise<void> {
    const sns = getSnsClient(this.region)

    try {
      await sns.send(
        new PublishCommand({
          TopicArn: this.snsTopicArn,
          Message: JSON.stringify(event),
          // Message attributes for SNS subscription filter policies
          MessageAttributes: {
            tenant_id: {
              DataType: 'String',
              StringValue: tenantId,
            },
            event_type: {
              DataType: 'String',
              StringValue: event.event_type,
            },
            aggregate_type: {
              DataType: 'String',
              StringValue: event.aggregate_type,
            },
          },
        }),
      )

      logger.debug(
        { eventId: event.event_id, tenantId, topicArn: this.snsTopicArn },
        'aws-fanout: published to SNS',
      )
    } catch (err) {
      logger.error({ eventId: event.event_id, err }, 'aws-fanout: SNS publish failed')
      // Don't rethrow — fanout failure should not block the caller (event was
      // already persisted). The DLQ handles retry.
    }
  }

  private async directFanout(event: EventEnvelope): Promise<void> {
    // Direct path: call the fanout logic inline (no SNS involved).
    // Used in tests and for low-latency direct-invoke scenarios.
    const { pushToWs } = await import('../lambda/ws/fanout.js')
    await pushToWs(event, this.connectionsTable!)
  }
}

// ---------------------------------------------------------------------------
// No-op fanout (in-process / self-host mode — hub.ts handles delivery)
// ---------------------------------------------------------------------------

/**
 * NoopEventFanout — used in self-hosted mode.
 * The HubModeWebSocketHub handles fan-out directly via in-process WS connections.
 */
export class NoopEventFanout implements IEventFanout {
  async broadcastEvent(_event: EventEnvelope): Promise<void> {
    // No-op: in-process hub handles fanout
  }
}

// ---------------------------------------------------------------------------
// Factory — returns the right implementation based on ORBITAL_DEPLOY_TARGET
// ---------------------------------------------------------------------------

let _fanout: IEventFanout | null = null

/**
 * getEventFanout — factory that returns the correct IEventFanout implementation.
 *
 * - ORBITAL_DEPLOY_TARGET=aws → AwsEventFanout (SNS or direct path)
 * - otherwise → NoopEventFanout (in-process hub handles it)
 */
export function getEventFanout(opts?: AwsFanoutOptions): IEventFanout {
  if (_fanout) return _fanout

  const deployTarget = process.env['ORBITAL_DEPLOY_TARGET']

  if (deployTarget === 'aws') {
    _fanout = new AwsEventFanout(opts)
  } else {
    _fanout = new NoopEventFanout()
  }

  return _fanout
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

export function _resetFanoutForTests(): void {
  _fanout = null
  _snsClient = null
}

export function _setFanoutForTests(fanout: IEventFanout): void {
  _fanout = fanout
}

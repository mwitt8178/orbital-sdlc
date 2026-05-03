/**
 * SQS work queue consumer for the orchestrator daemon.
 *
 * Phase 2.6 of the migration: long-poll the daemon-work queue and
 * dispatch each message to the appropriate handler. Idempotent:
 * messages are deleted only after successful handling.
 *
 * Events arrive via SNS → SQS subscription with filter
 * `consumer=daemon`. The SNS message body is the event envelope
 * (see @orbital/types — eventually). For Phase 2 we accept any JSON
 * body and dispatch on `kind`.
 */

import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  type Message,
} from '@aws-sdk/client-sqs'
import type { Logger } from 'pino'
import { systemLogger } from './logger.js'
import { counter, duration } from './metrics-emf.js'

export interface SqsConsumerOptions {
  readonly queueUrl: string
  readonly client?: SQSClient
  readonly maxConcurrency?: number
  readonly waitTimeSeconds?: number
  readonly visibilityTimeoutSeconds?: number
}

export type EventHandler = (event: unknown, raw: Message) => Promise<void>

/**
 * Parse an SNS-via-SQS message. SNS wraps the original payload in a
 * notification envelope: `{ Type, MessageId, TopicArn, Message, ... }`.
 * With rawMessageDelivery=true (set in our DaemonFargateConstruct) the
 * MessageBody is the raw event, so we try both shapes.
 */
function parseSnsBody(body: string): unknown {
  try {
    const parsed = JSON.parse(body) as { Type?: string; Message?: string }
    if (parsed.Type === 'Notification' && typeof parsed.Message === 'string') {
      try {
        return JSON.parse(parsed.Message)
      } catch {
        return parsed.Message
      }
    }
    return parsed
  } catch {
    return body
  }
}

export class SqsConsumer {
  private running = false
  private inflight = new Set<Promise<void>>()
  private readonly logger: Logger
  private readonly client: SQSClient
  private readonly queueUrl: string
  private readonly maxConcurrency: number
  private readonly waitTimeSeconds: number
  private readonly visibilityTimeoutSeconds: number

  constructor(opts: SqsConsumerOptions) {
    this.queueUrl = opts.queueUrl
    this.client = opts.client ?? new SQSClient({})
    this.maxConcurrency = opts.maxConcurrency ?? 10
    this.waitTimeSeconds = opts.waitTimeSeconds ?? 20
    this.visibilityTimeoutSeconds = opts.visibilityTimeoutSeconds ?? 360
    this.logger = systemLogger.child({ component: 'sqs-consumer', queue: opts.queueUrl })
  }

  /**
   * Start the consumer loop. Long-polls in a tight loop until `stop()`.
   */
  async start(handler: EventHandler): Promise<void> {
    this.running = true
    this.logger.info({ maxConcurrency: this.maxConcurrency }, 'sqs-consumer: starting')
    while (this.running) {
      try {
        await this.tick(handler)
      } catch (err) {
        this.logger.error({ err }, 'sqs-consumer: tick failed; backing off 5s')
        await sleep(5000)
      }
    }
    // Drain in-flight handlers on shutdown
    if (this.inflight.size > 0) {
      this.logger.info({ inflight: this.inflight.size }, 'sqs-consumer: draining')
      await Promise.allSettled([...this.inflight])
    }
    this.logger.info('sqs-consumer: stopped')
  }

  stop(): void {
    this.running = false
  }

  private async tick(handler: EventHandler): Promise<void> {
    // Apply backpressure if we're at the concurrency limit
    while (this.inflight.size >= this.maxConcurrency && this.running) {
      await Promise.race(this.inflight)
    }

    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: Math.min(10, this.maxConcurrency - this.inflight.size),
        WaitTimeSeconds: this.waitTimeSeconds,
        VisibilityTimeout: this.visibilityTimeoutSeconds,
        MessageAttributeNames: ['All'],
        AttributeNames: ['ApproximateReceiveCount', 'SentTimestamp'],
      }),
    )

    const messages = result.Messages ?? []
    if (messages.length === 0) return

    counter('sqs.received', { queue: 'daemon-work' }, 'Orbital/Daemon')

    for (const msg of messages) {
      const promise = this.handleMessage(msg, handler).finally(() => {
        this.inflight.delete(promise)
      })
      this.inflight.add(promise)
    }
  }

  private async handleMessage(msg: Message, handler: EventHandler): Promise<void> {
    const t0 = Date.now()
    const messageId = msg.MessageId ?? 'unknown'
    const receiveCount = Number(msg.Attributes?.['ApproximateReceiveCount'] ?? '1')
    const log = this.logger.child({ messageId, receiveCount })

    if (!msg.Body) {
      log.warn('sqs-consumer: empty body, dropping')
      await this.deleteMessage(msg)
      return
    }
    if (!msg.ReceiptHandle) {
      log.warn('sqs-consumer: missing ReceiptHandle, cannot delete')
      return
    }

    let event: unknown
    try {
      event = parseSnsBody(msg.Body)
    } catch (err) {
      log.error({ err, body: msg.Body.slice(0, 200) }, 'sqs-consumer: parse failed; sending to DLQ')
      // Don't delete — let SQS redrive to DLQ after maxReceiveCount.
      await this.changeVisibility(msg, 0)
      return
    }

    log.debug({ event }, 'sqs-consumer: dispatching')
    try {
      await handler(event, msg)
      counter('sqs.handled', { queue: 'daemon-work' }, 'Orbital/Daemon')
      duration('sqs.handler_ms', Date.now() - t0, { queue: 'daemon-work' }, 'Orbital/Daemon')
      await this.deleteMessage(msg)
      log.info({ elapsed_ms: Date.now() - t0 }, 'sqs-consumer: handled')
    } catch (err) {
      counter('sqs.handler_failed', { queue: 'daemon-work' }, 'Orbital/Daemon')
      log.error({ err, elapsed_ms: Date.now() - t0 }, 'sqs-consumer: handler threw; redrive')
      // Surface failure to SQS so the message returns after visibility timeout
      // and eventually hits DLQ if it keeps failing.
      await this.changeVisibility(msg, 30)
    }
  }

  private async deleteMessage(msg: Message): Promise<void> {
    if (!msg.ReceiptHandle) return
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: msg.ReceiptHandle,
      }),
    )
  }

  private async changeVisibility(msg: Message, seconds: number): Promise<void> {
    if (!msg.ReceiptHandle) return
    try {
      await this.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: msg.ReceiptHandle,
          VisibilityTimeout: seconds,
        }),
      )
    } catch (err) {
      this.logger.warn({ err }, 'sqs-consumer: ChangeMessageVisibility failed')
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}

import {
  KeyExpr,
  type Publisher,
  type Sample,
  Session,
  type Subscriber,
  Config as ZenohTsConfig,
} from '@eclipse-zenoh/zenoh-ts'
import type { Config, SubscriptionConfig } from './config'

/**
 * Callback for received messages.
 * @param topic - The full Zenoh key expression
 * @param payload - The decoded payload (JSON object or raw string)
 * @param subConfig - The matching subscription configuration
 */
export type MessageHandler = (
  topic: string,
  payload: unknown,
  subConfig: SubscriptionConfig
) => void | Promise<void>

/**
 * ZenohClient manages the Zenoh session, subscriptions (consumer),
 * and publishing (producer).
 */
export class ZenohClient {
  private session: Session | null = null
  private readonly config: Config
  private subscribers: Subscriber[] = []
  private publisher: Publisher | null = null

  constructor(config: Config) {
    this.config = config
  }

  /**
   * Open a session to the Zenoh router.
   */
  async connect(): Promise<void> {
    const zenohConfig = new ZenohTsConfig(this.config.zenoh.routerUrl)
    this.session = await Session.open(zenohConfig)
  }

  /**
   * Whether the session is currently open.
   */
  isConnected(): boolean {
    return this.session !== null && !this.session.isClosed()
  }

  /**
   * Subscribe to all configured topics and call the handler for each message.
   */
  async subscribeAll(handler: MessageHandler): Promise<void> {
    if (this.session === null) throw new Error('Not connected')

    for (const subConfig of this.config.subscriptions) {
      const prefix = this.config.zenoh.topicPrefix
      const topic =
        prefix !== undefined && prefix !== '' ? `${prefix}/${subConfig.topic}` : subConfig.topic

      const sub = await this.session.declareSubscriber(new KeyExpr(topic), {
        handler: (sample: Sample) => {
          const fullTopic = sample.keyexpr().toString()
          const payload = this.decodePayload(sample)
          void handler(fullTopic, payload, subConfig)
        },
      })
      this.subscribers.push(sub)
    }
  }

  /**
   * Initialize the producer publisher (if producer is enabled in config).
   */
  async initProducer(): Promise<void> {
    if (this.session === null) throw new Error('Not connected')

    const producerConfig = this.config.producer
    if (producerConfig?.enabled !== true) {
      return
    }

    this.publisher = await this.session.declarePublisher(new KeyExpr(producerConfig.topic))
  }

  /**
   * Publish a raw string (e.g. CoT XML) to the producer topic.
   * If a topic override is provided, publish to that topic instead
   * (using a session-level put rather than the pre-declared publisher).
   */
  async publish(data: string, topic?: string): Promise<void> {
    if (topic !== undefined) {
      if (this.session === null) return
      await this.session.put(new KeyExpr(topic), data)
      return
    }
    if (this.publisher === null) return
    await this.publisher.put(data)
  }

  /**
   * Close all subscriptions, publisher, and the session.
   */
  async close(): Promise<void> {
    if (this.session === null) return

    for (const sub of this.subscribers) {
      try {
        await sub.undeclare()
      } catch {
        // ignore
      }
    }
    this.subscribers = []

    if (this.publisher !== null) {
      try {
        await this.publisher.undeclare()
      } catch {
        // ignore
      }
      this.publisher = null
    }

    try {
      await this.session.close()
    } catch {
      // ignore
    }
    this.session = null
  }

  /**
   * Decode a Sample payload: try JSON, fallback to string.
   */
  private decodePayload(sample: Sample): unknown {
    const text = sample.payload().toString()
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
}

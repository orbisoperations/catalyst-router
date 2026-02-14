import { CoTParser } from '@tak-ps/node-cot'
import {
  parseConfig,
  type Config,
  type EmulatorPublisherConfig,
  type SubscriptionConfig,
} from './config'
import { getEmulator, initEmulatorRegistry, listEmulators } from './emulators/registry'
import { createSimulator } from './emulators/simulation-engine'
import type { CoTSimulator } from './emulators/types'
import { TakClient } from './tak-client'
import { destroyAllPlugins, getPlugin, initAllPlugins, initTransforms } from './transforms/registry'
import { createTransformLogger, type TransformContext } from './transforms/types'
import { ZenohClient } from './zenoh-client'

function loadConfig(): Config {
  return parseConfig()
}

async function initTransformsSafe(config: Config): Promise<void> {
  try {
    await initTransforms(config.transformsDir)
    await initAllPlugins()
  } catch (e) {
    throw new Error('Failed to initialize transforms', { cause: e })
  }
}

async function createAndConnectTakClient(config: Config): Promise<TakClient> {
  const takClient = new TakClient(config)
  try {
    await takClient.init()
  } catch (e) {
    throw new Error('Failed to connect to TAK Server', { cause: e })
  }
  return takClient
}

async function createAndConnectZenohClient(config: Config): Promise<ZenohClient> {
  const zenohClient = new ZenohClient(config)
  try {
    await zenohClient.connect()
  } catch (e) {
    throw new Error('Failed to connect to Zenoh router', { cause: e })
  }
  return zenohClient
}

async function handleZenohMessage(
  topic: string,
  payload: unknown,
  subConfig: SubscriptionConfig,
  config: Config,
  transformCache: Map<string, unknown>,
  takClient: TakClient | null
): Promise<void> {
  console.log(
    `handleZenohMessage(): topic='${topic}' payload='${JSON.stringify(payload).substring(0, 10)}...'`
  )
  const plugin = getPlugin(subConfig.transform)
  if (plugin === undefined) {
    console.warn(`Transform '${subConfig.transform}' not found for topic ${subConfig.topic}`)
    return
  }

  if (plugin.validate?.(payload) === false) {
    console.warn(
      `Transform '${subConfig.transform}' validation failed for topic ${subConfig.topic}`
    )
    return
  }

  const ctx: TransformContext = {
    topic,
    timestamp: new Date(),
    config: subConfig,
    logger: createTransformLogger(plugin.name, config.logLevel),
    cache: transformCache,
  }

  try {
    const cot = await plugin.transform(payload, ctx)
    console.debug(`handleZenohMessage(): cot='${cot?.uid()}' ${cot?.type()}`)
    if (cot !== null && takClient?.connected) {
      console.log('handleZenohMessage(): writing CoT to TAK')
      await takClient.write([cot])
    }
  } catch (e) {
    console.error(`Error in transform '${subConfig.transform}' for topic ${topic}`, e)
  }
}

async function runConsumer(
  zenohClient: ZenohClient,
  takClient: TakClient | null,
  config: Config
): Promise<void> {
  console.log('runConsumer(): starting...')
  const transformCache = new Map<string, unknown>()

  await zenohClient.subscribeAll(async (topic, payload, subConfig) => {
    await handleZenohMessage(topic, payload, subConfig, config, transformCache, takClient)
  })

  if (config.subscriptions.length > 0) {
    console.log(`Consumer: subscribed to ${config.subscriptions.length} topic(s)`)
    console.log(config.subscriptions.map((s) => `${s.topic} -> ${s.transform}`))
  } else {
    console.warn('Consumer: no subscriptions configured')
  }
}

/** Start a publish loop for a simulator on a given Zenoh topic. */
function startEmulatorPublishLoop(
  zenohClient: ZenohClient,
  sim: CoTSimulator,
  pub: EmulatorPublisherConfig
): void {
  let count = 0
  const sendData = async (): Promise<void> => {
    const cots = sim.next()
    for (const cot of cots) {
      try {
        await zenohClient.publish(CoTParser.to_xml(cot), pub.topic)
      } catch (e) {
        console.error(`Failed to publish CoT to Zenoh topic '${pub.topic}'`, e)
      }
    }
    count++
    if (count > 1 && count % 15 === 0) {
      console.log(
        `Emulator(${pub.emulator}): topic='${pub.topic}' count='${count}' intervalMs='${pub.intervalMs}'`
      )
    }
    setTimeout(() => {
      sendData().catch(console.error)
    }, pub.intervalMs)
  }
  setTimeout(() => {
    sendData().catch(console.error)
  }, pub.intervalMs)
}

/**
 * Build the effective emulator publishers list.
 * Handles both the new EMULATOR_PUBLISHERS config and the deprecated
 * PUBLISH_ZENO_TOPIC_EMULATOR / PUBLISH_WIESBADEN_EMULATOR env vars.
 */
function resolveEmulatorPublishers(config: Config): EmulatorPublisherConfig[] {
  // New system takes precedence
  if (config.emulatorPublishers.length > 0) {
    return config.emulatorPublishers
  }
  console.error('No emulator publishers configured')
  return []
}

async function runProducer(
  zenohClient: ZenohClient,
  takClient: TakClient | null,
  config: Config
): Promise<void> {
  if (config.producer?.enabled === true) {
    await zenohClient.initProducer()
    console.log(`Producer: publishing TAK CoTs to Zenoh topic '${config.producer.topic}'`)
  }

  const emulatorPubs = resolveEmulatorPublishers(config)

  if (emulatorPubs.length > 0) {
    for (const pub of emulatorPubs) {
      // New registry-based emulators
      const emulatorConfig = getEmulator(pub.emulator)
      if (emulatorConfig === undefined) {
        console.error(
          `Emulator '${pub.emulator}' not found. Available: ${listEmulators().join(', ')}`
        )
        continue
      }

      const sim = createSimulator(emulatorConfig)
      console.log(
        `Producer: emulator '${pub.emulator}' (${emulatorConfig.totalUnits} units) -> topic '${pub.topic}' @ ${pub.intervalMs}ms`
      )
      startEmulatorPublishLoop(zenohClient, sim, pub)
    }
    return
  }

  if (takClient === null) {
    console.error(
      'Producer: enabled but no TAK config provided and no emulators configured. ' +
        'Set TAK_HOST or EMULATOR_PUBLISHERS to produce data.'
    )
    return
  }

  takClient.start({
    onCoT: async (cot): Promise<void> => {
      if (config.producer?.enabled === true) {
        try {
          const xml = CoTParser.to_xml(cot)
          await zenohClient.publish(xml)
        } catch (e) {
          console.error('Failed to publish CoT to Zenoh', e)
        }
      }
    },
    onPing: async (): Promise<void> => {
      // TAK ping received
    },
  })
}

function registerShutdown(zenohClient: ZenohClient, takClient: TakClient | null): void {
  const shutdown = async (): Promise<void> => {
    console.log('Shutting down...')
    try {
      await zenohClient.close()
      takClient?.stop()
      await destroyAllPlugins()
    } catch (e) {
      console.error('Error during shutdown', e)
    }
    process.exit(0)
  }

  process.on('SIGINT', () => {
    shutdown().catch(console.error)
  })
  process.on('SIGTERM', () => {
    shutdown().catch(console.error)
  })
}

async function main(): Promise<void> {
  console.log('Starting Zeno TAK Adapter v2...')

  const config = loadConfig()
  await initTransformsSafe(config)
  await initEmulatorRegistry()

  const takClient = config.tak !== undefined ? await createAndConnectTakClient(config) : null

  if (takClient === null) {
    console.log('TAK config not provided -- running without TAK connection')
  }

  const zenohClient = await createAndConnectZenohClient(config)
  console.log('Connected to Zenoh router')

  await runConsumer(zenohClient, takClient, config)
  await runProducer(zenohClient, takClient, config)

  registerShutdown(zenohClient, takClient)
  console.log('Zeno TAK Adapter v2 started successfully')
}

main().catch((e) => {
  console.error('Unhandled error in main', e)
  process.exit(1)
})

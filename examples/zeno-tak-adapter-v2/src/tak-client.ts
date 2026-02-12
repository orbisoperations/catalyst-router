import { CoTParser } from '@tak-ps/node-cot'
import TAK, { type CoT } from '@tak-ps/node-tak'
import * as fs from 'fs'
import { URL } from 'url'
import { type Config } from './config'

/**
 * Interface for TAK client - allows mocking in tests.
 */
export interface ITakClient {
  /** Write a CoT event to the TAK server */
  write(cots: CoT[]): void | Promise<void>
  /** Whether the client is connected */
  connected: boolean
}

/**
 * Read cert content from file path or inline string.
 */
function readCertContent(pathOrContent?: string): string | undefined {
  if (pathOrContent === undefined) {
    return undefined
  }
  try {
    if (fs.existsSync(pathOrContent)) {
      return fs.readFileSync(pathOrContent, 'utf8')
    }
  } catch {
    // ignore, assume content
  }
  return pathOrContent
}

/**
 * CoT helper. Generate a cot that is for a Contact and location on the map.
 */
function generateCallsignHeartbeatCoT({
  callsignUid,
  callsign,
  intervalMs,
  groupRole = 'Team Member',
  groupName = 'Dark Blue',
  lat = 9999999.0,
  lon = 9999999.0,
  ce = 9999999.0,
  hae = 9999999.0,
  le = 9999999.0,
}: {
  callsignUid: string
  callsign: string
  intervalMs: number
  groupRole?: string
  groupName?: string
  lat?: number
  lon?: number
  ce?: number
  hae?: number
  le?: number
}): CoT {
  const now = new Date()
  const stale = new Date(now.getTime() + intervalMs)
  return CoTParser.from_xml(`
        <event version="2.0"
            uid="${callsignUid}"
            type="a-f-G-U-C"
            how="m-g"
            time="${now.toISOString()}"
            start="${now.toISOString()}"
            stale="${stale.toISOString()}">
            <point lat="${lat}" lon="${lon}" hae="${hae}" ce="${ce}" le="${le}"/>
            <detail>
                <__group name="${groupName}" role="${groupRole}"/>
                <takv device="GENERIC" platform="Catalyst-TAK" os="0" version="0"/>
                <contact callsign="${callsign}" endpoint="*:-1:stcp"/>
                <uid Droid="${callsign}"/>
                <remarks>Contact sharing</remarks>
            </detail>
        </event>`)
}

/**
 * Real TAK client that connects via SSL/TLS.
 */
export class TakClient implements ITakClient {
  tak?: TAK
  config: Config
  connected: boolean = false
  private reconnecting: boolean = false
  private pingTimeout: ReturnType<typeof setTimeout> | null = null
  private onCoTCallback?: (cot: CoT) => Promise<void>

  constructor(config: Config) {
    this.config = config
  }

  async init(): Promise<void> {
    if (!this.config.tak) throw new Error('TAK config not provided')
    const { host, port, tls, connectionId } = this.config.tak
    const takUrl = new URL(`ssl://${host}:${port}`)

    console.log(`Connecting to TAK Server at ${takUrl.toString()}`)

    const cert = readCertContent(tls?.cert)
    const key = readCertContent(tls?.key)
    const ca = readCertContent(tls?.ca)

    if (!cert || !key) {
      throw new Error(
        'TAK TLS client auth requires TAK_TLS_CERT and TAK_TLS_KEY. ' +
          'One or both are missing or empty. See .env.example for setup.'
      )
    }

    this.tak = await TAK.connect(
      takUrl,
      {
        key,
        cert,
        ca,
        passphrase:
          tls?.passphrase !== undefined && tls.passphrase !== '' ? tls.passphrase : undefined,
        rejectUnauthorized: tls?.rejectUnauthorized === true,
      },
      {
        id: connectionId,
      }
    )

    this.tak
      .on('end', () => {
        void this.reconnect()
      })
      .on('timeout', () => {
        void this.reconnect()
      })
      .on('error', (err: Error) => {
        console.error('TAKClient error:', err)
        void this.reconnect()
      })

    this.connected = true
    this.resetPingTimeout()
  }

  start(hooks: { onCoT?: (cot: CoT) => Promise<void>; onPing?: () => Promise<void> }): void {
    if (!this.tak) throw new Error('TAK not initialized')
    if (!this.config.tak) throw new Error('TAK config not provided')

    this.onCoTCallback = hooks.onCoT

    this.tak
      .on('cot', (cot: CoT): void => {
        if (hooks.onCoT) {
          try {
            void hooks.onCoT(cot)
          } catch (e) {
            console.error('Error processing CoT', e)
          }
        }
      })
      .on('ping', () => {
        this.resetPingTimeout()
        if (hooks.onPing)
          hooks.onPing().catch((e) => {
            console.error('Error processing Ping', e)
          })
      })

    // set a heartbeat interval to send a heartbeat CoT every 10 seconds of this adapter
    // the cot type is callsign heartbeat
    console.log(
      `[TAKClient] Setting up callsign heartbeat interval every ${this.config.tak.heartbeat.intervalMs}ms`
    )
    setInterval(() => {
      if (!this.config.tak) throw new Error('TAK config not provided')
      const cot = generateCallsignHeartbeatCoT({
        callsignUid: this.config.tak.heartbeat.callsignUid,
        callsign: this.config.tak.heartbeat.callsign,
        intervalMs: this.config.tak.heartbeat.intervalMs,
        groupRole: this.config.tak.heartbeat.groupRole,
        groupName: this.config.tak.heartbeat.groupName,
      })
      this.tak?.write([cot]).catch((e) => {
        console.error('Error writing heartbeat CoT', e)
      })
    }, this.config.tak.heartbeat.intervalMs)
  }

  async write(cots: CoT[]): Promise<void> {
    if (this.tak) {
      await this.tak.write(cots)
    }
  }

  stop(): void {
    this.connected = false
    this.reconnecting = false
    if (this.pingTimeout) clearTimeout(this.pingTimeout)
    try {
      this.tak?.removeAllListeners('cot')
      this.tak?.removeAllListeners('ping')
      this.tak?.destroy()
    } catch {
      // ignore
    }
  }

  private resetPingTimeout(): void {
    if (this.pingTimeout !== null) clearTimeout(this.pingTimeout)
    this.pingTimeout = setTimeout(() => {
      void this.reconnect()
    }, 120_000)
  }

  private async reconnect(): Promise<void> {
    if (this.connected === false || this.reconnecting === true) return
    this.reconnecting = true

    await new Promise<void>((r) => {
      setTimeout(r, 5000)
    })

    this.reconnecting = false
    // Re-read after await; stop() may have set connected to false from another tick.
    const stillConnected = this.connected as boolean
    if (stillConnected === false) {
      return
    }

    try {
      const tak = this.tak
      if (tak && typeof tak.reconnect === 'function') {
        await tak.reconnect()
      }
    } catch (e) {
      console.error('TAK reconnect error', e)
    }

    this.reconnecting = false
  }
}

// if (import.meta.main) {
//     const config = parseConfig();
//     const takClient = new TakClient(config);
//     await takClient.init();
//     await takClient.start({});
// }

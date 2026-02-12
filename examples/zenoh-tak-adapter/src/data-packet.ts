/**
 * Radar track data packet type.
 *
 * Matches the DataPacket published by zenoh-radar-publisher.
 */

export interface DataPacket {
  latitude: number
  longitude: number
  altitude: number
  speed: number
  heading: number
  timestamp: number
}

/** Best-effort parse of a DataPacket from a raw string/buffer. */
export function parseDataPacket(raw: string): DataPacket | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (
      typeof parsed.latitude === 'number' &&
      typeof parsed.longitude === 'number' &&
      typeof parsed.altitude === 'number' &&
      typeof parsed.speed === 'number' &&
      typeof parsed.heading === 'number' &&
      typeof parsed.timestamp === 'number'
    ) {
      return parsed as unknown as DataPacket
    }
    return undefined
  } catch {
    return undefined
  }
}

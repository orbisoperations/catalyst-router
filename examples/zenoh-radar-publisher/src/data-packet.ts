/**
 * Radar track data packet schema and generator.
 *
 * Adapted from red-team-repo apps/base-app-template/emulator.ts.
 * Self-contained — no cross-repo dependencies.
 */

export interface DataPacket {
  latitude: number
  longitude: number
  altitude: number
  speed: number
  heading: number
  timestamp: number
}

/** Generate a random float in [min, max). */
function randomFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min
}

/** Generate a random integer in [min, max]. */
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/** Generate a fake radar DataPacket with random values. */
export function generateDataPacket(): DataPacket {
  return {
    latitude: randomFloat(-90, 90),
    longitude: randomFloat(-180, 180),
    altitude: randomInt(0, 10_000),
    speed: randomInt(0, 1_000),
    heading: randomInt(0, 360),
    timestamp: Date.now(),
  }
}

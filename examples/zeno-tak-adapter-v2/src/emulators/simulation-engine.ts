import { CoTFactory } from './cot-factory'
import type { CoTSimulator, EmulatorRegionConfig, LatLon, SimUnit, UnitProfile } from './types'
import { moveCoordinate } from './utils'

// ── Geodesic helpers ─────────────────────────────────────────────────────────

function toRad(d: number): number {
  return (d * Math.PI) / 180
}

function toDeg(r: number): number {
  return (r * 180) / Math.PI
}

/** Bearing (degrees 0=N clockwise) from one point to another. */
export function bearingBetween(from: LatLon, to: LatLon): number {
  const dLon = toRad(to.lon - from.lon)
  const lat1 = toRad(from.lat)
  const lat2 = toRad(to.lat)

  const y = Math.sin(dLon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  return ((toDeg(Math.atan2(y, x)) % 360) + 360) % 360
}

/** Great-circle distance in meters between two points. */
export function haversineMeters(a: LatLon, b: LatLon): number {
  const R = 6_378_137

  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const sinHalfDLat = Math.sin(dLat / 2)
  const sinHalfDLon = Math.sin(dLon / 2)
  const h =
    sinHalfDLat * sinHalfDLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinHalfDLon * sinHalfDLon
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** Add small random offset to a position (scatter radius in meters). */
export function jitter(pos: LatLon, radiusMeters: number): LatLon {
  const bearing = Math.random() * 360
  const dist = Math.random() * radiusMeters
  return moveCoordinate(pos, dist, bearing)
}

/** Random float in [min, max). */
export function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

// ── Unit stepping ────────────────────────────────────────────────────────────

/**
 * Advance a unit one tick along its patrol route.
 *
 * Movement logic:
 *  1. Compute ideal bearing toward next waypoint.
 *  2. Add small bearing noise for realism.
 *  3. Pick a random speed within the unit's profile range.
 *  4. Move geodesically by that distance at that bearing.
 *  5. If within threshold of the next waypoint, advance to the one after it.
 */
export function stepUnit(unit: SimUnit): void {
  const target = unit.route[unit.waypointIdx]
  const distToTarget = haversineMeters(unit.pos, target)

  const speed = randRange(unit.profile.speedRange.min, unit.profile.speedRange.max)

  const arrivalThreshold = speed * 3
  if (distToTarget < arrivalThreshold) {
    unit.waypointIdx = (unit.waypointIdx + 1) % unit.route.length
  }

  const idealBearing = bearingBetween(unit.pos, unit.route[unit.waypointIdx])

  const noise = randRange(-unit.profile.bearingNoiseDeg, unit.profile.bearingNoiseDeg)
  const actualBearing = (((idealBearing + noise) % 360) + 360) % 360

  unit.pos = moveCoordinate(unit.pos, speed, actualBearing)
  unit.bearingDeg = actualBearing

  const altDrift = randRange(-0.5, 0.5)
  unit.altitude = Math.max(
    unit.profile.altitude.base - unit.profile.altitude.variance,
    Math.min(unit.profile.altitude.base + unit.profile.altitude.variance, unit.altitude + altDrift)
  )
}

// ── Simulator factory ────────────────────────────────────────────────────────

/**
 * Create a simulator from a region config.
 *
 * Uses CoTFactory.generateProfiles() to produce the hybrid random profiles,
 * then spawns units along those profiles' routes.
 *
 * Call `next()` each tick to advance all units and get CoT events.
 */
export function createSimulator(config: EmulatorRegionConfig): CoTSimulator {
  const profiles: UnitProfile[] = CoTFactory.generateProfiles(config)
  const units: SimUnit[] = []

  for (let i = 0; i < config.totalUnits; i++) {
    const profile = profiles[i % profiles.length]
    const route = profile.routes[i % profile.routes.length]
    const startPos = jitter(route[0], 200)

    units.push({
      callsign: `${profile.callsignPrefix}-${i.toString().padStart(2, '0')}`,
      uid: `${config.name}-${profile.callsignPrefix.toLowerCase()}-${i.toString().padStart(2, '0')}`,
      profile,
      route,
      waypointIdx: 1 % route.length,
      pos: startPos,
      bearingDeg: route.length > 1 ? bearingBetween(startPos, route[1 % route.length]) : 0,
      altitude:
        profile.altitude.base + randRange(-profile.altitude.variance, profile.altitude.variance),
    })
  }

  console.log(`[${config.name}] initialized ${units.length} units (${config.description})`)

  return {
    next: () =>
      units.map((unit) => {
        stepUnit(unit)
        return CoTFactory.createUnitCoT(unit, config.name)
      }),
  }
}

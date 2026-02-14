import { CoT } from '@tak-ps/node-tak'
import { moveCoordinate } from './utils'

// ── Wiesbaden area coordinates ──────────────────────────────────────────────
// Center: Wiesbaden, Germany  ~50.08°N, 8.24°E

type LatLon = { lat: number; lon: number }

/** Points of interest around Wiesbaden for waypoint-based patrol routes. */
const WP = {
  // City & infrastructure
  cityCenter: { lat: 50.0782, lon: 8.2397 },
  hauptbahnhof: { lat: 50.0707, lon: 8.2434 },
  biebrich: { lat: 50.0374, lon: 8.2308 },
  kastel: { lat: 50.0069, lon: 8.2819 },
  schierstein: { lat: 50.0442, lon: 8.1838 },

  // US Military installations (Lucius D. Clay Kaserne / Wiesbaden Army Airfield)
  clayKaserne: { lat: 50.0498, lon: 8.3254 },
  armyAirfield: { lat: 50.049, lon: 8.334 },

  // Surrounding towns
  mainz: { lat: 50.0, lon: 8.2711 },
  taunusstein: { lat: 50.1438, lon: 8.1528 },
  eltville: { lat: 50.0283, lon: 8.1172 },
  hochheim: { lat: 50.0131, lon: 8.3531 },

  // Rhine river waypoints (west bank → east bank)
  rhineWest: { lat: 50.035, lon: 8.215 },
  rhineEast: { lat: 50.01, lon: 8.29 },

  // Northern hills (Taunus)
  neroberg: { lat: 50.0963, lon: 8.2317 },
  sonnenberg: { lat: 50.105, lon: 8.27 },
  rambach: { lat: 50.115, lon: 8.2 },
} as const satisfies Record<string, LatLon>

// ── Unit profiles ───────────────────────────────────────────────────────────

type UnitProfile = {
  /** NATO 2525C CoT type code */
  cotType: string
  /** Human-readable callsign prefix */
  callsignPrefix: string
  /** Movement speed range in meters per tick */
  speedRange: { min: number; max: number }
  /** Altitude (HAE meters) */
  altitude: { base: number; variance: number }
  /** How aggressively the unit can deviate from ideal heading (degrees) */
  bearingNoiseDeg: number
  /** Closed-loop patrol routes */
  routes: LatLon[][]
}

const PROFILES: UnitProfile[] = [
  // Friendly infantry foot patrols
  {
    cotType: 'a-f-G-U-C-I',
    callsignPrefix: 'ALPHA',
    speedRange: { min: 1, max: 4 },
    altitude: { base: 115, variance: 5 },
    bearingNoiseDeg: 12,
    routes: [
      [WP.clayKaserne, WP.armyAirfield, WP.kastel, WP.clayKaserne],
      [WP.cityCenter, WP.hauptbahnhof, WP.biebrich, WP.cityCenter],
    ],
  },

  // Friendly armored vehicles
  {
    cotType: 'a-f-G-U-C-A',
    callsignPrefix: 'BRAVO',
    speedRange: { min: 8, max: 25 },
    altitude: { base: 110, variance: 3 },
    bearingNoiseDeg: 6,
    routes: [
      [WP.clayKaserne, WP.mainz, WP.kastel, WP.biebrich, WP.clayKaserne],
      [WP.armyAirfield, WP.hochheim, WP.mainz, WP.kastel, WP.armyAirfield],
    ],
  },

  // Friendly reconnaissance
  {
    cotType: 'a-f-G-U-C-R',
    callsignPrefix: 'CHARLIE',
    speedRange: { min: 5, max: 15 },
    altitude: { base: 120, variance: 8 },
    bearingNoiseDeg: 10,
    routes: [
      [WP.neroberg, WP.taunusstein, WP.eltville, WP.rhineWest, WP.biebrich, WP.neroberg],
      [WP.sonnenberg, WP.rambach, WP.neroberg, WP.cityCenter, WP.sonnenberg],
    ],
  },

  // Friendly helicopters
  {
    cotType: 'a-f-A-M-H',
    callsignPrefix: 'DUSTOFF',
    speedRange: { min: 30, max: 80 },
    altitude: { base: 300, variance: 150 },
    bearingNoiseDeg: 15,
    routes: [
      [WP.armyAirfield, WP.mainz, WP.eltville, WP.taunusstein, WP.armyAirfield],
      [WP.armyAirfield, WP.neroberg, WP.sonnenberg, WP.kastel, WP.armyAirfield],
    ],
  },

  // Friendly fixed wing
  {
    cotType: 'a-f-A-M-F',
    callsignPrefix: 'VIPER',
    speedRange: { min: 60, max: 150 },
    altitude: { base: 2000, variance: 500 },
    bearingNoiseDeg: 4,
    routes: [
      [WP.armyAirfield, WP.taunusstein, WP.eltville, WP.mainz, WP.hochheim, WP.armyAirfield],
    ],
  },

  // Friendly ground vehicles
  {
    cotType: 'a-f-G-E-V',
    callsignPrefix: 'EAGLE',
    speedRange: { min: 6, max: 18 },
    altitude: { base: 112, variance: 3 },
    bearingNoiseDeg: 8,
    routes: [
      [WP.clayKaserne, WP.cityCenter, WP.schierstein, WP.biebrich, WP.clayKaserne],
      [WP.hauptbahnhof, WP.kastel, WP.mainz, WP.biebrich, WP.hauptbahnhof],
    ],
  },

  // Hostile ground (simulated OPFOR across the Rhine)
  {
    cotType: 'a-h-G-U-C-I',
    callsignPrefix: 'OPFOR',
    speedRange: { min: 2, max: 8 },
    altitude: { base: 118, variance: 4 },
    bearingNoiseDeg: 14,
    routes: [
      [WP.eltville, WP.rhineWest, WP.schierstein, WP.eltville],
      [WP.mainz, WP.rhineEast, WP.kastel, WP.mainz],
    ],
  },

  // Unknown ground contacts
  {
    cotType: 'a-u-G',
    callsignPrefix: 'UNKNOWN',
    speedRange: { min: 1, max: 6 },
    altitude: { base: 112, variance: 6 },
    bearingNoiseDeg: 20,
    routes: [[WP.rhineEast, WP.kastel, WP.mainz, WP.rhineEast]],
  },
]

// ── Simulation internals ────────────────────────────────────────────────────

type SimUnit = {
  callsign: string
  uid: string
  profile: UnitProfile
  /** The closed-loop route this unit follows */
  route: LatLon[]
  /** Index of the *next* waypoint the unit is heading toward */
  waypointIdx: number
  pos: LatLon
  bearingDeg: number
  altitude: number
}

const TOTAL_UNITS = 24

function toRad(d: number): number {
  return (d * Math.PI) / 180
}
function toDeg(r: number): number {
  return (r * 180) / Math.PI
}

/** Bearing (degrees 0=N clockwise) from one point to another. */
function bearingBetween(from: LatLon, to: LatLon): number {
  const dLon = toRad(to.lon - from.lon)
  const lat1 = toRad(from.lat)
  const lat2 = toRad(to.lat)

  const y = Math.sin(dLon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  return ((toDeg(Math.atan2(y, x)) % 360) + 360) % 360
}

/** Great-circle distance in meters between two points. */
function haversineMeters(a: LatLon, b: LatLon): number {
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
function jitter(pos: LatLon, radiusMeters: number): LatLon {
  const bearing = Math.random() * 360
  const dist = Math.random() * radiusMeters
  return moveCoordinate(pos, dist, bearing)
}

/** Random float in [min, max). */
function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

/**
 * Advance a unit one tick along its patrol route.
 *
 * Movement logic:
 *  1. Compute ideal bearing toward next waypoint.
 *  2. Add small bearing noise for realism (simulates road curves, terrain).
 *  3. Pick a random speed within the unit's profile range.
 *  4. Move geodesically by that distance at that bearing.
 *  5. If within threshold of the next waypoint, advance to the one after it.
 */
function stepUnit(unit: SimUnit): void {
  const target = unit.route[unit.waypointIdx]
  const distToTarget = haversineMeters(unit.pos, target)

  // Speed for this tick (meters)
  const speed = randRange(unit.profile.speedRange.min, unit.profile.speedRange.max)

  // If we're close enough to the waypoint, snap toward it and advance
  const arrivalThreshold = speed * 3 // arrive when within ~3 ticks
  if (distToTarget < arrivalThreshold) {
    unit.waypointIdx = (unit.waypointIdx + 1) % unit.route.length
  }

  // Ideal bearing toward current target waypoint
  const idealBearing = bearingBetween(unit.pos, unit.route[unit.waypointIdx])

  // Add realistic noise: small random deviation from the ideal heading
  const noise = randRange(-unit.profile.bearingNoiseDeg, unit.profile.bearingNoiseDeg)
  const actualBearing = (((idealBearing + noise) % 360) + 360) % 360

  // Move
  unit.pos = moveCoordinate(unit.pos, speed, actualBearing)
  unit.bearingDeg = actualBearing

  // Gentle altitude drift
  const altDrift = randRange(-0.5, 0.5)
  unit.altitude = Math.max(
    unit.profile.altitude.base - unit.profile.altitude.variance,
    Math.min(unit.profile.altitude.base + unit.profile.altitude.variance, unit.altitude + altDrift)
  )
}

/** Convert a SimUnit into a TAK CoT event. */
function unitToCoT(unit: SimUnit): CoT {
  const now = new Date()
  const stale = new Date(now.getTime() + 10_000)

  return new CoT({
    event: {
      _attributes: {
        version: '2.0',
        uid: unit.uid,
        type: unit.profile.cotType,
        time: now.toISOString(),
        start: now.toISOString(),
        stale: stale.toISOString(),
        how: 'm-g', // machine-generated
      },
      point: {
        _attributes: {
          lat: unit.pos.lat,
          lon: unit.pos.lon,
          hae: unit.altitude,
          ce: 10,
          le: 10,
        },
      },
      detail: {
        contact: {
          _attributes: {
            callsign: unit.callsign,
          },
        },
        track: {
          _attributes: {
            course: unit.bearingDeg.toFixed(1),
            speed: ((unit.profile.speedRange.min + unit.profile.speedRange.max) / 2).toFixed(1),
          },
        },
        remarks: {
          _text: `Simulated unit ${unit.callsign} near Wiesbaden, DE`,
        },
      },
    },
  })
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialize the Wiesbaden area simulator.
 *
 * Spawns {@link TOTAL_UNITS} units distributed across the available profiles,
 * each following a closed-loop patrol route through real Wiesbaden landmarks.
 *
 * Call `next()` on each tick to advance all units one step and get back the
 * corresponding CoT events ready for publishing.
 */
export function initializeWiesbadenSim(): { next: () => CoT[] } {
  const units: SimUnit[] = []

  for (let i = 0; i < TOTAL_UNITS; i++) {
    const profile = PROFILES[i % PROFILES.length]
    const route = profile.routes[i % profile.routes.length]
    const startPos = jitter(route[0], 200) // scatter starts ~200 m from waypoint

    units.push({
      callsign: `${profile.callsignPrefix}-${i.toString().padStart(2, '0')}`,
      uid: `wiesbaden-${profile.callsignPrefix.toLowerCase()}-${i.toString().padStart(2, '0')}`,
      profile,
      route,
      waypointIdx: 1, // head toward second waypoint from the start
      pos: startPos,
      bearingDeg: bearingBetween(startPos, route[1]),
      altitude:
        profile.altitude.base + randRange(-profile.altitude.variance, profile.altitude.variance),
    })
  }

  console.log(`[wiesbaden-sim] initialized ${units.length} units around Wiesbaden, DE`)

  return {
    next: (): CoT[] => {
      return units.map((unit) => {
        stepUnit(unit)
        return unitToCoT(unit)
      })
    },
  }
}

// eslint-disable-file

import { CoT } from '@tak-ps/node-tak'
import type {
  Affiliation,
  AffiliationRatios,
  AirSubtype,
  CategoryDefault,
  EmulatorRegionConfig,
  GroundSubtype,
  LatLon,
  SeaSubtype,
  SimUnit,
  UnitCategory,
  UnitProfile,
} from './types'

// ── Subtype pools per domain ─────────────────────────────────────────────────

const GROUND_SUBTYPES: GroundSubtype[] = [
  'U-C-I',
  'U-C-A',
  'U-C-R',
  'E-V',
  'U-C-F',
] as GroundSubtype[]
const AIR_SUBTYPES: AirSubtype[] = ['M-F', 'M-H'] as AirSubtype[]
const SEA_SUBTYPES: SeaSubtype[] = ['X', 'X-S'] as SeaSubtype[]

// ── Sensible defaults per domain+subtype ─────────────────────────────────────

const DEFAULT_GROUND: CategoryDefault = {
  speedRange: { min: 2, max: 12 },
  altitude: { base: 115, variance: 5 },
  bearingNoiseDeg: 10,
}

const DEFAULT_AIR_FIXED_WING: CategoryDefault = {
  speedRange: { min: 60, max: 150 },
  altitude: { base: 3000, variance: 800 },
  bearingNoiseDeg: 4,
}

const DEFAULT_AIR_HELICOPTER: CategoryDefault = {
  speedRange: { min: 25, max: 70 },
  altitude: { base: 300, variance: 150 },
  bearingNoiseDeg: 12,
}

const DEFAULT_SEA_SURFACE: CategoryDefault = {
  speedRange: { min: 5, max: 20 },
  altitude: { base: 0, variance: 0 },
  bearingNoiseDeg: 6,
}

const DEFAULT_SEA_SUB: CategoryDefault = {
  speedRange: { min: 3, max: 12 },
  altitude: { base: -50, variance: 30 },
  bearingNoiseDeg: 8,
}

// ── Callsign prefix tables ───────────────────────────────────────────────────

const CALLSIGN_PREFIXES: Record<string, Record<string, string[]>> = {
  G: {
    'U-C-I': ['ALPHA', 'BRAVO', 'DELTA', 'FOXTROT', 'SIERRA'],
    'U-C-A': ['IRON', 'STEEL', 'HAMMER', 'SABRE', 'TITAN'],
    'U-C-R': ['SHADOW', 'SCOUT', 'RECON', 'GHOST', 'SPECTRE'],
    'E-V': ['EAGLE', 'HAULER', 'CONVOY', 'MOVER', 'TRANSIT'],
    'U-C-F': ['THUNDER', 'CANNON', 'MORTAR', 'BATTERY', 'HOWITZER'],
  },
  A: {
    'M-F': ['VIPER', 'RAPTOR', 'FALCON', 'HORNET', 'PHANTOM'],
    'M-H': ['DUSTOFF', 'PEDRO', 'CHALK', 'ROTARY', 'HAVOC'],
  },
  S: {
    X: ['NEPTUNE', 'TRIDENT', 'VESSEL', 'MARINER', 'ANCHOR'],
    'X-S': ['DEPTH', 'SILENT', 'DEEP', 'DIVER', 'HUNTER'],
  },
}

const AFFILIATION_TAGS: Record<string, string> = {
  f: 'FRD',
  h: 'HOS',
  n: 'NEU',
  u: 'UNK',
}

// ── CoTFactory ───────────────────────────────────────────────────────────────

export class CoTFactory {
  // ── Type string builder ──────────────────────────────────────────────────

  /**
   * Build a NATO 2525C CoT type string.
   * Example: buildCotType("f", "A", "M-F") → "a-f-A-M-F"
   */
  static buildCotType(
    affiliation: Affiliation | string,
    category: UnitCategory | string,
    subtype: string
  ): string {
    return `a-${affiliation}-${category}-${subtype}`
  }

  // ── CoT event creation ───────────────────────────────────────────────────

  /** Convert a SimUnit into a TAK CoT event. */
  static createUnitCoT(unit: SimUnit, regionName: string): CoT {
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
          how: 'm-g',
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
            _text: `Simulated unit ${unit.callsign} [${regionName}]`,
          },
        },
      },
    })
  }

  // ── Hybrid profile generation ────────────────────────────────────────────

  /**
   * Generate an array of UnitProfiles from a region config.
   *
   * For each unit slot the factory:
   *  1. Picks an affiliation randomly weighted by the ratios
   *  2. Picks a random subtype within the category
   *  3. Assigns speed/altitude/noise from defaults (with optional overrides)
   *  4. Assigns a route from the available routes for that category
   *  5. Generates a callsign prefix based on affiliation + subtype
   */
  static generateProfiles(config: EmulatorRegionConfig): UnitProfile[] {
    const profiles: UnitProfile[] = []

    const categories: Array<{ category: UnitCategory | string; count: number }> = [
      { category: 'A', count: config.distribution.air },
      { category: 'G', count: config.distribution.ground },
      { category: 'S', count: config.distribution.sea },
    ]

    for (const { category, count } of categories) {
      const subtypes = CoTFactory.getSubtypePool(category)
      const routePool = CoTFactory.getRoutePool(config, category)

      for (let i = 0; i < count; i++) {
        const affiliation = CoTFactory.pickAffiliation(config.affiliationRatios)
        const subtype = subtypes[Math.floor(Math.random() * subtypes.length)]
        const defaults = CoTFactory.getDefaults(category, subtype, config)
        const callsignPrefix = CoTFactory.pickCallsign(category, subtype, affiliation)
        const route = routePool[i % routePool.length]

        profiles.push({
          cotType: CoTFactory.buildCotType(affiliation, category, subtype),
          callsignPrefix,
          speedRange: { ...defaults.speedRange },
          altitude: { ...defaults.altitude },
          bearingNoiseDeg: defaults.bearingNoiseDeg,
          routes: [route],
        })
      }
    }

    return profiles
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  /** Pick an affiliation using weighted random selection. */
  private static pickAffiliation(ratios: AffiliationRatios): string {
    const r = Math.random()
    let cumulative = 0
    const entries: Array<[string, number]> = [
      ['f', ratios.friendly],
      ['h', ratios.hostile],
      ['n', ratios.neutral],
      ['u', ratios.unknown],
    ]
    for (const [aff, weight] of entries) {
      cumulative += weight
      if (r < cumulative) return aff
    }
    return 'u' // fallback
  }

  /** Get the subtype pool for a given domain. */
  private static getSubtypePool(category: string): string[] {
    switch (category) {
      case 'G':
        return GROUND_SUBTYPES as string[]
      case 'A':
        return AIR_SUBTYPES as string[]
      case 'S':
        return SEA_SUBTYPES as string[]
      default:
        return GROUND_SUBTYPES as string[]
    }
  }

  /** Get the route pool for a given domain from the region config. */
  private static getRoutePool(config: EmulatorRegionConfig, category: string): LatLon[][] {
    switch (category) {
      case 'A':
        return config.routes.air
      case 'G':
        return config.routes.ground
      case 'S':
        return config.routes.sea
      default:
        return config.routes.ground
    }
  }

  /** Get sensible defaults for a domain + subtype, with optional region overrides. */
  private static getDefaults(
    category: string,
    subtype: string,
    config: EmulatorRegionConfig
  ): CategoryDefault {
    // Check for region-level overrides first
    const overrides = config.categoryDefaults?.[category as UnitCategory]?.[subtype]
    if (overrides) return overrides

    // Fall back to built-in defaults
    if (category === 'A') {
      return subtype === 'M-H' ? DEFAULT_AIR_HELICOPTER : DEFAULT_AIR_FIXED_WING
    }
    if (category === 'S') {
      return subtype === 'X-S' ? DEFAULT_SEA_SUB : DEFAULT_SEA_SURFACE
    }
    return DEFAULT_GROUND
  }

  /** Pick a callsign prefix based on domain, subtype, and affiliation. */
  private static pickCallsign(category: string, subtype: string, affiliation: string): string {
    const pool = CALLSIGN_PREFIXES[category][subtype]
    const base = pool[Math.floor(Math.random() * pool.length)] ?? 'UNIT'
    const tag = AFFILIATION_TAGS[affiliation] ?? 'UNK'
    return `${base}-${tag}`
  }
}

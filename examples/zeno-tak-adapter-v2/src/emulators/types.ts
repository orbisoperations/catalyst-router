import type { CoT } from '@tak-ps/node-tak'

// ── Core geo type ────────────────────────────────────────────────────────────

export type LatLon = { lat: number; lon: number }

// ── Enums ────────────────────────────────────────────────────────────────────

/** NATO 2525C affiliation codes used in CoT type strings. */
export enum Affiliation {
  Friendly = 'f',
  Hostile = 'h',
  Neutral = 'n',
  Unknown = 'u',
}

/** Top-level battle dimension / domain. */
export enum UnitCategory {
  Ground = 'G',
  Air = 'A',
  Sea = 'S',
}

/** Subtypes within the Ground domain. */
export enum GroundSubtype {
  Infantry = 'U-C-I',
  Armor = 'U-C-A',
  Recon = 'U-C-R',
  Vehicle = 'E-V',
  Artillery = 'U-C-F',
}

/** Subtypes within the Air domain. */
export enum AirSubtype {
  FixedWing = 'M-F',
  Helicopter = 'M-H',
}

/** Subtypes within the Sea domain. */
export enum SeaSubtype {
  SurfaceVessel = 'X',
  Submarine = 'X-S',
}

// ── Unit profile & simulation unit ───────────────────────────────────────────

export type UnitProfile = {
  /** NATO 2525C CoT type code (e.g. "a-f-G-U-C-I") */
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

export type SimUnit = {
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

// ── Simulator interface ──────────────────────────────────────────────────────

export type CoTSimulator = { next: () => CoT[] }

// ── Region configuration ─────────────────────────────────────────────────────

/** How many units to spawn per domain. */
export type RegionDistribution = {
  air: number
  ground: number
  sea: number
}

/** Weighted probability of each affiliation (should sum to ~1.0). */
export type AffiliationRatios = {
  friendly: number
  hostile: number
  neutral: number
  unknown: number
}

/** Default speed / altitude / noise for a specific domain + subtype. */
export type CategoryDefault = {
  speedRange: { min: number; max: number }
  altitude: { base: number; variance: number }
  bearingNoiseDeg: number
}

/**
 * Everything needed to define a regional emulator.
 * Region files only need to provide this config; the simulation engine
 * and CoT factory handle everything else.
 */
export interface EmulatorRegionConfig {
  /** Unique name used in EMULATOR_PUBLISHERS (e.g. "japan", "virginia") */
  name: string
  /** Human-readable description */
  description: string
  /** Total number of units to spawn */
  totalUnits: number
  /** How many units per domain */
  distribution: RegionDistribution
  /** Weighted affiliation probabilities */
  affiliationRatios: AffiliationRatios
  /** Named waypoints for the region */
  waypoints: Record<string, LatLon>
  /** Patrol routes grouped by domain */
  routes: {
    air: LatLon[][]
    ground: LatLon[][]
    sea: LatLon[][]
  }
  /** Optional per-domain speed/altitude/noise overrides */
  categoryDefaults?: Partial<Record<UnitCategory, Partial<Record<string, CategoryDefault>>>>
}

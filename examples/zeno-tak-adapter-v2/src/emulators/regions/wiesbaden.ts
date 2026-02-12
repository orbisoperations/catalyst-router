import type { EmulatorRegionConfig, LatLon } from '../types'

// ── Wiesbaden area waypoints (~50.08N, 8.24E) ───────────────────────────────

const WP = {
  // City & infrastructure
  cityCenter: { lat: 50.0782, lon: 8.2397 },
  hauptbahnhof: { lat: 50.0707, lon: 8.2434 },
  biebrich: { lat: 50.0374, lon: 8.2308 },
  kastel: { lat: 50.0069, lon: 8.2819 },
  schierstein: { lat: 50.0442, lon: 8.1838 },

  // US Military installations
  clayKaserne: { lat: 50.0498, lon: 8.3254 },
  armyAirfield: { lat: 50.049, lon: 8.334 },

  // Surrounding towns
  mainz: { lat: 50.0, lon: 8.2711 },
  taunusstein: { lat: 50.1438, lon: 8.1528 },
  eltville: { lat: 50.0283, lon: 8.1172 },
  hochheim: { lat: 50.0131, lon: 8.3531 },

  // Rhine river waypoints
  rhineWest: { lat: 50.035, lon: 8.215 },
  rhineEast: { lat: 50.01, lon: 8.29 },

  // Northern hills (Taunus)
  neroberg: { lat: 50.0963, lon: 8.2317 },
  sonnenberg: { lat: 50.105, lon: 8.27 },
  rambach: { lat: 50.115, lon: 8.2 },
} as const satisfies Record<string, LatLon>

// ── Region config ────────────────────────────────────────────────────────────

export const wiesbadenConfig: EmulatorRegionConfig = {
  name: 'wiesbaden',
  description: 'Wiesbaden, Germany -- US Army Europe area',
  totalUnits: 24,
  distribution: { air: 6, ground: 12, sea: 6 },
  affiliationRatios: { friendly: 0.5, hostile: 0.2, neutral: 0.2, unknown: 0.1 },
  waypoints: WP,
  routes: {
    air: [
      [WP.armyAirfield, WP.mainz, WP.eltville, WP.taunusstein, WP.armyAirfield],
      [WP.armyAirfield, WP.neroberg, WP.sonnenberg, WP.kastel, WP.armyAirfield],
      [WP.armyAirfield, WP.taunusstein, WP.eltville, WP.mainz, WP.hochheim, WP.armyAirfield],
    ],
    ground: [
      [WP.clayKaserne, WP.armyAirfield, WP.kastel, WP.clayKaserne],
      [WP.cityCenter, WP.hauptbahnhof, WP.biebrich, WP.cityCenter],
      [WP.clayKaserne, WP.mainz, WP.kastel, WP.biebrich, WP.clayKaserne],
      [WP.armyAirfield, WP.hochheim, WP.mainz, WP.kastel, WP.armyAirfield],
      [WP.neroberg, WP.taunusstein, WP.eltville, WP.rhineWest, WP.biebrich, WP.neroberg],
      [WP.sonnenberg, WP.rambach, WP.neroberg, WP.cityCenter, WP.sonnenberg],
      [WP.clayKaserne, WP.cityCenter, WP.schierstein, WP.biebrich, WP.clayKaserne],
      [WP.hauptbahnhof, WP.kastel, WP.mainz, WP.biebrich, WP.hauptbahnhof],
      [WP.eltville, WP.rhineWest, WP.schierstein, WP.eltville],
      [WP.mainz, WP.rhineEast, WP.kastel, WP.mainz],
      [WP.rhineEast, WP.kastel, WP.mainz, WP.rhineEast],
    ],
    sea: [
      [WP.rhineWest, WP.biebrich, WP.kastel, WP.rhineEast, WP.mainz, WP.rhineWest],
      [WP.schierstein, WP.rhineWest, WP.biebrich, WP.schierstein],
      [WP.mainz, WP.rhineEast, WP.kastel, WP.rhineWest, WP.mainz],
    ],
  },
}

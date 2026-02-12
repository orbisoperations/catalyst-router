import type { EmulatorRegionConfig, LatLon } from '../types'

// ── Kaliningrad / Baltic region waypoints (~54.7N, 20.5E) ────────────────────

const WP = {
  // Cities
  kaliningrad: { lat: 54.7104, lon: 20.4522 },
  chernyakhovsk: { lat: 54.6372, lon: 21.8114 },
  sovietsk: { lat: 55.0819, lon: 21.8838 },
  gusev: { lat: 54.5931, lon: 22.1994 },

  // Military installations
  baltiyskNaval: { lat: 54.6536, lon: 19.906 }, // Baltiysk Naval Base
  chkalovskAirBase: { lat: 54.7669, lon: 20.3505 }, // Chkalovsk Air Base
  donskoye: { lat: 54.9318, lon: 20.1667 }, // Donskoye airfield area
  chernyakhovskAB: { lat: 54.6027, lon: 21.7833 }, // Chernyakhovsk Air Base

  // Coastal / sea waypoints
  balticApproach: { lat: 55.0, lon: 19.5 },
  gdanskBay: { lat: 54.5, lon: 19.0 },
  curonianSpit: { lat: 55.3, lon: 20.9 },
  offshorePatrolNorth: { lat: 55.5, lon: 19.0 },
  offshorePatrolSouth: { lat: 54.3, lon: 19.5 },

  // Curonian Lagoon
  curonianLagoon: { lat: 55.1, lon: 20.8 },
  nida: { lat: 55.3024, lon: 20.9683 },

  // Neighboring (for NATO friendly patrols)
  gdynia: { lat: 54.5189, lon: 18.5305 },
  klaipeda: { lat: 55.7033, lon: 21.1443 },
  elblag: { lat: 54.1561, lon: 19.4044 },
} as const satisfies Record<string, LatLon>

// ── Region config ────────────────────────────────────────────────────────────

export const russiaConfig: EmulatorRegionConfig = {
  name: 'russia',
  description: 'Kaliningrad / Baltic Sea region',
  totalUnits: 30,
  distribution: { air: 10, ground: 10, sea: 10 },
  affiliationRatios: { friendly: 0.3, hostile: 0.4, neutral: 0.2, unknown: 0.1 },
  waypoints: WP,
  routes: {
    air: [
      [
        WP.chkalovskAirBase,
        WP.balticApproach,
        WP.offshorePatrolNorth,
        WP.curonianSpit,
        WP.chkalovskAirBase,
      ],
      [WP.chernyakhovskAB, WP.kaliningrad, WP.baltiyskNaval, WP.gdanskBay, WP.chernyakhovskAB],
      [WP.donskoye, WP.curonianSpit, WP.offshorePatrolNorth, WP.balticApproach, WP.donskoye],
      [
        WP.chkalovskAirBase,
        WP.gdanskBay,
        WP.offshorePatrolSouth,
        WP.baltiyskNaval,
        WP.chkalovskAirBase,
      ],
      [WP.chernyakhovskAB, WP.gusev, WP.sovietsk, WP.curonianSpit, WP.chernyakhovskAB],
    ],
    ground: [
      [WP.kaliningrad, WP.chernyakhovsk, WP.gusev, WP.kaliningrad],
      [WP.baltiyskNaval, WP.kaliningrad, WP.donskoye, WP.baltiyskNaval],
      [WP.chernyakhovsk, WP.sovietsk, WP.gusev, WP.chernyakhovsk],
      [WP.kaliningrad, WP.curonianLagoon, WP.nida, WP.kaliningrad],
      [WP.gdynia, WP.gdanskBay, WP.elblag, WP.gdynia],
      [WP.klaipeda, WP.curonianSpit, WP.nida, WP.curonianLagoon, WP.klaipeda],
    ],
    sea: [
      [WP.baltiyskNaval, WP.balticApproach, WP.gdanskBay, WP.offshorePatrolSouth, WP.baltiyskNaval],
      [WP.baltiyskNaval, WP.offshorePatrolNorth, WP.curonianSpit, WP.baltiyskNaval],
      [WP.gdynia, WP.gdanskBay, WP.offshorePatrolSouth, WP.balticApproach, WP.gdynia],
      [WP.klaipeda, WP.curonianSpit, WP.offshorePatrolNorth, WP.balticApproach, WP.klaipeda],
      [
        WP.offshorePatrolSouth,
        WP.gdanskBay,
        WP.balticApproach,
        WP.offshorePatrolNorth,
        WP.offshorePatrolSouth,
      ],
    ],
  },
}

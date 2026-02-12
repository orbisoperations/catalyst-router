import type { EmulatorRegionConfig, LatLon } from '../types'

// ── East China Sea / Shanghai coast waypoints (~31.2N, 121.5E) ───────────────

const WP = {
  // Major cities / ports
  shanghai: { lat: 31.2304, lon: 121.4737 },
  ningbo: { lat: 29.8683, lon: 121.544 },
  hangzhou: { lat: 30.2741, lon: 120.1551 },
  nanjing: { lat: 32.0603, lon: 118.7969 },

  // Military / naval
  zhoushanNaval: { lat: 29.9853, lon: 122.1046 }, // Zhoushan Naval Base
  daishanIsland: { lat: 30.2431, lon: 122.1994 },
  shanghaiAirBase: { lat: 31.1434, lon: 121.806 }, // Shanghai Pudong area
  ningboAirBase: { lat: 29.9265, lon: 121.5804 },

  // Sea patrol zones
  eastChinaSeaNorth: { lat: 31.5, lon: 123.0 },
  eastChinaSeaSouth: { lat: 29.5, lon: 123.5 },
  hangzhouBayMouth: { lat: 30.6, lon: 121.9 },
  yangtzeEstuary: { lat: 31.4, lon: 122.0 },
  shengsiIslands: { lat: 30.73, lon: 122.45 },

  // Coastal
  wenzhou: { lat: 28.0, lon: 120.672 },
  lianyungang: { lat: 34.5965, lon: 119.2216 },

  // Inland
  suzhou: { lat: 31.2989, lon: 120.5853 },
  wuxi: { lat: 31.4912, lon: 120.3119 },
  hefei: { lat: 31.8206, lon: 117.2272 },
} as const satisfies Record<string, LatLon>

// ── Region config ────────────────────────────────────────────────────────────

export const chinaConfig: EmulatorRegionConfig = {
  name: 'china',
  description: 'East China Sea / Shanghai coast',
  totalUnits: 30,
  distribution: { air: 10, ground: 10, sea: 10 },
  affiliationRatios: { friendly: 0.35, hostile: 0.35, neutral: 0.2, unknown: 0.1 },
  waypoints: WP,
  routes: {
    air: [
      [WP.shanghaiAirBase, WP.eastChinaSeaNorth, WP.yangtzeEstuary, WP.shanghaiAirBase],
      [WP.ningboAirBase, WP.zhoushanNaval, WP.eastChinaSeaSouth, WP.ningboAirBase],
      [WP.shanghaiAirBase, WP.hangzhouBayMouth, WP.daishanIsland, WP.shanghaiAirBase],
      [
        WP.ningboAirBase,
        WP.eastChinaSeaSouth,
        WP.shengsiIslands,
        WP.daishanIsland,
        WP.ningboAirBase,
      ],
      [WP.shanghaiAirBase, WP.nanjing, WP.suzhou, WP.shanghai, WP.shanghaiAirBase],
    ],
    ground: [
      [WP.shanghai, WP.suzhou, WP.wuxi, WP.nanjing, WP.shanghai],
      [WP.ningbo, WP.hangzhou, WP.suzhou, WP.ningbo],
      [WP.shanghai, WP.hangzhouBayMouth, WP.ningbo, WP.shanghai],
      [WP.nanjing, WP.hefei, WP.wuxi, WP.nanjing],
      [WP.hangzhou, WP.ningbo, WP.wenzhou, WP.hangzhou],
      [WP.shanghai, WP.nanjing, WP.hefei, WP.shanghai],
    ],
    sea: [
      [WP.zhoushanNaval, WP.eastChinaSeaNorth, WP.yangtzeEstuary, WP.zhoushanNaval],
      [
        WP.zhoushanNaval,
        WP.eastChinaSeaSouth,
        WP.daishanIsland,
        WP.shengsiIslands,
        WP.zhoushanNaval,
      ],
      [WP.shanghai, WP.yangtzeEstuary, WP.eastChinaSeaNorth, WP.hangzhouBayMouth, WP.shanghai],
      [WP.ningbo, WP.zhoushanNaval, WP.eastChinaSeaSouth, WP.wenzhou, WP.ningbo],
      [
        WP.shengsiIslands,
        WP.eastChinaSeaNorth,
        WP.eastChinaSeaSouth,
        WP.daishanIsland,
        WP.shengsiIslands,
      ],
    ],
  },
}

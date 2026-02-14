import type { EmulatorRegionConfig, LatLon } from '../types'

// ── Tokyo Bay / Kanto region waypoints (~35.6N, 139.7E) ─────────────────────

const WP = {
  // Major cities
  tokyo: { lat: 35.6762, lon: 139.6503 },
  yokohama: { lat: 35.4437, lon: 139.638 },
  chiba: { lat: 35.6074, lon: 140.1065 },
  kawasaki: { lat: 35.5308, lon: 139.7029 },

  // Military installations
  yokosuka: { lat: 35.2834, lon: 139.6681 }, // US Naval Base
  atsugi: { lat: 35.4547, lon: 139.4497 }, // NAF Atsugi
  yokota: { lat: 35.7485, lon: 139.3487 }, // Yokota Air Base
  zama: { lat: 35.4881, lon: 139.3933 }, // Camp Zama

  // Sea waypoints
  tokyoBay: { lat: 35.4, lon: 139.8 },
  sagamiBay: { lat: 35.15, lon: 139.5 },
  pacificApproach: { lat: 34.9, lon: 139.9 },
  uraga: { lat: 35.23, lon: 139.73 },
  bosoPeninsula: { lat: 35.05, lon: 139.95 },

  // Inland
  machida: { lat: 35.5483, lon: 139.4462 },
  hachioji: { lat: 35.6564, lon: 139.3239 },
  tachikawa: { lat: 35.7138, lon: 139.4137 },
  fuchu: { lat: 35.6688, lon: 139.4777 },
  sagamihara: { lat: 35.5712, lon: 139.3731 },
} as const satisfies Record<string, LatLon>

// ── Region config ────────────────────────────────────────────────────────────

export const japanConfig: EmulatorRegionConfig = {
  name: 'japan',
  description: 'Tokyo Bay / Kanto region, Japan',
  totalUnits: 30,
  distribution: { air: 10, ground: 10, sea: 10 },
  affiliationRatios: { friendly: 0.4, hostile: 0.3, neutral: 0.2, unknown: 0.1 },
  waypoints: WP,
  routes: {
    air: [
      [WP.atsugi, WP.sagamiBay, WP.tokyoBay, WP.chiba, WP.atsugi],
      [WP.yokota, WP.tokyo, WP.tokyoBay, WP.yokohama, WP.yokota],
      [WP.yokota, WP.hachioji, WP.machida, WP.atsugi, WP.yokota],
      [WP.atsugi, WP.pacificApproach, WP.bosoPeninsula, WP.chiba, WP.atsugi],
      [WP.yokota, WP.tachikawa, WP.fuchu, WP.tokyo, WP.yokota],
    ],
    ground: [
      [WP.yokosuka, WP.yokohama, WP.kawasaki, WP.yokosuka],
      [WP.zama, WP.sagamihara, WP.machida, WP.zama],
      [WP.tokyo, WP.kawasaki, WP.yokohama, WP.tokyo],
      [WP.tachikawa, WP.hachioji, WP.fuchu, WP.tachikawa],
      [WP.yokota, WP.tachikawa, WP.fuchu, WP.tokyo, WP.yokota],
      [WP.zama, WP.atsugi, WP.machida, WP.sagamihara, WP.zama],
    ],
    sea: [
      [WP.yokosuka, WP.uraga, WP.sagamiBay, WP.yokosuka],
      [WP.tokyoBay, WP.chiba, WP.bosoPeninsula, WP.pacificApproach, WP.tokyoBay],
      [WP.yokohama, WP.tokyoBay, WP.uraga, WP.yokohama],
      [WP.sagamiBay, WP.pacificApproach, WP.bosoPeninsula, WP.tokyoBay, WP.sagamiBay],
      [WP.uraga, WP.tokyoBay, WP.chiba, WP.bosoPeninsula, WP.uraga],
    ],
  },
}

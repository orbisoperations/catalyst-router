import type { EmulatorRegionConfig, LatLon } from '../types'

// ── DC / Hampton Roads / Virginia waypoints ──────────────────────────────────

const WP = {
  // DC area
  pentagon: { lat: 38.8711, lon: -77.0559 },
  quantico: { lat: 38.5221, lon: -77.3176 },
  fortBelvoir: { lat: 38.7119, lon: -77.1457 },
  arlington: { lat: 38.8799, lon: -77.1068 },

  // Hampton Roads / Norfolk
  norfolkNaval: { lat: 36.9465, lon: -76.3256 }, // Naval Station Norfolk
  langleyAFB: { lat: 37.0832, lon: -76.3606 }, // Langley AFB
  damNeck: { lat: 36.8123, lon: -75.9674 }, // Dam Neck
  littleCreek: { lat: 36.9185, lon: -76.16 }, // JEBSA Little Creek
  oceana: { lat: 36.8207, lon: -76.0336 }, // NAS Oceana

  // Chesapeake Bay
  chesapeakeBayBridge: { lat: 37.03, lon: -76.12 },
  capeHenry: { lat: 36.9265, lon: -76.0076 },
  capeCharles: { lat: 37.2646, lon: -75.9946 },
  yorktown: { lat: 37.2366, lon: -76.5098 },

  // Coastal / sea waypoints
  virginiaBeach: { lat: 36.8529, lon: -75.978 },
  atlanticApproach: { lat: 36.7, lon: -75.5 },
  midBay: { lat: 37.4, lon: -76.05 },
  hamptonRoads: { lat: 36.97, lon: -76.33 },

  // Inland
  richmond: { lat: 37.5407, lon: -77.436 },
  fredericksburg: { lat: 38.3032, lon: -77.4605 },
  williamsburg: { lat: 37.2707, lon: -76.7075 },
} as const satisfies Record<string, LatLon>

// ── Region config ────────────────────────────────────────────────────────────

export const virginiaConfig: EmulatorRegionConfig = {
  name: 'virginia',
  description: 'DC / Hampton Roads, Virginia, USA',
  totalUnits: 30,
  distribution: { air: 10, ground: 10, sea: 10 },
  affiliationRatios: { friendly: 0.5, hostile: 0.2, neutral: 0.2, unknown: 0.1 },
  waypoints: WP,
  routes: {
    air: [
      [WP.langleyAFB, WP.chesapeakeBayBridge, WP.capeCharles, WP.atlanticApproach, WP.langleyAFB],
      [WP.oceana, WP.virginiaBeach, WP.atlanticApproach, WP.capeHenry, WP.oceana],
      [WP.langleyAFB, WP.yorktown, WP.williamsburg, WP.richmond, WP.langleyAFB],
      [WP.quantico, WP.fredericksburg, WP.richmond, WP.pentagon, WP.quantico],
      [WP.langleyAFB, WP.norfolkNaval, WP.damNeck, WP.atlanticApproach, WP.langleyAFB],
    ],
    ground: [
      [WP.pentagon, WP.arlington, WP.fortBelvoir, WP.pentagon],
      [WP.quantico, WP.fredericksburg, WP.fortBelvoir, WP.quantico],
      [WP.norfolkNaval, WP.littleCreek, WP.damNeck, WP.norfolkNaval],
      [WP.langleyAFB, WP.yorktown, WP.williamsburg, WP.langleyAFB],
      [WP.fortBelvoir, WP.quantico, WP.fredericksburg, WP.richmond, WP.fortBelvoir],
      [WP.norfolkNaval, WP.hamptonRoads, WP.langleyAFB, WP.norfolkNaval],
    ],
    sea: [
      [WP.norfolkNaval, WP.hamptonRoads, WP.capeHenry, WP.atlanticApproach, WP.norfolkNaval],
      [WP.littleCreek, WP.chesapeakeBayBridge, WP.midBay, WP.capeCharles, WP.littleCreek],
      [WP.capeHenry, WP.atlanticApproach, WP.virginiaBeach, WP.capeHenry],
      [WP.hamptonRoads, WP.yorktown, WP.chesapeakeBayBridge, WP.hamptonRoads],
      [WP.damNeck, WP.virginiaBeach, WP.atlanticApproach, WP.capeHenry, WP.damNeck],
    ],
  },
}

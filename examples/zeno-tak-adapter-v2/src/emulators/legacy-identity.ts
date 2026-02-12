/**
 * @deprecated Legacy identity emulator kept for backward compatibility.
 * Use the new EMULATOR_PUBLISHERS system instead.
 */

import { CoT } from '@tak-ps/node-tak'
import type { CoTSimulator } from './types'
import { moveCoordinate } from './utils'

const TOTAL_CALLSIGNS = 20

const callsigns = Array.from(
  { length: TOTAL_CALLSIGNS },
  (_, i) => `Target-${i.toString().padStart(2, '0')}`
)

const identities = new Map<string, CoT>()

function generateRandomType(): string {
  const types = [
    'a-f-G-U-C',
    'a-f-G-U-C-I',
    'a-f-G-U-C-A',
    'a-f-G-U-C-R',
    'a-f-G-E-V',
    'a-f-A-M-F',
    'a-f-A-M-H',
    'a-f-S-X',
    'a-h-G-U-C',
    'a-h-G-U-C-I',
    'a-n-G',
    'a-u-G',
    'b-m-p-s-p-loc',
    'b-m-p-s-p-i',
    'b-m-p-w-METAR',
  ]
  return types[Math.floor(Math.random() * types.length)]
}

function getRandomLatitude(): number {
  return Math.random() * 0.01 - 0.005 + 38.88
}

function getRandomLongitude(): number {
  return Math.random() * 0.01 - 0.005 + -77.02
}

function generateRandomCoT(callsign: string): CoT {
  const now = new Date()
  const stale = new Date(now.getTime() + 5000)
  return new CoT({
    event: {
      _attributes: {
        version: '2.0',
        uid: callsign,
        type: generateRandomType(),
        time: now.toISOString(),
        start: now.toISOString(),
        stale: stale.toISOString(),
      },
      point: {
        _attributes: {
          lat: getRandomLatitude(),
          lon: getRandomLongitude(),
          hae: Math.random() * 1000 + 150,
          ce: 10,
          le: 10,
        },
      },
      detail: {
        contact: {
          _attributes: {
            callsign,
          },
        },
        remarks: {
          _text: `Testing simulated data for ${callsign}`,
        },
      },
    },
  })
}

export function initializeIdentity(): CoTSimulator {
  for (const callsign of callsigns) {
    identities.set(callsign, generateRandomCoT(callsign))
  }

  return {
    next: () => {
      const newValues = Array.from(identities.values()).map((cot) => {
        const newPos = moveCoordinate(
          {
            lat: Number(cot.raw.event.point._attributes.lat),
            lon: Number(cot.raw.event.point._attributes.lon),
          },
          1,
          Math.random() * 360
        )
        cot.position([newPos.lat, newPos.lon])
        return cot
      })
      identities.clear()
      newValues.forEach((cot) => identities.set(cot.callsign(), cot))
      return newValues
    },
  }
}

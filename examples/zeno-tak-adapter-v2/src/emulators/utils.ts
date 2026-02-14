type LatLng = { lat: number; lon: number }

const EARTH_R = 6378137

/** Geodesic forward move: move X meters at a bearing from lat/lon (degrees). */
export function moveCoordinate(
  start: LatLng,
  distanceMeters: number,
  bearingDegrees: number
): LatLng {
  const bearing = toRad(bearingDegrees)
  const lat1 = toRad(start.lat)
  const lon1 = toRad(start.lon)

  const angularDistance = distanceMeters / EARTH_R

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing)
  )

  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
    )

  return { lat: toDeg(lat2), lon: normalizeLon(toDeg(lon2)) }
}

function toRad(d: number): number {
  return (d * Math.PI) / 180
}
function toDeg(r: number): number {
  return (r * 180) / Math.PI
}
function normalizeLon(lon: number): number {
  return ((lon + 540) % 360) - 180 // -180..180
}

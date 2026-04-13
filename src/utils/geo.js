const EARTH_RADIUS_KM = 6371

export function haversineKm(latA, lonA, latB, lonB) {
  if (
    !Number.isFinite(latA) ||
    !Number.isFinite(lonA) ||
    !Number.isFinite(latB) ||
    !Number.isFinite(lonB)
  ) {
    return Infinity
  }

  const toRadians = Math.PI / 180
  const dLat = (latB - latA) * toRadians
  const dLon = (lonB - lonA) * toRadians
  const aLat = latA * toRadians
  const bLat = latB * toRadians

  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat) * Math.cos(bLat) * Math.sin(dLon / 2) ** 2

  return EARTH_RADIUS_KM * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)))
}

export function normalizeLongitude(lon) {
  if (!Number.isFinite(lon)) return 0
  return ((((lon + 180) % 360) + 360) % 360) - 180
}

export function getDensityCell(lat, lon) {
  const normalizedLon = normalizeLongitude(lon)
  const col = Math.max(0, Math.min(35, Math.floor((normalizedLon + 180) / 10)))
  const row = Math.max(0, Math.min(17, Math.floor((lat + 90) / 10)))
  return {
    key: `${col}:${row}`,
    col,
    row,
  }
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

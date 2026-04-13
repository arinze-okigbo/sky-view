/**
 * fusion.js
 *
 * Bus events emitted:
 * - `fusion:overlap`      { pairs, updatedAt }
 * - `fusion:density`      { grid, updatedAt }
 * - `fusion:area-result`  { center, radiusKm, results, updatedAt }
 */

import { emit, on } from './core/bus.js'
import { getAircraftMap } from './flights.js'
import { getSatellites, getSatelliteSnapshot } from './satellites.js'
import { getCameras } from './cameras.js'
import { getLandmarks } from './landmarks.js'
import { getAirports } from './airports.js'
import { getDensityCell, haversineKm } from './utils/geo.js'

const AIRCRAFT_RADIUS_KM = 500
const CAMERA_RADIUS_KM = 200
const OVERLAP_INTERVAL_MS = 90_000

let _zoneCache = []
let _zoneOccupancy = new Map()
let _thresholdState = {
  thresholds: null,
  active: {},
}
let _densityGrid = new Map()
let _overlapPairs = []
let _areaResult = null
let _overlapTimer = null
let _correlationMatrix = {
  flights: { flights: 0, satellites: 0, cameras: 0 },
  satellites: { flights: 0, satellites: 0, cameras: 0 },
  cameras: { flights: 0, satellites: 0, cameras: 0 },
}

function getFlightEntries() {
  return [...getAircraftMap().values()]
    .filter((aircraft) => Number.isFinite(aircraft.lat) && Number.isFinite(aircraft.lon))
}

function getSatelliteEntries() {
  return getSatellites()
    .filter((satellite) => Number.isFinite(satellite.lat) && Number.isFinite(satellite.lon))
}

function getCameraEntries() {
  return getCameras()
    .filter((camera) => {
      const coords = camera.geometry?.coordinates
      return Array.isArray(coords) && Number.isFinite(coords[0]) && Number.isFinite(coords[1])
    })
}

function getEntityPosition(kind, data) {
  if (!data) return null

  if (kind === 'flight') {
    return { lat: data.lat, lon: data.lon }
  }

  if (kind === 'satellite') {
    return { lat: data.lat, lon: data.lon }
  }

  if (kind === 'camera') {
    return {
      lat: data.geometry.coordinates[1],
      lon: data.geometry.coordinates[0],
    }
  }

  if (kind === 'landmark' || kind === 'airport' || kind === 'annotation') {
    return { lat: data.lat, lon: data.lon }
  }

  return null
}

function getSubject(kind, entityId) {
  if (kind === 'flight') return getAircraftMap().get(entityId) || null
  if (kind === 'satellite') {
    const sid = String(entityId)
    return getSatellites().find((entry) => String(entry.id) === sid) || null
  }
  if (kind === 'camera') return getCameras().find((entry) => entry.id === String(entityId)) || null
  if (kind === 'landmark') return getLandmarks().find((entry) => entry.name === entityId) || null
  if (kind === 'airport') return getAirports().find((entry) => entry.iata === entityId) || null
  return null
}

function getZonesContaining(lat, lon) {
  return _zoneCache.filter((zone) => (
    zone.enabled &&
    haversineKm(lat, lon, zone.lat, zone.lon) <= zone.radiusKm
  ))
}

function getDensityLevel(total) {
  if (total >= 45) return 'High'
  if (total >= 18) return 'Medium'
  if (total >= 6) return 'Low'
  return 'Sparse'
}

function countNearby(sourceEntries, targetEntries, radiusKm, sameKind = false) {
  let total = 0

  for (let sourceIndex = 0; sourceIndex < sourceEntries.length; sourceIndex += 1) {
    const source = sourceEntries[sourceIndex]
    const sourceLat = source.lat ?? source.geometry?.coordinates?.[1]
    const sourceLon = source.lon ?? source.geometry?.coordinates?.[0]
    let found = false

    for (let targetIndex = 0; targetIndex < targetEntries.length; targetIndex += 1) {
      if (sameKind && sourceIndex === targetIndex) continue

      const target = targetEntries[targetIndex]
      const targetLat = target.lat ?? target.geometry?.coordinates?.[1]
      const targetLon = target.lon ?? target.geometry?.coordinates?.[0]

      if (haversineKm(sourceLat, sourceLon, targetLat, targetLon) <= radiusKm) {
        found = true
        break
      }
    }

    if (found) total += 1
  }

  return total
}

function computeMatrix() {
  const flights = getFlightEntries()
  const satellites = getSatelliteEntries()
  const cameras = getCameraEntries()
  const sources = {
    flights,
    satellites,
    cameras,
  }
  const matrix = {}

  for (const [rowKey, rowEntries] of Object.entries(sources)) {
    matrix[rowKey] = {}

    for (const [columnKey, columnEntries] of Object.entries(sources)) {
      matrix[rowKey][columnKey] = countNearby(
        rowEntries,
        columnEntries,
        AIRCRAFT_RADIUS_KM,
        rowKey === columnKey,
      )
    }
  }

  return matrix
}

function emitDensity() {
  emit('fusion:density', {
    grid: _densityGrid,
    updatedAt: Date.now(),
  })
}

function emitOverlap() {
  emit('fusion:overlap', {
    pairs: _overlapPairs,
    updatedAt: Date.now(),
  })
}

export function queryNearby(lat, lon, radiusKm) {
  const results = {
    flights: getFlightEntries().filter((aircraft) => haversineKm(lat, lon, aircraft.lat, aircraft.lon) <= radiusKm),
    satellites: getSatelliteEntries().filter((satellite) => haversineKm(lat, lon, satellite.lat, satellite.lon) <= radiusKm),
    cameras: getCameraEntries().filter((camera) => haversineKm(lat, lon, camera.geometry.coordinates[1], camera.geometry.coordinates[0]) <= radiusKm),
  }

  return results
}

export function queryOverlap() {
  const satellites = getSatelliteEntries()
  const aircraft = getFlightEntries()

  _overlapPairs = satellites.map((satellite) => ({
    satellite,
    aircraft: aircraft.filter((flight) => haversineKm(satellite.lat, satellite.lon, flight.lat, flight.lon) <= AIRCRAFT_RADIUS_KM),
  })).filter((entry) => entry.aircraft.length)

  emitOverlap()
  return _overlapPairs
}

export function queryDensityGrid() {
  const nextGrid = new Map()

  const addToGrid = (lat, lon, key) => {
    const cell = getDensityCell(lat, lon)
    const current = nextGrid.get(cell.key) || {
      flights: 0,
      satellites: 0,
      cameras: 0,
      total: 0,
      cell,
    }

    current[key] += 1
    current.total += 1
    nextGrid.set(cell.key, current)
  }

  for (const aircraft of getFlightEntries()) addToGrid(aircraft.lat, aircraft.lon, 'flights')
  for (const satellite of getSatelliteEntries()) addToGrid(satellite.lat, satellite.lon, 'satellites')
  for (const camera of getCameraEntries()) addToGrid(camera.geometry.coordinates[1], camera.geometry.coordinates[0], 'cameras')

  _densityGrid = nextGrid
  emitDensity()
  return _densityGrid
}

export function buildFusionContext(entityKind, entityId) {
  const subject = getSubject(entityKind, entityId)
  if (!subject) {
    return {
      subject: null,
      nearbyFlights: [],
      nearbySatellites: [],
      nearbyCameras: [],
      densityCell: null,
      activeZones: [],
      alertFlags: [],
    }
  }

  const subjectPosition = getEntityPosition(entityKind, subject)
  if (!subjectPosition) {
    return {
      subject: { kind: entityKind, id: entityId, data: subject },
      nearbyFlights: [],
      nearbySatellites: [],
      nearbyCameras: [],
      densityCell: null,
      activeZones: [],
      alertFlags: [],
    }
  }

  const nearbyFlights = getFlightEntries().filter((flight) => (
    flight.icao24 !== subject.icao24 &&
    haversineKm(subjectPosition.lat, subjectPosition.lon, flight.lat, flight.lon) <= AIRCRAFT_RADIUS_KM
  ))
  const nearbySatellites = getSatelliteEntries().filter((satellite) => (
    satellite.id !== subject.id &&
    haversineKm(subjectPosition.lat, subjectPosition.lon, satellite.lat, satellite.lon) <= AIRCRAFT_RADIUS_KM
  ))
  const nearbyCameras = getCameraEntries().filter((camera) => (
    camera.id !== subject.id &&
    haversineKm(subjectPosition.lat, subjectPosition.lon, camera.geometry.coordinates[1], camera.geometry.coordinates[0]) <= CAMERA_RADIUS_KM
  ))

  const cellKey = getDensityCell(subjectPosition.lat, subjectPosition.lon).key
  const densityCell = _densityGrid.get(cellKey) || {
    flights: 0,
    satellites: 0,
    cameras: 0,
    total: 0,
  }
  const activeZones = getZonesContaining(subjectPosition.lat, subjectPosition.lon)
  const alertFlags = []

  if (entityKind === 'flight' && _thresholdState.thresholds) {
    const maxAltitudeFeet = _thresholdState.thresholds.maxAltitudeFeet
    const minSpeedKts = _thresholdState.thresholds.minSpeedKts

    if (Number.isFinite(maxAltitudeFeet) && maxAltitudeFeet > 0 && (subject.altitude ?? 0) * 3.281 > maxAltitudeFeet) {
      alertFlags.push('Above altitude threshold')
    }

    if (Number.isFinite(minSpeedKts) && minSpeedKts > 0 && (subject.velocity ?? 0) * 1.944 > minSpeedKts) {
      alertFlags.push('Above speed threshold')
    }

    if (_thresholdState.active?.airborneBelowMinimum) {
      alertFlags.push('Airborne count below configured minimum')
    }
  }

  if (activeZones.length) {
    alertFlags.push(`Inside ${activeZones.length} active zone${activeZones.length === 1 ? '' : 's'}`)
  }

  return {
    subject: {
      kind: entityKind,
      id: entityId,
      data: subject,
    },
    nearbyFlights,
    nearbySatellites,
    nearbyCameras,
    densityCell: {
      ...densityCell,
      level: getDensityLevel(densityCell.total),
    },
    activeZones,
    alertFlags,
  }
}

export function getFusionSnapshot() {
  return {
    areaResult: _areaResult,
    overlapPairs: _overlapPairs,
    densityGrid: _densityGrid,
    correlationMatrix: _correlationMatrix,
  }
}

export function initFusion() {
  on('zones:update', ({ zones = [], occupancy = [] }) => {
    _zoneCache = zones
    _zoneOccupancy = new Map(occupancy.map((entry) => [entry.id, entry.count]))
  })

  on('analytics:threshold-state', (detail) => {
    _thresholdState = detail || _thresholdState
  })

  on('fusion:query-area', ({ lat, lon, radiusKm = AIRCRAFT_RADIUS_KM }) => {
    _areaResult = {
      center: { lat, lon },
      radiusKm,
      results: queryNearby(lat, lon, radiusKm),
      updatedAt: Date.now(),
    }

    emit('fusion:area-result', _areaResult)
  })

  const refreshDerivedState = () => {
    _correlationMatrix = computeMatrix()
    queryDensityGrid()

    if (getSatelliteSnapshot().enabled && getSatellites().length) {
      queryOverlap()
    } else {
      _overlapPairs = []
      emitOverlap()
    }
  }

  on('flights:update', refreshDerivedState)
  on('satellites:update', refreshDerivedState)
  on('cameras:update', refreshDerivedState)

  clearInterval(_overlapTimer)
  _overlapTimer = setInterval(() => {
    if (getSatelliteSnapshot().enabled && getSatellites().length) {
      queryOverlap()
    }
  }, OVERLAP_INTERVAL_MS)

  refreshDerivedState()
}

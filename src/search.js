import { on } from './core/bus.js'
import { getAircraftMap } from './flights.js'
import { getSatellites } from './satellites.js'
import { getCameras } from './cameras.js'
import { getLandmarks } from './landmarks.js'
import { getAirports } from './airports.js'
import { clamp, haversineKm } from './utils/geo.js'

let _query = ''
let _filters = []
let _results = []
let _savedViews = []
const _subscribers = new Set()

function notify() {
  const snapshot = {
    query: _query,
    filters: _filters,
    results: _results,
  }

  for (const handler of _subscribers) {
    try {
      handler(snapshot)
    } catch (error) {
      console.error('[SkyView:search] subscriber failed', error)
    }
  }
}

function getViewerCenter() {
  const viewer = window.__skyview
  const cartographic = viewer?.camera?.positionCartographic
  if (!cartographic) return null

  const radToDeg = 180 / Math.PI
  return {
    lat: cartographic.latitude * radToDeg,
    lon: cartographic.longitude * radToDeg,
  }
}

function getTextMatchScore(query, fields) {
  if (!query) return 0.62

  const normalizedQuery = query.toLowerCase()

  for (const field of fields) {
    const value = String(field || '').toLowerCase()
    if (!value) continue
    if (value === normalizedQuery) return 1
    if (value.startsWith(normalizedQuery)) return 0.92
    if (value.includes(normalizedQuery)) return 0.78
  }

  return 0
}

function getDistanceBonus(lat, lon) {
  const center = getViewerCenter()
  if (!center || !Number.isFinite(lat) || !Number.isFinite(lon)) return 1

  const distanceKm = haversineKm(center.lat, center.lon, lat, lon)
  return clamp(1.2 - distanceKm / 10000, 0.82, 1.2)
}

function getRecencyBonus(kind, entity) {
  if (kind === 'flight') {
    const ageSeconds = Math.max(0, (Date.now() - (entity.lastSeen || Date.now())) / 1000)
    return clamp(1.18 - ageSeconds / 180, 0.8, 1.18)
  }

  return 1
}

function getLatLon(result) {
  if (result.kind === 'flight' || result.kind === 'satellite' || result.kind === 'landmark' || result.kind === 'airport') {
    return { lat: result.entity.lat, lon: result.entity.lon }
  }

  if (result.kind === 'camera') {
    return {
      lat: result.entity.geometry.coordinates[1],
      lon: result.entity.geometry.coordinates[0],
    }
  }

  if (result.kind === 'saved_view') {
    return {
      lat: result.entity.centerLat,
      lon: result.entity.centerLon,
    }
  }

  return { lat: null, lon: null }
}

function normalizeOperator(raw) {
  if (raw === '>=') return '>='
  if (raw === '<=') return '<='
  if (raw === '>') return '>'
  if (raw === '<') return '<'
  return '='
}

function parseNumericFilter(raw, field, unit = null) {
  const match = raw.match(new RegExp(`^${field}\\s*(>=|<=|>|<|=)\\s*([\\d.]+)\\s*([a-zA-Z/]+)?$`, 'i'))
  if (!match) return null

  return {
    field,
    op: normalizeOperator(match[1]),
    value: Number(match[2]),
    unit: (match[3] || unit || '').toLowerCase(),
    label: raw.trim(),
  }
}

export function parseQuery(rawQuery) {
  const query = String(rawQuery || '').trim()
  if (!query) return null

  const altitudeFilter = parseNumericFilter(query, 'altitude', 'm')
  if (altitudeFilter) {
    let altitudeValue = altitudeFilter.value

    if (altitudeFilter.unit === 'ft' || altitudeFilter.unit === 'feet') {
      altitudeValue = altitudeValue / 3.281
    }

    if (altitudeFilter.unit === 'km') {
      altitudeValue *= 1000
    }

    return {
      ...altitudeFilter,
      value: altitudeValue,
    }
  }

  const speedFilter = parseNumericFilter(query, 'speed', 'kts')
  if (speedFilter) return {
    ...speedFilter,
    field: 'velocity',
    value: speedFilter.unit === 'kts'
      ? speedFilter.value / 1.944
      : speedFilter.value,
  }

  const countryMatch = query.match(/^country:(.+)$/i)
  if (countryMatch) {
    return {
      field: 'country',
      value: countryMatch[1].trim(),
      label: query,
    }
  }

  const categoryMatch = query.match(/^category:(.+)$/i)
  if (categoryMatch) {
    return {
      field: 'categories',
      value: categoryMatch[1].trim(),
      label: query,
    }
  }

  const nearMatch = query.match(/^near:([-\d.]+),([-\d.]+),([\d.]+)\s*km$/i)
  if (nearMatch) {
    return {
      field: 'proximity',
      lat: Number(nearMatch[1]),
      lon: Number(nearMatch[2]),
      radius: Number(nearMatch[3]),
      label: query,
    }
  }

  return null
}

function compareNumeric(actualValue, filter) {
  if (!Number.isFinite(actualValue)) return false

  if (filter.op === '>') return actualValue > filter.value
  if (filter.op === '>=') return actualValue >= filter.value
  if (filter.op === '<') return actualValue < filter.value
  if (filter.op === '<=') return actualValue <= filter.value
  return actualValue === filter.value
}

function resultMatchesFilter(result, filter) {
  if (filter.field === 'altitude') {
    const altitudeMeters = result.kind === 'satellite'
      ? (result.entity.altitudeKm ?? 0) * 1000
      : result.entity.altitude ?? result.entity.elev ?? 0
    return compareNumeric(altitudeMeters, filter)
  }

  if (filter.field === 'velocity') {
    return compareNumeric(result.entity.velocity ?? 0, filter)
  }

  if (filter.field === 'country') {
    return String(result.entity.country || '').toLowerCase().includes(String(filter.value || '').toLowerCase())
  }

  if (filter.field === 'categories') {
    return String(result.entity.categories || '').toLowerCase().includes(String(filter.value || '').toLowerCase())
  }

  if (filter.field === 'proximity') {
    const { lat, lon } = getLatLon(result)
    return haversineKm(filter.lat, filter.lon, lat, lon) <= filter.radius
  }

  return true
}

function buildResults() {
  const results = []

  for (const aircraft of getAircraftMap().values()) {
    results.push({
      kind: 'flight',
      id: aircraft.icao24,
      icon: '✈',
      title: aircraft.callsign || aircraft.icao24,
      subtitle: `${aircraft.country || 'Unknown'} · ${Math.round((aircraft.altitude ?? 0) * 3.281).toLocaleString()} ft`,
      entity: aircraft,
      fields: [aircraft.callsign, aircraft.icao24, aircraft.country],
    })
  }

  getSatellites().forEach((satellite) => {
    results.push({
      kind: 'satellite',
      id: String(satellite.id),
      icon: '🛰',
      title: satellite.name,
      subtitle: `NORAD ${satellite.id} · ${Math.round(satellite.altitudeKm || 0)} km`,
      entity: satellite,
      fields: [satellite.name, satellite.designator, satellite.id, satellite.category],
    })
  })

  getCameras().forEach((camera) => {
    results.push({
      kind: 'camera',
      id: camera.id,
      icon: camera.video ? '🎥' : '📷',
      title: camera.city || camera.title || camera.id,
      subtitle: [camera.state, camera.country].filter(Boolean).join(', ') || 'Unknown location',
      entity: camera,
      fields: [camera.id, camera.title, camera.city, camera.state, camera.country, camera.categories],
    })
  })

  getLandmarks().forEach((landmark) => {
    results.push({
      kind: 'landmark',
      id: landmark.name,
      icon: landmark.emoji,
      title: landmark.name,
      subtitle: landmark.country,
      entity: landmark,
      fields: [landmark.name, landmark.country, landmark.description],
    })
  })

  getAirports().forEach((airport) => {
    results.push({
      kind: 'airport',
      id: airport.iata,
      icon: '🛬',
      title: `${airport.iata} · ${airport.name}`,
      subtitle: airport.country,
      entity: airport,
      fields: [airport.iata, airport.icao, airport.name, airport.country],
    })
  })

  _savedViews.forEach((view) => {
    results.push({
      kind: 'saved_view',
      id: view.id,
      icon: '⬢',
      title: view.name,
      subtitle: 'Saved camera view',
      entity: view,
      fields: [view.name, ...(view.activeLayers || [])],
    })
  })

  return results
}

export function runSearch(query, filters = _filters) {
  _query = String(query || '').trim()
  const parsedInlineFilter = parseQuery(_query)
  const effectiveFilters = parsedInlineFilter
    ? [...filters, parsedInlineFilter]
    : filters
  const textQuery = parsedInlineFilter ? '' : _query.toLowerCase()

  _results = buildResults()
    .filter((result) => effectiveFilters.every((filter) => resultMatchesFilter(result, filter)))
    .map((result) => {
      const { lat, lon } = getLatLon(result)
      const textScore = getTextMatchScore(textQuery, result.fields)
      const recencyBonus = getRecencyBonus(result.kind, result.entity)
      const distanceBonus = getDistanceBonus(lat, lon)
      const score = clamp(textScore * recencyBonus * distanceBonus, 0, 1)
      return {
        ...result,
        score,
      }
    })
    .filter((result) => textQuery ? result.score > 0 : true)
    .sort((left, right) => right.score - left.score)

  notify()
  return _results
}

export function getSearchResults() {
  return _results
}

export function getActiveSearchFilters() {
  return _filters
}

export function setSearchFilters(filters) {
  _filters = filters
  runSearch(_query, _filters)
}

export function addSearchFilter(filter) {
  if (!filter) return
  _filters = [..._filters, filter]
  runSearch('', _filters)
}

export function removeSearchFilter(index) {
  _filters = _filters.filter((_, currentIndex) => currentIndex !== index)
  runSearch(_query, _filters)
}

export function clearSearchFilters() {
  _filters = []
  runSearch('', _filters)
}

export function subscribeSearch(handler) {
  _subscribers.add(handler)
  handler({
    query: _query,
    filters: _filters,
    results: _results,
  })
  return () => _subscribers.delete(handler)
}

export function initSearch() {
  on('bookmarks:update', ({ savedViews = [] }) => {
    _savedViews = savedViews
    runSearch(_query, _filters)
  })

  on('search:add-filter', (filter) => {
    addSearchFilter(filter)
  })

  on('search:clear-filters', () => {
    clearSearchFilters()
  })

  runSearch('', _filters)
}

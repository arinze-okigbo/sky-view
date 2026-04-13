/**
 * zones.js
 *
 * Bus events emitted:
 * - `zones:update`      { zones, occupancy, drawActive }
 * - `zones:draw-state`  { active, step }
 * - `alert:zone`        { zone, aircraft, event, timestamp }
 */

import * as Cesium from 'cesium'
import { emit, on } from './core/bus.js'
import { getAircraftMap } from './flights.js'
import { clamp, haversineKm } from './utils/geo.js'
import { readJsonStorage, writeJsonStorage } from './utils/storage.js'

const STORAGE_KEY = 'skyview-zones'
const MAX_ZONES = 10
const DEFAULT_ZONE_COLOR = '#6ce7ff'

let _viewer = null
let _zones = readJsonStorage(STORAGE_KEY, []) || []
let _zoneRuntime = new Map()
let _drawState = {
  active: false,
  step: 'idle',
  center: null,
}
let _previewEntity = null
const _subscribers = new Set()

function persist() {
  writeJsonStorage(STORAGE_KEY, _zones.map((zone) => ({
    id: zone.id,
    name: zone.name,
    lat: zone.lat,
    lon: zone.lon,
    radiusKm: zone.radiusKm,
    color: zone.color,
    alertOn: zone.alertOn,
    dwellMinutes: zone.dwellMinutes,
    enabled: zone.enabled,
    createdAt: zone.createdAt,
  })))
}

function getRuntime(zoneId) {
  if (!_zoneRuntime.has(zoneId)) {
    _zoneRuntime.set(zoneId, {
      inside: new Set(),
      enteredAt: new Map(),
      dwellAlerted: new Set(),
      entity: null,
    })
  }

  return _zoneRuntime.get(zoneId)
}

function notify() {
  const occupancy = _zones.map((zone) => ({
    id: zone.id,
    count: getRuntime(zone.id).inside.size,
  }))
  const snapshot = {
    zones: _zones,
    occupancy,
    drawActive: _drawState.active,
  }

  for (const handler of _subscribers) {
    try {
      handler(snapshot)
    } catch (error) {
      console.error('[SkyView:zones] subscriber failed', error)
    }
  }

  emit('zones:update', snapshot)
}

function removePreview() {
  if (_previewEntity) {
    _viewer?.entities.remove(_previewEntity)
    _previewEntity = null
  }
}

function buildZoneStyle(zone) {
  return {
    material: Cesium.Color.fromCssColorString(zone.color).withAlpha(zone.enabled ? 0.14 : 0.05),
    outline: true,
    outlineColor: Cesium.Color.fromCssColorString(zone.color).withAlpha(zone.enabled ? 0.76 : 0.32),
    outlineWidth: 2,
    semiMajorAxis: zone.radiusKm * 1000,
    semiMinorAxis: zone.radiusKm * 1000,
    height: 0,
  }
}

function syncZoneEntity(zone) {
  if (!_viewer) return

  const runtime = getRuntime(zone.id)
  const position = Cesium.Cartesian3.fromDegrees(zone.lon, zone.lat, 0)

  if (!runtime.entity) {
    runtime.entity = _viewer.entities.add({
      position,
      ellipse: buildZoneStyle(zone),
      label: {
        text: zone.name,
        font: '600 12px "Azeret Mono", monospace',
        fillColor: Cesium.Color.fromCssColorString(zone.color),
        outlineColor: Cesium.Color.fromCssColorString('#020611'),
        outlineWidth: 4,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -18),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })
    return
  }

  runtime.entity.position = position
  runtime.entity.ellipse = {
    ...runtime.entity.ellipse,
    ...buildZoneStyle(zone),
  }
  runtime.entity.label.text = `${zone.name} (${runtime.inside.size})`
  runtime.entity.label.fillColor = Cesium.Color.fromCssColorString(zone.color).withAlpha(zone.enabled ? 1 : 0.45)
}

function rebuildZoneEntities() {
  for (const runtime of _zoneRuntime.values()) {
    if (runtime.entity) {
      _viewer?.entities.remove(runtime.entity)
    }
  }

  _zoneRuntime = new Map()
  _zones.forEach(syncZoneEntity)
}

function clearDrawState() {
  _drawState = {
    active: false,
    step: 'idle',
    center: null,
  }
  removePreview()
  emit('zones:draw-state', {
    active: false,
    step: 'idle',
  })
  notify()
}

function updatePreview(lat, lon, radiusKm) {
  if (!_viewer) return

  const zone = {
    id: 'preview',
    name: 'Draft zone',
    lat,
    lon,
    radiusKm,
    color: DEFAULT_ZONE_COLOR,
    enabled: true,
  }

  if (!_previewEntity) {
    _previewEntity = _viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(zone.lon, zone.lat, 0),
      ellipse: buildZoneStyle(zone),
    })
    return
  }

  _previewEntity.position = Cesium.Cartesian3.fromDegrees(zone.lon, zone.lat, 0)
  _previewEntity.ellipse = {
    ..._previewEntity.ellipse,
    ...buildZoneStyle(zone),
  }
}

function emitZoneAlert(zone, aircraft, eventName) {
  emit('alert:zone', {
    zone,
    aircraft,
    event: eventName,
    timestamp: Date.now(),
  })

  emit('ui:toast', {
    tone: 'danger',
    title: `${zone.name} ${eventName}`,
    message: `${aircraft.callsign || aircraft.icao24 || 'An aircraft'} triggered a ${eventName} alert.`,
  })
}

function evaluateZones() {
  const aircraft = [...getAircraftMap().values()]

  _zones.forEach((zone) => {
    const runtime = getRuntime(zone.id)
    const nextInside = new Set()

    if (!zone.enabled) {
      runtime.inside.clear()
      runtime.enteredAt.clear()
      runtime.dwellAlerted.clear()
      syncZoneEntity(zone)
      return
    }

    aircraft.forEach((entry) => {
      const distanceKm = haversineKm(zone.lat, zone.lon, entry.lat, entry.lon)
      if (distanceKm > zone.radiusKm) return

      nextInside.add(entry.icao24)

      if (!runtime.inside.has(entry.icao24)) {
        runtime.enteredAt.set(entry.icao24, Date.now())
        if (zone.alertOn.includes('enter')) {
          emitZoneAlert(zone, entry, 'enter')
        }
      }

      if (
        zone.alertOn.includes('dwell') &&
        !runtime.dwellAlerted.has(entry.icao24) &&
        Date.now() - (runtime.enteredAt.get(entry.icao24) || Date.now()) >= zone.dwellMinutes * 60_000
      ) {
        runtime.dwellAlerted.add(entry.icao24)
        emitZoneAlert(zone, entry, 'dwell')
      }
    })

    for (const previousIcao of runtime.inside) {
      if (nextInside.has(previousIcao)) continue

      runtime.enteredAt.delete(previousIcao)
      runtime.dwellAlerted.delete(previousIcao)

      if (zone.alertOn.includes('exit')) {
        const aircraftEntry = aircraft.find((entry) => entry.icao24 === previousIcao) || { icao24: previousIcao }
        emitZoneAlert(zone, aircraftEntry, 'exit')
      }
    }

    runtime.inside = nextInside
    syncZoneEntity(zone)
  })

  notify()
}

export function getZones() {
  return _zones
}

export function getZoneOccupancy(zoneId) {
  return getRuntime(zoneId).inside.size
}

export function subscribeZones(handler) {
  _subscribers.add(handler)
  handler({
    zones: _zones,
    occupancy: _zones.map((zone) => ({ id: zone.id, count: getRuntime(zone.id).inside.size })),
    drawActive: _drawState.active,
  })
  return () => _subscribers.delete(handler)
}

export function createZone(config) {
  const zone = {
    id: crypto.randomUUID(),
    name: String(config.name || `Zone ${_zones.length + 1}`).trim() || `Zone ${_zones.length + 1}`,
    lat: Number(config.lat),
    lon: Number(config.lon),
    radiusKm: clamp(Number(config.radiusKm || 50), 1, 2000),
    color: config.color || DEFAULT_ZONE_COLOR,
    alertOn: Array.isArray(config.alertOn) && config.alertOn.length ? config.alertOn : ['enter', 'exit', 'dwell'],
    dwellMinutes: Math.max(1, Number(config.dwellMinutes || 5)),
    enabled: config.enabled !== false,
    createdAt: Date.now(),
  }

  _zones = [..._zones, zone].slice(-MAX_ZONES)
  persist()
  rebuildZoneEntities()
  notify()
  return zone
}

export function updateZone(zoneId, patch) {
  _zones = _zones.map((zone) => zone.id === zoneId ? {
    ...zone,
    ...patch,
  } : zone)
  persist()
  rebuildZoneEntities()
  notify()
}

export function deleteZone(zoneId) {
  const runtime = getRuntime(zoneId)
  if (runtime.entity) {
    _viewer?.entities.remove(runtime.entity)
  }

  _zoneRuntime.delete(zoneId)
  _zones = _zones.filter((zone) => zone.id !== zoneId)
  persist()
  notify()
}

export function toggleZone(zoneId) {
  const zone = _zones.find((entry) => entry.id === zoneId)
  if (!zone) return
  updateZone(zoneId, { enabled: !zone.enabled })
}

export function startZoneDraw() {
  _drawState = {
    active: true,
    step: 'center',
    center: null,
  }

  emit('zones:draw-state', {
    active: true,
    step: 'center',
  })

  emit('ui:toast', {
    tone: 'neutral',
    title: 'Zone drawing',
    message: 'Click the globe to set a zone center, then click again to set the radius.',
  })

  notify()
}

export function cancelZoneDraw() {
  clearDrawState()
}

export function initZones(viewer) {
  _viewer = viewer
  rebuildZoneEntities()
  notify()

  on('flights:update', evaluateZones)

  on('map:left-click', (detail) => {
    if (!_drawState.active || !Number.isFinite(detail?.lat) || !Number.isFinite(detail?.lon)) return

    if (!_drawState.center) {
      _drawState = {
        active: true,
        step: 'radius',
        center: {
          lat: detail.lat,
          lon: detail.lon,
        },
      }

      updatePreview(detail.lat, detail.lon, 1)
      emit('zones:draw-state', {
        active: true,
        step: 'radius',
      })
      notify()
      return
    }

    const suggestedRadius = clamp(
      Math.round(haversineKm(_drawState.center.lat, _drawState.center.lon, detail.lat, detail.lon)),
      1,
      2000,
    )
    const radiusInput = window.prompt('Zone radius in km', String(suggestedRadius))
    const radiusKm = clamp(Number(radiusInput || suggestedRadius), 1, 2000)
    const name = window.prompt('Zone name', `Zone ${_zones.length + 1}`) || `Zone ${_zones.length + 1}`

    createZone({
      name,
      lat: _drawState.center.lat,
      lon: _drawState.center.lon,
      radiusKm,
      color: DEFAULT_ZONE_COLOR,
      alertOn: ['enter', 'exit', 'dwell'],
      dwellMinutes: 5,
      enabled: true,
    })

    clearDrawState()
  })

  on('map:mouse-move', (detail) => {
    if (!_drawState.active || !_drawState.center || !Number.isFinite(detail?.lat) || !Number.isFinite(detail?.lon)) return

    const radiusKm = clamp(
      haversineKm(_drawState.center.lat, _drawState.center.lon, detail.lat, detail.lon),
      1,
      2000,
    )
    updatePreview(_drawState.center.lat, _drawState.center.lon, radiusKm)
  })

  on('map:right-click', () => {
    if (_drawState.active) {
      clearDrawState()
    }
  })

  on('zones:start-draw', startZoneDraw)
  on('zones:cancel-draw', cancelZoneDraw)
}

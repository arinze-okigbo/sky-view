/**
 * timeline.js
 *
 * Bus events emitted:
 * - `timeline:update` { count, filter, events }
 */

import { emit, on } from './core/bus.js'
import { getAircraftMap } from './flights.js'
import { getSatellites } from './satellites.js'
import { formatAbsoluteTime, escapeHtml } from './utils/format.js'

const MAX_EVENTS = 200
const AUTO_SCROLL_RESUME_MS = 5000

const TYPE_META = {
  flight_appeared: { icon: '✈', color: '#00ff88', category: 'flights' },
  flight_lost: { icon: '✈', color: '#ff4444', category: 'flights' },
  satellite_overhead: { icon: '🛰', color: '#a78bfa', category: 'satellites' },
  high_altitude: { icon: '▲', color: '#cc00ff', category: 'flights' },
  high_speed: { icon: '⚡', color: '#ffcc00', category: 'flights' },
  alert_threshold: { icon: '⚠', color: '#ff6600', category: 'alerts' },
  webcam_loaded: { icon: '📷', color: '#6ee7ff', category: 'cameras' },
  layer_toggle: { icon: '◎', color: '#888', category: 'alerts' },
  zone_alert: { icon: '◉', color: '#ff4444', category: 'alerts' },
}

let _events = []
let _activeFilter = 'all'
let _autoScrollEnabled = true
let _resumeTimer = null
let _previousFlightIds = new Set()
let _previousHighAltitude = new Set()
let _previousHighSpeed = new Set()
let _previousSatelliteIds = new Set()
let _previousCameraReadyCount = 0

const dom = {
  panel: null,
  list: null,
  filters: null,
}

function makeEvent(type, title, detail, entityId = null, entityKind = null) {
  return {
    id: crypto.randomUUID(),
    type,
    timestamp: Date.now(),
    title,
    detail,
    entityId,
    entityKind,
  }
}

function pushEvent(event) {
  pushEvents([event])
}

function pushEvents(batch) {
  if (!batch.length) return
  _events = [..._events, ...batch].slice(-MAX_EVENTS)
  renderTimeline()
  emit('timeline:update', {
    count: _events.length,
    filter: _activeFilter,
    events: _events,
  })
}

function getFilteredEvents() {
  if (_activeFilter === 'all') return _events
  return _events.filter((event) => TYPE_META[event.type]?.category === _activeFilter)
}

function renderTimeline() {
  if (!dom.list || !dom.filters) return

  dom.filters.querySelectorAll('[data-filter]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.filter === _activeFilter)
  })

  const events = getFilteredEvents()
  dom.list.innerHTML = events.length
    ? events.map((event) => {
      const meta = TYPE_META[event.type] || TYPE_META.layer_toggle
      return `
        <button
          class="timeline-row"
          type="button"
          data-event-id="${escapeHtml(event.id)}"
          ${event.entityId ? `data-entity-id="${escapeHtml(String(event.entityId))}" data-entity-kind="${escapeHtml(String(event.entityKind))}"` : ''}
        >
          <span class="timeline-icon" style="color:${meta.color}">${meta.icon}</span>
          <span class="timeline-time">${escapeHtml(formatAbsoluteTime(event.timestamp))}</span>
          <span class="timeline-copy">
            <strong>${escapeHtml(event.title)}</strong>
            <span>${escapeHtml(event.detail)}</span>
          </span>
        </button>
      `
    }).join('')
    : '<div class="timeline-empty">No matching activity yet.</div>'

  if (_autoScrollEnabled) {
    dom.list.scrollTop = dom.list.scrollHeight
  }
}

function bindPanel() {
  if (!dom.panel || !dom.list || !dom.filters) return

  dom.filters.addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]')
    if (!button) return
    _activeFilter = button.dataset.filter
    renderTimeline()
  })

  dom.list.addEventListener('click', (event) => {
    const row = event.target.closest('.timeline-row')
    if (!row?.dataset.entityId || !row.dataset.entityKind) return

    emit('entity:focus', {
      kind: row.dataset.entityKind,
      id: row.dataset.entityId,
    })
  })

  dom.list.addEventListener('scroll', () => {
    const distanceToBottom = dom.list.scrollHeight - dom.list.scrollTop - dom.list.clientHeight
    _autoScrollEnabled = distanceToBottom < 20

    clearTimeout(_resumeTimer)
    _resumeTimer = setTimeout(() => {
      _autoScrollEnabled = true
      renderTimeline()
    }, AUTO_SCROLL_RESUME_MS)
  })
}

function handleFlightUpdate() {
  const aircraft = [...getAircraftMap().values()]
  const currentIds = new Set(aircraft.map((entry) => entry.icao24))
  const nextHighAltitude = new Set()
  const nextHighSpeed = new Set()

  aircraft.forEach((entry) => {
    if (!_previousFlightIds.has(entry.icao24)) {
      pushEvent(makeEvent(
        'flight_appeared',
        `${entry.callsign || entry.icao24} entered scope`,
        `${entry.country || 'Unknown'} · ${Math.round((entry.altitude ?? 0) * 3.281).toLocaleString()} ft`,
        entry.icao24,
        'flight',
      ))
    }

    if ((entry.altitude ?? 0) > 12000) {
      nextHighAltitude.add(entry.icao24)
      if (!_previousHighAltitude.has(entry.icao24)) {
        pushEvent(makeEvent(
          'high_altitude',
          `${entry.callsign || entry.icao24} climbed high`,
          `Now above 12,000 m at ${Math.round((entry.altitude ?? 0) * 3.281).toLocaleString()} ft`,
          entry.icao24,
          'flight',
        ))
      }
    }

    if ((entry.velocity ?? 0) > 280) {
      nextHighSpeed.add(entry.icao24)
      if (!_previousHighSpeed.has(entry.icao24)) {
        pushEvent(makeEvent(
          'high_speed',
          `${entry.callsign || entry.icao24} accelerated`,
          `Now above 280 m/s at ${Math.round((entry.velocity ?? 0) * 1.944).toLocaleString()} kts`,
          entry.icao24,
          'flight',
        ))
      }
    }
  })

  for (const flightId of _previousFlightIds) {
    if (!currentIds.has(flightId)) {
      pushEvent(makeEvent(
        'flight_lost',
        `${flightId} left tracking scope`,
        'Aircraft was removed from the live scope after the stale threshold.',
        flightId,
        'flight',
      ))
    }
  }

  _previousFlightIds = currentIds
  _previousHighAltitude = nextHighAltitude
  _previousHighSpeed = nextHighSpeed
}

function handleSatelliteUpdate() {
  const satellites = getSatellites()
  const nextIds = new Set(satellites.map((entry) => String(entry.id)))

  const batch = []
  for (const satellite of satellites) {
    if (!_previousSatelliteIds.has(String(satellite.id))) {
      batch.push(makeEvent(
        'satellite_overhead',
        `${satellite.name} now overhead`,
        `${satellite.category || 'ANY'} · NORAD ${satellite.id}`,
        String(satellite.id),
        'satellite',
      ))
    }
  }
  _previousSatelliteIds = nextIds
  pushEvents(batch)
}

export function initTimeline() {
  dom.panel = document.getElementById('timelinePanel')
  dom.list = document.getElementById('timelineList')
  dom.filters = document.getElementById('timelineFilters')

  bindPanel()

  on('flights:update', handleFlightUpdate)
  on('satellites:update', handleSatelliteUpdate)

  on('cameras:update', (snapshot) => {
    if (snapshot.ready && snapshot.count > 0 && snapshot.count !== _previousCameraReadyCount) {
      pushEvent(makeEvent(
        'webcam_loaded',
        'Webcam layer refreshed',
        `${snapshot.count} webcams are available in the current scene`,
        null,
        'camera',
      ))
    }

    _previousCameraReadyCount = snapshot.count || 0
  })

  on('alert:threshold', (detail) => {
    pushEvent(makeEvent(
      'alert_threshold',
      detail.title || 'Threshold alert',
      detail.detail || 'A configured alert threshold was crossed.',
      null,
      null,
    ))
  })

  on('alert:zone', (detail) => {
    pushEvent(makeEvent(
      'zone_alert',
      `${detail.zone?.name || 'Zone'} ${detail.event || 'alert'}`,
      `${detail.aircraft?.callsign || detail.aircraft?.icao24 || 'Unknown flight'} triggered a geo-fence alert`,
      detail.aircraft?.icao24 || null,
      detail.aircraft ? 'flight' : null,
    ))
  })

  on('layer:toggle', (detail) => {
    pushEvent(makeEvent(
      'layer_toggle',
      `${detail.label || detail.layer} ${detail.enabled ? 'enabled' : 'disabled'}`,
      'Layer visibility changed from the command surface.',
      null,
      null,
    ))
  })

  renderTimeline()
}

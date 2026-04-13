/**
 * analytics.js
 *
 * Bus events emitted:
 * - `alert:threshold`          { key, title, detail, severity, timestamp }
 * - `analytics:threshold-state` { thresholds, active }
 */

import { emit, on } from './core/bus.js'
import { getAircraftMap, getFlightSnapshot } from './flights.js'
import { getFusionSnapshot } from './fusion.js'
import { readJsonStorage, readStorage, writeJsonStorage, writeStorage } from './utils/storage.js'

const STORAGE_KEY = 'skyview-alert-thresholds'
const COLLAPSE_KEY = 'skyview-analytics-collapsed'
const MAX_HISTORY = 60
const REDRAW_INTERVAL_MS = 250
const COUNTRY_ANIMATION_MS = 400

const DEFAULT_THRESHOLDS = {
  maxAltitudeFeet: 43000,
  minSpeedKts: 520,
  minAirborneCount: 25,
}

let _viewer = null
let _history = []
let _thresholds = {
  ...DEFAULT_THRESHOLDS,
  ...(readJsonStorage(STORAGE_KEY, {}) || {}),
}
let _thresholdActive = {
  altitudeExceeded: false,
  speedExceeded: false,
  airborneBelowMinimum: false,
}
let _lastRenderAt = 0
let _renderTimeout = null
let _countryAnimation = {
  startAt: 0,
  from: [],
  to: [],
}
let _collapsed = readStorage(COLLAPSE_KEY, 'false') === 'true'
let _matrixHover = null
let _lastAreaResult = null

const dom = {
  rail: null,
  sparkline: null,
  histogram: null,
  countryChart: null,
  matrix: null,
  matrixTooltip: null,
  fusionSummary: null,
  countLabel: null,
  altitudeInput: null,
  speedInput: null,
  airborneInput: null,
  collapseButton: null,
}

function getAltitudeBuckets() {
  const buckets = [
    { label: '0-3 km', color: '#00ff88', count: 0 },
    { label: '3-8 km', color: '#ffcc00', count: 0 },
    { label: '8-12 km', color: '#ff6600', count: 0 },
    { label: '12-20 km', color: '#cc00ff', count: 0 },
    { label: '>20 km', color: '#ffffff', count: 0 },
  ]

  for (const aircraft of getAircraftMap().values()) {
    const altitude = Number(aircraft.altitude || 0)
    if (altitude < 3000) buckets[0].count += 1
    else if (altitude < 8000) buckets[1].count += 1
    else if (altitude < 12000) buckets[2].count += 1
    else if (altitude < 20000) buckets[3].count += 1
    else buckets[4].count += 1
  }

  return buckets
}

function getCountryRows() {
  const counts = new Map()

  for (const aircraft of getAircraftMap().values()) {
    const key = aircraft.country || 'Unknown'
    counts.set(key, (counts.get(key) || 0) + 1)
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([country, count]) => ({ country, count }))
}

function resizeCanvas(canvas) {
  if (!canvas) return null

  const ratio = window.devicePixelRatio || 1
  const width = Math.max(1, Math.round(canvas.clientWidth * ratio))
  const height = Math.max(1, Math.round(canvas.clientHeight * ratio))

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }

  const ctx = canvas.getContext('2d')
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  return ctx
}

function clearCanvas(ctx, canvas) {
  if (!ctx || !canvas) return
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight)
}

function drawSparkline() {
  const canvas = dom.sparkline
  const ctx = resizeCanvas(canvas)
  if (!ctx || !canvas) return
  clearCanvas(ctx, canvas)

  const width = canvas.clientWidth
  const height = canvas.clientHeight
  const values = _history.length ? _history : [0]
  const maxValue = Math.max(1, ...values)
  const minValue = Math.min(...values)
  const valueRange = Math.max(1, maxValue - minValue)
  const padding = 14

  const gradient = ctx.createLinearGradient(0, 0, 0, height)
  gradient.addColorStop(0, 'rgba(108, 231, 255, 0.36)')
  gradient.addColorStop(1, 'rgba(108, 231, 255, 0)')

  ctx.beginPath()
  values.forEach((value, index) => {
    const x = padding + ((width - padding * 2) * index) / Math.max(1, values.length - 1)
    const y = height - padding - (((value - minValue) / valueRange) * (height - padding * 2))
    if (index === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })

  const lastX = padding + ((width - padding * 2) * (values.length - 1)) / Math.max(1, values.length - 1)
  const lastY = height - padding - (((values[values.length - 1] - minValue) / valueRange) * (height - padding * 2))

  ctx.lineWidth = 2
  ctx.strokeStyle = '#6ce7ff'
  ctx.stroke()

  ctx.lineTo(lastX, height - padding)
  ctx.lineTo(padding, height - padding)
  ctx.closePath()
  ctx.fillStyle = gradient
  ctx.fill()

  ctx.beginPath()
  ctx.arc(lastX, lastY, 4, 0, Math.PI * 2)
  ctx.fillStyle = '#6ce7ff'
  ctx.fill()

  ctx.fillStyle = '#f6f0e7'
  ctx.font = '600 11px "Azeret Mono", monospace'
  ctx.textAlign = 'right'
  ctx.fillText(String(values[values.length - 1]), width - 8, Math.max(14, lastY - 8))
}

function drawHistogram() {
  const canvas = dom.histogram
  const ctx = resizeCanvas(canvas)
  if (!ctx || !canvas) return
  clearCanvas(ctx, canvas)

  const buckets = getAltitudeBuckets()
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  const barGap = 8
  const rowHeight = (height - barGap * (buckets.length - 1)) / buckets.length
  const maxCount = Math.max(1, ...buckets.map((entry) => entry.count))

  ctx.font = '600 11px "Azeret Mono", monospace'
  ctx.textBaseline = 'middle'

  buckets.forEach((bucket, index) => {
    const y = index * (rowHeight + barGap)
    const labelWidth = 58
    const countWidth = 34
    const barWidth = ((width - labelWidth - countWidth - 20) * bucket.count) / maxCount

    ctx.fillStyle = 'rgba(246, 240, 231, 0.72)'
    ctx.textAlign = 'left'
    ctx.fillText(bucket.label, 0, y + rowHeight / 2)

    ctx.fillStyle = bucket.color
    ctx.fillRect(labelWidth, y + 3, Math.max(4, barWidth), rowHeight - 6)

    ctx.fillStyle = '#f6f0e7'
    ctx.textAlign = 'right'
    ctx.fillText(String(bucket.count), width - 2, y + rowHeight / 2)
  })
}

function getAnimatedCountryRows() {
  const targetRows = getCountryRows()
  const previousRows = _countryAnimation.to.length ? _countryAnimation.to : targetRows

  if (JSON.stringify(previousRows) !== JSON.stringify(targetRows)) {
    _countryAnimation = {
      startAt: performance.now(),
      from: previousRows,
      to: targetRows,
    }
  }

  const elapsed = performance.now() - _countryAnimation.startAt
  const progress = Math.min(1, elapsed / COUNTRY_ANIMATION_MS)
  const previousMap = new Map(_countryAnimation.from.map((row) => [row.country, row.count]))
  const nextMap = new Map(_countryAnimation.to.map((row) => [row.country, row.count]))
  const countries = [...new Set([...previousMap.keys(), ...nextMap.keys()])]

  const rows = countries.map((country) => {
    const from = previousMap.get(country) || 0
    const to = nextMap.get(country) || 0
    return {
      country,
      count: from + (to - from) * progress,
      finalCount: to,
    }
  }).filter((row) => row.finalCount > 0)
    .sort((left, right) => right.finalCount - left.finalCount)
    .slice(0, 8)

  if (progress < 1) {
    requestAnimationFrame(() => renderAll(true))
  }

  return rows
}

function drawCountryBars() {
  const canvas = dom.countryChart
  const ctx = resizeCanvas(canvas)
  if (!ctx || !canvas) return
  clearCanvas(ctx, canvas)

  const rows = getAnimatedCountryRows()
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  const rowGap = 6
  const rowHeight = (height - rowGap * Math.max(0, rows.length - 1)) / Math.max(1, rows.length)
  const maxCount = Math.max(1, ...rows.map((row) => row.finalCount))

  ctx.font = '600 11px "Azeret Mono", monospace'
  ctx.textBaseline = 'middle'

  rows.forEach((row, index) => {
    const y = index * (rowHeight + rowGap)
    const labelWidth = 86
    const countWidth = 34
    const barWidth = ((width - labelWidth - countWidth - 20) * row.count) / maxCount

    ctx.fillStyle = '#f6f0e7'
    ctx.textAlign = 'left'
    ctx.fillText(row.country, 0, y + rowHeight / 2)

    ctx.fillStyle = 'rgba(108, 231, 255, 0.18)'
    ctx.fillRect(labelWidth, y + 4, width - labelWidth - countWidth - 14, rowHeight - 8)

    ctx.fillStyle = '#6ce7ff'
    ctx.fillRect(labelWidth, y + 4, Math.max(3, barWidth), rowHeight - 8)

    ctx.fillStyle = '#f6f0e7'
    ctx.textAlign = 'right'
    ctx.fillText(String(Math.round(row.finalCount)), width - 2, y + rowHeight / 2)
  })
}

function getMatrixCells() {
  const matrix = getFusionSnapshot().correlationMatrix
  const labels = ['flights', 'satellites', 'cameras']
  const counts = labels.flatMap((row) => labels.map((column) => matrix[row][column]))
  const maxCount = Math.max(1, ...counts)
  const cells = []

  labels.forEach((row, rowIndex) => {
    labels.forEach((column, columnIndex) => {
      const value = matrix[row][column]
      cells.push({
        row,
        column,
        rowIndex,
        columnIndex,
        value,
        intensity: value / maxCount,
      })
    })
  })

  return cells
}

function drawMatrix() {
  const canvas = dom.matrix
  const ctx = resizeCanvas(canvas)
  if (!ctx || !canvas) return
  clearCanvas(ctx, canvas)

  const width = canvas.clientWidth
  const height = canvas.clientHeight
  const labels = ['Flights', 'Satellites', 'Webcams']
  const paddingLeft = 62
  const paddingTop = 18
  const cellWidth = (width - paddingLeft - 10) / 3
  const cellHeight = (height - paddingTop - 26) / 3
  const cells = getMatrixCells()

  ctx.font = '600 11px "Azeret Mono", monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  labels.forEach((label, index) => {
    ctx.fillStyle = 'rgba(246, 240, 231, 0.75)'
    ctx.fillText(label, paddingLeft + cellWidth * index + cellWidth / 2, 8)
    ctx.save()
    ctx.translate(20, paddingTop + cellHeight * index + cellHeight / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.fillText(label, 0, 0)
    ctx.restore()
  })

  cells.forEach((cell) => {
    const x = paddingLeft + cell.columnIndex * cellWidth
    const y = paddingTop + cell.rowIndex * cellHeight
    const alpha = 0.12 + cell.intensity * 0.65

    ctx.fillStyle = `rgba(108, 231, 255, ${alpha})`
    ctx.fillRect(x + 3, y + 3, cellWidth - 6, cellHeight - 6)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)'
    ctx.strokeRect(x + 3, y + 3, cellWidth - 6, cellHeight - 6)
    ctx.fillStyle = '#03121a'
    ctx.fillText(String(cell.value), x + cellWidth / 2, y + cellHeight / 2)
  })
}

function renderFusionSummary() {
  if (!dom.fusionSummary) return

  const area = _lastAreaResult
  const overlapCount = getFusionSnapshot().overlapPairs.length
  const densityHotspots = [...getFusionSnapshot().densityGrid.values()]
    .sort((left, right) => right.total - left.total)
    .slice(0, 3)

  dom.fusionSummary.innerHTML = `
    <div class="analytics-summary-grid">
      <div class="analytics-summary-card">
        <span class="analytics-summary-label">Overlap pairs</span>
        <strong>${overlapCount}</strong>
      </div>
      <div class="analytics-summary-card">
        <span class="analytics-summary-label">Area query</span>
        <strong>${area ? `${area.results.flights.length + area.results.satellites.length + area.results.cameras.length} hits` : 'Idle'}</strong>
      </div>
    </div>
    <div class="analytics-hotspots">
      ${densityHotspots.length ? densityHotspots.map((entry) => `
        <div class="analytics-hotspot-row">
          <span>${entry.cell.key}</span>
          <span>${entry.total} total</span>
        </div>
      `).join('') : '<div class="analytics-hotspot-row"><span>No density cells yet</span><span>—</span></div>'}
    </div>
    ${area ? `
      <div class="analytics-area-result">
        <strong>Area query</strong>
        <span>${area.center.lat.toFixed(2)}°, ${area.center.lon.toFixed(2)}° · ${area.radiusKm} km</span>
        <span>${area.results.flights.length} flights · ${area.results.satellites.length} satellites · ${area.results.cameras.length} webcams</span>
      </div>
    ` : ''}
  `
}

function updateThresholdInputs() {
  if (dom.altitudeInput) dom.altitudeInput.value = String(_thresholds.maxAltitudeFeet)
  if (dom.speedInput) dom.speedInput.value = String(_thresholds.minSpeedKts)
  if (dom.airborneInput) dom.airborneInput.value = String(_thresholds.minAirborneCount)
}

function persistThresholds() {
  writeJsonStorage(STORAGE_KEY, _thresholds)
  emit('analytics:threshold-state', {
    thresholds: _thresholds,
    active: _thresholdActive,
  })
}

function triggerThresholdAlert(key, title, detail, severity = 'warning') {
  emit('alert:threshold', {
    key,
    title,
    detail,
    severity,
    timestamp: Date.now(),
  })

  emit('ui:toast', {
    tone: severity === 'danger' ? 'danger' : 'warning',
    title,
    message: detail,
  })
}

function evaluateThresholds() {
  const snapshot = getFlightSnapshot()
  const aircraft = [...getAircraftMap().values()]
  const maxAltitudeFeet = aircraft.reduce((max, entry) => Math.max(max, (entry.altitude ?? 0) * 3.281), 0)
  const maxSpeedKts = aircraft.reduce((max, entry) => Math.max(max, (entry.velocity ?? 0) * 1.944), 0)

  const nextState = {
    altitudeExceeded: maxAltitudeFeet > _thresholds.maxAltitudeFeet,
    speedExceeded: maxSpeedKts > _thresholds.minSpeedKts,
    airborneBelowMinimum: snapshot.airborneCount < _thresholds.minAirborneCount,
  }

  if (nextState.altitudeExceeded && !_thresholdActive.altitudeExceeded) {
    triggerThresholdAlert(
      'altitudeExceeded',
      'Altitude threshold crossed',
      `An aircraft climbed above ${Math.round(_thresholds.maxAltitudeFeet).toLocaleString()} ft`,
      'warning',
    )
  }

  if (nextState.speedExceeded && !_thresholdActive.speedExceeded) {
    triggerThresholdAlert(
      'speedExceeded',
      'Speed threshold crossed',
      `An aircraft exceeded ${Math.round(_thresholds.minSpeedKts).toLocaleString()} kts`,
      'warning',
    )
  }

  if (nextState.airborneBelowMinimum && !_thresholdActive.airborneBelowMinimum) {
    triggerThresholdAlert(
      'airborneBelowMinimum',
      'Airborne count dropped',
      `Tracked airborne traffic fell below ${Math.round(_thresholds.minAirborneCount).toLocaleString()} aircraft`,
      'danger',
    )
  }

  _thresholdActive = nextState
  emit('analytics:threshold-state', {
    thresholds: _thresholds,
    active: _thresholdActive,
  })
}

function renderAll(force = false) {
  const now = Date.now()
  if (!force && now - _lastRenderAt < REDRAW_INTERVAL_MS) {
    clearTimeout(_renderTimeout)
    _renderTimeout = setTimeout(() => renderAll(true), REDRAW_INTERVAL_MS)
    return
  }

  _lastRenderAt = now

  if (dom.countLabel) {
    dom.countLabel.textContent = String(getFlightSnapshot().airborneCount || 0)
  }

  drawSparkline()
  drawHistogram()
  drawCountryBars()
  drawMatrix()
  renderFusionSummary()
}

function applyCollapsedState() {
  if (!dom.rail) return
  dom.rail.classList.toggle('is-collapsed', _collapsed)
  if (dom.collapseButton) {
    dom.collapseButton.textContent = _collapsed ? 'Expand' : 'Collapse'
    dom.collapseButton.setAttribute('aria-expanded', String(!_collapsed))
  }
}

function bindThresholdInputs() {
  const fields = [
    ['maxAltitudeFeet', dom.altitudeInput],
    ['minSpeedKts', dom.speedInput],
    ['minAirborneCount', dom.airborneInput],
  ]

  fields.forEach(([key, input]) => {
    if (!input) return
    input.addEventListener('input', () => {
      _thresholds[key] = Math.max(0, Number(input.value || 0))
      persistThresholds()
      evaluateThresholds()
      renderAll(true)
    })
  })
}

function bindMatrixHover() {
  if (!dom.matrix || !dom.matrixTooltip) return

  dom.matrix.addEventListener('mousemove', (event) => {
    const rect = dom.matrix.getBoundingClientRect()
    const width = dom.matrix.clientWidth
    const height = dom.matrix.clientHeight
    const paddingLeft = 62
    const paddingTop = 18
    const cellWidth = (width - paddingLeft - 10) / 3
    const cellHeight = (height - paddingTop - 26) / 3
    const col = Math.floor((event.clientX - rect.left - paddingLeft) / cellWidth)
    const row = Math.floor((event.clientY - rect.top - paddingTop) / cellHeight)

    if (row < 0 || row > 2 || col < 0 || col > 2) {
      dom.matrixTooltip.classList.add('is-hidden')
      return
    }

    const cells = getMatrixCells()
    const hit = cells.find((cell) => cell.rowIndex === row && cell.columnIndex === col)
    if (!hit) {
      dom.matrixTooltip.classList.add('is-hidden')
      return
    }

    dom.matrixTooltip.classList.remove('is-hidden')
    dom.matrixTooltip.style.left = `${event.clientX - rect.left + 14}px`
    dom.matrixTooltip.style.top = `${event.clientY - rect.top + 14}px`
    dom.matrixTooltip.textContent = `${hit.row} × ${hit.column}: ${hit.value}`
  })

  dom.matrix.addEventListener('mouseleave', () => {
    dom.matrixTooltip.classList.add('is-hidden')
  })
}

function bindCollapse() {
  if (!dom.collapseButton) return

  dom.collapseButton.addEventListener('click', () => {
    _collapsed = !_collapsed
    writeStorage(COLLAPSE_KEY, String(_collapsed))
    applyCollapsedState()
  })
}

function refreshHistory() {
  _history.push(getFlightSnapshot().airborneCount || 0)
  if (_history.length > MAX_HISTORY) {
    _history = _history.slice(-MAX_HISTORY)
  }
}

export function initAnalytics(viewer) {
  _viewer = viewer
  dom.rail = document.getElementById('analyticsRail')
  dom.sparkline = document.getElementById('analyticsSparkline')
  dom.histogram = document.getElementById('analyticsHistogram')
  dom.countryChart = document.getElementById('analyticsCountryChart')
  dom.matrix = document.getElementById('analyticsMatrix')
  dom.matrixTooltip = document.getElementById('analyticsMatrixTooltip')
  dom.fusionSummary = document.getElementById('fusionSummaryPanel')
  dom.countLabel = document.getElementById('analyticsCountLabel')
  dom.altitudeInput = document.getElementById('thresholdAltitudeInput')
  dom.speedInput = document.getElementById('thresholdSpeedInput')
  dom.airborneInput = document.getElementById('thresholdAirborneInput')
  dom.collapseButton = document.getElementById('analyticsCollapse')

  refreshHistory()
  updateThresholdInputs()
  applyCollapsedState()
  bindThresholdInputs()
  bindMatrixHover()
  bindCollapse()

  on('flights:update', () => {
    refreshHistory()
    evaluateThresholds()
    renderAll()
  })

  on('satellites:update', () => {
    renderAll()
  })

  on('cameras:update', () => {
    renderAll()
  })

  on('fusion:area-result', (detail) => {
    _lastAreaResult = detail
    renderAll(true)
  })

  renderAll(true)
  evaluateThresholds()
}

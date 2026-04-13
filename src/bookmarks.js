/**
 * bookmarks.js
 *
 * Bus events emitted:
 * - `bookmarks:update`   { savedViews, bookmarks, annotations }
 * - `view:load-layers`   { activeLayers }
 */

import * as Cesium from 'cesium'
import { emit, on } from './core/bus.js'
import { readJsonStorage, writeJsonStorage } from './utils/storage.js'

const SAVED_VIEWS_KEY = 'skyview-saved-views'
const BOOKMARKS_KEY = 'skyview-bookmarks'
const ANNOTATIONS_KEY = 'skyview-annotations'
const MAX_VIEWS = 20
const MAX_BOOKMARKS = 50
const MAX_ANNOTATIONS = 100

let _viewer = null
let _savedViews = readJsonStorage(SAVED_VIEWS_KEY, []) || []
let _bookmarks = readJsonStorage(BOOKMARKS_KEY, []) || []
let _annotations = readJsonStorage(ANNOTATIONS_KEY, []) || []
let _activeLayers = {
  flights: true,
  landmarks: true,
  airports: true,
  satellites: true,
  cameras: false,
  weather: false,
  trajectories: true,
  lighting: true,
}
let _labelCollection = null
const _annotationLabels = new Map()
const _subscribers = new Set()

function notify() {
  const snapshot = {
    savedViews: _savedViews,
    bookmarks: _bookmarks,
    annotations: _annotations,
  }

  for (const handler of _subscribers) {
    try {
      handler(snapshot)
    } catch (error) {
      console.error('[SkyView:bookmarks] subscriber failed', error)
    }
  }

  emit('bookmarks:update', snapshot)
}

function persist() {
  writeJsonStorage(SAVED_VIEWS_KEY, _savedViews)
  writeJsonStorage(BOOKMARKS_KEY, _bookmarks)
  writeJsonStorage(ANNOTATIONS_KEY, _annotations)
}

function trimCollection(collection, limit) {
  return collection.slice(-limit)
}

function createAnnotationLabel(annotation) {
  if (!_labelCollection) return

  const label = _labelCollection.add({
    id: annotation.id,
    position: Cesium.Cartesian3.fromDegrees(annotation.lon, annotation.lat, 0),
    text: annotation.text,
    font: '600 13px "Azeret Mono", monospace',
    fillColor: Cesium.Color.fromCssColorString(annotation.color || '#6ce7ff'),
    outlineColor: Cesium.Color.fromCssColorString('#020611'),
    outlineWidth: 4,
    showBackground: true,
    backgroundColor: Cesium.Color.fromCssColorString('rgba(8, 12, 24, 0.72)'),
    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
    pixelOffset: new Cesium.Cartesian2(0, -18),
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
  })

  _annotationLabels.set(annotation.id, label)
}

function rebuildAnnotations() {
  if (!_labelCollection) return
  _labelCollection.removeAll()
  _annotationLabels.clear()

  _annotations.forEach(createAnnotationLabel)
}

function getCameraSnapshot() {
  const position = _viewer?.camera?.positionWC
  const cartographic = _viewer?.camera?.positionCartographic

  if (!position || !cartographic) return null

  return {
    cameraPosition: {
      x: position.x,
      y: position.y,
      z: position.z,
    },
    cameraOrientation: {
      heading: _viewer.camera.heading,
      pitch: _viewer.camera.pitch,
      roll: _viewer.camera.roll,
    },
    centerLat: Cesium.Math.toDegrees(cartographic.latitude),
    centerLon: Cesium.Math.toDegrees(cartographic.longitude),
  }
}

export function getSavedViews() {
  return _savedViews
}

export function getBookmarks() {
  return _bookmarks
}

export function getAnnotations() {
  return _annotations
}

export function getAnnotationById(annotationId) {
  return _annotations.find((entry) => entry.id === annotationId) || null
}

export function subscribeBookmarks(handler) {
  _subscribers.add(handler)
  handler({
    savedViews: _savedViews,
    bookmarks: _bookmarks,
    annotations: _annotations,
  })
  return () => _subscribers.delete(handler)
}

export function saveView(name) {
  if (!_viewer) return null
  const camera = getCameraSnapshot()
  if (!camera) return null

  const view = {
    id: crypto.randomUUID(),
    name: String(name || `View ${_savedViews.length + 1}`).trim() || `View ${_savedViews.length + 1}`,
    ...camera,
    activeLayers: Object.entries(_activeLayers)
      .filter(([, enabled]) => enabled)
      .map(([layer]) => layer),
    timestamp: Date.now(),
  }

  _savedViews = trimCollection([..._savedViews, view], MAX_VIEWS)
  persist()
  notify()
  return view
}

export function loadView(viewId) {
  const view = _savedViews.find((entry) => entry.id === viewId)
  if (!view || !_viewer) return false

  _viewer.camera.flyTo({
    destination: new Cesium.Cartesian3(
      view.cameraPosition.x,
      view.cameraPosition.y,
      view.cameraPosition.z,
    ),
    orientation: {
      heading: view.cameraOrientation.heading,
      pitch: view.cameraOrientation.pitch,
      roll: view.cameraOrientation.roll,
    },
    duration: 1.8,
  })

  emit('view:load-layers', {
    activeLayers: view.activeLayers || [],
  })

  return true
}

export function deleteSavedView(viewId) {
  _savedViews = _savedViews.filter((entry) => entry.id !== viewId)
  persist()
  notify()
}

export function addBookmark(kind, id, label) {
  const bookmark = {
    id: crypto.randomUUID(),
    kind,
    entityId: id,
    label,
    timestamp: Date.now(),
  }

  _bookmarks = trimCollection([
    ..._bookmarks.filter((entry) => !(entry.kind === kind && String(entry.entityId) === String(id))),
    bookmark,
  ], MAX_BOOKMARKS)
  persist()
  notify()
  return bookmark
}

export function removeBookmark(bookmarkId) {
  _bookmarks = _bookmarks.filter((entry) => entry.id !== bookmarkId)
  persist()
  notify()
}

export function addAnnotation(lat, lon, text, color = '#6ce7ff') {
  const annotation = {
    id: crypto.randomUUID(),
    lat,
    lon,
    text: String(text || '').trim().slice(0, 120),
    color,
    createdAt: Date.now(),
  }

  if (!annotation.text) return null

  _annotations = trimCollection([..._annotations, annotation], MAX_ANNOTATIONS)
  persist()
  rebuildAnnotations()
  notify()
  return annotation
}

export function removeAnnotation(annotationId) {
  _annotations = _annotations.filter((entry) => entry.id !== annotationId)
  persist()
  rebuildAnnotations()
  notify()
}

export function flyToAnnotation(annotationId) {
  const annotation = getAnnotationById(annotationId)
  if (!annotation || !_viewer) return false

  const center = Cesium.Cartesian3.fromDegrees(annotation.lon, annotation.lat, 0)
  _viewer.camera.flyToBoundingSphere(
    new Cesium.BoundingSphere(center, 0),
    {
      offset: new Cesium.HeadingPitchRange(
        0,
        Cesium.Math.toRadians(-45),
        80_000,
      ),
      duration: 1.6,
    },
  )

  return true
}

export function initBookmarks(viewer) {
  _viewer = viewer

  if (_labelCollection) {
    viewer.scene.primitives.remove(_labelCollection)
  }

  _labelCollection = new Cesium.LabelCollection({ scene: viewer.scene })
  viewer.scene.primitives.add(_labelCollection)
  rebuildAnnotations()

  on('layer:toggle', ({ layer, enabled }) => {
    _activeLayers = {
      ..._activeLayers,
      [layer]: enabled,
    }
  })

  // Saved views only persist enabled layer names; keep bookmark state aligned when a view loads.
  on('view:load-layers', ({ activeLayers = [] }) => {
    const enabled = new Set(activeLayers.map(String))
    _activeLayers = {
      flights: enabled.has('flights'),
      landmarks: enabled.has('landmarks'),
      airports: enabled.has('airports'),
      satellites: enabled.has('satellites'),
      cameras: enabled.has('cameras'),
      weather: enabled.has('weather'),
      trajectories: enabled.has('trajectories'),
      lighting: enabled.has('lighting'),
    }
  })

  on('bookmarks:add', ({ kind, id, label }) => {
    addBookmark(kind, id, label)
  })

  notify()
}

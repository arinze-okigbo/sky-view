import * as Cesium from 'cesium';
import { emit, on } from './core/bus.js';
import { getApiUrl } from './config.js';
import { getUserLocation } from './userLocation.js';

const REFRESH_INTERVAL_MS = 90_000;
const RETRY_INTERVAL_MS = 120_000;
const SEARCH_RADIUS_DEGREES = 70;
const CATEGORY_ID = 0;
const TRACK_SECONDS = 120;
const DEFAULT_ALTITUDE_METERS = 0;

let _viewer = null;
let _visible = false;
let _entitiesBySatId = new Map();
let _satellitesById = new Map();
let _pollTimer = null;
let _abortController = null;
let _selectedSatelliteId = null;
let _trackEntity = null;
let _unsubscribeUserLocation = null;
let _lastObserverLat = null;
let _lastObserverLon = null;
let _cameraMoveDebounceId = null;

const _entityToSatellite = new WeakMap();
const _subscribers = new Set();

let _snapshot = {
  available: Boolean(getApiUrl('/n2yo/above/0/0/0/70/0')),
  ready: false,
  enabled: _visible,
  count: 0,
  category: 'ANY',
  observerLabel: 'Awaiting observer',
  observerSource: 'unknown',
  lastRefreshTime: 0,
  transactionCount: 0,
  feedLabel: 'Satellites offline',
  statusText: 'Satellite layer idle',
  error: null,
};

function notifySnapshot() {
  for (const handler of _subscribers) {
    try {
      handler(_snapshot);
    } catch (error) {
      console.error('[SkyView:satellites] subscriber failed', error);
    }
  }

  emit('satellites:update', _snapshot);
}

function setSnapshot(patch) {
  _snapshot = {
    ..._snapshot,
    ...patch,
    enabled: _visible,
    available: Boolean(getApiUrl('/n2yo/above/0/0/0/70/0')),
  };

  notifySnapshot();
}

function clearPollTimer() {
  if (_pollTimer) {
    clearTimeout(_pollTimer);
    _pollTimer = null;
  }
}

function schedulePoll(delayMs = REFRESH_INTERVAL_MS) {
  clearPollTimer();
  if (!_visible) return;
  _pollTimer = setTimeout(() => {
    pollAbove();
  }, delayMs);
}

function getCameraObserver() {
  if (!_viewer?.camera?.positionCartographic) return null;

  const cartographic = _viewer.camera.positionCartographic;
  if (!cartographic) return null;

  return {
    lat: Cesium.Math.toDegrees(cartographic.latitude),
    lon: Cesium.Math.toDegrees(cartographic.longitude),
    alt: DEFAULT_ALTITUDE_METERS,
    label: 'camera view',
    source: 'camera',
  };
}

function getObserver() {
  // Always use the camera subpoint so satellites update as you navigate the globe.
  // Geolocation is not used here — the app is a globe explorer, not a stationary tracker.
  return getCameraObserver();
}

function getColorForAltitude(altitudeKm) {
  if (altitudeKm < 800) return Cesium.Color.fromCssColorString('#5eead4');
  if (altitudeKm < 2_000) return Cesium.Color.fromCssColorString('#74d9ff');
  if (altitudeKm < 20_000) return Cesium.Color.fromCssColorString('#f59e0b');
  return Cesium.Color.fromCssColorString('#a78bfa');
}

function toCartesian(satellite) {
  return Cesium.Cartesian3.fromDegrees(
    satellite.lon,
    satellite.lat,
    (satellite.altitudeKm ?? 0) * 1000,
  );
}

function createSatelliteEntity(satellite) {
  const entity = _viewer.entities.add({
    position: toCartesian(satellite),
    point: {
      pixelSize: 11,
      color: getColorForAltitude(satellite.altitudeKm),
      outlineColor: Cesium.Color.fromCssColorString('#0b1220'),
      outlineWidth: 3,
      scaleByDistance: new Cesium.NearFarScalar(8e5, 1.3, 2.8e7, 0.85),
    },
    label: {
      text: satellite.name,
      font: '600 11px "Azeret Mono", monospace',
      fillColor: Cesium.Color.fromCssColorString('#f6f0e7'),
      outlineColor: Cesium.Color.fromCssColorString('#020611'),
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new Cesium.Cartesian2(0, -22),
      scaleByDistance: new Cesium.NearFarScalar(3e5, 1.05, 1.1e7, 0.3),
      showBackground: false,
    },
    show: _visible,
  });

  _entityToSatellite.set(entity, satellite);
  _entitiesBySatId.set(satellite.id, entity);
  return entity;
}

function updateSatelliteEntity(entity, satellite) {
  entity.position = toCartesian(satellite);
  entity.show = _visible;

  if (entity.point) {
    entity.point.color = satellite.id === _selectedSatelliteId
      ? Cesium.Color.fromCssColorString('#f8c76b')
      : getColorForAltitude(satellite.altitudeKm);
    entity.point.pixelSize = satellite.id === _selectedSatelliteId ? 14 : 11;
  }

  if (entity.label) {
    entity.label.text = satellite.name;
  }

  _entityToSatellite.set(entity, satellite);
}

function clearTrack() {
  if (_trackEntity) {
    _viewer?.entities.remove(_trackEntity);
    _trackEntity = null;
  }
}

function removeSatellite(satId) {
  const entity = _entitiesBySatId.get(satId);
  if (entity) {
    _viewer?.entities.remove(entity);
  }

  _entitiesBySatId.delete(satId);
  _satellitesById.delete(satId);
}

function applySelectionStyles() {
  for (const [satId, entity] of _entitiesBySatId) {
    const satellite = _satellitesById.get(satId);
    if (!satellite) continue;
    updateSatelliteEntity(entity, satellite);
  }
}

function normalizeSatellite(raw, category = 'ANY') {
  return {
    id: Number(raw.satid),
    name: String(raw.satname || 'Unknown object').trim(),
    category,
    designator: raw.intDesignator || '—',
    launchDate: raw.launchDate || '—',
    lat: Number(raw.satlat),
    lon: Number(raw.satlng),
    altitudeKm: Number(raw.satalt),
  };
}

function applyAboveResponse(data, observer) {
  const category = data?.info?.category || 'ANY';
  const transactionCount = Number(data?.info?.transactionscount || 0);
  const rawSatellites = Array.isArray(data?.above) ? data.above : [];
  const nextSatellites = rawSatellites
    .map((entry) => normalizeSatellite(entry, category))
    .filter((entry) => Number.isFinite(entry.id) && Number.isFinite(entry.lat) && Number.isFinite(entry.lon));

  const seen = new Set();

  for (const satellite of nextSatellites) {
    seen.add(satellite.id);
    _satellitesById.set(satellite.id, satellite);

    const existing = _entitiesBySatId.get(satellite.id);
    if (existing) {
      updateSatelliteEntity(existing, satellite);
    } else {
      createSatelliteEntity(satellite);
    }
  }

  for (const satId of [..._entitiesBySatId.keys()]) {
    if (!seen.has(satId)) {
      removeSatellite(satId);
    }
  }

  applySelectionStyles();

  _lastObserverLat = observer.lat;
  _lastObserverLon = observer.lon;

  setSnapshot({
    ready: true,
    count: nextSatellites.length,
    category,
    observerLabel: observer.label,
    observerSource: observer.source,
    lastRefreshTime: Date.now(),
    transactionCount,
    feedLabel: nextSatellites.length ? `${nextSatellites.length} overhead` : 'No overhead objects',
    statusText: nextSatellites.length
      ? `${nextSatellites.length} tracked over ${observer.label}`
      : `No tracked objects above ${observer.label}`,
    error: null,
  });
}

function getAboveUrl(observer) {
  return getApiUrl(
    `/n2yo/above/${observer.lat.toFixed(4)}/${observer.lon.toFixed(4)}/${Math.round(observer.alt)}/${SEARCH_RADIUS_DEGREES}/${CATEGORY_ID}`,
  );
}

function getPositionsUrl(satelliteId, observer, seconds = TRACK_SECONDS) {
  return getApiUrl(
    `/n2yo/positions/${satelliteId}/${observer.lat.toFixed(4)}/${observer.lon.toFixed(4)}/${Math.round(observer.alt)}/${seconds}`,
  );
}

async function requestJson(url, errorPrefix, signal) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
    },
    signal,
  });

  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message = data?.error || data?.message || `${errorPrefix} (${response.status})`;
    throw new Error(message);
  }

  return data;
}

async function pollAbove() {
  clearPollTimer();

  if (!_visible) return;

  const observer = getObserver();

  if (!observer) {
    setSnapshot({
      ready: false,
      count: 0,
      feedLabel: 'Awaiting observer',
      statusText: 'Waiting for location or camera context before querying satellites.',
      error: 'observer-unavailable',
    });
    schedulePoll(RETRY_INTERVAL_MS);
    return;
  }

  const url = getAboveUrl(observer);

  if (!url) {
    setSnapshot({
      ready: false,
      count: 0,
      feedLabel: 'Satellites unavailable',
      statusText: 'No N2YO backend is configured for this deployment.',
      error: 'unconfigured',
    });
    return;
  }

  if (_abortController) {
    _abortController.abort();
  }
  _abortController = new AbortController();

  setSnapshot({
    observerLabel: observer.label,
    observerSource: observer.source,
    feedLabel: 'Refreshing satellites',
    statusText: `Checking the sky above ${observer.label}…`,
    error: null,
  });

  try {
    const data = await requestJson(url, 'Satellite feed unavailable', _abortController.signal);
    applyAboveResponse(data, observer);
    console.log(`[SkyView] ${_snapshot.count} satellites above ${observer.label}`);
    schedulePoll(REFRESH_INTERVAL_MS);
  } catch (error) {
    if (error?.name === 'AbortError') return;

    console.warn('[SkyView:satellites] Poll failed', error);
    setSnapshot({
      ready: false,
      feedLabel: 'Satellites degraded',
      statusText: error.message,
      error: error.message,
    });
    emit('ui:toast', {
      tone: 'warning',
      title: 'Satellite feed issue',
      message: error.message,
    });
    schedulePoll(RETRY_INTERVAL_MS);
  }
}

export function subscribeSatellites(handler) {
  _subscribers.add(handler);
  handler(_snapshot);
  return () => {
    _subscribers.delete(handler);
  };
}

export function getSatelliteSnapshot() {
  return _snapshot;
}

export function getSatellites() {
  return [..._satellitesById.values()];
}

export function getSatelliteById(satId) {
  return _satellitesById.get(Number(satId)) || null;
}

export function getEntityToSatellite() {
  return _entityToSatellite;
}

export function setSatellitesVisible(visible) {
  _visible = Boolean(visible);

  for (const entity of _entitiesBySatId.values()) {
    entity.show = _visible;
  }

  if (!_visible) {
    _abortController?.abort();
    _abortController = null;
    clearPollTimer();
    clearTrack();
    _selectedSatelliteId = null;
    setSnapshot({
      enabled: false,
      statusText: 'Satellite layer hidden.',
      feedLabel: 'Satellites off',
    });
    return;
  }

  setSnapshot({
    enabled: true,
  });

  pollAbove();
}

export function setSelectedSatellite(satId) {
  _selectedSatelliteId = satId ? Number(satId) : null;

  if (!_selectedSatelliteId) {
    clearTrack();
  }

  applySelectionStyles();
}

export function flyToSatellite(satellite) {
  if (!_viewer || !satellite) return;

  const center = toCartesian(satellite);
  const range = Cesium.Math.clamp((satellite.altitudeKm ?? 400) * 4_500, 80_000, 2_400_000);

  _viewer.camera.flyToBoundingSphere(
    new Cesium.BoundingSphere(center, 0),
    {
      offset: new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(0),
        Cesium.Math.toRadians(-35),
        range,
      ),
      duration: 2.1,
    },
  );
}

export async function enrichSatellite(satelliteId) {
  const satellite = getSatelliteById(satelliteId);
  const observer = getObserver();
  const url = satellite && observer ? getPositionsUrl(satellite.id, observer) : null;

  if (!satellite || !url) {
    return {
      availability: 'unconfigured',
    };
  }

  try {
    const data = await requestJson(url, 'Satellite track unavailable');
    const positions = Array.isArray(data?.positions) ? data.positions : [];

    clearTrack();

    if (positions.length >= 2 && _viewer) {
      _trackEntity = _viewer.entities.add({
        polyline: {
          positions: positions.map((entry) => Cesium.Cartesian3.fromDegrees(
            Number(entry.satlongitude),
            Number(entry.satlatitude),
            Number(entry.sataltitude || 0) * 1000,
          )),
          width: 2,
          arcType: Cesium.ArcType.NONE,
          material: Cesium.Color.fromCssColorString('#f59e0b').withAlpha(0.8),
        },
        show: _visible,
      });
    }

    return {
      availability: 'live',
      observer,
      transactionCount: Number(data?.info?.transactionscount || 0),
      current: positions[0] || null,
      positions,
    };
  } catch (error) {
    console.warn('[SkyView:satellites] Track lookup failed', error);
    return {
      availability: 'unavailable',
      message: error.message,
    };
  }
}

export function initSatellites(viewer) {
  _viewer = viewer;

  setSnapshot({
    available: Boolean(getApiUrl('/n2yo/above/0/0/0/70/0')),
    statusText: Boolean(getApiUrl('/n2yo/above/0/0/0/70/0'))
      ? 'Satellite layer ready when enabled.'
      : 'Satellite layer requires an N2YO backend.',
    feedLabel: Boolean(getApiUrl('/n2yo/above/0/0/0/70/0'))
      ? 'Satellites ready'
      : 'Satellites unavailable',
  });

  _unsubscribeUserLocation?.();
  _unsubscribeUserLocation = on('user:location', () => {
    if (_visible) pollAbove();
  });

  // Re-poll when the camera moves more than ~25 degrees from the last query point.
  viewer.camera.changed.addEventListener(() => {
    if (!_visible) return;

    const observer = getCameraObserver();
    if (!observer) return;

    if (_lastObserverLat !== null && _lastObserverLon !== null) {
      const latDiff = Math.abs(observer.lat - _lastObserverLat);
      const lonDiff = Math.abs(observer.lon - _lastObserverLon);
      if (latDiff < 25 && lonDiff < 25) return;
    }

    // Debounce: wait 1.5 s after the camera stops moving before firing.
    clearTimeout(_cameraMoveDebounceId);
    _cameraMoveDebounceId = setTimeout(() => {
      if (_visible) pollAbove();
    }, 1500);
  });
}

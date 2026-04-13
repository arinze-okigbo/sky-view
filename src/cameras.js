/**
 * cameras.js — Windy Webcams layer
 *
 * Features:
 *   - Fetches webcams from the Windy Webcams API V3 using a viewport bounding box
 *   - Renders webcam markers as Cesium entities on the globe
 *   - Re-polls automatically when the camera view shifts significantly
 *   - Hemisphere culling for performance
 *   - Live embed via Windy player iframe (no auth required on the client)
 */

import * as Cesium from 'cesium';
import { emit, on } from './core/bus.js';
import { getApiUrl } from './config.js';
import { ICON_CAMERA } from './layerIcons.js';

const POLL_INTERVAL = 120_000;
const RETRY_INTERVAL = 180_000;
const MAX_WEBCAMS = 50;
const MOVE_THRESHOLD_DEG = 15;
const MOVE_DEBOUNCE_MS = 1_500;
// Don't query if the camera is too far away to show useful webcams
const MAX_QUERY_HEIGHT_M = 8_000_000;

let _viewer = null;
let _visible = false;
let _entitiesByCamId = new Map();
let _camerasById = new Map();
/** ECEF marker positions for hemisphere culling (avoids fromDegrees every frame). */
let _webcamEcefById = new Map();
let _selectedCameraId = null;
let _pollTimer = null;
let _abortController = null;
let _lastBboxCenter = null;
let _cameraMoveDebounceId = null;

const _entityToCamera = new WeakMap();
const _subscribers = new Set();

let _snapshot = {
  available: Boolean(getApiUrl('/windy/webcams')),
  ready: false,
  enabled: false,
  count: 0,
  feedLabel: 'Webcams offline',
  statusText: 'Webcam layer idle',
  error: null,
};

// ── Snapshot & pub/sub ───────────────────────────────────────────────────────

function notifySnapshot() {
  for (const handler of _subscribers) {
    try {
      handler(_snapshot);
    } catch (error) {
      console.error('[SkyView:cameras] subscriber failed', error);
    }
  }
  emit('cameras:update', _snapshot);
}

function setSnapshot(patch) {
  _snapshot = {
    ..._snapshot,
    ...patch,
    enabled: _visible,
    available: Boolean(getApiUrl('/windy/webcams')),
  };
  notifySnapshot();
}

// ── Viewport bbox ─────────────────────────────────────────────────────────────

function getViewportBbox() {
  if (!_viewer?.camera?.positionCartographic) return null;

  const cartographic = _viewer.camera.positionCartographic;
  const lat = Cesium.Math.toDegrees(cartographic.latitude);
  const lon = Cesium.Math.toDegrees(cartographic.longitude);
  const height = cartographic.height;

  if (height > MAX_QUERY_HEIGHT_M) return null;

  // Estimate visible extent from camera height
  let extentDeg;
  if (height > 2_000_000) extentDeg = 20;
  else if (height > 500_000) extentDeg = 8;
  else if (height > 100_000) extentDeg = 2;
  else extentDeg = 0.5;

  return {
    lat,
    lon,
    north: Math.min(85, lat + extentDeg),
    south: Math.max(-85, lat - extentDeg),
    east: Math.min(180, lon + extentDeg * 1.5),
    west: Math.max(-180, lon - extentDeg * 1.5),
  };
}

// ── API ───────────────────────────────────────────────────────────────────────

function buildSearchUrl(bbox) {
  // Windy bbox format: {north},{east},{south},{west}
  const bboxStr = `${bbox.north.toFixed(4)},${bbox.east.toFixed(4)},${bbox.south.toFixed(4)},${bbox.west.toFixed(4)}`;
  return getApiUrl(
    `/windy/webcams?bbox=${encodeURIComponent(bboxStr)}&include=location,images,player,categories&limit=${MAX_WEBCAMS}`,
  );
}

async function requestJson(url, signal = undefined) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    ...(signal ? { signal } : {}),
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message = data?.message || data?.error || `Webcams API error (${response.status})`;
    throw new Error(message);
  }

  return data;
}

/** Windy Webcams API v3: `player.live` is often `{ embed, available }`, not a raw URL string. */
function extractWindyPlayerEmbedUrl(player) {
  if (!player || typeof player !== 'object') return null;

  const live = player.live;
  if (typeof live === 'string' && /^https?:\/\//i.test(live.trim())) return live.trim();
  if (live && typeof live === 'object') {
    if (typeof live.embed === 'string' && /^https?:\/\//i.test(live.embed)) return live.embed.trim();
    if (typeof live.link === 'string' && /^https?:\/\//i.test(live.link)) return live.link.trim();
  }

  const day = player.day;
  if (typeof day === 'string' && /^https?:\/\//i.test(day.trim())) return day.trim();
  if (day && typeof day === 'object' && typeof day.embed === 'string' && /^https?:\/\//i.test(day.embed)) {
    return day.embed.trim();
  }

  return null;
}

function extractPreviewUrl(images) {
  const current = images?.current;
  if (!current || typeof current !== 'object') return null;
  if (typeof current.preview === 'string') return current.preview;
  if (typeof current.thumbnail === 'string') return current.thumbnail;
  if (typeof current.icon === 'string') return current.icon;
  return null;
}

function pickWebcamArray(data) {
  if (!data) return [];
  if (Array.isArray(data.webcams)) return data.webcams;
  if (Array.isArray(data.result?.webcams)) return data.result.webcams;
  return [];
}

function pickSingleWebcamPayload(data) {
  if (!data) return null;
  if (data.webcam) return data.webcam;
  if (data.result?.webcam) return data.result.webcam;
  if (Array.isArray(data.webcams) && data.webcams[0]) return data.webcams[0];
  if (Array.isArray(data.result?.webcams) && data.result.webcams[0]) return data.result.webcams[0];
  return null;
}

// ── Normalize ─────────────────────────────────────────────────────────────────

function normalizeWebcam(webcam) {
  if (!webcam?.webcamId) return null;
  const loc = webcam.location;
  if (!loc || loc.longitude == null || loc.latitude == null) return null;

  const playerUrl = extractWindyPlayerEmbedUrl(webcam.player);

  return {
    id: String(webcam.webcamId),
    geometry: { coordinates: [loc.longitude, loc.latitude] },
    title: webcam.title || '',
    description: webcam.title || '',
    city: loc.city || '',
    state: loc.region || '',
    country: loc.country || '',
    country_code: loc.country_code || '',
    continent: loc.continent || '',
    provider: 'Windy',
    direction: '',
    video: Boolean(playerUrl),
    categories: (webcam.categories || []).map((c) => c.name || c.id).join(', '),
    playerUrl,
    previewUrl: extractPreviewUrl(webcam.images),
    viewCount: webcam.viewCount || 0,
    status: webcam.status || 'active',
  };
}

// ── Entity management ─────────────────────────────────────────────────────────

function toCartesian(camera) {
  const [lon, lat] = camera.geometry.coordinates;
  return Cesium.Cartesian3.fromDegrees(lon, lat, 50);
}

function createCameraEntity(camera) {
  const position = toCartesian(camera);
  _webcamEcefById.set(camera.id, Cesium.Cartesian3.clone(position));
  const live = Boolean(camera.playerUrl);

  const entity = _viewer.entities.add({
    position,
    billboard: {
      image: ICON_CAMERA,
      width: live ? 42 : 36,
      height: live ? 42 : 36,
      color: Cesium.Color.WHITE,
      heightReference: Cesium.HeightReference.NONE,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      scaleByDistance: new Cesium.NearFarScalar(1e5, 1.6, 1e7, 0.65),
      verticalOrigin: Cesium.VerticalOrigin.CENTER,
      horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
    },
    label: {
      text: camera.city || camera.title?.substring(0, 20) || camera.id,
      font: '600 11px Inter, system-ui, sans-serif',
      fillColor: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.fromCssColorString('#000000cc'),
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      pixelOffset: new Cesium.Cartesian2(0, -22),
      heightReference: Cesium.HeightReference.NONE,
      disableDepthTestDistance: 1.1e6,
      translucencyByDistance: new Cesium.NearFarScalar(5e5, 1.0, 7e6, 0.12),
      scaleByDistance: new Cesium.NearFarScalar(5e5, 1.05, 5e6, 0.55),
    },
    show: _visible,
  });

  _entityToCamera.set(entity, camera);
  _entitiesByCamId.set(camera.id, entity);
  return entity;
}

function updateCameraEntity(entity, camera) {
  const [lon, lat] = camera.geometry.coordinates;
  const position = Cesium.Cartesian3.fromDegrees(lon, lat, 50);
  entity.position = position;
  _webcamEcefById.set(camera.id, Cesium.Cartesian3.clone(position));
  entity.show = _visible;

  if (entity.billboard) {
    entity.billboard.scale = camera.id === _selectedCameraId ? 1.3 : 1;
  }

  if (entity.label) {
    entity.label.text = camera.city || camera.title?.substring(0, 20) || camera.id;
  }

  _entityToCamera.set(entity, camera);
}

function removeCamera(camId) {
  const entity = _entitiesByCamId.get(camId);
  if (entity) _viewer?.entities.remove(entity);
  _entitiesByCamId.delete(camId);
  _camerasById.delete(camId);
  _webcamEcefById.delete(camId);
}

function applySelectionStyles() {
  for (const [camId, entity] of _entitiesByCamId) {
    if (entity.billboard) {
      entity.billboard.scale = camId === _selectedCameraId ? 1.3 : 1;
    }
  }
}

// ── Hemisphere culling ────────────────────────────────────────────────────────

function setupHemisphereCulling() {
  const R_EARTH = 6_371_000;

  _viewer.scene.preRender.addEventListener(() => {
    if (!_visible) return;
    const camPos = _viewer.camera.positionWC;
    const camMag = Cesium.Cartesian3.magnitude(camPos);
    if (camMag < R_EARTH) return;

    const threshold = R_EARTH / camMag;

    for (const [camId, entity] of _entitiesByCamId) {
      const pos = _webcamEcefById.get(camId);
      if (!pos) continue;
      const mag = Cesium.Cartesian3.magnitude(pos);
      const cos = Cesium.Cartesian3.dot(camPos, pos) / (camMag * mag);
      entity.show = _visible && cos >= threshold;
    }
  });
}

// ── Poll ──────────────────────────────────────────────────────────────────────

function clearPollTimer() {
  if (_pollTimer) {
    clearTimeout(_pollTimer);
    _pollTimer = null;
  }
}

function schedulePoll(delay = POLL_INTERVAL) {
  clearPollTimer();
  if (!_visible) return;
  _pollTimer = setTimeout(pollCameras, delay);
}

async function pollCameras() {
  clearPollTimer();
  if (!_visible) return;

  const bbox = getViewportBbox();

  if (!bbox) {
    setSnapshot({
      ready: false,
      count: 0,
      feedLabel: 'Zoom in to see webcams',
      statusText: 'Zoom in closer to load webcams for this area.',
      error: null,
    });
    schedulePoll(POLL_INTERVAL);
    return;
  }

  const url = buildSearchUrl(bbox);

  if (!url) {
    setSnapshot({
      ready: false,
      count: 0,
      feedLabel: 'Webcams unavailable',
      statusText: 'No Windy Webcams API key is configured.',
      error: 'unconfigured',
    });
    return;
  }

  if (_abortController) _abortController.abort();
  _abortController = new AbortController();

  setSnapshot({
    feedLabel: 'Refreshing webcams',
    statusText: 'Loading webcams for this area…',
    error: null,
  });

  try {
    const data = await requestJson(url, _abortController.signal);
    const webcams = pickWebcamArray(data);
    const seen = new Set();

    for (const raw of webcams) {
      const camera = normalizeWebcam(raw);
      if (!camera) continue;

      seen.add(camera.id);
      _camerasById.set(camera.id, camera);

      const existing = _entitiesByCamId.get(camera.id);
      if (existing) {
        updateCameraEntity(existing, camera);
      } else {
        createCameraEntity(camera);
      }
    }

    for (const camId of [..._entitiesByCamId.keys()]) {
      if (!seen.has(camId)) removeCamera(camId);
    }

    applySelectionStyles();
    _lastBboxCenter = { lat: bbox.lat, lon: bbox.lon };

    setSnapshot({
      ready: true,
      count: webcams.length,
      feedLabel: webcams.length ? `${webcams.length} webcams` : 'No webcams here',
      statusText: webcams.length
        ? `${webcams.length} webcams loaded for this area`
        : 'No webcams found in this area',
      error: null,
    });

    console.log(`[SkyView:cameras] ${webcams.length} webcams loaded`);
    schedulePoll(POLL_INTERVAL);
  } catch (error) {
    if (error?.name === 'AbortError') return;

    console.warn('[SkyView:cameras] Poll failed', error);
    setSnapshot({
      ready: false,
      feedLabel: 'Webcams degraded',
      statusText: error.message,
      error: error.message,
    });
    emit('ui:toast', {
      tone: 'warning',
      title: 'Webcam feed issue',
      message: error.message,
    });
    schedulePoll(RETRY_INTERVAL);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getCameras() {
  return [..._camerasById.values()];
}

export function getEntityToCamera() {
  return _entityToCamera;
}

export function getCameraById(camId) {
  return _camerasById.get(String(camId)) || null;
}

export function getCameraSnapshot() {
  return _snapshot;
}

export function setCamerasVisible(visible) {
  _visible = Boolean(visible);

  for (const entity of _entitiesByCamId.values()) {
    entity.show = _visible;
  }

  if (!_visible) {
    _abortController?.abort();
    _abortController = null;
    clearPollTimer();
    clearTimeout(_cameraMoveDebounceId);
    _selectedCameraId = null;
    setSnapshot({
      enabled: false,
      statusText: 'Webcam layer hidden.',
      feedLabel: 'Webcams off',
    });
    return;
  }

  setSnapshot({ enabled: true });
  pollCameras();
}

export function setSelectedCamera(camId) {
  _selectedCameraId = camId ? String(camId) : null;
  applySelectionStyles();
}

export function flyToCamera(camera) {
  if (!_viewer || !camera?.geometry?.coordinates) return;
  const [lon, lat] = camera.geometry.coordinates;
  const center = Cesium.Cartesian3.fromDegrees(lon, lat, 0);
  _viewer.camera.flyToBoundingSphere(
    new Cesium.BoundingSphere(center, 0),
    {
      offset: new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(0),
        Cesium.Math.toRadians(-45),
        5_000,
      ),
      duration: 2.2,
    },
  );
}

export function subscribeCameras(handler) {
  _subscribers.add(handler);
  handler(_snapshot);
  return () => _subscribers.delete(handler);
}

export async function enrichCamera(cameraId) {
  const camera = getCameraById(cameraId);
  if (!camera) return { availability: 'unavailable' };

  const detailUrl = getApiUrl(
    `/windy/webcams/${encodeURIComponent(cameraId)}?include=player,images,location,urls&lang=en`,
  );

  if (detailUrl) {
    try {
      const data = await requestJson(detailUrl);
      const raw = pickSingleWebcamPayload(data);
      const embed = extractWindyPlayerEmbedUrl(raw?.player);
      if (embed) {
        return {
          availability: 'live',
          playerUrl: embed,
          previewUrl: extractPreviewUrl(raw?.images) || camera.previewUrl || null,
        };
      }
    } catch (error) {
      console.warn('[SkyView:cameras] enrichCamera detail request failed', error);
    }
  }

  const fallback =
    typeof camera.playerUrl === 'string' && /^https?:\/\//i.test(camera.playerUrl)
      ? camera.playerUrl.trim()
      : null;

  if (!fallback) return { availability: 'unconfigured' };

  return {
    availability: 'live',
    playerUrl: fallback,
    previewUrl: camera.previewUrl || null,
  };
}

export function getCameraDetailLines(camera) {
  const [lon, lat] = camera.geometry?.coordinates || [0, 0];
  return [
    { label: 'Location', value: [camera.city, camera.state, camera.country].filter(Boolean).join(', ') || 'Unknown' },
    { label: 'Categories', value: camera.categories || '—' },
    { label: 'Views', value: camera.viewCount ? Number(camera.viewCount).toLocaleString() : '—' },
    { label: 'Status', value: camera.status || 'active' },
    { label: 'Coordinates', value: `${lat.toFixed(4)}°, ${lon.toFixed(4)}°` },
    { label: 'Webcam ID', value: camera.id },
  ];
}

export function initCameras(viewer) {
  _viewer = viewer;

  setSnapshot({
    available: Boolean(getApiUrl('/windy/webcams')),
    statusText: Boolean(getApiUrl('/windy/webcams'))
      ? 'Webcam layer ready when enabled.'
      : 'Webcam layer requires a Windy API key (WINDY_WEBCAMS_API_KEY in .env).',
    feedLabel: Boolean(getApiUrl('/windy/webcams'))
      ? 'Webcams ready'
      : 'Webcams unavailable',
  });

  setupHemisphereCulling();

  on('user:location', () => {
    if (_visible) pollCameras();
  });

  // Re-poll when the camera view shifts significantly
  viewer.camera.changed.addEventListener(() => {
    if (!_visible) return;

    const bbox = getViewportBbox();
    if (!bbox) return;

    if (_lastBboxCenter) {
      const latDiff = Math.abs(bbox.lat - _lastBboxCenter.lat);
      const lonDiff = Math.abs(bbox.lon - _lastBboxCenter.lon);
      if (latDiff < MOVE_THRESHOLD_DEG && lonDiff < MOVE_THRESHOLD_DEG) return;
    }

    clearTimeout(_cameraMoveDebounceId);
    _cameraMoveDebounceId = setTimeout(() => {
      if (_visible) pollCameras();
    }, MOVE_DEBOUNCE_MS);
  });

  console.log('[SkyView:cameras] initialised (Windy Webcams V3)');
}

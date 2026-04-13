import * as Cesium from 'cesium';
import { appConfig, getApiUrl, hasLiveFlightBackend } from './config.js';
import { emit } from './core/bus.js';
import { ICON_PLANE } from './layerIcons.js';
import {
  formatAltitudeFeet,
  formatFlightIdentity,
  formatSpeedKnots,
} from './utils/format.js';

const POLL_INTERVAL = 10_000;
const REQUEST_TIMEOUT = 12_000;
const STALE_THRESHOLD = 30_000;
const LABEL_CAMERA_LIMIT = 2_000_000;
const PREDICTION_CAMERA_LIMIT = 500_000_000;
const TRAIL_MAX_POINTS = 24;
const PREDICTION_STEPS = 12;
const BACKOFF_DELAYS = [15_000, 30_000, 60_000, 120_000];
const MAX_AIRCRAFT = 5_000;
const CULL_THRESHOLD = 6_000;
const EARTH_RADIUS = 6_371_000;

const COLOR_LOW = Cesium.Color.fromCssColorString('#00ff88');
const COLOR_MID = Cesium.Color.fromCssColorString('#ffcc00');
const COLOR_HIGH = Cesium.Color.fromCssColorString('#ff6600');
const COLOR_CRUISE = Cesium.Color.fromCssColorString('#cc00ff');

const FLIGHT_ENDPOINT          = getApiUrl('/opensky/states');
const OPENSKY_TOKEN_ENDPOINT   = '/api/skyview/opensky/token';
const ENRICH_AIRCRAFT_ENDPOINT = '/aircraft';
const ENRICH_CALLSIGN_ENDPOINT = '/callsign';

const _subscribers     = new Set();
const _enrichmentCache = new Map();

// ── OpenSky OAuth2 token manager ──────────────────────────────────────────────
let _oauthToken      = null;
let _tokenExpiresAt  = 0;

async function getOAuthToken() {
  // Return cached token if still valid (refresh 60 s before expiry).
  if (_oauthToken && Date.now() < _tokenExpiresAt - 60_000) return _oauthToken;

  try {
    const res = await fetch(OPENSKY_TOKEN_ENDPOINT, { method: 'POST' });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json.access_token) return null;
    _oauthToken     = json.access_token;
    _tokenExpiresAt = Date.now() + (json.expires_in ?? 1800) * 1000;
    console.log('[SkyView:flights] OAuth2 token acquired, expires in', json.expires_in, 's');
    return _oauthToken;
  } catch {
    return null;
  }
}

let _viewer = null;
let _worker = null;
let _workerFailed = false;
let _requestId = 0;
let _pollTimeoutId = null;

let _billboardCollection = null;
let _labelCollection = null;
let _trailCollection = null;
let _predictionCollection = null;

let _aircraftMap = new Map();
let _countrySet = new Set();
let _flightsVisible = true;
let _trajectoriesVisible = true;
let _altitudeMinMeters = 0;
let _altitudeMaxMeters = 20_000;
let _lastRefreshTime = null;
let _selectedIcao24 = null;
let _backoffIndex = 0;
let _usingDemoData = false;
let _feedMode = hasLiveFlightBackend() ? 'booting' : 'demo';
let _feedMessage = hasLiveFlightBackend()
  ? 'Connecting to live flight data'
  : 'Live backend not configured. Demo traffic is active.';
let _aircraftIcon = null;
let _demoStates = null;

let _fastest = null;
let _highest = null;
let _mostActiveCountry = null;
let _groundCount = 0;
let _airborneCount = 0;

function altitudeColor(altitudeMeters) {
  if (altitudeMeters == null || altitudeMeters < 3_000) return COLOR_LOW;
  if (altitudeMeters < 8_000) return COLOR_MID;
  if (altitudeMeters < 12_000) return COLOR_HIGH;
  return COLOR_CRUISE;
}

function emitSnapshot() {
  const snapshot = getFlightSnapshot();

  for (const subscriber of _subscribers) {
    try {
      subscriber(snapshot);
    } catch (error) {
      console.error('[SkyView:flights] subscriber failed', error);
    }
  }

  emit('flights:update', snapshot);
}

function setFeedState(mode, message) {
  _feedMode = mode;
  _feedMessage = message;

  emit('flights:status', {
    mode,
    message,
    usingDemoData: _usingDemoData,
    lastRefreshTime: _lastRefreshTime,
  });
  emitSnapshot();
}

function notifyFlightError(message, tone = 'warning') {
  emit('ui:toast', {
    tone,
    title: tone === 'danger' ? 'Flight feed issue' : 'Flight feed status',
    message,
  });
}

function toLiveFeedLabel() {
  if (_usingDemoData) return 'Demo traffic';
  if (_feedMode === 'live') return 'Live traffic';
  if (_feedMode === 'degraded') return 'Degraded traffic';
  return 'Flight feed';
}

function createAbortController(timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs);

  return {
    controller,
    dispose: () => clearTimeout(timeoutId),
  };
}

function clearScheduledPoll() {
  if (_pollTimeoutId) {
    clearTimeout(_pollTimeoutId);
    _pollTimeoutId = null;
  }
}

function scheduleNextPoll(delay) {
  clearScheduledPoll();
  _pollTimeoutId = setTimeout(poll, delay);
}

function isOnNearSide(position, cameraPosition, cameraMagnitude) {
  if (cameraMagnitude < EARTH_RADIUS) return true;
  const positionMagnitude = Cesium.Cartesian3.magnitude(position);
  if (positionMagnitude === 0) return true;

  const cosine = Cesium.Cartesian3.dot(cameraPosition, position) / (cameraMagnitude * positionMagnitude);
  return cosine >= EARTH_RADIUS / cameraMagnitude;
}

function isAltitudeVisible(aircraft) {
  return aircraft.altitude >= _altitudeMinMeters && aircraft.altitude <= _altitudeMaxMeters;
}

function applyVisibility(aircraft, cameraHeight, cameraPosition, cameraMagnitude) {
  const visible = _flightsVisible &&
    isAltitudeVisible(aircraft) &&
    isOnNearSide(aircraft.currentPos, cameraPosition, cameraMagnitude);

  if (aircraft.billboard) aircraft.billboard.show = visible;
  if (aircraft.label) aircraft.label.show = visible && cameraHeight < LABEL_CAMERA_LIMIT;
  if (aircraft.polyline) aircraft.polyline.show = visible && _trajectoriesVisible;
  if (aircraft.prediction) {
    aircraft.prediction.show = visible &&
      _trajectoriesVisible &&
      cameraHeight < PREDICTION_CAMERA_LIMIT &&
      aircraft.icao24 === _selectedIcao24;
  }
}

function refreshSelectionStyles() {
  const hasSelection = Boolean(_selectedIcao24);

  for (const aircraft of _aircraftMap.values()) {
    const selected = aircraft.icao24 === _selectedIcao24;
    const baseColor = altitudeColor(aircraft.altitude);
    const trailAlpha = hasSelection ? (selected ? 0.94 : 0.14) : 0.42;

    if (aircraft.polyline) {
      aircraft.polyline.material = Cesium.Material.fromType('Color', {
        color: baseColor.withAlpha(trailAlpha),
      });
      aircraft.polyline.width = selected ? 3.25 : 1.5;
    }

    if (aircraft.prediction) {
      aircraft.prediction.show = selected &&
        _flightsVisible &&
        _trajectoriesVisible &&
        isAltitudeVisible(aircraft);
    }

    if (aircraft.billboard) {
      aircraft.billboard.scale = selected ? 1.35 : 1;
    }
  }
}

function createTrailPolyline(aircraft) {
  return _trailCollection.add({
    positions: [...aircraft.trail],
    width: 1.5,
    material: Cesium.Material.fromType('Color', {
      color: altitudeColor(aircraft.altitude).withAlpha(0.42),
    }),
    show: _flightsVisible && _trajectoriesVisible,
  });
}

function updateTrailPolyline(aircraft) {
  if (aircraft.trail.length < 2) return;

  if (!aircraft.polyline) {
    aircraft.polyline = createTrailPolyline(aircraft);
    return;
  }

  aircraft.polyline.positions = [...aircraft.trail];
}

function buildPredictionPositions(aircraft) {
  if (!aircraft.velocity || aircraft.velocity < 1) return [];

  const positions = [];
  const radiansPerDegree = Math.PI / 180;
  const headingRadians = aircraft.heading * radiansPerDegree;
  const distancePerStep = aircraft.velocity * (POLL_INTERVAL / 1000);

  for (let step = 1; step <= PREDICTION_STEPS; step++) {
    const distance = distancePerStep * step;
    const angularDistance = distance / EARTH_RADIUS;
    const latRadians = aircraft.lat * radiansPerDegree;
    const lonRadians = aircraft.lon * radiansPerDegree;

    const nextLat = Math.asin(
      Math.sin(latRadians) * Math.cos(angularDistance) +
      Math.cos(latRadians) * Math.sin(angularDistance) * Math.cos(headingRadians)
    );
    const nextLon = lonRadians + Math.atan2(
      Math.sin(headingRadians) * Math.sin(angularDistance) * Math.cos(latRadians),
      Math.cos(angularDistance) - Math.sin(latRadians) * Math.sin(nextLat)
    );
    const altitude = Math.max((aircraft.altitude || 10_000) + (aircraft.verticalRate || 0) * step * (POLL_INTERVAL / 1000), 50);

    positions.push(Cesium.Cartesian3.fromDegrees(
      nextLon / radiansPerDegree,
      nextLat / radiansPerDegree,
      altitude
    ));
  }

  return positions;
}

function updatePredictionPolyline(aircraft) {
  const selected = aircraft.icao24 === _selectedIcao24;

  if (!selected) {
    if (aircraft.prediction) aircraft.prediction.show = false;
    return;
  }

  const predictionPositions = buildPredictionPositions(aircraft);
  if (predictionPositions.length < 2) return;

  const positions = [Cesium.Cartesian3.clone(aircraft.currentPos), ...predictionPositions];

  if (!aircraft.prediction) {
    aircraft.prediction = _predictionCollection.add({
      positions,
      width: 2,
      material: Cesium.Material.fromType('PolylineDash', {
        color: Cesium.Color.fromCssColorString('#55d8ff').withAlpha(0.9),
        dashLength: 18,
        dashPattern: 0xF0F0,
      }),
      show: true,
    });
    return;
  }

  aircraft.prediction.positions = positions;
}

function removeAircraft(aircraft) {
  if (aircraft.billboard) _billboardCollection.remove(aircraft.billboard);
  if (aircraft.label) _labelCollection.remove(aircraft.label);
  if (aircraft.polyline) _trailCollection.remove(aircraft.polyline);
  if (aircraft.prediction) _predictionCollection.remove(aircraft.prediction);
}

function updateStats({ countries, fastest, highest, mostActiveCountry, groundCount, airborneCount }) {
  _countrySet = new Set(countries);
  _fastest = fastest;
  _highest = highest;
  _mostActiveCountry = mostActiveCountry;
  _groundCount = groundCount;
  _airborneCount = airborneCount;
}

function applyProcessedAircraft(result) {
  const now = Date.now();
  const seen = new Set();

  updateStats(result);

  for (const nextAircraft of result.aircraft) {
    const {
      icao24,
      callsign,
      country,
      lon,
      lat,
      alt,
      heading,
      velocity,
      vertRate,
      x,
      y,
      z,
    } = nextAircraft;

    seen.add(icao24);
    const targetPosition = new Cesium.Cartesian3(x, y, z);

    if (_aircraftMap.has(icao24)) {
      const current = _aircraftMap.get(icao24);

      current.trail.unshift(Cesium.Cartesian3.clone(current.currentPos));
      if (current.trail.length > TRAIL_MAX_POINTS) current.trail.pop();

      Cesium.Cartesian3.clone(current.currentPos, current.prevPos);
      Cesium.Cartesian3.clone(targetPosition, current.targetPos);

      current.lon = lon;
      current.lat = lat;
      current.altitude = alt;
      current.heading = heading;
      current.callsign = callsign;
      current.country = country;
      current.velocity = velocity;
      current.verticalRate = vertRate;
      current.lastSeen = now;
      current.updateTime = now;

      current.billboard.color = Cesium.Color.WHITE;
      if (!current._surfaceUp) current._surfaceUp = new Cesium.Cartesian3();
      Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(targetPosition, current._surfaceUp);
      current.billboard.alignedAxis = current._surfaceUp;
      current.billboard.rotation = -Cesium.Math.toRadians(Number.isFinite(heading) ? heading : 0);
      current.billboard.id = icao24;

      if (current.label) {
        current.label.text = callsign || icao24;
      }

      updateTrailPolyline(current);
      updatePredictionPolyline(current);
      continue;
    }

    const surfaceUp = new Cesium.Cartesian3();
    Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(targetPosition, surfaceUp);

    const billboard = _billboardCollection.add({
      id: icao24,
      position: targetPosition,
      image: _aircraftIcon,
      width: 48,
      height: 48,
      color: Cesium.Color.WHITE,
      rotation: -Cesium.Math.toRadians(Number.isFinite(heading) ? heading : 0),
      alignedAxis: surfaceUp,
      scaleByDistance: new Cesium.NearFarScalar(60_000, 1.9, 7_500_000, 0.82),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      show: _flightsVisible,
    });

    const label = _labelCollection.add({
      id: icao24,
      position: targetPosition,
      text: callsign || icao24,
      font: '600 12px Inter, system-ui, sans-serif',
      fillColor: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 4,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new Cesium.Cartesian2(22, 0),
      horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
      verticalOrigin: Cesium.VerticalOrigin.CENTER,
      scaleByDistance: new Cesium.NearFarScalar(20_000, 1.08, 800_000, 0.6),
      disableDepthTestDistance: 900_000,
      show: false,
    });

    _aircraftMap.set(icao24, {
      icao24,
      callsign,
      country,
      lon,
      lat,
      altitude: alt,
      heading,
      velocity,
      verticalRate: vertRate,
      _surfaceUp: surfaceUp,
      billboard,
      label,
      polyline: null,
      prediction: null,
      trail: [],
      prevPos: Cesium.Cartesian3.clone(targetPosition),
      targetPos: Cesium.Cartesian3.clone(targetPosition),
      currentPos: Cesium.Cartesian3.clone(targetPosition),
      lastSeen: now,
      updateTime: now,
    });
  }

  for (const [icao24, aircraft] of _aircraftMap) {
    if (!seen.has(icao24) && now - aircraft.lastSeen > STALE_THRESHOLD) {
      removeAircraft(aircraft);
      _aircraftMap.delete(icao24);
    }
  }

  _lastRefreshTime = now;
  refreshSelectionStyles();
  emitSnapshot();
}

function processStatesOnMainThread(states, now) {
  const groundCount = states.reduce((total, state) => total + (state?.[8] === true ? 1 : 0), 0);
  const cameraPosition = _viewer?.camera?.positionWC;

  let airborneStates = states.filter((state) =>
    state &&
    state[8] !== true &&
    state[5] != null &&
    state[6] != null
  );

  if (airborneStates.length > CULL_THRESHOLD && cameraPosition) {
    airborneStates = airborneStates
      .map((state) => ({
        state,
        distance: Cesium.Cartesian3.distance(
          cameraPosition,
          Cesium.Cartesian3.fromDegrees(state[5], state[6], Math.max(state[7] ?? 0, 50))
        ),
      }))
      .sort((left, right) => left.distance - right.distance)
      .slice(0, MAX_AIRCRAFT)
      .map((entry) => entry.state);
  }

  const aircraft = [];
  const countryMap = new Map();
  let fastest = null;
  let highest = null;

  for (const state of airborneStates) {
    const icao24 = state[0] || '';
    const callsign = (state[1] || '').trim();
    const country = state[2] || '';
    const lon = state[5];
    const lat = state[6];
    const altitude = Math.max(state[7] ?? 0, 50);
    const velocity = state[9];
    const heading = state[10] ?? 0;
    const verticalRate = state[11] ?? 0;
    const position = Cesium.Cartesian3.fromDegrees(lon, lat, altitude);

    if (country) {
      countryMap.set(country, (countryMap.get(country) || 0) + 1);
    }

    if (velocity != null && (!fastest || velocity > fastest.velocity)) {
      fastest = { icao24, callsign, velocity };
    }

    if (!highest || altitude > highest.altitude) {
      highest = { icao24, callsign, altitude };
    }

    aircraft.push({
      icao24,
      callsign,
      country,
      lon,
      lat,
      alt: altitude,
      heading,
      velocity,
      vertRate: verticalRate,
      x: position.x,
      y: position.y,
      z: position.z,
    });
  }

  let mostActiveCountry = null;
  let maxCountryCount = 0;

  for (const [country, count] of countryMap) {
    if (count > maxCountryCount) {
      maxCountryCount = count;
      mostActiveCountry = { country, count, flag: '🌍' };
    }
  }

  applyProcessedAircraft({
    aircraft,
    countries: [...countryMap.keys()],
    fastest,
    highest,
    mostActiveCountry,
    groundCount,
    airborneCount: aircraft.length,
  });
}

const DEMO_CALLSIGNS = ['UAL', 'DAL', 'AAL', 'SWA', 'BAW', 'KLM', 'AFR', 'DLH', 'QFA', 'SIA'];
const DEMO_COUNTRIES = ['United States', 'Germany', 'France', 'United Kingdom', 'Singapore', 'Australia', 'Japan', 'Canada'];

function generateDemoStates() {
  const demoCount = 360;

  if (!_demoStates) {
    _demoStates = [];
    for (let index = 0; index < demoCount; index += 1) {
      _demoStates.push([
        `demo${index.toString(16).padStart(6, '0')}`,
        `${DEMO_CALLSIGNS[index % DEMO_CALLSIGNS.length]}${110 + ((index * 7) % 840)}`,
        DEMO_COUNTRIES[index % DEMO_COUNTRIES.length],
        null,
        null,
        (Math.random() * 360) - 180,
        (Math.random() * 120) - 60,
        6_500 + Math.random() * 6_000,
        false,
        170 + Math.random() * 110,
        Math.random() * 360,
        (Math.random() - 0.5) * 5,
      ]);
    }
  } else {
    const deltaSeconds = POLL_INTERVAL / 1000;
    for (const state of _demoStates) {
      const lon = state[5];
      const lat = state[6];
      const heading = state[10] * Math.PI / 180;
      const distance = state[9] * deltaSeconds;
      const angularDistance = distance / EARTH_RADIUS;
      const latRadians = lat * Math.PI / 180;
      const lonRadians = lon * Math.PI / 180;

      const nextLat = Math.asin(
        Math.sin(latRadians) * Math.cos(angularDistance) +
        Math.cos(latRadians) * Math.sin(angularDistance) * Math.cos(heading)
      );
      const nextLon = lonRadians + Math.atan2(
        Math.sin(heading) * Math.sin(angularDistance) * Math.cos(latRadians),
        Math.cos(angularDistance) - Math.sin(latRadians) * Math.sin(nextLat)
      );

      state[5] = ((nextLon * 180 / Math.PI) + 540) % 360 - 180;
      state[6] = nextLat * 180 / Math.PI;
      state[7] = Math.max(600, state[7] + (state[11] * deltaSeconds));
    }
  }

  return _demoStates;
}

function setupWorker() {
  try {
    _worker = new Worker(new URL('./flights.worker.js', import.meta.url), { type: 'module' });

    _worker.onmessage = (event) => {
      if (event.data?.requestId !== _requestId) return;
      applyProcessedAircraft(event.data);
      if (import.meta.env.DEV) {
        console.log(`[SkyView:flights] ${_aircraftMap.size} aircraft tracked`);
      }
    };

    _worker.onerror = (error) => {
      console.error('[SkyView:flights] worker failed, switching to main-thread processing', error);
      _workerFailed = true;
      _worker = null;
      notifyFlightError('The high-volume flight processor failed, so SkyView switched to a lighter fallback mode.');
    };
  } catch (error) {
    console.warn('[SkyView:flights] worker unavailable, using main-thread processing', error);
    _workerFailed = true;
    _worker = null;
  }
}

function setupPreRender() {
  const scratch = new Cesium.Cartesian3();

  _viewer.scene.preRender.addEventListener(() => {
    const now = Date.now();
    const cameraHeight = _viewer.camera.positionCartographic?.height ?? Infinity;
    const cameraPosition = _viewer.camera.positionWC;
    const cameraMagnitude = Cesium.Cartesian3.magnitude(cameraPosition);

    for (const aircraft of _aircraftMap.values()) {
      const interpolation = Math.min(1, (now - aircraft.updateTime) / POLL_INTERVAL);
      Cesium.Cartesian3.lerp(aircraft.prevPos, aircraft.targetPos, interpolation, scratch);
      Cesium.Cartesian3.clone(scratch, aircraft.currentPos);

      const altitudeOk = isAltitudeVisible(aircraft);
      const onNearSide = isOnNearSide(scratch, cameraPosition, cameraMagnitude);
      const selected = aircraft.icao24 === _selectedIcao24;

      // Skip billboard / label / trail GPU updates for aircraft that cannot be seen
      // (far hemisphere or altitude filtered). Keeps interpolation math cheap only.
      if (!_flightsVisible || !altitudeOk || (!onNearSide && !selected)) {
        if (aircraft.billboard) aircraft.billboard.show = false;
        if (aircraft.label) aircraft.label.show = false;
        if (aircraft.polyline) aircraft.polyline.show = false;
        if (aircraft.prediction) aircraft.prediction.show = false;
        continue;
      }

      if (aircraft.billboard) {
        const fadeAlpha = aircraft.lastSeen + STALE_THRESHOLD < now
          ? 0
          : Math.max(0.22, 1 - Math.max(0, now - aircraft.lastSeen - (STALE_THRESHOLD - 8_000)) / 8_000);
        aircraft.billboard.position = scratch;
        aircraft.billboard.color = Cesium.Color.WHITE.withAlpha(fadeAlpha);
        // Local “up” at aircraft position — rotation stays in the tangent plane (no screen-flip / upside-down).
        if (aircraft._surfaceUp) {
          Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(scratch, aircraft._surfaceUp);
          aircraft.billboard.alignedAxis = aircraft._surfaceUp;
        }
        const h = Number.isFinite(aircraft.heading) ? aircraft.heading : 0;
        aircraft.billboard.rotation = -Cesium.Math.toRadians(h);
      }

      if (aircraft.label) aircraft.label.position = scratch;
      applyVisibility(aircraft, cameraHeight, cameraPosition, cameraMagnitude);
    }
  });
}

async function fetchLiveStates() {
  if (!FLIGHT_ENDPOINT) {
    _usingDemoData = true;
    setFeedState('demo', 'Live backend not configured. Showing demo traffic.');
    processStatesOnMainThread(generateDemoStates(), Date.now());
    scheduleNextPoll(POLL_INTERVAL);
    return;
  }

  const { controller, dispose } = createAbortController(REQUEST_TIMEOUT);

  try {
    const token   = await getOAuthToken();
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(FLIGHT_ENDPOINT, {
      signal: controller.signal,
      headers,
    });

    if (response.status === 429) {
      _usingDemoData = true;
      _backoffIndex = Math.min(_backoffIndex + 1, BACKOFF_DELAYS.length - 1);
      const retryDelay = BACKOFF_DELAYS[_backoffIndex];

      setFeedState('degraded', `Rate limited by the live provider. Demo traffic will stay active for ${Math.round(retryDelay / 1000)} seconds.`);
      notifyFlightError('Live traffic is being rate limited. SkyView switched to demo traffic so the scene stays usable.');

      processStatesOnMainThread(generateDemoStates(), Date.now());
      scheduleNextPoll(retryDelay);
      return;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    const states = Array.isArray(payload?.states) ? payload.states : [];

    _requestId += 1;
    _usingDemoData = false;
    _backoffIndex = 0;

    processStatesOnMainThread(states, Date.now());

    if (_worker && !_workerFailed) {
      const cameraPosition = _viewer.camera.positionWC;
      _worker.postMessage({
        requestId: _requestId,
        states,
        camX: cameraPosition.x,
        camY: cameraPosition.y,
        camZ: cameraPosition.z,
        now: Date.now(),
      });
    }

    setFeedState('live', `${formatNumberSafe(states.length)} raw aircraft states received. ${formatNumberSafe(_aircraftMap.size)} aircraft rendered.`);
    console.log(`[SkyView] ${_aircraftMap.size} aircraft tracked`);
    scheduleNextPoll(POLL_INTERVAL);
  } catch (error) {
    _usingDemoData = true;
    const retryDelay = 15_000;

    processStatesOnMainThread(generateDemoStates(), Date.now());
    setFeedState('degraded', 'Live traffic is temporarily unavailable. Demo traffic is active while SkyView retries.');
    notifyFlightError('SkyView could not reach the live traffic provider. Demo traffic is active until the connection recovers.');
    scheduleNextPoll(retryDelay);
  } finally {
    dispose();
  }
}

function formatNumberSafe(value) {
  return new Intl.NumberFormat('en-US').format(value ?? 0);
}

async function poll() {
  await fetchLiveStates();
}

export async function enrichFlightData(icao24, callsign) {
  const aircraftEndpoint = getApiUrl(`${ENRICH_AIRCRAFT_ENDPOINT}/${encodeURIComponent(icao24)}`);
  const routeEndpoint = callsign
    ? getApiUrl(`${ENRICH_CALLSIGN_ENDPOINT}/${encodeURIComponent(String(callsign).trim())}`)
    : null;

  if (!aircraftEndpoint) {
    return {
      availability: 'unconfigured',
      type: null,
      registration: null,
      operator: null,
      airline: null,
      origin: null,
      destination: null,
    };
  }

  const cacheKey = `${icao24}|${String(callsign || '').trim()}`;
  if (_enrichmentCache.has(cacheKey)) {
    return _enrichmentCache.get(cacheKey);
  }

  const promise = Promise.allSettled([
    fetch(aircraftEndpoint).then((response) => response.ok ? response.json() : null),
    routeEndpoint ? fetch(routeEndpoint).then((response) => response.ok ? response.json() : null) : Promise.resolve(null),
  ]).then(([aircraftResult, routeResult]) => {
    const aircraftData = aircraftResult.status === 'fulfilled' ? aircraftResult.value : null;
    const routeData = routeResult.status === 'fulfilled' ? routeResult.value : null;

    return {
      availability: 'available',
      type: aircraftData?.response?.aircraft?.type || null,
      registration: aircraftData?.response?.aircraft?.registration || null,
      operator: aircraftData?.response?.aircraft?.registered_owner || null,
      airline: routeData?.response?.flightroute?.airline?.name || null,
      origin: routeData?.response?.flightroute?.origin || null,
      destination: routeData?.response?.flightroute?.destination || null,
    };
  }).catch(() => ({
    availability: 'unavailable',
    type: null,
    registration: null,
    operator: null,
    airline: null,
    origin: null,
    destination: null,
  }));

  _enrichmentCache.set(cacheKey, promise);
  return promise;
}

export function subscribeFlights(listener) {
  _subscribers.add(listener);
  listener(getFlightSnapshot());

  return () => {
    _subscribers.delete(listener);
  };
}

export function getFlightSnapshot() {
  return {
    count: _aircraftMap.size,
    countryCount: _countrySet.size,
    lastRefreshTime: _lastRefreshTime,
    fastest: _fastest,
    highest: _highest,
    mostActiveCountry: _mostActiveCountry,
    groundCount: _groundCount,
    airborneCount: _airborneCount,
    usingDemoData: _usingDemoData,
    feedMode: _feedMode,
    feedMessage: _feedMessage,
    feedLabel: toLiveFeedLabel(),
  };
}

export function getAircraftCount() { return _aircraftMap.size; }
export function getCountryCount() { return _countrySet.size; }
export function getLastRefreshTime() { return _lastRefreshTime; }
export function getAircraftMap() { return _aircraftMap; }
export function getBillboardCollection() { return _billboardCollection; }
export function getFastestAircraft() { return _fastest; }
export function getHighestAircraft() { return _highest; }
export function getMostActiveCountry() { return _mostActiveCountry; }
export function getGroundCount() { return _groundCount; }
export function getAirborneCount() { return _airborneCount; }
export function isUsingDemoData() { return _usingDemoData; }
export function getFlightFeedState() { return { mode: _feedMode, message: _feedMessage, usingDemoData: _usingDemoData }; }

export function setFlightsVisible(visible) {
  _flightsVisible = visible;

  if (_billboardCollection) _billboardCollection.show = visible;
  if (_labelCollection) _labelCollection.show = visible;
  if (_trailCollection) _trailCollection.show = visible && _trajectoriesVisible;
  if (_predictionCollection) _predictionCollection.show = visible && _trajectoriesVisible;

  emitSnapshot();
}

export function setAltitudeRange(minimumMeters, maximumMeters) {
  _altitudeMinMeters = minimumMeters;
  _altitudeMaxMeters = maximumMeters;
  emitSnapshot();
}

export function setTrajectoriesVisible(visible) {
  _trajectoriesVisible = visible;

  if (_trailCollection) _trailCollection.show = _flightsVisible && visible;
  if (_predictionCollection) _predictionCollection.show = _flightsVisible && visible;

  refreshSelectionStyles();
  emitSnapshot();
}

export function setSelectedFlight(icao24) {
  _selectedIcao24 = icao24 || null;
  refreshSelectionStyles();
  emitSnapshot();
}

export function flyToFlight(aircraft) {
  if (!_viewer || !aircraft) return;
  const alt    = aircraft.altitude ?? 10_000;
  const center = Cesium.Cartesian3.fromDegrees(aircraft.lon, aircraft.lat, alt);
  _viewer.camera.flyToBoundingSphere(
    new Cesium.BoundingSphere(center, 0),
    {
      offset: new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(0),
        Cesium.Math.toRadians(-40),
        900_000,
      ),
      duration: 2.2,
    },
  );
}

export function initFlights(viewer) {
  _viewer = viewer;
  _aircraftIcon = ICON_PLANE;

  _billboardCollection = new Cesium.BillboardCollection({ scene: viewer.scene });
  _labelCollection = new Cesium.LabelCollection({ scene: viewer.scene });
  _trailCollection = new Cesium.PolylineCollection();
  _predictionCollection = new Cesium.PolylineCollection();

  viewer.scene.primitives.add(_billboardCollection);
  viewer.scene.primitives.add(_labelCollection);
  viewer.scene.primitives.add(_trailCollection);
  viewer.scene.primitives.add(_predictionCollection);

  setupWorker();
  setupPreRender();
  emitSnapshot();
  setFeedState(_feedMode, _feedMessage);
  poll();

  if (!appConfig.apiBaseUrl && !import.meta.env.DEV) {
    notifyFlightError('No production SkyView API is configured. Set VITE_SKYVIEW_API_BASE_URL to enable live traffic.');
  }
}

export function getFlightSummaryLines(aircraft) {
  return [
    { label: 'Country', value: aircraft.country || 'Unknown' },
    { label: 'Altitude', value: formatAltitudeFeet(aircraft.altitude) },
    { label: 'Speed', value: formatSpeedKnots(aircraft.velocity) },
    { label: 'Identity', value: formatFlightIdentity(aircraft) },
  ];
}

import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import './vendor/leaflet/leaflet.css';
import './styles.css';
import { appConfig, getRuntimeWarnings } from './config.js';
import { emit, on } from './core/bus.js';
import {
  initFlights,
  getBillboardCollection,
  getAircraftMap,
  flyToFlight,
  setSelectedFlight,
} from './flights.js';
import { initLandmarks, getEntityToLandmark, getLandmarks, flyToLandmark } from './landmarks.js';
import { initAirports, getEntityToAirport, getAirports, flyToAirport } from './airports.js';
import { initWeather } from './weather.js';
import { initUserLocation, flyToUserLocation } from './userLocation.js';
import {
  initSatellites,
  getEntityToSatellite,
  getSatelliteById,
  flyToSatellite,
  setSelectedSatellite,
} from './satellites.js';
import {
  initCameras,
  getEntityToCamera,
  getCameraById,
  flyToCamera,
  setSelectedCamera,
} from './cameras.js';
import { initAnalytics } from './analytics.js';
import { initTimeline } from './timeline.js';
import { initFusion } from './fusion.js';
import { initSearch } from './search.js';
import { initBookmarks } from './bookmarks.js';
import { initZones } from './zones.js';
import {
  initUI,
  openFlightSidebar,
  openLandmarkSidebar,
  openAirportSidebar,
  openSatelliteSidebar,
  openCameraSidebar,
  closeSidebar,
} from './ui.js';

Cesium.Ion.defaultAccessToken = appConfig.cesiumIonToken;
Cesium.GoogleMaps.defaultApiKey = appConfig.googleMapsApiKey;

const overlay = document.getElementById('loadingOverlay');
const overlayTitle = overlay?.querySelector('[data-loading-title]');
const overlayStatus = overlay?.querySelector('[data-loading-status]');
const overlayMeta = overlay?.querySelector('[data-loading-meta]');
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

let overlayDismissed = false;
let lastInteractionAt = Date.now();
let spinEnabled = !reducedMotion;
let tilesReady = false;
let zoneDrawActive = false;
const GLOBAL_VIEW_RANGE = Cesium.Ellipsoid.WGS84.maximumRadius * 3.35;
const MIN_CENTER_ZOOM_DISTANCE = 60;
const MAX_CENTER_ZOOM_DISTANCE = Cesium.Ellipsoid.WGS84.maximumRadius * 14;
const screenCenterScratch = new Cesium.Cartesian2();
const zoomTargetToCameraScratch = new Cesium.Cartesian3();
const zoomDestinationScratch = new Cesium.Cartesian3();
const zoomDirectionScratch = new Cesium.Cartesian3();
const zoomRightScratch = new Cesium.Cartesian3();
const zoomUpScratch = new Cesium.Cartesian3();
const wasdKeysDown = new Set();
let wasdPanLastTick = performance.now();

function setLoadingState(title, status, meta = '') {
  if (overlayTitle) overlayTitle.textContent = title;
  if (overlayStatus) overlayStatus.textContent = status;
  if (overlayMeta) overlayMeta.textContent = meta;

  emit('app:status', {
    title,
    status,
    meta,
  });
}

function dismissLoadingOverlay() {
  if (!overlay || overlayDismissed) return;
  overlayDismissed = true;
  overlay.classList.add('is-complete');

  const cleanup = () => overlay.remove();
  const timer = setTimeout(cleanup, 800);

  overlay.addEventListener('transitionend', () => {
    clearTimeout(timer);
    cleanup();
  }, { once: true });
}

function surfaceFatalBootMessage(message) {
  setLoadingState('SkyView started with limited data', message, 'The globe is still interactive while services recover.');
  emit('ui:toast', {
    tone: 'danger',
    title: 'Startup issue',
    message,
  });
}

const viewer = new Cesium.Viewer('cesiumContainer', {
  timeline: false,
  animation: false,
  baseLayerPicker: false,
  geocoder: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  fullscreenButton: false,
  selectionIndicator: false,
  infoBox: false,
  creditContainer: document.createElement('div'),
  // Cap DPR on high-resolution displays — large win for fragment shading cost.
  useBrowserRecommendedResolution: true,
});

viewer.imageryLayers.removeAll();
viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#020611');
viewer.scene.globe.enableLighting = true;
viewer.scene.skyAtmosphere.show = true;
viewer.scene.globe.showGroundAtmosphere = true;
viewer.scene.fog.enabled = true;
viewer.scene.skyBox.show = true;
// Slightly coarser globe mesh = fewer tiles / less GPU while visuals stay close.
viewer.scene.globe.maximumScreenSpaceError = 2.5;
// FXAA is a full-screen pass; globe + 3D tiles already hide most shimmer at distance.
if (viewer.scene.postProcessStages?.fxaa) {
  viewer.scene.postProcessStages.fxaa.enabled = false;
}

// Expose early so search ranking and helpers see a camera for the full boot sequence.
window.__skyview = viewer;

viewer.clock.shouldAnimate = true;
viewer.scene.screenSpaceCameraController.zoomEventTypes = [Cesium.CameraEventType.PINCH];

function applyGlobalView(animate = false) {
  const boundingSphere = new Cesium.BoundingSphere(
    Cesium.Cartesian3.ZERO,
    Cesium.Ellipsoid.WGS84.maximumRadius
  );

  const options = {
    offset: new Cesium.HeadingPitchRange(
      0,
      -Cesium.Math.PI_OVER_TWO,
      GLOBAL_VIEW_RANGE
    ),
  };

  if (animate) {
    viewer.camera.flyToBoundingSphere(boundingSphere, {
      ...options,
      duration: 1.8,
    });
    return;
  }

  viewer.camera.viewBoundingSphere(boundingSphere, options.offset);
  viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
}

applyGlobalView(false);

function getViewportCenter() {
  screenCenterScratch.x = viewer.canvas.clientWidth * 0.5;
  screenCenterScratch.y = viewer.canvas.clientHeight * 0.5;
  return screenCenterScratch;
}

function getCenterZoomTarget() {
  const center = getViewportCenter();

  if (viewer.scene.pickPositionSupported) {
    try {
      const pickedPosition = viewer.scene.pickPosition(center);
      if (Cesium.defined(pickedPosition)) {
        return pickedPosition;
      }
    } catch {}
  }

  const ray = viewer.camera.getPickRay(center);
  if (!ray) return null;

  return (
    viewer.scene.globe.pick(ray, viewer.scene) ||
    viewer.camera.pickEllipsoid(center, viewer.scene.globe.ellipsoid) ||
    null
  );
}

function getNormalizedWheelDelta(event) {
  const lineHeight = 16;
  const pageHeight = viewer.canvas.clientHeight || window.innerHeight || 800;

  if (event.deltaMode === 1) return event.deltaY * lineHeight;
  if (event.deltaMode === 2) return event.deltaY * pageHeight;
  return event.deltaY;
}

function fallbackZoom(deltaY) {
  const height = viewer.camera.positionCartographic?.height ?? Cesium.Ellipsoid.WGS84.maximumRadius;
  const scaledStep = Math.max(40, height * 0.12 * Math.max(0.18, Math.min(Math.abs(deltaY) / 120, 3)));

  if (deltaY < 0) {
    viewer.camera.zoomIn(scaledStep);
    return;
  }

  viewer.camera.zoomOut(scaledStep);
}

function zoomTowardScreenCenter(deltaY) {
  const clampedDelta = Cesium.Math.clamp(deltaY, -2400, 2400);
  const zoomTarget = getCenterZoomTarget();

  if (!zoomTarget) {
    fallbackZoom(clampedDelta);
    return;
  }

  const targetToCamera = Cesium.Cartesian3.subtract(
    viewer.camera.positionWC,
    zoomTarget,
    zoomTargetToCameraScratch,
  );
  const distance = Cesium.Cartesian3.magnitude(targetToCamera);

  if (!Number.isFinite(distance) || distance <= Cesium.Math.EPSILON6) {
    fallbackZoom(clampedDelta);
    return;
  }

  const wheelSteps = Math.min(Math.abs(clampedDelta) / 120, 8);
  const scale = Math.pow(1.18, wheelSteps);
  const nextDistance = Cesium.Math.clamp(
    clampedDelta < 0 ? distance / scale : distance * scale,
    MIN_CENTER_ZOOM_DISTANCE,
    MAX_CENTER_ZOOM_DISTANCE,
  );

  Cesium.Cartesian3.normalize(targetToCamera, targetToCamera);
  const destination = Cesium.Cartesian3.add(
    zoomTarget,
    Cesium.Cartesian3.multiplyByScalar(targetToCamera, nextDistance, zoomDestinationScratch),
    zoomDestinationScratch,
  );
  const direction = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(zoomTarget, destination, zoomDirectionScratch),
    zoomDirectionScratch,
  );

  let right = Cesium.Cartesian3.cross(direction, viewer.camera.upWC, zoomRightScratch);
  if (Cesium.Cartesian3.magnitudeSquared(right) < Cesium.Math.EPSILON10) {
    right = Cesium.Cartesian3.cross(direction, viewer.camera.rightWC, zoomRightScratch);
  }
  Cesium.Cartesian3.normalize(right, right);

  const up = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.cross(right, direction, zoomUpScratch),
    zoomUpScratch,
  );

  viewer.camera.setView({
    destination,
    orientation: {
      direction,
      up,
    },
  });
}

function resetIdleTimer() {
  lastInteractionAt = Date.now();
}

for (const eventName of ['mousemove', 'mousedown', 'wheel', 'keydown', 'touchstart', 'touchmove']) {
  window.addEventListener(eventName, resetIdleTimer, { passive: true });
}

viewer.canvas.addEventListener('wheel', (event) => {
  const deltaY = getNormalizedWheelDelta(event);
  if (!Number.isFinite(deltaY) || Math.abs(deltaY) < 0.01) return;

  event.preventDefault();
  resetIdleTimer();
  zoomTowardScreenCenter(deltaY);
}, { passive: false });

function isTypingKeyboardTarget(target) {
  if (!target || typeof Element === 'undefined' || !(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return Boolean(target.isContentEditable);
}

function setupKeyboardCameraPan() {
  viewer.canvas.setAttribute('tabindex', '0');
  viewer.canvas.setAttribute('role', 'application');
  viewer.canvas.setAttribute('aria-label', 'Globe view — use WASD to pan on screen');

  window.addEventListener(
    'keydown',
    (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingKeyboardTarget(event.target)) return;
      const k = event.key.toLowerCase();
      if (k !== 'w' && k !== 'a' && k !== 's' && k !== 'd') return;
      wasdKeysDown.add(k);
      event.preventDefault();
      resetIdleTimer();
    },
    true,
  );

  window.addEventListener(
    'keyup',
    (event) => {
      const k = event.key.toLowerCase();
      if (k === 'w' || k === 'a' || k === 's' || k === 'd') wasdKeysDown.delete(k);
    },
    true,
  );

  window.addEventListener('blur', () => {
    wasdKeysDown.clear();
  });

  viewer.scene.postRender.addEventListener(() => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - wasdPanLastTick) / 1000);
    wasdPanLastTick = now;
    if (wasdKeysDown.size === 0) return;

    const cam = viewer.camera;
    const height = cam.positionCartographic?.height ?? 2e7;
    const translateRate = Cesium.Math.clamp(height * 0.18, 120, 4e6);
    const panMeters = translateRate * dt;

    if (wasdKeysDown.has('d')) cam.moveRight(panMeters);
    if (wasdKeysDown.has('a')) cam.moveRight(-panMeters);

    // W/S: translate along camera.up (screen Y), not pitch / globe tilt.
    if (wasdKeysDown.has('w')) cam.moveUp(panMeters);
    if (wasdKeysDown.has('s')) cam.moveUp(-panMeters);
  });
}

setupKeyboardCameraPan();

viewer.scene.postRender.addEventListener(() => {
  if (!tilesReady || !spinEnabled || reducedMotion) return;

  const idleFor = Date.now() - lastInteractionAt;
  if (idleFor < 5_000) return;

  viewer.camera.rotate(Cesium.Cartesian3.UNIT_Z, 0.0001);
});

export function toggleSpin() {
  spinEnabled = !spinEnabled;
  resetIdleTimer();
  emit('app:spin', { enabled: spinEnabled });
  return spinEnabled;
}

export function focusGlobalView(animate = true) {
  applyGlobalView(animate);
}

function getScenePosition(windowPosition) {
  if (!windowPosition) return null

  let cartesian = null

  if (viewer.scene.pickPositionSupported) {
    try {
      cartesian = viewer.scene.pickPosition(windowPosition)
    } catch {}
  }

  if (!cartesian) {
    const ray = viewer.camera.getPickRay(windowPosition)
    if (ray) {
      cartesian = viewer.scene.globe.pick(ray, viewer.scene) ||
        viewer.camera.pickEllipsoid(windowPosition, viewer.scene.globe.ellipsoid) ||
        null
    }
  }

  if (!cartesian) return null

  const cartographic = Cesium.Cartographic.fromCartesian(cartesian)
  if (!cartographic) return null

  return {
    cartesian,
    lat: Cesium.Math.toDegrees(cartographic.latitude),
    lon: Cesium.Math.toDegrees(cartographic.longitude),
    altitude: cartographic.height,
  }
}

function focusEntity(kind, id) {
  if (kind === 'flight') {
    const aircraft = getAircraftMap().get(id)
    if (!aircraft) return false
    setSelectedFlight(aircraft.icao24)
    openFlightSidebar(aircraft)
    flyToFlight(aircraft)
    return true
  }

  if (kind === 'satellite') {
    const satellite = getSatelliteById(id)
    if (!satellite) return false
    setSelectedSatellite(satellite.id)
    openSatelliteSidebar(satellite)
    flyToSatellite(satellite)
    return true
  }

  if (kind === 'camera') {
    const camera = getCameraById(id)
    if (!camera) return false
    setSelectedCamera(camera.id)
    openCameraSidebar(camera)
    flyToCamera(camera)
    return true
  }

  if (kind === 'landmark') {
    const landmark = getLandmarks().find((entry) => entry.name === id)
    if (!landmark) return false
    openLandmarkSidebar(landmark)
    flyToLandmark(landmark)
    return true
  }

  if (kind === 'airport') {
    const airport = getAirports().find((entry) => entry.iata === id)
    if (!airport) return false
    openAirportSidebar(airport)
    flyToAirport(airport)
    return true
  }

  return false
}

function setupUnifiedClickHandler() {
  viewer.screenSpaceEventHandler.setInputAction((click) => {
    const scenePosition = getScenePosition(click.position)

    if (zoneDrawActive) {
      emit('map:left-click', {
        position: click.position,
        ...scenePosition,
      })
      return
    }

    const billboardCollection = getBillboardCollection();
    const aircraftMap = getAircraftMap();
    const entityToLandmark = getEntityToLandmark();
    const entityToAirport = getEntityToAirport();
    const entityToSatellite = getEntityToSatellite();
    const entityToCamera = getEntityToCamera();
    const picked = viewer.scene.pick(click.position);

    if (!Cesium.defined(picked)) {
      emit('map:left-click', {
        position: click.position,
        ...scenePosition,
      })
      closeSidebar();
      return;
    }

    if (billboardCollection && picked.collection === billboardCollection) {
      const aircraft = aircraftMap.get(picked.id);
      if (aircraft) {
        setSelectedFlight(aircraft.icao24);
        openFlightSidebar(aircraft);
        flyToFlight(aircraft);
        return;
      }
    }

    if (picked.id instanceof Cesium.Entity) {
      const satellite = entityToSatellite.get(picked.id);
      if (satellite) {
        setSelectedSatellite(satellite.id);
        openSatelliteSidebar(satellite);
        flyToSatellite(satellite);
        return;
      }

      const camera = entityToCamera.get(picked.id);
      if (camera) {
        setSelectedCamera(camera.id);
        openCameraSidebar(camera);
        flyToCamera(camera);
        return;
      }

      const landmark = entityToLandmark.get(picked.id);
      if (landmark) {
        openLandmarkSidebar(landmark);
        flyToLandmark(landmark);
        return;
      }

      const airport = entityToAirport.get(picked.id);
      if (airport) {
        openAirportSidebar(airport);
        flyToAirport(airport);
        return;
      }
    }

    closeSidebar();
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  viewer.screenSpaceEventHandler.setInputAction((movement) => {
    if (!zoneDrawActive) return

    emit('map:mouse-move', {
      endPosition: movement.endPosition,
      ...getScenePosition(movement.endPosition),
    })
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)

  viewer.screenSpaceEventHandler.setInputAction((click) => {
    emit('map:right-click', {
      position: click.position,
      screenX: click.position.x,
      screenY: click.position.y,
      ...getScenePosition(click.position),
    })
  }, Cesium.ScreenSpaceEventType.RIGHT_CLICK)

  viewer.canvas.addEventListener('contextmenu', (event) => {
    event.preventDefault()
  })
}

on('ui:toggle-spin', () => {
  toggleSpin();
});

on('camera:global-view', () => {
  focusGlobalView(true);
});

on('camera:home-view', () => {
  // Prefer user's location; fall back to global view if permission was denied
  if (!flyToUserLocation(true)) {
    focusGlobalView(true);
  }
});

on('entity:focus', ({ kind, id }) => {
  focusEntity(kind, id)
})

on('zones:draw-state', ({ active }) => {
  zoneDrawActive = Boolean(active)
})

async function loadFallbackImagery() {
  try {
    const provider = await Cesium.ArcGisMapServerImageryProvider.fromUrl(
      'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
    );
    viewer.imageryLayers.add(new Cesium.ImageryLayer(provider));
    console.log('[SkyView] Loaded ESRI World Imagery fallback');
  } catch (err) {
    console.warn('[SkyView] ESRI imagery failed, using built-in Natural Earth', err);
    const builtIn = new Cesium.TileMapServiceImageryProvider({
      url: Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII'),
    });
    viewer.imageryLayers.add(new Cesium.ImageryLayer(builtIn));
  }
  tilesReady = true;
  emit('app:tiles', { ready: true });
}

async function loadGoogleTiles() {
  if (!appConfig.googleMapsApiKey) {
    console.info('[SkyView] No Google Maps API key — using satellite imagery fallback.');
    await loadFallbackImagery();
    return null;
  }

  try {
    setLoadingState('Loading SkyView', 'Loading Google 3D tiles', 'Photorealistic terrain and imagery');
    const tileset = await Cesium.createGooglePhotorealistic3DTileset();
    viewer.scene.primitives.add(tileset);
    // Photorealistic tiles default to high refinement; relax slightly for smoother frame times.
    tileset.maximumScreenSpaceError = 20;
    tileset.dynamicScreenSpaceError = true;
    tilesReady = true;
    emit('app:tiles', { ready: true });
    return tileset;
  } catch (error) {
    console.warn('[SkyView] Google 3D tiles unavailable, switching to satellite imagery.', error);
    await loadFallbackImagery();
    return null;
  }
}

async function boot() {
  setLoadingState('Loading SkyView', 'Initializing globe', 'Loading modules and layers');

  initUI(viewer);
  initLandmarks(viewer);
  initAirports(viewer);
  initWeather(viewer);
  initFlights(viewer);
  initUserLocation(viewer);
  initSatellites(viewer);
  initCameras(viewer);
  initSearch();
  initBookmarks(viewer);
  initZones(viewer);
  initFusion();
  initAnalytics(viewer);
  initTimeline();
  setupUnifiedClickHandler();

  for (const warning of getRuntimeWarnings()) {
    console.info('[SkyView:config]', warning);
  }

  const tilesPromise = loadGoogleTiles();
  const overlayTimeout = new Promise((resolve) => {
    setTimeout(resolve, 10_000);
  });

  await Promise.race([tilesPromise, overlayTimeout]);
  focusGlobalView(false);

  setLoadingState(
    'SkyView ready',
    tilesReady ? 'Live globe initialized' : 'Running in resilient fallback mode',
    tilesReady ? 'Use search and layer controls to explore.' : 'Some layers are unavailable; the rest of the app stays interactive.'
  );

  setTimeout(dismissLoadingOverlay, 650);
  emit('app:ready', { tilesReady });
}

boot();

export { viewer };

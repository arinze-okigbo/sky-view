import * as Cesium from 'cesium';
import { appConfig } from './config.js';
import { emit } from './core/bus.js';

const RAINVIEWER_API = 'https://api.rainviewer.com/public/weather-maps.json';
const TILE_SIZE = 512;
const COLOR_SCHEME = 2;
const SMOOTH = 1;
const SNOW = 1;
const OPACITY = 0.5;
// Replacing the imagery layer is expensive; slower stepping cuts GPU + network churn.
const LOOP_INTERVAL = 1_100;
const REFRESH_EVERY = 5 * 60 * 1_000;

let _viewer = null;
let _visible = false;
let _imageryLayer = null;
let _radarFrames = [];
let _currentFrame = 0;
let _looping = false;
let _loopTimer = null;
let _refreshTimer = null;
let _statusTimer = null;
let _lastUpdated = null;
let _statusText = appConfig.enableWeather ? 'Weather feed idle' : 'Weather disabled';

function broadcastWeatherState() {
  emit('weather:update', getWeatherState());
  emit('weather:status', { text: _statusText, visible: _visible });
}

function setStatus(text) {
  _statusText = text;
  broadcastWeatherState();
}

function tileUrl(timestamp) {
  return `https://tilecache.rainviewer.com/v2/radar/${timestamp}/${TILE_SIZE}/{z}/{x}/{y}/${COLOR_SCHEME}/${SMOOTH}_${SNOW}.png`;
}

function setFrame(index) {
  if (!_radarFrames.length || !_viewer) return;

  const nextIndex = ((index % _radarFrames.length) + _radarFrames.length) % _radarFrames.length;
  _currentFrame = nextIndex;
  const timestamp = _radarFrames[nextIndex];

  if (_imageryLayer) {
    _viewer.imageryLayers.remove(_imageryLayer, true);
    _imageryLayer = null;
  }

  _imageryLayer = _viewer.imageryLayers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({
    url: tileUrl(timestamp),
    credit: 'RainViewer',
    minimumLevel: 0,
    maximumLevel: 6,
    tileWidth: TILE_SIZE,
    tileHeight: TILE_SIZE,
  }));
  _imageryLayer.alpha = OPACITY;
  _imageryLayer.show = _visible;
}

function startLoop() {
  if (_looping || _radarFrames.length < 2) return;
  _looping = true;
  _loopTimer = setInterval(() => {
    setFrame(_currentFrame + 1);
  }, LOOP_INTERVAL);
  setStatus('Weather radar animation active');
}

function stopLoop() {
  _looping = false;
  if (_loopTimer) clearInterval(_loopTimer);
  _loopTimer = null;

  if (_radarFrames.length) {
    setFrame(_radarFrames.length - 1);
  }

  if (_visible) {
    setStatus(_lastUpdated ? 'Weather radar live' : 'Weather feed idle');
  }
}

async function fetchRadarFrames() {
  if (!appConfig.enableWeather) return;

  try {
    const response = await fetch(RAINVIEWER_API);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    const pastFrames = payload?.radar?.past ?? [];

    if (!pastFrames.length) {
      throw new Error('No radar frames available');
    }

    _radarFrames = pastFrames.slice(-12).map((frame) => frame.path ?? frame.time ?? frame);
    _lastUpdated = Date.now();
    setFrame(_radarFrames.length - 1);
    setStatus('Weather radar synced');
  } catch (error) {
    console.warn('[SkyView:weather] unable to refresh radar frames', error);
    setStatus('Weather feed unavailable');
  }
}

function startStatusTicker() {
  _statusTimer = setInterval(() => {
    if (!_lastUpdated) return;

    const ageSeconds = Math.max(0, Math.round((Date.now() - _lastUpdated) / 1000));
    const ageLabel = ageSeconds < 60 ? `${ageSeconds}s` : `${Math.floor(ageSeconds / 60)}m`;
    setStatus(_visible ? `Weather updated ${ageLabel} ago` : `Weather ready, updated ${ageLabel} ago`);
  }, 15_000);
}

export function setWeatherVisible(visible) {
  _visible = visible;
  if (_imageryLayer) _imageryLayer.show = visible;
  if (!visible) stopLoop();
  setStatus(visible ? (_lastUpdated ? 'Weather layer enabled' : 'Weather loading') : 'Weather layer hidden');
}

export function isWeatherVisible() {
  return _visible;
}

export function toggleWeatherLoop() {
  if (_looping) stopLoop();
  else startLoop();
  broadcastWeatherState();
  return _looping;
}

export function getWeatherState() {
  return {
    visible: _visible,
    looping: _looping,
    ready: _radarFrames.length > 0,
    lastUpdated: _lastUpdated,
    statusText: _statusText,
  };
}

export function initWeather(viewer) {
  _viewer = viewer;

  if (!appConfig.enableWeather) {
    setStatus('Weather disabled by configuration');
    return;
  }

  fetchRadarFrames();
  _refreshTimer = setInterval(fetchRadarFrames, REFRESH_EVERY);
  startStatusTicker();
  broadcastWeatherState();
}

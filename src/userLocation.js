/**
 * userLocation.js
 * Tracks the user's geolocation, places a marker on the globe,
 * and exports flyToUserLocation() for camera-home behaviour.
 */

import * as Cesium from 'cesium';
import { emit } from './core/bus.js';

let _viewer   = null;
let _userPos  = null;   // { lon, lat, accuracy }
let _marker   = null;   // billboard entity
let _ring     = null;   // outer pulse entity
let _watchId  = null;

const HOME_ALTITUDE = 80_000;   // 80 km — shows city / regional context

// ─── Icon ─────────────────────────────────────────────────────────────────

function createMarkerIcon() {
  const S = 64;
  const canvas = document.createElement('canvas');
  canvas.width  = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d');
  const cx  = S / 2;
  const cy  = S / 2;

  // Outermost faint ring
  ctx.beginPath();
  ctx.arc(cx, cy, 28, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(99, 179, 237, 0.28)';
  ctx.lineWidth   = 1.5;
  ctx.stroke();

  // Mid ring
  ctx.beginPath();
  ctx.arc(cx, cy, 20, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(99, 179, 237, 0.55)';
  ctx.lineWidth   = 1.5;
  ctx.stroke();

  // Filled circle
  const grad = ctx.createRadialGradient(cx, cy - 3, 2, cx, cy, 14);
  grad.addColorStop(0,   '#90cdf4');
  grad.addColorStop(0.5, '#3b82f6');
  grad.addColorStop(1,   '#1d4ed8');
  ctx.beginPath();
  ctx.arc(cx, cy, 13, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.shadowBlur = 14;
  ctx.shadowColor = 'rgba(59, 130, 246, 0.8)';
  ctx.fill();

  // White centre dot
  ctx.shadowBlur  = 0;
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  return canvas.toDataURL();
}

// ─── Marker management ────────────────────────────────────────────────────

function addMarker(lon, lat) {
  if (!_viewer) return;

  const pos = Cesium.Cartesian3.fromDegrees(lon, lat, 0);

  _marker = _viewer.entities.add({
    name:     'Your location',
    position: pos,
    billboard: {
      image:                    createMarkerIcon(),
      width:                    56,
      height:                   56,
      heightReference:          Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      scaleByDistance:          new Cesium.NearFarScalar(1e3, 1.75, 5e6, 0.7),
      pixelOffset:              new Cesium.Cartesian2(0, 0),
    },
    label: {
      text:                     'You',
      font:                     '600 12px "Azeret Mono", monospace',
      fillColor:                Cesium.Color.fromCssColorString('#93c5fd'),
      outlineColor:             Cesium.Color.BLACK,
      outlineWidth:             2,
      style:                    Cesium.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset:              new Cesium.Cartesian2(0, -44),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      scaleByDistance:          new Cesium.NearFarScalar(1e3, 1.05, 3e6, 0.2),
    },
  });
}

function updateMarkerPosition(lon, lat) {
  if (!_marker) return;
  const pos = Cesium.Cartesian3.fromDegrees(lon, lat, 0);
  _marker.position = pos;
  if (_ring) _ring.position = pos;
}

// ─── Fly-to ────────────────────────────────────────────────────────────────

/**
 * Fly the camera to the user's current location.
 * @param {boolean} animate  Whether to animate (false = instant snap).
 * @returns {boolean}        true if location was known, false otherwise.
 */
export function flyToUserLocation(animate = true) {
  if (!_viewer || !_userPos) return false;

  const center = Cesium.Cartesian3.fromDegrees(_userPos.lon, _userPos.lat, 0);
  _viewer.camera.flyToBoundingSphere(
    new Cesium.BoundingSphere(center, 0),
    {
      offset: new Cesium.HeadingPitchRange(
        0,
        Cesium.Math.toRadians(-50),
        HOME_ALTITUDE,
      ),
      duration: animate ? 2.0 : 0,
    },
  );
  return true;
}

/** Returns the cached user position, or null if not yet known. */
export function getUserLocation() {
  return _userPos;
}

// ─── Init ─────────────────────────────────────────────────────────────────

/**
 * Initialise geolocation and place the marker on the globe.
 * @param {Cesium.Viewer} viewer
 */
export function initUserLocation(viewer) {
  _viewer = viewer;

  if (!navigator.geolocation) {
    console.info('[SkyView:location] Geolocation API not available.');
    return;
  }

  const opts = { enableHighAccuracy: false, timeout: 12_000, maximumAge: 60_000 };

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      _userPos = { lon: pos.coords.longitude, lat: pos.coords.latitude, accuracy: pos.coords.accuracy };

      addMarker(_userPos.lon, _userPos.lat);

      // Fly to user's location as the home view
      flyToUserLocation(true);

      emit('user:location', _userPos);
      console.info(
        `[SkyView:location] Located at ${_userPos.lat.toFixed(4)}, ${_userPos.lon.toFixed(4)}`
      );

      // Keep marker updated if the user moves
      _watchId = navigator.geolocation.watchPosition(
        (p) => {
          _userPos = { lon: p.coords.longitude, lat: p.coords.latitude, accuracy: p.coords.accuracy };
          updateMarkerPosition(_userPos.lon, _userPos.lat);
          emit('user:location', _userPos);
        },
        null,
        { enableHighAccuracy: false, maximumAge: 60_000 },
      );
    },
    (err) => {
      console.info('[SkyView:location] Permission denied or unavailable:', err.message);
    },
    opts,
  );
}

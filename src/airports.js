/**
 * airports.js — World airports layer
 *
 * Features:
 *   - 70+ major airports dataset
 *   - Cesium entity rendering (billboard + label; hub airports use a larger icon)
 *   - Camera fly-to on click (12 km altitude, angled view)
 *   - setAirportsVisible() / getAirports() public API
 *   - getEntityToAirport() WeakMap for unified click handler in main.js
 */

import * as Cesium from 'cesium';
import { ICON_AIRPORT } from './layerIcons.js';

// ── Airport dataset ───────────────────────────────────────────────────────────
// pax: millions of annual passengers (approximate)
// hub: true = major international hub
export const AIRPORTS = [
  // ── North America ───────────────────────────────────────────────────────────
  { iata:'ATL', icao:'KATL', name:'Hartsfield-Jackson Atlanta Intl',      lat: 33.6367, lon: -84.4281, country:'USA',         elev:  313, tz:'America/New_York',      pax:104, hub:true  },
  { iata:'LAX', icao:'KLAX', name:'Los Angeles International',             lat: 33.9425, lon:-118.4081, country:'USA',         elev:   38, tz:'America/Los_Angeles',   pax: 88, hub:true  },
  { iata:'ORD', icao:'KORD', name:"O'Hare International",                  lat: 41.9742, lon: -87.9073, country:'USA',         elev:  205, tz:'America/Chicago',       pax: 83, hub:true  },
  { iata:'DFW', icao:'KDFW', name:'Dallas/Fort Worth International',       lat: 32.8998, lon: -97.0403, country:'USA',         elev:  182, tz:'America/Chicago',       pax: 73, hub:true  },
  { iata:'DEN', icao:'KDEN', name:'Denver International',                  lat: 39.8561, lon:-104.6737, country:'USA',         elev: 1655, tz:'America/Denver',        pax: 69, hub:true  },
  { iata:'JFK', icao:'KJFK', name:'John F. Kennedy International',         lat: 40.6413, lon: -73.7781, country:'USA',         elev:    4, tz:'America/New_York',      pax: 62, hub:true  },
  { iata:'SFO', icao:'KSFO', name:'San Francisco International',           lat: 37.6213, lon:-122.3790, country:'USA',         elev:    4, tz:'America/Los_Angeles',   pax: 57, hub:true  },
  { iata:'MCO', icao:'KMCO', name:'Orlando International',                 lat: 28.4294, lon: -81.3089, country:'USA',         elev:   29, tz:'America/New_York',      pax: 50, hub:false },
  { iata:'MIA', icao:'KMIA', name:'Miami International',                   lat: 25.7959, lon: -80.2870, country:'USA',         elev:    2, tz:'America/New_York',      pax: 45, hub:true  },
  { iata:'SEA', icao:'KSEA', name:'Seattle-Tacoma International',          lat: 47.4502, lon:-122.3088, country:'USA',         elev:  132, tz:'America/Los_Angeles',   pax: 51, hub:false },
  { iata:'EWR', icao:'KEWR', name:'Newark Liberty International',          lat: 40.6895, lon: -74.1745, country:'USA',         elev:    9, tz:'America/New_York',      pax: 46, hub:true  },
  { iata:'LAS', icao:'KLAS', name:'Harry Reid International',              lat: 36.0840, lon:-115.1537, country:'USA',         elev:  645, tz:'America/Los_Angeles',   pax: 48, hub:false },
  { iata:'BOS', icao:'KBOS', name:'Logan International',                   lat: 42.3656, lon: -71.0096, country:'USA',         elev:    9, tz:'America/New_York',      pax: 42, hub:false },
  { iata:'PHX', icao:'KPHX', name:'Phoenix Sky Harbor International',      lat: 33.4373, lon:-112.0078, country:'USA',         elev:  337, tz:'America/Phoenix',       pax: 48, hub:false },
  { iata:'IAH', icao:'KIAH', name:'George Bush Intercontinental',          lat: 29.9902, lon: -95.3368, country:'USA',         elev:   29, tz:'America/Chicago',       pax: 44, hub:true  },
  { iata:'YYZ', icao:'CYYZ', name:'Toronto Pearson International',         lat: 43.6772, lon: -79.6306, country:'Canada',      elev:  173, tz:'America/Toronto',       pax: 50, hub:true  },
  { iata:'YVR', icao:'CYVR', name:'Vancouver International',               lat: 49.1967, lon:-123.1815, country:'Canada',      elev:    4, tz:'America/Vancouver',     pax: 26, hub:false },
  { iata:'MEX', icao:'MMMX', name:'Mexico City International',             lat: 19.4363, lon: -99.0721, country:'Mexico',      elev: 2230, tz:'America/Mexico_City',   pax: 47, hub:true  },
  { iata:'GRU', icao:'SBGR', name:'São Paulo–Guarulhos International',     lat:-23.4356, lon: -46.4731, country:'Brazil',      elev:  750, tz:'America/Sao_Paulo',     pax: 44, hub:true  },
  { iata:'BOG', icao:'SKBO', name:'El Dorado International',               lat:  4.7016, lon: -74.1469, country:'Colombia',    elev: 2548, tz:'America/Bogota',        pax: 35, hub:true  },
  { iata:'EZE', icao:'SAEZ', name:'Ministro Pistarini International',      lat:-34.8222, lon: -58.5358, country:'Argentina',   elev:   20, tz:'America/Buenos_Aires',  pax: 13, hub:true  },
  { iata:'SCL', icao:'SCEL', name:'Arturo Merino Benítez International',   lat:-33.3928, lon: -70.7858, country:'Chile',       elev:  474, tz:'America/Santiago',      pax: 23, hub:false },
  { iata:'LIM', icao:'SPJC', name:'Jorge Chávez International',            lat:-12.0219, lon: -77.1143, country:'Peru',        elev:  113, tz:'America/Lima',          pax: 22, hub:false },
  // ── Europe ──────────────────────────────────────────────────────────────────
  { iata:'LHR', icao:'EGLL', name:'London Heathrow',                       lat: 51.4775, lon:  -0.4614, country:'UK',          elev:   25, tz:'Europe/London',         pax: 80, hub:true  },
  { iata:'CDG', icao:'LFPG', name:'Paris Charles de Gaulle',               lat: 49.0097, lon:   2.5479, country:'France',      elev:  119, tz:'Europe/Paris',          pax: 76, hub:true  },
  { iata:'IST', icao:'LTFM', name:'Istanbul Airport',                      lat: 41.2753, lon:  28.7519, country:'Turkey',      elev:   99, tz:'Europe/Istanbul',       pax: 76, hub:true  },
  { iata:'AMS', icao:'EHAM', name:'Amsterdam Schiphol',                    lat: 52.3086, lon:   4.7639, country:'Netherlands', elev:   -3, tz:'Europe/Amsterdam',      pax: 72, hub:true  },
  { iata:'FRA', icao:'EDDF', name:'Frankfurt Airport',                     lat: 50.0379, lon:   8.5622, country:'Germany',     elev:  111, tz:'Europe/Berlin',         pax: 70, hub:true  },
  { iata:'MAD', icao:'LEMD', name:'Adolfo Suárez Madrid-Barajas',          lat: 40.4936, lon:  -3.5668, country:'Spain',       elev:  610, tz:'Europe/Madrid',         pax: 60, hub:true  },
  { iata:'BCN', icao:'LEBL', name:'Barcelona-El Prat',                     lat: 41.2971, lon:   2.0785, country:'Spain',       elev:    4, tz:'Europe/Madrid',         pax: 53, hub:false },
  { iata:'MUC', icao:'EDDM', name:'Munich Airport',                        lat: 48.3538, lon:  11.7861, country:'Germany',     elev:  453, tz:'Europe/Berlin',         pax: 48, hub:true  },
  { iata:'LGW', icao:'EGKK', name:'London Gatwick',                        lat: 51.1481, lon:  -0.1903, country:'UK',          elev:   62, tz:'Europe/London',         pax: 46, hub:false },
  { iata:'FCO', icao:'LIRF', name:'Rome Fiumicino',                        lat: 41.7999, lon:  12.2462, country:'Italy',       elev:   13, tz:'Europe/Rome',           pax: 43, hub:false },
  { iata:'SVO', icao:'UUEE', name:'Moscow Sheremetyevo',                   lat: 55.9726, lon:  37.4146, country:'Russia',      elev:  190, tz:'Europe/Moscow',         pax: 45, hub:true  },
  { iata:'LIS', icao:'LPPT', name:'Lisbon Humberto Delgado',               lat: 38.7813, lon:  -9.1359, country:'Portugal',    elev:  114, tz:'Europe/Lisbon',         pax: 32, hub:true  },
  { iata:'ZRH', icao:'LSZH', name:'Zurich Airport',                        lat: 47.4647, lon:   8.5492, country:'Switzerland', elev:  432, tz:'Europe/Zurich',         pax: 31, hub:true  },
  { iata:'VIE', icao:'LOWW', name:'Vienna International',                  lat: 48.1103, lon:  16.5697, country:'Austria',     elev:  183, tz:'Europe/Vienna',         pax: 32, hub:false },
  { iata:'CPH', icao:'EKCH', name:'Copenhagen Kastrup',                    lat: 55.6180, lon:  12.6508, country:'Denmark',     elev:    5, tz:'Europe/Copenhagen',     pax: 30, hub:true  },
  { iata:'OSL', icao:'ENGM', name:'Oslo Gardermoen',                       lat: 60.1976, lon:  11.1004, country:'Norway',      elev:  208, tz:'Europe/Oslo',           pax: 28, hub:false },
  { iata:'ARN', icao:'ESSA', name:'Stockholm Arlanda',                     lat: 59.6519, lon:  17.9186, country:'Sweden',      elev:   42, tz:'Europe/Stockholm',      pax: 27, hub:true  },
  { iata:'ATH', icao:'LGAV', name:'Athens Eleftherios Venizelos',          lat: 37.9364, lon:  23.9445, country:'Greece',      elev:   94, tz:'Europe/Athens',         pax: 27, hub:true  },
  { iata:'BRU', icao:'EBBR', name:'Brussels Airport',                      lat: 50.9014, lon:   4.4844, country:'Belgium',     elev:   56, tz:'Europe/Brussels',       pax: 26, hub:false },
  { iata:'HEL', icao:'EFHK', name:'Helsinki Vantaa',                       lat: 60.3172, lon:  24.9633, country:'Finland',     elev:   55, tz:'Europe/Helsinki',       pax: 21, hub:true  },
  { iata:'WAW', icao:'EPWA', name:'Warsaw Chopin',                         lat: 52.1657, lon:  20.9671, country:'Poland',      elev:  110, tz:'Europe/Warsaw',         pax: 18, hub:true  },
  // ── Middle East ─────────────────────────────────────────────────────────────
  { iata:'DXB', icao:'OMDB', name:'Dubai International',                   lat: 25.2532, lon:  55.3657, country:'UAE',         elev:   19, tz:'Asia/Dubai',            pax: 87, hub:true  },
  { iata:'DOH', icao:'OTHH', name:'Hamad International',                   lat: 25.2731, lon:  51.6082, country:'Qatar',       elev:   13, tz:'Asia/Qatar',            pax: 50, hub:true  },
  { iata:'AUH', icao:'OMAA', name:'Abu Dhabi International',               lat: 24.4328, lon:  54.6511, country:'UAE',         elev:   27, tz:'Asia/Dubai',            pax: 23, hub:true  },
  { iata:'RUH', icao:'OERK', name:'King Khalid International',             lat: 24.9576, lon:  46.6988, country:'Saudi Arabia',elev:  614, tz:'Asia/Riyadh',           pax: 37, hub:true  },
  { iata:'JED', icao:'OEJN', name:'King Abdulaziz International',          lat: 21.6796, lon:  39.1565, country:'Saudi Arabia',elev:   17, tz:'Asia/Riyadh',           pax: 44, hub:false },
  { iata:'TLV', icao:'LLBG', name:'Ben Gurion International',              lat: 32.0114, lon:  34.8867, country:'Israel',      elev:   41, tz:'Asia/Jerusalem',        pax: 24, hub:true  },
  // ── Asia-Pacific ────────────────────────────────────────────────────────────
  { iata:'HND', icao:'RJTT', name:'Tokyo Haneda',                          lat: 35.5494, lon: 139.7798, country:'Japan',       elev:    9, tz:'Asia/Tokyo',            pax: 87, hub:true  },
  { iata:'PEK', icao:'ZBAA', name:'Beijing Capital International',         lat: 40.0799, lon: 116.6031, country:'China',       elev:   35, tz:'Asia/Shanghai',         pax:100, hub:true  },
  { iata:'PVG', icao:'ZSPD', name:'Shanghai Pudong International',         lat: 31.1434, lon: 121.8052, country:'China',       elev:    4, tz:'Asia/Shanghai',         pax: 76, hub:true  },
  { iata:'CAN', icao:'ZGGG', name:'Guangzhou Baiyun International',        lat: 23.3924, lon: 113.2988, country:'China',       elev:   15, tz:'Asia/Shanghai',         pax: 74, hub:true  },
  { iata:'HKG', icao:'VHHH', name:'Hong Kong International',               lat: 22.3080, lon: 113.9185, country:'Hong Kong',   elev:    9, tz:'Asia/Hong_Kong',        pax: 71, hub:true  },
  { iata:'ICN', icao:'RKSI', name:'Seoul Incheon International',           lat: 37.4691, lon: 126.4505, country:'South Korea', elev:    7, tz:'Asia/Seoul',            pax: 71, hub:true  },
  { iata:'SIN', icao:'WSSS', name:'Singapore Changi',                      lat:  1.3644, lon: 103.9915, country:'Singapore',   elev:    7, tz:'Asia/Singapore',        pax: 68, hub:true  },
  { iata:'BKK', icao:'VTBS', name:'Suvarnabhumi Airport',                  lat: 13.6900, lon: 100.7501, country:'Thailand',    elev:    1, tz:'Asia/Bangkok',          pax: 65, hub:true  },
  { iata:'KUL', icao:'WMKK', name:'Kuala Lumpur International',            lat:  2.7456, lon: 101.7099, country:'Malaysia',    elev:   21, tz:'Asia/Kuala_Lumpur',     pax: 62, hub:true  },
  { iata:'DEL', icao:'VIDP', name:'Indira Gandhi International',           lat: 28.5665, lon:  77.1031, country:'India',       elev:  237, tz:'Asia/Kolkata',          pax: 69, hub:true  },
  { iata:'BOM', icao:'VABB', name:'Chhatrapati Shivaji Maharaj Intl',      lat: 19.0896, lon:  72.8656, country:'India',       elev:   11, tz:'Asia/Kolkata',          pax: 50, hub:false },
  { iata:'NRT', icao:'RJAA', name:'Tokyo Narita',                          lat: 35.7719, lon: 140.3929, country:'Japan',       elev:   42, tz:'Asia/Tokyo',            pax: 39, hub:false },
  { iata:'CGK', icao:'WIII', name:'Soekarno-Hatta International',          lat: -6.1255, lon: 106.6558, country:'Indonesia',   elev:    8, tz:'Asia/Jakarta',          pax: 66, hub:true  },
  { iata:'MNL', icao:'RPLL', name:'Ninoy Aquino International',            lat: 14.5086, lon: 121.0197, country:'Philippines', elev:    7, tz:'Asia/Manila',           pax: 48, hub:false },
  { iata:'PKX', icao:'ZBAD', name:'Beijing Daxing International',          lat: 39.5098, lon: 116.4105, country:'China',       elev:   27, tz:'Asia/Shanghai',         pax: 40, hub:false },
  // ── Oceania ─────────────────────────────────────────────────────────────────
  { iata:'SYD', icao:'YSSY', name:'Sydney Kingsford Smith',                lat:-33.9399, lon: 151.1753, country:'Australia',   elev:    6, tz:'Australia/Sydney',      pax: 44, hub:true  },
  { iata:'MEL', icao:'YMML', name:'Melbourne Airport',                     lat:-37.6690, lon: 144.8410, country:'Australia',   elev:  132, tz:'Australia/Melbourne',   pax: 37, hub:false },
  { iata:'BNE', icao:'YBBN', name:'Brisbane Airport',                      lat:-27.3842, lon: 153.1175, country:'Australia',   elev:    4, tz:'Australia/Brisbane',    pax: 24, hub:false },
  { iata:'AKL', icao:'NZAA', name:'Auckland Airport',                      lat:-37.0082, lon: 174.7850, country:'New Zealand', elev:    7, tz:'Pacific/Auckland',      pax: 21, hub:true  },
  // ── Africa ──────────────────────────────────────────────────────────────────
  { iata:'JNB', icao:'FAOR', name:'O.R. Tambo International',              lat:-26.1392, lon:  28.2461, country:'South Africa',elev: 1694, tz:'Africa/Johannesburg',   pax: 21, hub:true  },
  { iata:'CAI', icao:'HECA', name:'Cairo International',                   lat: 30.1219, lon:  31.4056, country:'Egypt',       elev:  116, tz:'Africa/Cairo',          pax: 16, hub:true  },
  { iata:'ADD', icao:'HAAB', name:'Addis Ababa Bole International',        lat:  8.9779, lon:  38.7993, country:'Ethiopia',    elev: 2334, tz:'Africa/Addis_Ababa',    pax: 12, hub:true  },
  { iata:'NBO', icao:'HKJK', name:'Jomo Kenyatta International',           lat: -1.3192, lon:  36.9275, country:'Kenya',       elev: 1624, tz:'Africa/Nairobi',        pax:  9, hub:false },
  { iata:'CMN', icao:'GMMN', name:'Mohammed V International',              lat: 33.3675, lon:  -7.5900, country:'Morocco',     elev:  188, tz:'Africa/Casablanca',     pax: 10, hub:true  },
  { iata:'LOS', icao:'DNMM', name:'Murtala Muhammed International',        lat:  6.5774, lon:   3.3214, country:'Nigeria',     elev:   38, tz:'Africa/Lagos',          pax: 14, hub:true  },
];

// ── Module state ──────────────────────────────────────────────────────────────
let _viewer        = null;
/** @type {Cesium.Entity[]} */
let _entities      = [];
let _visible       = true;
const _entityToAirport = new WeakMap();

// ── Public API ────────────────────────────────────────────────────────────────
/** @returns {typeof AIRPORTS} */
export function getAirports()         { return AIRPORTS; }

/** @returns {WeakMap} entity → airport data */
export function getEntityToAirport()  { return _entityToAirport; }

/**
 * Show or hide all airport entities.
 * @param {boolean} visible
 */
export function setAirportsVisible(visible) {
  _visible = visible;
  for (const e of _entities) e.show = visible;
}

// ── Camera fly-to ─────────────────────────────────────────────────────────────
/**
 * Smoothly fly the camera to an airport at a regional overview altitude.
 * @param {{ lon: number, lat: number }} ap
 */
export function flyToAirport(ap) {
  if (!_viewer) return;
  const center = Cesium.Cartesian3.fromDegrees(ap.lon, ap.lat, 0);
  _viewer.camera.flyToBoundingSphere(
    new Cesium.BoundingSphere(center, 0),
    {
      offset: new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(0),
        Cesium.Math.toRadians(-45),
        12_000,
      ),
      duration: 2.5,
    },
  );
}

// ── Initialisation ────────────────────────────────────────────────────────────
/**
 * Add all airport entities to the viewer.
 * @param {Cesium.Viewer} viewer
 */
export function initAirports(viewer) {
  _viewer = viewer;

  for (const ap of AIRPORTS) {
    const entity = viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(ap.lon, ap.lat, 50),
      billboard: {
        image:                    ICON_AIRPORT,
        width:                    ap.hub ? 42 : 34,
        height:                   ap.hub ? 42 : 34,
        color:                    Cesium.Color.WHITE,
        heightReference:          Cesium.HeightReference.NONE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance:          new Cesium.NearFarScalar(1e5, 1.8, 8e6, 0.68),
        verticalOrigin:           Cesium.VerticalOrigin.CENTER,
        horizontalOrigin:         Cesium.HorizontalOrigin.CENTER,
      },
      label: {
        text:                     ap.iata,
        font:                     '600 11px Inter, system-ui, sans-serif',
        fillColor:                Cesium.Color.WHITE,
        outlineColor:             Cesium.Color.fromCssColorString('#000000cc'),
        outlineWidth:             3,
        style:                    Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin:           Cesium.VerticalOrigin.BOTTOM,
        pixelOffset:              new Cesium.Cartesian2(0, -24),
        heightReference:          Cesium.HeightReference.NONE,
        disableDepthTestDistance: 1.2e6,
        translucencyByDistance:   new Cesium.NearFarScalar(2e5, 1.0, 5e6, 0.15),
        scaleByDistance:          new Cesium.NearFarScalar(2e5, 1.06, 4e6, 0.65),
      },
      show: _visible,
    });

    _entityToAirport.set(entity, ap);
    _entities.push(entity);
  }

  // Pre-cache ECEF positions for hemisphere culling (positions are fixed)
  const R_EARTH   = 6_371_000;
  const ecefCache = AIRPORTS.map(ap => Cesium.Cartesian3.fromDegrees(ap.lon, ap.lat, 50));

  viewer.scene.preRender.addEventListener(() => {
    if (!_visible) return;
    const camPos = viewer.camera.positionWC;
    const camMag = Cesium.Cartesian3.magnitude(camPos);
    if (camMag < R_EARTH) return;
    const threshold = R_EARTH / camMag;

    for (let i = 0; i < _entities.length; i++) {
      const p   = ecefCache[i];
      const mag = Cesium.Cartesian3.magnitude(p);
      const cos = Cesium.Cartesian3.dot(camPos, p) / (camMag * mag);
      _entities[i].show = cos >= threshold;
    }
  });

  console.log(`[SkyView:airports] loaded ${_entities.length} airports`);
}

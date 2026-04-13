/**
 * landmarks.js — World landmarks layer
 *
 * Responsibilities:
 *   - Maintain a hardcoded dataset of 25 famous landmarks
 *   - Render each as a Cesium entity with a point marker + label
 *   - Fly the camera to a landmark on search selection
 *   - Expose getLandmarks() for the search bar in ui.js
 *   - Expose setLandmarksVisible() for the layer toggle in ui.js
 *   - Expose getEntityToLandmark() WeakMap for unified click handler in main.js
 */

import * as Cesium from 'cesium';
import { ICON_CAMERA } from './layerIcons.js';

// ── Landmark dataset ──────────────────────────────────────────────────────────
export const LANDMARKS = [
  {
    name: 'Eiffel Tower',
    lat: 48.8584, lon: 2.2945,
    country: 'France', emoji: '🗼',
    description: 'Iron lattice tower built in 1889 — symbol of Paris and one of the most visited monuments in the world.',
  },
  {
    name: 'Great Pyramids of Giza',
    lat: 29.9792, lon: 31.1342,
    country: 'Egypt', emoji: '🏛️',
    description: 'Ancient wonder of the world built around 2560 BC as tombs for pharaohs Khufu, Khafre and Menkaure.',
  },
  {
    name: 'Statue of Liberty',
    lat: 40.6892, lon: -74.0445,
    country: 'USA', emoji: '🗽',
    description: 'Colossal neoclassical sculpture on Liberty Island, gifted by France to the United States in 1886.',
  },
  {
    name: 'Taj Mahal',
    lat: 27.1751, lon: 78.0421,
    country: 'India', emoji: '🕌',
    description: 'White marble mausoleum built 1632–1653 by Mughal emperor Shah Jahan in memory of his wife Mumtaz Mahal.',
  },
  {
    name: 'Colosseum',
    lat: 41.8902, lon: 12.4922,
    country: 'Italy', emoji: '🏟️',
    description: 'Ancient Roman amphitheatre completed in 80 AD — the largest ever built, seating up to 80 000 spectators.',
  },
  {
    name: 'Machu Picchu',
    lat: -13.1631, lon: -72.5450,
    country: 'Peru', emoji: '🏔️',
    description: '15th-century Inca citadel set high in the Andes mountains at 2 430 m above sea level.',
  },
  {
    name: 'Great Wall of China',
    lat: 40.4319, lon: 116.5704,
    country: 'China', emoji: '🧱',
    description: 'Series of ancient fortifications spanning over 21 000 km, built and rebuilt between the 7th century BC and 17th century AD.',
  },
  {
    name: 'Sydney Opera House',
    lat: -33.8568, lon: 151.2153,
    country: 'Australia', emoji: '🎭',
    description: 'Iconic multi-venue performing arts centre on Bennelong Point in Sydney Harbour, opened in 1973.',
  },
  {
    name: 'Christ the Redeemer',
    lat: -22.9519, lon: -43.2105,
    country: 'Brazil', emoji: '✝️',
    description: 'Art Deco statue of Jesus Christ, 30 m tall, standing atop the 700 m Corcovado mountain since 1931.',
  },
  {
    name: 'Big Ben',
    lat: 51.5007, lon: -0.1246,
    country: 'UK', emoji: '🕰️',
    description: 'Iconic clock tower at the north end of the Palace of Westminster, officially named the Elizabeth Tower since 2012.',
  },
  {
    name: 'Burj Khalifa',
    lat: 25.1972, lon: 55.2744,
    country: 'UAE', emoji: '🏗️',
    description: "World's tallest structure at 828 m, completed in 2010 in the heart of Downtown Dubai.",
  },
  {
    name: 'Mount Fuji',
    lat: 35.3606, lon: 138.7274,
    country: 'Japan', emoji: '🗻',
    description: "Japan's highest mountain at 3 776 m — an active stratovolcano and a sacred site in Shinto culture.",
  },
  {
    name: 'Petra',
    lat: 30.3285, lon: 35.4444,
    country: 'Jordan', emoji: '🏜️',
    description: 'Ancient Nabataean city carved into rose-red sandstone cliffs, inhabited since the 4th century BC.',
  },
  {
    name: 'Angkor Wat',
    lat: 13.4125, lon: 103.8670,
    country: 'Cambodia', emoji: '🛕',
    description: "World's largest religious monument, built in the early 12th century as a Hindu temple, later converted to Buddhism.",
  },
  {
    name: 'Chichen Itza',
    lat: 20.6843, lon: -88.5678,
    country: 'Mexico', emoji: '🏛️',
    description: 'Pre-Columbian Mayan city featuring El Castillo pyramid, a UNESCO World Heritage site and New Seven Wonder.',
  },
  {
    name: 'Stonehenge',
    lat: 51.1789, lon: -1.8262,
    country: 'UK', emoji: '🪨',
    description: 'Prehistoric ring of standing stones on Salisbury Plain dating to ~3 000 BC — purpose and construction method still debated.',
  },
  {
    name: 'Golden Gate Bridge',
    lat: 37.8199, lon: -122.4783,
    country: 'USA', emoji: '🌉',
    description: 'Iconic Art Deco suspension bridge spanning 2.7 km across the Golden Gate strait into San Francisco Bay, completed 1937.',
  },
  {
    name: 'Santorini',
    lat: 36.3932, lon: 25.4615,
    country: 'Greece', emoji: '🏝️',
    description: 'Volcanic island in the Aegean Sea, famous for white-washed clifftop villages, blue-domed churches and stunning caldera views.',
  },
  {
    name: 'Niagara Falls',
    lat: 43.0896, lon: -79.0849,
    country: 'USA / Canada', emoji: '💧',
    description: 'Three massive waterfalls straddling the US–Canada border — Horseshoe Falls drops 57 m and is the most powerful in North America.',
  },
  {
    name: 'Mount Everest',
    lat: 27.9881, lon: 86.9250,
    country: 'Nepal / China', emoji: '🏔️',
    description: "Earth's highest mountain above sea level at 8 849 m, located in the Himalayas on the Nepal–China border.",
  },
  {
    name: 'Dubai Frame',
    lat: 25.2350, lon: 55.3002,
    country: 'UAE', emoji: '🖼️',
    description: '150 m tall picture-frame structure in Zabeel Park offering views of both old and modern Dubai, opened 2018.',
  },
  {
    name: 'Brandenburg Gate',
    lat: 52.5163, lon: 13.3777,
    country: 'Germany', emoji: '🏛️',
    description: '18th-century neoclassical monument in Berlin, a symbol of German unity and one of Europe\'s most iconic landmarks.',
  },
  {
    name: 'Acropolis of Athens',
    lat: 37.9715, lon: 23.7267,
    country: 'Greece', emoji: '🏛️',
    description: 'Ancient citadel above Athens containing the Parthenon and other 5th-century BC structures, symbol of Western civilisation.',
  },
  {
    name: 'Times Square',
    lat: 40.7580, lon: -73.9855,
    country: 'USA', emoji: '🌃',
    description: "Commercial and entertainment hub at the heart of Midtown Manhattan — the 'Crossroads of the World', visited by 50 M annually.",
  },
  {
    name: 'Table Mountain',
    lat: -33.9628, lon: 18.4098,
    country: 'South Africa', emoji: '⛰️',
    description: 'Flat-topped mountain overlooking Cape Town at 1 086 m, a UNESCO World Heritage site and New Seven Wonder of Nature.',
  },
];

// ── Module state ──────────────────────────────────────────────────────────────
/** @type {Cesium.Viewer} */
let _viewer = null;

/** @type {Cesium.Entity[]} */
let _entities = [];

/** WeakMap so we don't pollute Cesium's entity object */
const _entityToLandmark = new WeakMap();

let _visible = true;

// ── Public API ────────────────────────────────────────────────────────────────
export function getLandmarks()            { return LANDMARKS; }
export function getEntityToLandmark()     { return _entityToLandmark; }

export function setLandmarksVisible(visible) {
  _visible = visible;
  for (const entity of _entities) {
    entity.show = visible;
  }
}

// ── Camera fly-to ─────────────────────────────────────────────────────────────
/**
 * Smoothly fly the camera to a landmark at a close, angled view.
 * @param {{ lon: number, lat: number }} landmark
 */
export function flyToLandmark(landmark) {
  if (!_viewer) return;
  const center = Cesium.Cartesian3.fromDegrees(landmark.lon, landmark.lat, 0);
  _viewer.camera.flyToBoundingSphere(
    new Cesium.BoundingSphere(center, 0),
    {
      offset: new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(0),
        Cesium.Math.toRadians(-45),
        5_000,
      ),
      duration: 2.5,
    },
  );
}

// ── Initialisation ────────────────────────────────────────────────────────────
/**
 * Add all landmark entities to the viewer.
 * @param {Cesium.Viewer} viewer
 */
export function initLandmarks(viewer) {
  _viewer = viewer;

  for (const lm of LANDMARKS) {
    const entity = viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lm.lon, lm.lat, 200),
      billboard: {
        image:                    ICON_CAMERA,
        width:                    38,
        height:                   38,
        color:                    Cesium.Color.WHITE,
        heightReference:          Cesium.HeightReference.NONE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance:          new Cesium.NearFarScalar(1e5, 1.55, 8e6, 0.88),
        verticalOrigin:           Cesium.VerticalOrigin.CENTER,
        horizontalOrigin:         Cesium.HorizontalOrigin.CENTER,
      },
      label: {
        text:                     lm.name,
        font:                     '600 12px Inter, system-ui, sans-serif',
        fillColor:                Cesium.Color.WHITE,
        outlineColor:             Cesium.Color.fromCssColorString('#000000cc'),
        outlineWidth:             3,
        style:                    Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin:           Cesium.VerticalOrigin.BOTTOM,
        pixelOffset:              new Cesium.Cartesian2(0, -22),
        heightReference:          Cesium.HeightReference.NONE,
        disableDepthTestDistance: 1.1e6,
        translucencyByDistance:   new Cesium.NearFarScalar(5e5, 1.0, 7e6, 0.12),
        scaleByDistance:          new Cesium.NearFarScalar(5e5, 1.05, 5e6, 0.58),
      },
      show: _visible,
    });

    _entityToLandmark.set(entity, lm);
    _entities.push(entity);
  }

  // Pre-cache ECEF positions for hemisphere culling (positions are fixed)
  const R_EARTH   = 6_371_000;
  const ecefCache = LANDMARKS.map(lm => Cesium.Cartesian3.fromDegrees(lm.lon, lm.lat, 200));

  viewer.scene.preRender.addEventListener(() => {
    if (!_visible) return;
    const camPos = viewer.camera.positionWC;
    const camMag = Cesium.Cartesian3.magnitude(camPos);
    if (camMag < R_EARTH) return; // camera underground — show all
    const threshold = R_EARTH / camMag;

    for (let i = 0; i < _entities.length; i++) {
      const p   = ecefCache[i];
      const mag = Cesium.Cartesian3.magnitude(p);
      const cos = Cesium.Cartesian3.dot(camPos, p) / (camMag * mag);
      _entities[i].show = cos >= threshold;
    }
  });

  console.log(`[SkyView:landmarks] loaded ${_entities.length} landmarks`);
}

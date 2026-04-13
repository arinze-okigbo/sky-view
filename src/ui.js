import * as Cesium from 'cesium';
import L from 'leaflet';
import { appConfig } from './config.js';
import { emit, on } from './core/bus.js';
import { initPanelManager, showPanel } from './panelManager.js';
import {
  escapeHtml,
  formatAltitudeFeet,
  formatCoordinates,
  formatFlightIdentity,
  formatHeading,
  formatNumber,
  formatRelativeTime,
  formatSpeedKnots,
  formatVerticalRate,
} from './utils/format.js';
import {
  enrichFlightData,
  flyToFlight,
  getAircraftMap,
  getFlightSnapshot,
  setAltitudeRange,
  setFlightsVisible,
  setSelectedFlight,
  setTrajectoriesVisible,
  subscribeFlights,
} from './flights.js';
import { setLandmarksVisible } from './landmarks.js';
import { setAirportsVisible } from './airports.js';
import { getWeatherState, setWeatherVisible, toggleWeatherLoop } from './weather.js';
import {
  enrichSatellite,
  getSatellites,
  getSatelliteSnapshot,
  setSatellitesVisible,
  setSelectedSatellite,
  subscribeSatellites,
} from './satellites.js';
import {
  enrichCamera,
  getCameras,
  getCameraSnapshot,
  setCamerasVisible,
  setSelectedCamera,
  subscribeCameras,
} from './cameras.js';
import {
  addSearchFilter,
  getActiveSearchFilters,
  getSearchResults,
  parseQuery,
  removeSearchFilter,
  runSearch,
  subscribeSearch,
} from './search.js';
import {
  addAnnotation,
  addBookmark,
  deleteSavedView,
  flyToAnnotation,
  getAnnotations,
  getBookmarks,
  getSavedViews,
  loadView,
  removeAnnotation,
  removeBookmark,
  saveView,
  subscribeBookmarks,
} from './bookmarks.js';
import {
  buildFusionContext,
} from './fusion.js';
import {
  deleteZone,
  getZoneOccupancy,
  getZones,
  startZoneDraw,
  subscribeZones,
  toggleZone,
  updateZone,
} from './zones.js';
import { readStorage, writeStorage } from './utils/storage.js';

let _viewer = null;
let _flightSnapshot = getFlightSnapshot();
let _weatherSnapshot = getWeatherState();
let _satelliteSnapshot = getSatelliteSnapshot();
let _cameraSnapshot = getCameraSnapshot();
let _systemStatus = {
  title: 'SkyView',
  status: 'Initializing globe',
  meta: 'Flight layers and tools',
};
let _tilesReady = false;
let _flightsOn = true;
let _landmarksOn = true;
let _airportsOn = false;
let _satellitesOn = false;
let _camerasOn = false;
let _weatherOn = false;
let _trajectoriesOn = true;
let _lightingOn = true;
let _minimap = null;
let _minimapBounds = null;
let _minimapMarkers = [];
let _unsubscribeFlights = null;
let _unsubscribeSatellites = null;
let _unsubscribeCameras = null;
let _unsubscribeSearch = null;
let _unsubscribeBookmarks = null;
let _unsubscribeZones = null;
let _relativeTimeTimer = null;
let _minimapTimer = null;
let _overviewCollapsed = true;
let _bookmarkSnapshot = {
  savedViews: getSavedViews(),
  bookmarks: getBookmarks(),
  annotations: getAnnotations(),
};
let _zoneSnapshot = {
  zones: getZones(),
  occupancy: [],
  drawActive: false,
};
let _searchSnapshot = {
  query: '',
  filters: getActiveSearchFilters(),
  results: getSearchResults(),
};
let _contextMenuState = null;

/** Removed on each initUI so dev HMR / re-init does not stack global listeners. */
let _docSearchDismiss = null;
let _docShortcutKeydown = null;
let _docContextMenuDismiss = null;
let _cameraMinimapSync = null;

function teardownUiDocumentListeners() {
  if (_docSearchDismiss) {
    document.removeEventListener('click', _docSearchDismiss);
    _docSearchDismiss = null;
  }
  if (_docShortcutKeydown) {
    document.removeEventListener('keydown', _docShortcutKeydown);
    _docShortcutKeydown = null;
  }
  if (_docContextMenuDismiss) {
    document.removeEventListener('click', _docContextMenuDismiss);
    _docContextMenuDismiss = null;
  }
  if (_viewer?.camera?.changed && _cameraMinimapSync) {
    _viewer.camera.changed.removeEventListener(_cameraMinimapSync);
    _cameraMinimapSync = null;
  }
}

const ui = {
  root: null,
  drawer: null,
  searchInput: null,
  searchResults: null,
  shortcutsModal: null,
  toastRegion: null,
  overviewRail: null,
  contextMenu: null,
};

function createMetricMarkup(label, value, meta = '') {
  return `
    <div class="metric-card">
      <div class="metric-head">
        <span class="metric-label">${escapeHtml(label)}</span>
      </div>
      <span class="metric-value">${escapeHtml(value)}</span>
      ${meta ? `<div class="metric-meta">${escapeHtml(meta)}</div>` : ''}
    </div>
  `;
}

function createRowMarkup(label, value, emphasis = false) {
  return `
    <div class="detail-row">
      <span class="detail-label">${escapeHtml(label)}</span>
      <span class="detail-value${emphasis ? ' is-emphasis' : ''}">${value}</span>
    </div>
  `;
}

function getFeedTone(mode) {
  if (mode === 'live') return 'tone-live';
  if (mode === 'degraded') return 'tone-warning';
  if (mode === 'demo') return 'tone-demo';
  return 'tone-neutral';
}

function showToast({ title, message, tone = 'neutral' }) {
  if (!ui.toastRegion) return;

  const toast = document.createElement('article');
  toast.className = `toast-card is-${tone}`;
  toast.innerHTML = `
    <div class="toast-header">
      <strong>${escapeHtml(title)}</strong>
      <button type="button" class="toast-close" aria-label="Dismiss notification">✕</button>
    </div>
    <p>${escapeHtml(message)}</p>
  `;

  const close = () => {
    toast.classList.add('is-closing');
    setTimeout(() => toast.remove(), 220);
  };

  toast.querySelector('.toast-close')?.addEventListener('click', close);
  ui.toastRegion.appendChild(toast);
  setTimeout(close, 6000);
}

function highlightMatch(text, query) {
  const normalizedText = String(text || '');
  const normalizedQuery = String(query || '').trim();

  if (!normalizedQuery) return escapeHtml(normalizedText);

  const index = normalizedText.toLowerCase().indexOf(normalizedQuery.toLowerCase());
  if (index === -1) return escapeHtml(normalizedText);

  return (
    escapeHtml(normalizedText.slice(0, index)) +
    `<mark>${escapeHtml(normalizedText.slice(index, index + normalizedQuery.length))}</mark>` +
    escapeHtml(normalizedText.slice(index + normalizedQuery.length))
  );
}

const HUD_MODAL_IDS = [
  'analyticsModalShell',
  'bookmarksModalShell',
  'zonesModalShell',
  'timelineModalShell',
];

function showHudModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('is-hidden');
  el.setAttribute('aria-hidden', 'false');
}

function hideHudModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('is-hidden');
  el.setAttribute('aria-hidden', 'true');
}

function toggleHudModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el.classList.contains('is-hidden')) showHudModal(id);
  else hideHudModal(id);
}

function closeAllHudModals() {
  HUD_MODAL_IDS.forEach(hideHudModal);
}

let _mainSidebarOpen = !window.matchMedia('(max-width: 900px)').matches;

function applyMainSidebarOpenState() {
  const sb = document.getElementById('mainSidebar');
  const bd = document.getElementById('sidebarBackdrop');
  const btn = document.getElementById('mainSidebarToggle');
  if (!sb) return;
  const narrow = window.matchMedia('(max-width: 900px)').matches;
  sb.classList.toggle('is-sidebar-collapsed', !_mainSidebarOpen);
  btn?.setAttribute('aria-expanded', String(_mainSidebarOpen));
  if (bd) {
    const showBackdrop = narrow && _mainSidebarOpen;
    bd.classList.toggle('is-hidden', !showBackdrop);
    bd.setAttribute('aria-hidden', String(!showBackdrop));
  }
}

function toggleMainSidebar() {
  const sb = document.getElementById('mainSidebar');
  if (sb?.classList.contains('is-panel-hidden')) {
    showPanel('mainSidebar');
    _mainSidebarOpen = true;
    applyMainSidebarOpenState();
    return;
  }
  _mainSidebarOpen = !_mainSidebarOpen;
  applyMainSidebarOpenState();
}

function bindHudModalDismiss() {
  document.getElementById('appHud')?.addEventListener('click', (event) => {
    const t = event.target.closest('[data-modal-close]');
    if (!t) return;
    hideHudModal(t.dataset.modalClose);
  });
}

function bindMainSidebarChrome() {
  document.getElementById('mainSidebarToggle')?.addEventListener('click', () => toggleMainSidebar());
  document.getElementById('sidebarBackdrop')?.addEventListener('click', () => {
    _mainSidebarOpen = false;
    applyMainSidebarOpenState();
  });
  window.addEventListener('resize', () => applyMainSidebarOpenState());

  document.querySelectorAll('[data-sidebar-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      const key = tab.dataset.sidebarTab;
      document.querySelectorAll('[data-sidebar-tab]').forEach((btn) => {
        const active = btn.dataset.sidebarTab === key;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-selected', String(active));
      });
      document.querySelectorAll('[data-tab-panel]').forEach((panel) => {
        const active = panel.dataset.tabPanel === key;
        panel.classList.toggle('is-active', active);
        panel.toggleAttribute('hidden', !active);
      });
    });
  });

  document.getElementById('openAnalyticsModal')?.addEventListener('click', () => showHudModal('analyticsModalShell'));
  document.getElementById('openBookmarksModal')?.addEventListener('click', () => showHudModal('bookmarksModalShell'));
  document.getElementById('openZonesModal')?.addEventListener('click', () => showHudModal('zonesModalShell'));
  document.getElementById('openTimelineModal')?.addEventListener('click', () => showHudModal('timelineModalShell'));
}

function buildShell() {
  document.getElementById('appHud')?.remove();

  document.body.insertAdjacentHTML('beforeend', `
    <div id="appHud" aria-live="polite">

      <!-- ── Command bar: search + sidebar toggle + status ── -->
      <header id="commandBar" class="hud-surface">
        <div class="command-bar-main">
          <button id="mainSidebarToggle" class="icon-button is-prominent" type="button" aria-label="Toggle main sidebar" aria-expanded="true">☰</button>
          <div class="command-center">
            <label class="search-shell" for="searchInput">
              <span class="search-shell-icon">⌕</span>
              <input id="searchInput" type="text" autocomplete="off" spellcheck="false" placeholder="Search flights, airports, POIs, satellites…" />
              <button id="searchClear" class="icon-button is-hidden" type="button" aria-label="Clear search">✕</button>
            </label>
            <div id="searchResults" class="search-panel is-hidden" role="listbox" aria-label="Search results"></div>
            <div class="search-meta-row">
              <div id="searchFilterChips" class="search-filter-chips"></div>
              <span id="searchResultCount" class="search-count-badge">0</span>
            </div>
          </div>
          <div class="status-cluster">
            <div id="commandStatus" class="status-pill tone-neutral">
              <span class="status-dot"></span>
              <span class="status-copy">Initializing</span>
            </div>
            <button id="helpButton" class="icon-button is-prominent" type="button" aria-label="Keyboard shortcuts" aria-expanded="false" aria-controls="shortcutsModal">?</button>
          </div>
        </div>
      </header>

      <div id="sidebarBackdrop" class="sidebar-backdrop is-hidden" aria-hidden="true"></div>

      <!-- ── Unified sidebar (tabs) ── -->
      <aside id="mainSidebar" class="hud-surface hud-panel main-sidebar">
        <div class="main-sidebar-core">
          <nav class="sidebar-tabs" role="tablist" aria-label="Cockpit sections">
            <button type="button" class="sidebar-tab is-active" role="tab" aria-selected="true" id="sidebarTabOverview" data-sidebar-tab="overview">Overview</button>
            <button type="button" class="sidebar-tab" role="tab" aria-selected="false" id="sidebarTabLayers" data-sidebar-tab="layers">Layers</button>
            <button type="button" class="sidebar-tab" role="tab" aria-selected="false" id="sidebarTabTools" data-sidebar-tab="tools">Tools</button>
          </nav>
          <div class="sidebar-tab-panels">
            <div id="sidebarPanelOverview" class="sidebar-tab-panel is-active" role="tabpanel" data-tab-panel="overview">
      <aside id="overviewRail" class="hud-surface hud-panel">
        <button id="overviewToggle" class="overview-toggle" type="button" aria-label="Collapse overview" aria-expanded="true">
          <span class="overview-toggle-icon">❮</span>
          <span class="overview-toggle-label">Overview</span>
        </button>

        <section class="panel-block">
          <div class="section-heading">
            <span>Metrics</span>
            <span id="refreshTimeLabel" class="section-meta">—</span>
          </div>
          <div id="metricsGrid" class="metrics-grid"></div>
        </section>

        <section class="panel-block">
          <div class="section-heading">
            <span>Highlights</span>
            <span id="feedModeLabel" class="inline-badge tone-neutral">Feed</span>
          </div>
          <div id="insightList" class="insight-list"></div>
        </section>

        <section class="panel-block">
          <div class="section-heading"><span>Quick views</span></div>
          <div class="quick-view-grid">
            <button class="quick-view-btn" data-view="global">Global</button>
            <button class="quick-view-btn" data-lon="-40" data-lat="28" data-alt="10000000">Atlantic</button>
            <button class="quick-view-btn" data-lon="10" data-lat="50" data-alt="4500000">Europe</button>
            <button class="quick-view-btn" data-lon="-100" data-lat="38" data-alt="7000000">Americas</button>
            <button class="quick-view-btn" data-lon="110" data-lat="25" data-alt="7500000">Asia-Pac</button>
            <button class="quick-view-btn" data-lon="45" data-lat="25" data-alt="5500000">Mid-East</button>
          </div>
        </section>

        <section class="panel-block">
          <div class="section-heading">
            <span>Saved views</span>
            <button id="saveViewInline" class="inline-action-btn" type="button">Save</button>
          </div>
          <div id="savedViewsList" class="saved-view-list"></div>
        </section>

        <!-- Preserve IDs used by updateCommandStatus / renderOverview -->
        <span id="overviewTitle" hidden></span>
        <span id="overviewMeta" hidden></span>
        <span id="overviewReadiness" hidden></span>
        <span id="overviewReadinessMeta" hidden></span>
      </aside>
            </div>

            <div id="sidebarPanelLayers" class="sidebar-tab-panel" role="tabpanel" data-tab-panel="layers" hidden>
      <aside id="controlRail" class="hud-surface hud-panel">
        <section class="panel-block">
          <div class="section-heading"><span>Layers</span></div>
          <div class="toggle-grid">
            <button id="toggleFlights" class="control-toggle is-active">
              <span class="control-toggle-icon" aria-hidden="true">✈</span>
              <span class="control-toggle-label">Flights</span>
            </button>
            <button id="toggleLandmarks" class="control-toggle is-active">
              <span class="control-toggle-icon" aria-hidden="true">⌖</span>
              <span class="control-toggle-label">Landmarks</span>
            </button>
            <button id="toggleAirports" class="control-toggle">
              <span class="control-toggle-icon" aria-hidden="true">▦</span>
              <span class="control-toggle-label">Airports</span>
            </button>
            <button id="toggleSatellites" class="control-toggle">
              <span class="control-toggle-icon" aria-hidden="true">🛰</span>
              <span class="control-toggle-label">Satellites</span>
            </button>
            <button id="toggleCameras" class="control-toggle">
              <span class="control-toggle-icon" aria-hidden="true">📷</span>
              <span class="control-toggle-label">Cameras</span>
            </button>
            <button id="toggleWeather" class="control-toggle">
              <span class="control-toggle-icon" aria-hidden="true">◌</span>
              <span class="control-toggle-label">Weather</span>
            </button>
            <button id="toggleTrajectories" class="control-toggle is-active">
              <span class="control-toggle-icon" aria-hidden="true">≈</span>
              <span class="control-toggle-label">Trails</span>
            </button>
            <button id="toggleLighting" class="control-toggle is-active">
              <span class="control-toggle-icon" aria-hidden="true">◐</span>
              <span class="control-toggle-label">Lighting</span>
            </button>
          </div>
        </section>

        <section class="panel-block">
          <div class="section-heading">
            <span>Altitude</span>
            <span id="altitudeLabel" class="section-meta">All</span>
          </div>
          <div class="range-stack">
            <input id="altitudeMin" class="range-input" type="range" min="0" max="15000" step="100" value="0"     aria-label="Min altitude" />
            <input id="altitudeMax" class="range-input" type="range" min="0" max="15000" step="100" value="15000" aria-label="Max altitude" />
          </div>
        </section>

        <section class="panel-block">
          <div class="section-heading">
            <span>Weather</span>
            <span id="weatherStatusLabel" class="section-meta">Idle</span>
          </div>
          <p class="panel-copy" id="weatherFeedMessage">Ready when enabled.</p>
          <button id="toggleWeatherLoop" class="feature-button">Animate radar</button>
        </section>

        <section class="panel-block">
          <div class="section-heading"><span>Legend</span></div>
          <div class="legend-list">
            <div class="legend-item"><span class="legend-swatch" style="background:var(--success)"></span><span>Live</span></div>
            <div class="legend-item"><span class="legend-swatch" style="background:var(--warning)"></span><span>Degraded</span></div>
            <div class="legend-item"><span class="legend-swatch" style="background:var(--demo)"></span><span>Demo</span></div>
          </div>
        </section>
      </aside>
            </div>

            <div id="sidebarPanelTools" class="sidebar-tab-panel" role="tabpanel" data-tab-panel="tools" hidden>
              <section class="panel-block">
                <div class="section-heading"><span>Panels</span><span class="section-meta">Modals</span></div>
                <div class="tools-launch-grid">
                  <button type="button" id="openAnalyticsModal" class="feature-button">Analytics</button>
                  <button type="button" id="openBookmarksModal" class="feature-button">Bookmarks</button>
                  <button type="button" id="openZonesModal" class="feature-button">Zones</button>
                  <button type="button" id="openTimelineModal" class="feature-button">Timeline</button>
                </div>
              </section>
              <section class="panel-block">
                <div class="section-heading"><span>Saved view</span></div>
                <button id="saveViewButton" class="feature-button" type="button">Save current view</button>
              </section>
              <section class="panel-block">
                <div class="section-heading"><span>System status</span></div>
                <p class="dock-status-headline"><strong id="dockHeadline" class="dock-headline">SkyView</strong></p>
                <p id="dockSubline" class="dock-subline-text"></p>
                <div id="dockBadges" class="dock-badges dock-badges--sidebar"></div>
              </section>
            </div>
          </div>
        </div>
      </aside>

      <div id="analyticsModalShell" class="hud-modal-shell is-hidden" role="dialog" aria-modal="true" aria-label="Analytics" aria-hidden="true">
        <button type="button" class="hud-modal-backdrop" data-modal-close="analyticsModalShell" aria-label="Close analytics overlay"></button>
        <div class="hud-modal-card hud-surface">
      <aside id="analyticsRail" class="hud-panel analytics-rail">
        <section class="panel-block analytics-head">
          <div class="section-heading">
            <span>Analytics</span>
            <div class="section-inline-actions">
              <span class="section-meta">Airborne <strong id="analyticsCountLabel">0</strong></span>
              <button id="analyticsCollapse" class="inline-action-btn" type="button" aria-expanded="true">Collapse</button>
              <button type="button" class="inline-action-btn" data-modal-close="analyticsModalShell">Close</button>
            </div>
          </div>
        </section>
        <div class="analytics-body">
          <section class="panel-block">
            <div class="section-heading"><span>Flight density</span><span class="section-meta">10 min</span></div>
            <canvas id="analyticsSparkline" class="analytics-canvas analytics-canvas-sparkline"></canvas>
          </section>
          <section class="panel-block">
            <div class="section-heading"><span>Altitude distribution</span><span class="section-meta">Live</span></div>
            <canvas id="analyticsHistogram" class="analytics-canvas analytics-canvas-bars"></canvas>
          </section>
          <section class="panel-block">
            <div class="section-heading"><span>Country breakdown</span><span class="section-meta">Top 8</span></div>
            <canvas id="analyticsCountryChart" class="analytics-canvas analytics-canvas-bars"></canvas>
          </section>
          <section class="panel-block">
            <div class="section-heading"><span>Correlation matrix</span><span class="section-meta">500 km</span></div>
            <div class="analytics-matrix-shell">
              <canvas id="analyticsMatrix" class="analytics-canvas analytics-canvas-matrix"></canvas>
              <div id="analyticsMatrixTooltip" class="analytics-tooltip is-hidden"></div>
            </div>
          </section>
          <section class="panel-block">
            <div class="section-heading"><span>Alert thresholds</span><span class="section-meta">Persistent</span></div>
            <div class="threshold-grid">
              <label class="threshold-field">
                <span>Max altitude ft</span>
                <input id="thresholdAltitudeInput" type="number" min="0" step="100" />
              </label>
              <label class="threshold-field">
                <span>Min speed kts</span>
                <input id="thresholdSpeedInput" type="number" min="0" step="10" />
              </label>
              <label class="threshold-field">
                <span>Min airborne</span>
                <input id="thresholdAirborneInput" type="number" min="0" step="1" />
              </label>
            </div>
          </section>
          <section class="panel-block">
            <div class="section-heading"><span>Fusion query</span><span class="section-meta">Cross-layer</span></div>
            <div id="fusionSummaryPanel" class="fusion-summary-panel"></div>
          </section>
        </div>
      </aside>
        </div>
      </div>

      <div id="bookmarksModalShell" class="hud-modal-shell is-hidden" role="dialog" aria-modal="true" aria-label="Bookmarks" aria-hidden="true">
        <button type="button" class="hud-modal-backdrop" data-modal-close="bookmarksModalShell" aria-label="Close bookmarks"></button>
        <div class="hud-modal-card hud-surface hud-modal-card--stack">
          <div class="hud-modal-topbar">
            <span class="hud-modal-title">Bookmarks</span>
            <button type="button" class="icon-button" data-modal-close="bookmarksModalShell" aria-label="Close">✕</button>
          </div>
      <aside id="bookmarksPanel" class="hud-panel bookmarks-panel">
        <section class="panel-block">
          <div class="section-heading"><span>Bookmarks</span><span class="section-meta">Saved pins</span></div>
          <div id="bookmarksList" class="bookmark-list"></div>
        </section>
        <section class="panel-block">
          <div class="section-heading"><span>Annotations</span><span class="section-meta">Map notes</span></div>
          <div id="annotationsList" class="bookmark-list"></div>
        </section>
      </aside>
        </div>
      </div>

      <div id="zonesModalShell" class="hud-modal-shell is-hidden" role="dialog" aria-modal="true" aria-label="Zones" aria-hidden="true">
        <button type="button" class="hud-modal-backdrop" data-modal-close="zonesModalShell" aria-label="Close zones"></button>
        <div class="hud-modal-card hud-surface hud-modal-card--stack">
          <div class="hud-modal-topbar">
            <span class="hud-modal-title">Geo-fence zones</span>
            <button type="button" class="icon-button" data-modal-close="zonesModalShell" aria-label="Close">✕</button>
          </div>
      <aside id="zonesPanel" class="hud-panel zones-panel">
        <section class="panel-block">
          <div class="section-heading">
            <span>Geo-fence zones</span>
            <button id="drawZoneButton" class="inline-action-btn" type="button">Draw zone</button>
          </div>
          <div id="zonesList" class="zone-list"></div>
        </section>
      </aside>
        </div>
      </div>

      <div id="timelineModalShell" class="hud-modal-shell is-hidden" role="dialog" aria-modal="true" aria-label="Activity feed" aria-hidden="true">
        <button type="button" class="hud-modal-backdrop" data-modal-close="timelineModalShell" aria-label="Close timeline"></button>
        <div class="hud-modal-card hud-surface hud-modal-card--stack">
          <div class="hud-modal-topbar">
            <span class="hud-modal-title">Activity feed</span>
            <button type="button" class="icon-button" data-modal-close="timelineModalShell" aria-label="Close">✕</button>
          </div>
      <aside id="timelinePanel" class="hud-panel timeline-panel">
        <section class="panel-block">
          <div class="section-heading"><span>Activity feed</span><span class="section-meta">Live events</span></div>
          <div id="timelineFilters" class="timeline-filters">
            <button class="filter-pill is-active" data-filter="all" type="button">All</button>
            <button class="filter-pill" data-filter="flights" type="button">Flights</button>
            <button class="filter-pill" data-filter="satellites" type="button">Satellites</button>
            <button class="filter-pill" data-filter="cameras" type="button">Cameras</button>
            <button class="filter-pill" data-filter="alerts" type="button">Alerts</button>
          </div>
          <div id="timelineList" class="timeline-list"></div>
        </section>
      </aside>
        </div>
      </div>

      <!-- ── Detail drawer ── -->
      <aside id="detailDrawer" class="detail-drawer" aria-label="Detail"></aside>

      <!-- ── Toasts ── -->
      <div id="toastRegion" class="toast-region" aria-live="assertive" aria-atomic="true"></div>

      <!-- ── Shortcuts modal ── -->
      <div id="shortcutsModal" class="modal-shell is-hidden" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <div class="modal-card hud-surface">
          <div class="modal-header">
            <div>
              <span class="modal-eyebrow">Quick commands</span>
              <h3>Keyboard shortcuts</h3>
            </div>
            <button id="closeShortcuts" class="icon-button" type="button" aria-label="Close">✕</button>
          </div>
          <div class="shortcut-grid">
            <div class="shortcut-row"><kbd>/</kbd><span>Focus search</span></div>
            <div class="shortcut-row"><kbd>F</kbd><span>Toggle flights</span></div>
            <div class="shortcut-row"><kbd>L</kbd><span>Toggle landmarks</span></div>
            <div class="shortcut-row"><kbd>P</kbd><span>Toggle airports</span></div>
            <div class="shortcut-row"><kbd>O</kbd><span>Toggle satellites</span></div>
            <div class="shortcut-row"><kbd>C</kbd><span>Toggle cameras</span></div>
            <div class="shortcut-row"><kbd>R</kbd><span>Toggle weather</span></div>
            <div class="shortcut-row">
              <span class="shortcut-keys"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span>
              <span>Pan on screen X/Y (click globe first)</span>
            </div>
            <div class="shortcut-row"><kbd>T</kbd><span>Toggle trails</span></div>
            <div class="shortcut-row"><kbd>I</kbd><span>Toggle analytics window</span></div>
            <div class="shortcut-row"><kbd>E</kbd><span>Toggle activity feed</span></div>
            <div class="shortcut-row"><kbd>B</kbd><span>Toggle bookmarks</span></div>
            <div class="shortcut-row"><kbd>Z</kbd><span>Toggle zones</span></div>
            <div class="shortcut-row"><kbd>V</kbd><span>Save current view</span></div>
            <div class="shortcut-row"><kbd>Space</kbd><span>Pause spin</span></div>
            <div class="shortcut-row"><kbd>Esc</kbd><span>Close panel</span></div>
            <div class="shortcut-row"><kbd>?</kbd><span>This dialog</span></div>
          </div>
        </div>
      </div>

      <!-- ── Minimap ── -->
      <section id="minimapShell" class="hud-surface minimap-shell ${appConfig.enableMinimap ? '' : 'is-hidden'}">
        <div class="section-heading minimap-heading">
          <span>Navigator</span>
          <span class="section-meta minimap-hint">Map · click to fly</span>
        </div>
        <div id="minimapCanvas"></div>
      </section>

      <div id="mapContextMenu" class="map-context-menu is-hidden">
        <button class="context-menu-item" data-action="query-area" type="button">Query this area</button>
        <button class="context-menu-item" data-action="add-annotation" type="button">Add annotation here</button>
      </div>

    </div>
  `);

  ui.root = document.getElementById('appHud');
  ui.drawer = document.getElementById('detailDrawer');
  ui.searchInput = document.getElementById('searchInput');
  ui.searchResults = document.getElementById('searchResults');
  ui.shortcutsModal = document.getElementById('shortcutsModal');
  ui.toastRegion = document.getElementById('toastRegion');
  ui.overviewRail = document.getElementById('overviewRail');
  ui.contextMenu = document.getElementById('mapContextMenu');
}

function applyOverviewRailState() {
  if (!ui.overviewRail) return;

  ui.overviewRail.classList.toggle('is-collapsed', _overviewCollapsed);

  const toggle = document.getElementById('overviewToggle');
  if (!toggle) return;

  toggle.setAttribute('aria-expanded', String(!_overviewCollapsed));
  toggle.setAttribute('aria-label', _overviewCollapsed ? 'Expand overview panel' : 'Collapse overview panel');
  const icon = toggle.querySelector('.overview-toggle-icon');
  if (icon) icon.textContent = _overviewCollapsed ? '❯' : '❮';
}

function renderOverview() {
  const metricsGrid = document.getElementById('metricsGrid');
  const insightList = document.getElementById('insightList');
  const refreshTimeLabel = document.getElementById('refreshTimeLabel');
  const feedModeLabel = document.getElementById('feedModeLabel');
  const overviewReadiness = document.getElementById('overviewReadiness');
  const overviewReadinessMeta = document.getElementById('overviewReadinessMeta');
  const savedViewsList = document.getElementById('savedViewsList');
  if (!metricsGrid || !insightList || !refreshTimeLabel || !feedModeLabel || !overviewReadiness || !overviewReadinessMeta) return;

  metricsGrid.innerHTML = [
    createMetricMarkup('Aircraft', formatNumber(_flightSnapshot.count), _flightSnapshot.feedLabel),
    createMetricMarkup('Countries', formatNumber(_flightSnapshot.countryCount), 'Global reach'),
    createMetricMarkup('Airborne', formatNumber(_flightSnapshot.airborneCount), 'Tracked now'),
    createMetricMarkup('Grounded', formatNumber(_flightSnapshot.groundCount), 'Reported by feed'),
  ].join('');

  const fastestIdentity = _flightSnapshot.fastest
    ? `${formatFlightIdentity(_flightSnapshot.fastest)} · ${formatSpeedKnots(_flightSnapshot.fastest.velocity)}`
    : 'Waiting for live telemetry';
  const highestIdentity = _flightSnapshot.highest
    ? `${formatFlightIdentity(_flightSnapshot.highest)} · ${formatAltitudeFeet(_flightSnapshot.highest.altitude)}`
    : 'Waiting for live telemetry';
  const activeCountry = _flightSnapshot.mostActiveCountry
    ? `${_flightSnapshot.mostActiveCountry.flag || '🌍'} ${_flightSnapshot.mostActiveCountry.country} · ${formatNumber(_flightSnapshot.mostActiveCountry.count)} aircraft`
    : 'No dominant country yet';

  insightList.innerHTML = `
    <div class="insight-card">
      <span class="insight-label">Fastest aircraft</span>
      <strong>${escapeHtml(fastestIdentity)}</strong>
      <span class="insight-meta">Highest observed ground speed in the current tracking scope.</span>
    </div>
    <div class="insight-card">
      <span class="insight-label">Highest aircraft</span>
      <strong>${escapeHtml(highestIdentity)}</strong>
      <span class="insight-meta">Top operational altitude in the active feed window.</span>
    </div>
    <div class="insight-card">
      <span class="insight-label">Most active country</span>
      <strong>${escapeHtml(activeCountry)}</strong>
      <span class="insight-meta">Current density leader across the tracked airspace snapshot.</span>
    </div>
  `;

  feedModeLabel.textContent = _flightSnapshot.feedLabel;
  feedModeLabel.className = `inline-badge ${getFeedTone(_flightSnapshot.feedMode)}`;
  refreshTimeLabel.textContent = formatRelativeTime(_flightSnapshot.lastRefreshTime);
  overviewReadiness.textContent = _tilesReady ? 'Ready' : 'Limited';
  overviewReadinessMeta.textContent = _tilesReady
    ? 'Terrain and imagery loaded; controls are active.'
    : 'Terrain or live services are limited; other features still work.';

  if (savedViewsList) {
    savedViewsList.innerHTML = _bookmarkSnapshot.savedViews.length
      ? _bookmarkSnapshot.savedViews.slice().reverse().map((view) => `
        <div class="saved-view-row">
          <button class="saved-view-btn" type="button" data-view-id="${escapeHtml(view.id)}">
            <strong>${escapeHtml(view.name)}</strong>
            <span>${escapeHtml(formatRelativeTime(view.timestamp))}</span>
          </button>
          <button class="mini-icon-btn" type="button" data-delete-view="${escapeHtml(view.id)}" aria-label="Delete saved view">✕</button>
        </div>
      `).join('')
      : '<div class="panel-empty">Save camera positions here for quick recall.</div>';
  }
}

function renderBookmarksPanel() {
  const bookmarksList = document.getElementById('bookmarksList');
  const annotationsList = document.getElementById('annotationsList');
  if (!bookmarksList || !annotationsList) return;

  bookmarksList.innerHTML = _bookmarkSnapshot.bookmarks.length
    ? _bookmarkSnapshot.bookmarks.slice().reverse().map((bookmark) => `
      <div class="bookmark-row">
        <button class="bookmark-action" type="button" data-bookmark-focus="${escapeHtml(bookmark.id)}">
          <strong>${escapeHtml(bookmark.label)}</strong>
          <span>${escapeHtml(`${bookmark.kind} · ${formatRelativeTime(bookmark.timestamp)}`)}</span>
        </button>
        <button class="mini-icon-btn" type="button" data-bookmark-remove="${escapeHtml(bookmark.id)}" aria-label="Remove bookmark">✕</button>
      </div>
    `).join('')
    : '<div class="panel-empty">Bookmark flights, satellites, webcams, airports, and landmarks from their detail drawers.</div>';

  annotationsList.innerHTML = _bookmarkSnapshot.annotations.length
    ? _bookmarkSnapshot.annotations.slice().reverse().map((annotation) => `
      <div class="bookmark-row">
        <button class="bookmark-action" type="button" data-annotation-focus="${escapeHtml(annotation.id)}">
          <strong>${escapeHtml(annotation.text)}</strong>
          <span>${escapeHtml(`${annotation.lat.toFixed(2)}°, ${annotation.lon.toFixed(2)}°`)}</span>
        </button>
        <button class="mini-icon-btn" type="button" data-annotation-remove="${escapeHtml(annotation.id)}" aria-label="Remove annotation">✕</button>
      </div>
    `).join('')
    : '<div class="panel-empty">Right-click the globe and choose “Add annotation here” to pin context to the map.</div>';
}

function renderZonesPanel() {
  const zonesList = document.getElementById('zonesList');
  const drawButton = document.getElementById('drawZoneButton');
  if (!zonesList) return;

  if (drawButton) {
    drawButton.textContent = _zoneSnapshot.drawActive ? 'Drawing…' : 'Draw zone';
    drawButton.classList.toggle('is-active', _zoneSnapshot.drawActive);
  }

  zonesList.innerHTML = _zoneSnapshot.zones.length
    ? _zoneSnapshot.zones.map((zone) => `
      <div class="zone-row">
        <div class="zone-row-copy">
          <strong>${escapeHtml(zone.name)}</strong>
          <span>${escapeHtml(`${zone.radiusKm} km · ${getZoneOccupancy(zone.id)} inside`)}</span>
        </div>
        <div class="zone-row-actions">
          <button class="mini-toggle-btn ${zone.enabled ? 'is-active' : ''}" type="button" data-zone-toggle="${escapeHtml(zone.id)}">${zone.enabled ? 'On' : 'Off'}</button>
          <button class="mini-icon-btn" type="button" data-zone-edit="${escapeHtml(zone.id)}" aria-label="Edit zone">✎</button>
          <button class="mini-icon-btn" type="button" data-zone-delete="${escapeHtml(zone.id)}" aria-label="Delete zone">✕</button>
        </div>
      </div>
    `).join('')
    : '<div class="panel-empty">Draw up to 10 zones to monitor entry, exit, and dwell alerts.</div>';
}

function hideContextMenu() {
  if (!ui.contextMenu) return;
  ui.contextMenu.classList.add('is-hidden');
  _contextMenuState = null;
}

function showContextMenu(detail) {
  if (!ui.contextMenu || !Number.isFinite(detail?.screenX) || !Number.isFinite(detail?.screenY) || !Number.isFinite(detail?.lat) || !Number.isFinite(detail?.lon)) return;

  _contextMenuState = detail;
  const maxLeft = window.innerWidth - 196;
  const maxTop = window.innerHeight - 96;
  ui.contextMenu.style.left = `${Math.max(8, Math.min(detail.screenX, maxLeft))}px`;
  ui.contextMenu.style.top = `${Math.max(8, Math.min(detail.screenY, maxTop))}px`;
  ui.contextMenu.classList.remove('is-hidden');
}

function renderDock() {
  const headline = document.getElementById('dockHeadline');
  const subline = document.getElementById('dockSubline');
  const badges = document.getElementById('dockBadges');
  if (!headline || !subline || !badges) return;

  headline.textContent = _systemStatus.status;
  subline.textContent = _flightSnapshot.feedMessage || _systemStatus.meta;

  const feedDockBadge =
    _flightSnapshot.feedMode === 'demo'
      ? ''
      : `<span class="dock-badge ${getFeedTone(_flightSnapshot.feedMode)}">${escapeHtml(_flightSnapshot.feedLabel)}</span>`;

  badges.innerHTML = `
    <span class="dock-badge ${_tilesReady ? 'tone-live' : 'tone-warning'}">${_tilesReady ? '3D tiles ready' : '3D tiles degraded'}</span>
    ${feedDockBadge}
    <span class="dock-badge ${_satelliteSnapshot.ready ? 'tone-live' : _satelliteSnapshot.error ? 'tone-warning' : 'tone-neutral'}">${escapeHtml(_satelliteSnapshot.feedLabel || 'Satellites idle')}</span>
    <span class="dock-badge ${_cameraSnapshot.ready ? 'tone-live' : _cameraSnapshot.error ? 'tone-warning' : 'tone-neutral'}">${escapeHtml(_cameraSnapshot.feedLabel || 'Cameras idle')}</span>
    <span class="dock-badge ${_weatherSnapshot.ready ? 'tone-live' : 'tone-neutral'}">${escapeHtml(_weatherSnapshot.statusText || 'Weather idle')}</span>
    <span class="dock-badge tone-neutral">${escapeHtml(`${_bookmarkSnapshot.bookmarks.length} bookmarks`)}</span>
    <span class="dock-badge tone-neutral">${escapeHtml(`${_zoneSnapshot.zones.length} zones`)}</span>
    <span class="dock-badge tone-neutral">${escapeHtml(appConfig.environment)}</span>
    <span class="dock-badge tone-neutral">Press ? for shortcuts</span>
  `;
}

function updateCommandStatus() {
  const commandStatus = document.getElementById('commandStatus');
  const overviewTitle = document.getElementById('overviewTitle');
  const overviewMeta = document.getElementById('overviewMeta');
  if (!commandStatus || !overviewTitle || !overviewMeta) return;

  const tone = _tilesReady ? getFeedTone(_flightSnapshot.feedMode) : 'tone-warning';
  commandStatus.className = `status-pill ${tone}`;
  const statusCopy = commandStatus.querySelector('.status-copy');
  if (statusCopy) statusCopy.textContent = _systemStatus.status;

  overviewTitle.textContent = _systemStatus.title;
  overviewMeta.textContent = _systemStatus.meta;
}

function updateWeatherPanel() {
  const weatherStatusLabel = document.getElementById('weatherStatusLabel');
  const weatherFeedMessage = document.getElementById('weatherFeedMessage');
  const weatherToggle = document.getElementById('toggleWeatherLoop');
  if (!weatherStatusLabel || !weatherFeedMessage || !weatherToggle) return;

  weatherStatusLabel.textContent = _weatherSnapshot.statusText || 'Weather idle';
  weatherFeedMessage.textContent = _weatherSnapshot.ready
    ? 'Radar frames are loaded and ready to layer over the globe when you enable weather.'
    : 'Weather frames are still loading or temporarily unavailable.';
  weatherToggle.textContent = _weatherSnapshot.looping ? 'Pause radar animation' : 'Animate radar';
}

function closeSearchResults() {
  if (!ui.searchResults) return;
  ui.searchResults.classList.add('is-hidden');
  ui.searchResults.innerHTML = '';
}

function focusSearchResult(nextIndex) {
  if (!ui.searchResults) return;
  const items = [...ui.searchResults.querySelectorAll('.search-result')];
  if (!items.length) return;

  items.forEach((item) => item.classList.remove('is-focused'));
  items[Math.max(0, Math.min(nextIndex, items.length - 1))].classList.add('is-focused');
}

function renderSearchResults(query) {
  if (!ui.searchResults) return;
  const normalizedQuery = query.trim();
  if (!normalizedQuery && !_searchSnapshot.filters.length) {
    closeSearchResults();
    renderSearchChips();
    return;
  }

  const results = runSearch(normalizedQuery, getActiveSearchFilters());
  _searchSnapshot = {
    ..._searchSnapshot,
    query: normalizedQuery,
    filters: getActiveSearchFilters(),
    results,
  };

  const groups = new Map();
  results.slice(0, 24).forEach((result) => {
    const label = result.kind === 'saved_view'
      ? 'Saved views'
      : `${result.kind.charAt(0).toUpperCase()}${result.kind.slice(1)}${result.kind.endsWith('s') ? '' : 's'}`;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(result);
  });

  const sections = [...groups.entries()].map(([label, entries]) => `
    <div class="search-group">
      <div class="search-group-title">${escapeHtml(label)}</div>
      ${entries.map((result) => `
        <button class="search-result" data-kind="${escapeHtml(result.kind)}" data-id="${escapeHtml(String(result.id))}" type="button">
          <span class="search-result-icon">${escapeHtml(result.icon)}</span>
          <span class="search-result-copy">
            <strong>${highlightMatch(result.title, normalizedQuery)}</strong>
            <span>${escapeHtml(result.subtitle)} · score ${(result.score * 100).toFixed(0)}%</span>
          </span>
        </button>
      `).join('')}
    </div>
  `);

  ui.searchResults.innerHTML = sections.length
    ? sections.join('')
    : '<div class="search-empty">No flights, airports, landmarks, satellites, cameras, or saved views matched the current query.</div>';
  ui.searchResults.classList.remove('is-hidden');
  const searchCountEl = document.getElementById('searchResultCount');
  if (searchCountEl) searchCountEl.textContent = String(results.length);
  renderSearchChips();
  focusSearchResult(0);
}

function renderSearchChips() {
  const chipRoot = document.getElementById('searchFilterChips');
  const countBadge = document.getElementById('searchResultCount');
  if (!chipRoot || !countBadge) return;

  const filters = getActiveSearchFilters();
  chipRoot.innerHTML = filters.map((filter, index) => `
    <button class="search-filter-chip" type="button" data-filter-index="${index}">
      <span>${escapeHtml(filter.label || `${filter.field}:${filter.value ?? filter.radius ?? ''}`)}</span>
      <span aria-hidden="true">✕</span>
    </button>
  `).join('');
  chipRoot.classList.toggle('is-empty', !filters.length);
  countBadge.textContent = String((_searchSnapshot.results || []).length);
}

function getLayerState() {
  return {
    flights: _flightsOn,
    landmarks: _landmarksOn,
    airports: _airportsOn,
    satellites: _satellitesOn,
    cameras: _camerasOn,
    weather: _weatherOn,
    trajectories: _trajectoriesOn,
    lighting: _lightingOn,
  };
}

function setLayerState(layer, enabled, emitChange = true) {
  if (layer === 'flights') {
    _flightsOn = enabled;
    setFlightsVisible(enabled);
  }

  if (layer === 'landmarks') {
    _landmarksOn = enabled;
    setLandmarksVisible(enabled);
  }

  if (layer === 'airports') {
    _airportsOn = enabled;
    setAirportsVisible(enabled);
  }

  if (layer === 'satellites') {
    _satellitesOn = enabled;
    setSatellitesVisible(enabled);
  }

  if (layer === 'cameras') {
    _camerasOn = enabled;
    setCamerasVisible(enabled);
  }

  if (layer === 'weather') {
    _weatherOn = enabled;
    setWeatherVisible(enabled);
  }

  if (layer === 'trajectories') {
    _trajectoriesOn = enabled;
    setTrajectoriesVisible(enabled);
  }

  if (layer === 'lighting') {
    _lightingOn = enabled;
    _viewer.scene.globe.enableLighting = enabled;
  }

  const buttonMap = {
    flights: 'toggleFlights',
    landmarks: 'toggleLandmarks',
    airports: 'toggleAirports',
    satellites: 'toggleSatellites',
    cameras: 'toggleCameras',
    weather: 'toggleWeather',
    trajectories: 'toggleTrajectories',
    lighting: 'toggleLighting',
  };

  document.getElementById(buttonMap[layer])?.classList.toggle('is-active', enabled);

  if (emitChange) {
    emit('layer:toggle', {
      layer,
      label: layer === 'trajectories' ? 'Trails' : layer.charAt(0).toUpperCase() + layer.slice(1),
      enabled,
    });
  }
}

function applySavedLayerState(activeLayers = []) {
  const nextLayers = new Set(activeLayers);
  Object.keys(getLayerState()).forEach((layer) => {
    setLayerState(layer, nextLayers.has(layer), false);
  });
}

function openDrawer(content) {
  if (!ui.drawer) return;
  ui.drawer.innerHTML = content;
  ui.drawer.classList.add('is-open');
  ui.drawer.querySelector('[data-drawer-close]')?.addEventListener('click', closeSidebar);
  bindDrawerActions();
}

export function closeSidebar() {
  if (!ui.drawer) return;
  ui.drawer.classList.remove('is-open');
  ui.drawer.innerHTML = '';
  setSelectedFlight(null);
  setSelectedSatellite(null);
  setSelectedCamera(null);
  emit('camera:home-view');
}

function buildDrawerFrame({ eyebrow, title, subtitle = '', badge = '', actions = '', body }) {
  return `
    <div class="drawer-header">
      <div>
        <span class="drawer-eyebrow">${escapeHtml(eyebrow)}</span>
        <h3>${escapeHtml(title)}</h3>
        ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}
      </div>
      <div class="drawer-header-actions">
        ${actions}
        ${badge ? `<span class="inline-badge tone-neutral">${escapeHtml(badge)}</span>` : ''}
        <button data-drawer-close class="icon-button" type="button" aria-label="Close details">✕</button>
      </div>
    </div>
    <div class="drawer-body">${body}</div>
  `;
}

function buildBookmarkAction(kind, id, label) {
  return `
    <button
      class="command-chip is-mini"
      type="button"
      data-bookmark-kind="${escapeHtml(kind)}"
      data-bookmark-id="${escapeHtml(String(id))}"
      data-bookmark-label="${escapeHtml(label)}"
    >☆ Save</button>
  `;
}

function buildIntelMarkup(kind, id) {
  const context = buildFusionContext(kind, id)
  if (!context.subject) {
    return '<div class="intel-empty">Fusion context is still warming up for this subject.</div>'
  }

  const subject = context.subject.data
  const subjectLat = subject.lat ?? subject.geometry?.coordinates?.[1]
  const subjectLon = subject.lon ?? subject.geometry?.coordinates?.[0]
  const hasCoordinates = Number.isFinite(subjectLat) && Number.isFinite(subjectLon)
  const proximityLabel = hasCoordinates ? `near:${subjectLat.toFixed(2)},${subjectLon.toFixed(2)},500km` : null

  return `
    <div class="intel-grid">
      ${createRowMarkup('Nearby flights', proximityLabel
        ? `<button class="intel-link" type="button" data-intel-search-lat="${escapeHtml(String(subjectLat))}" data-intel-search-lon="${escapeHtml(String(subjectLon))}" data-intel-radius="500">${escapeHtml(String(context.nearbyFlights.length))}</button>`
        : escapeHtml(String(context.nearbyFlights.length)))}
      ${createRowMarkup('Nearby satellites', escapeHtml(String(context.nearbySatellites.length)))}
      ${createRowMarkup('Nearby webcams', escapeHtml(String(context.nearbyCameras.length)))}
      ${createRowMarkup('Density cell', escapeHtml(`${context.densityCell?.level || 'Sparse'} · ${context.densityCell?.total || 0} total`))}
      ${createRowMarkup('Active zones', escapeHtml(context.activeZones.length ? context.activeZones.map((zone) => zone.name).join(', ') : '—'))}
      ${createRowMarkup('Alert flags', escapeHtml(context.alertFlags.length ? context.alertFlags.join(' · ') : '—'))}
    </div>
    <button class="feature-button intel-fusion-btn" type="button" ${hasCoordinates ? `data-intel-fusion-lat="${escapeHtml(String(subjectLat))}" data-intel-fusion-lon="${escapeHtml(String(subjectLon))}"` : 'disabled'}>
      View in fusion query
    </button>
  `
}

function bindDrawerActions() {
  if (!ui.drawer) return

  ui.drawer.querySelector('[data-bookmark-kind]')?.addEventListener('click', (event) => {
    const button = event.currentTarget
    addBookmark(button.dataset.bookmarkKind, button.dataset.bookmarkId, button.dataset.bookmarkLabel)
    showToast({
      tone: 'neutral',
      title: 'Bookmark saved',
      message: `${button.dataset.bookmarkLabel} was added to your saved references.`,
    })
  })

  ui.drawer.querySelector('[data-intel-search-lat]')?.addEventListener('click', (event) => {
    const button = event.currentTarget
    addSearchFilter({
      field: 'proximity',
      lat: Number(button.dataset.intelSearchLat),
      lon: Number(button.dataset.intelSearchLon),
      radius: Number(button.dataset.intelRadius || 500),
      label: `near:${Number(button.dataset.intelSearchLat).toFixed(2)},${Number(button.dataset.intelSearchLon).toFixed(2)},${button.dataset.intelRadius || 500}km`,
    })
    showHudModal('analyticsModalShell')
    if (ui.searchInput) {
      ui.searchInput.value = ''
      ui.searchInput.focus()
    }
    renderSearchChips()
  })

  ui.drawer.querySelector('[data-intel-fusion-lat]')?.addEventListener('click', (event) => {
    const button = event.currentTarget
    const lat = Number(button.dataset.intelFusionLat)
    const lon = Number(button.dataset.intelFusionLon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return
    showHudModal('analyticsModalShell')
    emit('fusion:query-area', {
      lat,
      lon,
      radiusKm: 500,
    })
  })
}

export function openFlightSidebar(aircraft) {
  const identity = formatFlightIdentity(aircraft);
  const selectionKey = `flight:${aircraft.icao24}`;
  ui.drawer.dataset.selection = selectionKey;

  const body = `
    <section class="drawer-section">
      <div class="drawer-metric-grid">
        ${createMetricMarkup('Altitude', formatAltitudeFeet(aircraft.altitude), 'Barometric')}
        ${createMetricMarkup('Speed', formatSpeedKnots(aircraft.velocity), 'Ground speed')}
        ${createMetricMarkup('Heading', formatHeading(aircraft.heading), 'True track')}
        ${createMetricMarkup('Vertical', formatVerticalRate(aircraft.verticalRate), 'Climb profile')}
      </div>
    </section>
    <section class="drawer-section">
      <div class="section-heading">
        <span>Flight telemetry</span>
        <span>${escapeHtml(_flightSnapshot.feedLabel)}</span>
      </div>
      ${createRowMarkup('ICAO24', `<span class="mono-value">${escapeHtml(aircraft.icao24)}</span>`, true)}
      ${createRowMarkup('Country', escapeHtml(aircraft.country || 'Unknown'))}
      ${createRowMarkup('Coordinates', `<span class="mono-value">${escapeHtml(formatCoordinates(aircraft.lat, aircraft.lon))}</span>`)}
      ${createRowMarkup('Updated', escapeHtml(formatRelativeTime(_flightSnapshot.lastRefreshTime)))}
    </section>
    <section class="drawer-section">
      <div class="section-heading">
        <span>Operational context</span>
        <span>Enrichment</span>
      </div>
      <div id="flightEnrichmentPanel" class="enrichment-state">Loading optional route and aircraft details…</div>
    </section>
    <section class="drawer-section">
      <div class="section-heading">
        <span>Intel</span>
        <span>Cross-layer</span>
      </div>
      ${buildIntelMarkup('flight', aircraft.icao24)}
    </section>
  `;

  openDrawer(buildDrawerFrame({
    eyebrow: 'Aircraft detail',
    title: identity,
    subtitle: _flightSnapshot.usingDemoData
      ? 'This aircraft is part of the demo traffic set.'
      : 'Live positional telemetry from the active flight feed.',
    badge: _flightSnapshot.feedLabel,
    actions: buildBookmarkAction('flight', aircraft.icao24, identity),
    body,
  }));

  enrichFlightData(aircraft.icao24, aircraft.callsign).then((details) => {
    if (ui.drawer.dataset.selection !== selectionKey) return;
    const enrichmentPanel = document.getElementById('flightEnrichmentPanel');
    if (!enrichmentPanel) return;

    if (details.availability === 'unconfigured') {
      enrichmentPanel.textContent = 'Route enrichment is not configured for this deployment.';
      return;
    }

    if (details.availability === 'unavailable') {
      enrichmentPanel.textContent = 'Route enrichment is temporarily unavailable.';
      return;
    }

    const formatAirport = (airport) => airport
      ? `${airport.iata_code || airport.icao_code || '—'} · ${airport.municipality || airport.name || 'Unknown'}`
      : '—';

    enrichmentPanel.innerHTML = `
      ${createRowMarkup('Airline', escapeHtml(details.airline || details.operator || '—'))}
      ${createRowMarkup('Aircraft', escapeHtml(details.type || '—'))}
      ${createRowMarkup('Registration', `<span class="mono-value">${escapeHtml(details.registration || '—')}</span>`)}
      ${createRowMarkup('Origin', escapeHtml(formatAirport(details.origin)))}
      ${createRowMarkup('Destination', escapeHtml(formatAirport(details.destination)))}
    `;
  });
}

export function openLandmarkSidebar(landmark) {
  openDrawer(buildDrawerFrame({
    eyebrow: 'Landmark',
    title: landmark.name,
    subtitle: `${landmark.country} · curated world landmark`,
    badge: 'Point of interest',
    actions: buildBookmarkAction('landmark', landmark.name, landmark.name),
    body: `
      <section class="drawer-section">
        <div class="drawer-metric-grid">
          ${createMetricMarkup('Country', landmark.country)}
          ${createMetricMarkup('Coordinates', formatCoordinates(landmark.lat, landmark.lon), 'WGS84')}
        </div>
      </section>
      <section class="drawer-section">
        <div class="section-heading">
          <span>Description</span>
          <span>${escapeHtml(landmark.emoji)}</span>
        </div>
        <p class="drawer-paragraph">${escapeHtml(landmark.description)}</p>
      </section>
      <section class="drawer-section">
        <div class="section-heading">
          <span>Intel</span>
          <span>Cross-layer</span>
        </div>
        ${buildIntelMarkup('landmark', landmark.name)}
      </section>
    `,
  }));
}

export function openAirportSidebar(airport) {
  openDrawer(buildDrawerFrame({
    eyebrow: 'Airport',
    title: `${airport.iata} · ${airport.name}`,
    subtitle: airport.country,
    badge: airport.hub ? 'Hub airport' : 'Regional airport',
    actions: buildBookmarkAction('airport', airport.iata, `${airport.iata} · ${airport.name}`),
    body: `
      <section class="drawer-section">
        <div class="drawer-metric-grid">
          ${createMetricMarkup('ICAO', airport.icao)}
          ${createMetricMarkup('Elevation', formatAltitudeFeet(airport.elev), 'Above sea level')}
          ${createMetricMarkup('Passengers', `${airport.pax}M`, 'Annual volume')}
          ${createMetricMarkup('Timezone', airport.tz)}
        </div>
      </section>
      <section class="drawer-section">
        <div class="section-heading">
          <span>Airport detail</span>
          <span>${airport.hub ? 'International hub' : 'Regional gateway'}</span>
        </div>
        ${createRowMarkup('Country', escapeHtml(airport.country))}
        ${createRowMarkup('Coordinates', `<span class="mono-value">${escapeHtml(formatCoordinates(airport.lat, airport.lon))}</span>`)}
        ${createRowMarkup('Identifiers', `<span class="mono-value">${escapeHtml(`${airport.iata} / ${airport.icao}`)}</span>`)}
      </section>
      <section class="drawer-section">
        <div class="section-heading">
          <span>Intel</span>
          <span>Cross-layer</span>
        </div>
        ${buildIntelMarkup('airport', airport.iata)}
      </section>
    `,
  }));
}

export function openSatelliteSidebar(satellite) {
  const selectionKey = `satellite:${satellite.id}`;
  ui.drawer.dataset.selection = selectionKey;
  setSelectedSatellite(satellite.id);

  const body = `
    <section class="drawer-section">
      <div class="drawer-metric-grid">
        ${createMetricMarkup('NORAD', String(satellite.id), 'Catalog')}
        ${createMetricMarkup('Altitude', `${formatNumber(Math.round(satellite.altitudeKm))} km`, 'Orbital height')}
        ${createMetricMarkup('Category', satellite.category || 'ANY', 'N2YO')}
        ${createMetricMarkup('Launch', satellite.launchDate || '—', 'UTC date')}
      </div>
    </section>
    <section class="drawer-section">
      <div class="section-heading">
        <span>Satellite detail</span>
        <span>N2YO</span>
      </div>
      ${createRowMarkup('Designator', `<span class="mono-value">${escapeHtml(satellite.designator || '—')}</span>`, true)}
      ${createRowMarkup('Footprint', `<span class="mono-value">${escapeHtml(formatCoordinates(satellite.lat, satellite.lon))}</span>`)}
      ${createRowMarkup('Observer', escapeHtml(_satelliteSnapshot.observerLabel || 'Unknown observer'))}
      ${createRowMarkup('Updated', escapeHtml(formatRelativeTime(_satelliteSnapshot.lastRefreshTime)))}
    </section>
    <section class="drawer-section">
      <div class="section-heading">
        <span>Observer track</span>
        <span>120s look-ahead</span>
      </div>
      <div id="satelliteEnrichmentPanel" class="enrichment-state">Loading observer-relative track and look angles…</div>
    </section>
    <section class="drawer-section">
      <div class="section-heading">
        <span>Intel</span>
        <span>Cross-layer</span>
      </div>
      ${buildIntelMarkup('satellite', satellite.id)}
    </section>
  `;

  openDrawer(buildDrawerFrame({
    eyebrow: 'Satellite',
    title: satellite.name,
    subtitle: 'N2YO overhead object tracking relative to the active observer.',
    badge: `${satellite.category || 'ANY'} · NORAD ${satellite.id}`,
    actions: buildBookmarkAction('satellite', satellite.id, satellite.name),
    body,
  }));

  enrichSatellite(satellite.id).then((details) => {
    if (ui.drawer.dataset.selection !== selectionKey) return;
    const enrichmentPanel = document.getElementById('satelliteEnrichmentPanel');
    if (!enrichmentPanel) return;

    if (details.availability === 'unconfigured') {
      enrichmentPanel.textContent = 'Satellite track enrichment is not configured for this deployment.';
      return;
    }

    if (details.availability === 'unavailable') {
      enrichmentPanel.textContent = details.message || 'Satellite track enrichment is temporarily unavailable.';
      return;
    }

    const current = details.current;
    enrichmentPanel.innerHTML = `
      ${createRowMarkup('Azimuth', escapeHtml(current ? `${current.azimuth?.toFixed?.(1) ?? '—'}°` : '—'))}
      ${createRowMarkup('Elevation', escapeHtml(current ? `${current.elevation?.toFixed?.(1) ?? '—'}°` : '—'))}
      ${createRowMarkup('Right ascension', escapeHtml(current ? `${current.ra?.toFixed?.(1) ?? '—'}°` : '—'))}
      ${createRowMarkup('Declination', escapeHtml(current ? `${current.dec?.toFixed?.(1) ?? '—'}°` : '—'))}
      ${createRowMarkup('Track points', escapeHtml(String(details.positions?.length || 0)))}
      ${createRowMarkup('Observer source', escapeHtml(details.observer?.label || _satelliteSnapshot.observerLabel || 'Unknown'))}
    `;
  });
}

export function openCameraSidebar(camera) {
  const selectionKey = `camera:${camera.id}`;
  ui.drawer.dataset.selection = selectionKey;
  setSelectedCamera(camera.id);

  const coords = camera.geometry?.coordinates || [0, 0];

  const body = `
    <section class="drawer-section">
      <div class="drawer-metric-grid">
        ${createMetricMarkup('City', escapeHtml(camera.city || 'Unknown'), 'Location')}
        ${createMetricMarkup('Country', escapeHtml(camera.country || 'Unknown'), 'Region')}
        ${createMetricMarkup('Views', camera.viewCount ? Number(camera.viewCount).toLocaleString() : '—', 'All time')}
        ${createMetricMarkup('Status', escapeHtml(camera.status || 'active'), 'Feed')}
      </div>
    </section>
    <section class="drawer-section">
      <div class="section-heading">
        <span>Webcam detail</span>
        <span>Windy</span>
      </div>
      ${createRowMarkup('Location', escapeHtml([camera.city, camera.state, camera.country].filter(Boolean).join(', ') || 'Unknown'))}
      ${createRowMarkup('Categories', escapeHtml(camera.categories || '—'))}
      ${createRowMarkup('Coordinates', `<span class="mono-value">${escapeHtml(formatCoordinates(coords[1], coords[0]))}</span>`)}
      ${createRowMarkup('Webcam ID', `<span class="mono-value">${escapeHtml(camera.id)}</span>`)}
    </section>
    <section class="drawer-section">
      <div class="section-heading">
        <span>Live player</span>
        <span>Windy Webcams</span>
      </div>
      <div id="cameraEnrichmentPanel" class="enrichment-state">Loading player…</div>
    </section>
    <section class="drawer-section">
      <div class="section-heading">
        <span>Intel</span>
        <span>Cross-layer</span>
      </div>
      ${buildIntelMarkup('camera', camera.id)}
    </section>
  `;

  openDrawer(buildDrawerFrame({
    eyebrow: 'Webcam',
    title: camera.title || camera.city || camera.id,
    subtitle: [camera.state, camera.country].filter(Boolean).join(', ') || 'Windy Webcams network',
    badge: 'Live · Windy',
    actions: buildBookmarkAction('camera', camera.id, camera.title || camera.city || camera.id),
    body,
  }));

  enrichCamera(camera.id).then((details) => {
    if (ui.drawer.dataset.selection !== selectionKey) return;
    const enrichmentPanel = document.getElementById('cameraEnrichmentPanel');
    if (!enrichmentPanel) return;

    if (details.availability === 'unconfigured') {
      enrichmentPanel.textContent = 'No live player available for this webcam.';
      return;
    }

    if (details.availability === 'unavailable') {
      enrichmentPanel.textContent = 'Live player temporarily unavailable.';
      return;
    }

    // Windy player URLs are public — embed directly as an iframe, no auth needed.
    enrichmentPanel.innerHTML = `
      <iframe
        src="${escapeHtml(details.playerUrl)}"
        style="width:100%;aspect-ratio:16/9;border:none;border-radius:6px;display:block;"
        allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
        allowfullscreen
        loading="lazy"
        referrerpolicy="strict-origin-when-cross-origin"
        title="${escapeHtml(camera.title || 'Webcam live view')}"
      ></iframe>
      <p style="margin-top:6px;font-size:11px;opacity:0.55;text-align:center;">Powered by Windy Webcams</p>
    `;
  });
}

function handleSearchSelection(kind, id) {
  if (kind === 'saved_view') {
    loadView(id);
  } else {
    emit('entity:focus', {
      kind,
      id,
    });
  }

  if (ui.searchInput) ui.searchInput.value = '';
  document.getElementById('searchClear')?.classList.add('is-hidden');
  closeSearchResults();
}

function bindSearch() {
  const searchClear = document.getElementById('searchClear');
  const chipRoot = document.getElementById('searchFilterChips');
  if (!ui.searchInput || !ui.searchResults || !searchClear || !chipRoot) return;

  ui.searchInput.addEventListener('input', () => {
    const query = ui.searchInput.value.trim();
    searchClear.classList.toggle('is-hidden', !query);
    renderSearchResults(query);
  });

  searchClear.addEventListener('click', () => {
    ui.searchInput.value = '';
    searchClear.classList.add('is-hidden');
    runSearch('', getActiveSearchFilters());
    _searchSnapshot = {
      ..._searchSnapshot,
      query: '',
      filters: getActiveSearchFilters(),
      results: getSearchResults(),
    };
    renderSearchChips();
    closeSearchResults();
    ui.searchInput.focus();
  });

  chipRoot.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-filter-index]');
    if (!chip) return;
    removeSearchFilter(Number(chip.dataset.filterIndex));
    _searchSnapshot = {
      ..._searchSnapshot,
      filters: getActiveSearchFilters(),
      results: getSearchResults(),
    };
    renderSearchResults(ui.searchInput.value.trim());
  });

  ui.searchResults.addEventListener('click', (event) => {
    const result = event.target.closest('.search-result');
    if (!result) return;
    handleSearchSelection(result.dataset.kind, result.dataset.id);
  });

  ui.searchInput.addEventListener('keydown', (event) => {
    const items = [...ui.searchResults.querySelectorAll('.search-result')];
    const activeIndex = items.findIndex((item) => item.classList.contains('is-focused'));

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusSearchResult(activeIndex + 1);
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusSearchResult(activeIndex <= 0 ? items.length - 1 : activeIndex - 1);
    }

    if (event.key === 'Enter' && activeIndex >= 0) {
      items[activeIndex].click();
    }

    if (event.key === 'Enter' && activeIndex < 0) {
      const parsed = parseQuery(ui.searchInput.value.trim());
      if (parsed) {
        addSearchFilter(parsed);
        ui.searchInput.value = '';
        searchClear.classList.add('is-hidden');
        _searchSnapshot = {
          ..._searchSnapshot,
          filters: getActiveSearchFilters(),
          results: getSearchResults(),
        };
        renderSearchChips();
        closeSearchResults();
      }
    }

    if (event.key === 'Escape') {
      closeSearchResults();
      ui.searchInput.blur();
    }
  });

  _docSearchDismiss = (event) => {
    const searchShell = event.target.closest('.search-shell');
    const searchPanel = event.target.closest('.search-panel');
    if (!searchShell && !searchPanel) {
      closeSearchResults();
    }
  };
  document.addEventListener('click', _docSearchDismiss);

  renderSearchChips();
}

function bindControls() {
  const toggleMap = [
    ['toggleFlights', 'flights'],
    ['toggleLandmarks', 'landmarks'],
    ['toggleAirports', 'airports'],
    ['toggleSatellites', 'satellites'],
    ['toggleCameras', 'cameras'],
    ['toggleWeather', 'weather'],
    ['toggleTrajectories', 'trajectories'],
    ['toggleLighting', 'lighting'],
  ];

  for (const [id, layer] of toggleMap) {
    const button = document.getElementById(id);
    if (!button) continue;
    button.addEventListener('click', () => {
      setLayerState(layer, !getLayerState()[layer]);
    });
  }

  document.getElementById('toggleWeatherLoop')?.addEventListener('click', () => {
    toggleWeatherLoop();
    _weatherSnapshot = getWeatherState();
    updateWeatherPanel();
    renderDock();
  });

  const altitudeMin = document.getElementById('altitudeMin');
  const altitudeMax = document.getElementById('altitudeMax');
  const altitudeLabel = document.getElementById('altitudeLabel');
  if (altitudeMin && altitudeMax && altitudeLabel) {
    const updateAltitude = (source) => {
      let min = Number(altitudeMin.value);
      let max = Number(altitudeMax.value);

      if (min > max) {
        if (source === altitudeMin) {
          min = max;
          altitudeMin.value = String(min);
        } else {
          max = min;
          altitudeMax.value = String(max);
        }
      }

      altitudeLabel.textContent = `${formatAltitudeFeet(min)} - ${formatAltitudeFeet(max)}`;
      setAltitudeRange(min, max);
    };

    altitudeMin.addEventListener('input', () => updateAltitude(altitudeMin));
    altitudeMax.addEventListener('input', () => updateAltitude(altitudeMax));
  }

  for (const button of document.querySelectorAll('.quick-view-btn')) {
    button.addEventListener('click', () => {
      if (button.dataset.view === 'global') {
        emit('camera:global-view');
        return;
      }

      const lon = Number(button.dataset.lon);
      const lat = Number(button.dataset.lat);
      const alt = Number(button.dataset.alt);

      _viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(lon, lat, alt),
        orientation: {
          heading: 0,
          pitch: Cesium.Math.toRadians(-90),
          roll: 0,
        },
        duration: 1.8,
      });
    });
  }

  document.getElementById('overviewToggle')?.addEventListener('click', () => {
    _overviewCollapsed = !_overviewCollapsed;
    writeStorage('skyview-overview-collapsed', String(_overviewCollapsed));
    applyOverviewRailState();
  });

  const saveCurrentView = () => {
    const name = window.prompt('Saved view name', `View ${_bookmarkSnapshot.savedViews.length + 1}`);
    if (!name) return;
    saveView(name);
  };

  document.getElementById('saveViewButton')?.addEventListener('click', saveCurrentView);
  document.getElementById('saveViewInline')?.addEventListener('click', saveCurrentView);
  document.getElementById('drawZoneButton')?.addEventListener('click', () => {
    showHudModal('zonesModalShell');
    startZoneDraw();
  });

  bindMainSidebarChrome();
  bindHudModalDismiss();
  applyMainSidebarOpenState();
}

function bindShortcuts() {
  if (!ui.shortcutsModal || !ui.searchInput) return;
  const toggleShortcutModal = () => {
    const hidden = ui.shortcutsModal.classList.toggle('is-hidden');
    document.getElementById('helpButton')?.setAttribute('aria-expanded', String(!hidden));
  };

  document.getElementById('helpButton')?.addEventListener('click', toggleShortcutModal);
  document.getElementById('closeShortcuts')?.addEventListener('click', toggleShortcutModal);
  ui.shortcutsModal.addEventListener('click', (event) => {
    if (event.target === ui.shortcutsModal) {
      ui.shortcutsModal.classList.add('is-hidden');
      document.getElementById('helpButton')?.setAttribute('aria-expanded', 'false');
    }
  });

  _docShortcutKeydown = (event) => {
    const isTyping = ['INPUT', 'TEXTAREA'].includes(event.target.tagName);
    if (isTyping && event.key !== 'Escape') return;

    switch (event.key.toLowerCase()) {
      case '/':
        event.preventDefault();
        ui.searchInput.focus();
        break;
      case 'f':
        document.getElementById('toggleFlights')?.click();
        break;
      case 'l':
        document.getElementById('toggleLandmarks')?.click();
        break;
      case 'p':
        document.getElementById('toggleAirports')?.click();
        break;
      case 'o':
        document.getElementById('toggleSatellites')?.click();
        break;
      case 'c':
        document.getElementById('toggleCameras')?.click();
        break;
      case 'r':
        document.getElementById('toggleWeather')?.click();
        break;
      case 't':
        document.getElementById('toggleTrajectories')?.click();
        break;
      case 'i':
        toggleHudModal('analyticsModalShell');
        break;
      case 'e':
        toggleHudModal('timelineModalShell');
        break;
      case 'b':
        toggleHudModal('bookmarksModalShell');
        break;
      case 'z':
        toggleHudModal('zonesModalShell');
        break;
      case 'v': {
        const name = window.prompt('Saved view name', `View ${_bookmarkSnapshot.savedViews.length + 1}`);
        if (name) saveView(name);
        break;
      }
      case '?':
        toggleShortcutModal();
        break;
      case ' ':
        event.preventDefault();
        emit('ui:toggle-spin');
        break;
      case 'escape':
        closeAllHudModals();
        closeSearchResults();
        hideContextMenu();
        ui.shortcutsModal.classList.add('is-hidden');
        document.getElementById('helpButton')?.setAttribute('aria-expanded', 'false');
        ui.searchInput.blur();
        if (window.matchMedia('(max-width: 900px)').matches) {
          _mainSidebarOpen = false;
          applyMainSidebarOpenState();
        }
        closeSidebar();
        break;
    }
  };
  document.addEventListener('keydown', _docShortcutKeydown);
}

function bindPanels() {
  document.getElementById('savedViewsList')?.addEventListener('click', (event) => {
    const loadButton = event.target.closest('[data-view-id]');
    if (loadButton) {
      loadView(loadButton.dataset.viewId);
      return;
    }

    const deleteButton = event.target.closest('[data-delete-view]');
    if (deleteButton) {
      deleteSavedView(deleteButton.dataset.deleteView);
    }
  });

  document.getElementById('bookmarksList')?.addEventListener('click', (event) => {
    const focusButton = event.target.closest('[data-bookmark-focus]');
    if (focusButton) {
      const bookmark = _bookmarkSnapshot.bookmarks.find((entry) => entry.id === focusButton.dataset.bookmarkFocus);
      if (bookmark) {
        emit('entity:focus', {
          kind: bookmark.kind,
          id: bookmark.entityId,
        });
      }
      return;
    }

    const removeButton = event.target.closest('[data-bookmark-remove]');
    if (removeButton) {
      removeBookmark(removeButton.dataset.bookmarkRemove);
    }
  });

  document.getElementById('annotationsList')?.addEventListener('click', (event) => {
    const focusButton = event.target.closest('[data-annotation-focus]');
    if (focusButton) {
      flyToAnnotation(focusButton.dataset.annotationFocus);
      return;
    }

    const removeButton = event.target.closest('[data-annotation-remove]');
    if (removeButton) {
      removeAnnotation(removeButton.dataset.annotationRemove);
    }
  });

  document.getElementById('zonesList')?.addEventListener('click', (event) => {
    const toggleButton = event.target.closest('[data-zone-toggle]');
    if (toggleButton) {
      toggleZone(toggleButton.dataset.zoneToggle);
      return;
    }

    const deleteButton = event.target.closest('[data-zone-delete]');
    if (deleteButton) {
      deleteZone(deleteButton.dataset.zoneDelete);
      return;
    }

    const editButton = event.target.closest('[data-zone-edit]');
    if (editButton) {
      const zone = _zoneSnapshot.zones.find((entry) => entry.id === editButton.dataset.zoneEdit);
      if (!zone) return;
      const name = window.prompt('Zone name', zone.name);
      if (!name) return;
      updateZone(zone.id, { name: name.trim() || zone.name });
    }
  });

  ui.contextMenu?.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action || !_contextMenuState) return;

    if (action === 'query-area') {
      showHudModal('analyticsModalShell');
      emit('fusion:query-area', {
        lat: _contextMenuState.lat,
        lon: _contextMenuState.lon,
        radiusKm: 500,
      });
    }

    if (action === 'add-annotation') {
      const text = window.prompt('Annotation text', '');
      if (text) {
        addAnnotation(_contextMenuState.lat, _contextMenuState.lon, text, '#6ce7ff');
      }
    }

    hideContextMenu();
  });

  _docContextMenuDismiss = (event) => {
    if (!event.target.closest('.map-context-menu')) {
      hideContextMenu();
    }
  };
  document.addEventListener('click', _docContextMenuDismiss);
}

function buildMinimap() {
  if (!appConfig.enableMinimap) return;
  if (!document.getElementById('minimapCanvas')) return;

  _minimap = L.map('minimapCanvas', {
    zoomControl: false,
    attributionControl: false,
    dragging: true,
    doubleClickZoom: false,
    scrollWheelZoom: false,
  }).setView([0, 0], 2);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 8,
    subdomains: 'abcd',
  }).addTo(_minimap);

  _minimapBounds = L.rectangle([[0, 0], [1, 1]], {
    color: '#6ce7ff',
    weight: 1,
    fillColor: '#6ce7ff',
    fillOpacity: 0.08,
    interactive: false,
  }).addTo(_minimap);

  _minimap.on('click', (event) => {
    const { lat, lng } = event.latlng;
    const altitude = _viewer.camera.positionCartographic?.height ?? 10_000_000;
    _viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lng, lat, altitude),
      duration: 1.2,
    });
  });
}

function syncMinimap() {
  if (!_minimap || !_viewer) return;

  try {
    const cartographic = _viewer.camera.positionCartographic;
    const lon = Cesium.Math.toDegrees(cartographic.longitude);
    const lat = Cesium.Math.toDegrees(cartographic.latitude);
    const zoom = Math.max(1, Math.min(8, Math.round(13 - Math.log2(cartographic.height / 1000))));

    _minimap.setView([lat, lon], zoom, { animate: false });

    const widthDegrees = (cartographic.height * 0.7) / 111_320;
    _minimapBounds.setBounds([
      [lat - widthDegrees, lon - widthDegrees],
      [lat + widthDegrees, lon + widthDegrees],
    ]);
  } catch {}
}

function updateMinimapMarkers() {
  if (!_minimap) return;

  for (const marker of _minimapMarkers) {
    marker.remove();
  }
  _minimapMarkers = [];

  let rendered = 0;
  for (const aircraft of getAircraftMap().values()) {
    if (rendered >= 300) break;

    const marker = L.circleMarker([aircraft.lat, aircraft.lon], {
      radius: 2,
      color: aircraft.altitude < 3_000 ? '#00ff88' : aircraft.altitude < 8_000 ? '#ffcc00' : aircraft.altitude < 12_000 ? '#ff6600' : '#cc00ff',
      fillColor: aircraft.altitude < 3_000 ? '#00ff88' : aircraft.altitude < 8_000 ? '#ffcc00' : aircraft.altitude < 12_000 ? '#ff6600' : '#cc00ff',
      fillOpacity: 0.95,
      weight: 0,
      interactive: false,
    }).addTo(_minimap);

    _minimapMarkers.push(marker);
    rendered += 1;
  }
}

function registerEvents() {
  on('app:status', (detail) => {
    _systemStatus = detail;
    updateCommandStatus();
    renderDock();
  });

  on('app:tiles', (detail) => {
    _tilesReady = Boolean(detail.ready);
    renderOverview();
    updateCommandStatus();
    renderDock();
  });

  on('ui:toast', showToast);

  on('map:right-click', (detail) => {
    if (_zoneSnapshot.drawActive) return;
    showContextMenu(detail);
  });

  on('view:load-layers', ({ activeLayers }) => {
    applySavedLayerState(activeLayers);
  });

  on('alert:zone', () => {
    renderDock();
  });

  on('alert:threshold', () => {
    renderDock();
  });

  on('weather:update', (detail) => {
    _weatherSnapshot = detail;
    updateWeatherPanel();
    renderDock();
  });

  on('app:spin', ({ enabled }) => {
    showToast({
      tone: 'neutral',
      title: 'Idle spin',
      message: enabled ? 'Idle globe rotation will resume after a short pause.' : 'Idle globe rotation is paused.',
    });
  });

  _unsubscribeFlights = subscribeFlights((snapshot) => {
    _flightSnapshot = snapshot;
    renderOverview();
    renderDock();
    updateMinimapMarkers();
  });

  _unsubscribeSatellites = subscribeSatellites((snapshot) => {
    _satelliteSnapshot = snapshot;
    renderDock();
  });

  _unsubscribeCameras = subscribeCameras((snapshot) => {
    _cameraSnapshot = snapshot;
    renderDock();
  });

  _unsubscribeSearch = subscribeSearch((snapshot) => {
    _searchSnapshot = snapshot;
    renderSearchChips();
  });

  _unsubscribeBookmarks = subscribeBookmarks((snapshot) => {
    _bookmarkSnapshot = snapshot;
    renderOverview();
    renderBookmarksPanel();
    renderDock();
  });

  _unsubscribeZones = subscribeZones((snapshot) => {
    _zoneSnapshot = snapshot;
    renderZonesPanel();
    renderDock();
  });
}

export function initUI(viewer) {
  _viewer = viewer;
  _weatherSnapshot = getWeatherState();
  _flightSnapshot = getFlightSnapshot();
  _satelliteSnapshot = getSatelliteSnapshot();
  _cameraSnapshot = getCameraSnapshot();
  _overviewCollapsed = readStorage('skyview-overview-collapsed', 'true') !== 'false';

  if (_relativeTimeTimer) {
    clearInterval(_relativeTimeTimer);
    _relativeTimeTimer = null;
  }

  if (_minimapTimer) {
    clearInterval(_minimapTimer);
    _minimapTimer = null;
  }

  _unsubscribeFlights?.();
  _unsubscribeFlights = null;
  _unsubscribeSatellites?.();
  _unsubscribeSatellites = null;
  _unsubscribeCameras?.();
  _unsubscribeCameras = null;
  _unsubscribeSearch?.();
  _unsubscribeSearch = null;
  _unsubscribeBookmarks?.();
  _unsubscribeBookmarks = null;
  _unsubscribeZones?.();
  _unsubscribeZones = null;

  if (_minimap) {
    _minimap.remove();
    _minimap = null;
    _minimapBounds = null;
    _minimapMarkers = [];
  }

  teardownUiDocumentListeners();

  buildShell();
  applyOverviewRailState();
  bindSearch();
  bindControls();
  bindShortcuts();
  bindPanels();
  buildMinimap();
  registerEvents();
  initPanelManager();

  renderOverview();
  renderBookmarksPanel();
  renderZonesPanel();
  updateCommandStatus();
  updateWeatherPanel();
  renderDock();
  syncMinimap();

  if (_viewer?.camera?.changed) {
    _cameraMinimapSync = syncMinimap;
    _viewer.camera.changed.addEventListener(_cameraMinimapSync);
  }

  _relativeTimeTimer = setInterval(() => {
    renderOverview();
    renderDock();
  }, 1_000);

  if (_minimap) {
    _minimapTimer = setInterval(updateMinimapMarkers, 4_000);
  }
}

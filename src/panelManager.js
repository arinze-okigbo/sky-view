/**
 * panelManager.js
 * Drag-to-reposition and hide/show for all HUD panels.
 * Positions and visibility are persisted to localStorage.
 */

const STORAGE_PREFIX = 'sv-hud-';

const MANAGED_PANELS = [
  { id: 'commandBar',   label: 'Command Bar' },
  { id: 'mainSidebar',  label: 'Main sidebar' },
  { id: 'detailDrawer', label: 'Detail drawer' },
  { id: 'minimapShell', label: 'Minimap'     },
];

/** Cleared when the panel FAB menu is rebuilt so outside-click handlers do not accumulate. */
let _panelMenuOutsideClick = null;

// ─── Storage ──────────────────────────────────────────────────────────────

function loadState(id) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + id);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveState(id, patch) {
  try {
    const prev = loadState(id) || {};
    localStorage.setItem(STORAGE_PREFIX + id, JSON.stringify({ ...prev, ...patch }));
  } catch {}
}

function clearState(id) {
  try { localStorage.removeItem(STORAGE_PREFIX + id); } catch {}
}

// ─── Position helpers ──────────────────────────────────────────────────────

/** Lock the element to explicit top/left so it can be freely repositioned. */
function pinToPosition(el, left, top) {
  el.style.left      = `${Math.round(left)}px`;
  el.style.top       = `${Math.round(top)}px`;
  el.style.right     = 'auto';
  el.style.bottom    = 'auto';
  el.style.transform = 'none';
  el.dataset.dragged = '1';
}

function restorePosition(el, state) {
  if (!state?.dragged) return;

  // Clamp to current viewport in case window was resized since last save
  const maxLeft = Math.max(0, window.innerWidth  - (state.width || 200));
  const maxTop  = Math.max(0, window.innerHeight - 56);
  const left    = Math.min(Math.max(0, state.left || 0), maxLeft);
  const top     = Math.min(Math.max(0, state.top  || 0), maxTop);

  pinToPosition(el, left, top);
  if (state.width) el.style.width = `${state.width}px`;
}

// ─── Drag ─────────────────────────────────────────────────────────────────

function makeDraggable(el, handle) {
  // ── Mouse ──
  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();

    const rect  = el.getBoundingClientRect();
    const offX  = e.clientX - rect.left;
    const offY  = e.clientY - rect.top;

    // Snap to computed position before any dragging
    pinToPosition(el, rect.left, rect.top);
    el.style.width = `${rect.width}px`;
    el.classList.add('is-dragging');

    const onMove = (e) => {
      const newLeft = clamp(e.clientX - offX, 0, window.innerWidth  - rect.width);
      const newTop  = clamp(e.clientY - offY, 0, window.innerHeight - 56);
      el.style.left = `${newLeft}px`;
      el.style.top  = `${newTop}px`;
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      el.classList.remove('is-dragging');
      saveState(el.id, {
        dragged: true,
        left:    parseFloat(el.style.left),
        top:     parseFloat(el.style.top),
        width:   rect.width,
      });
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });

  // ── Touch ──
  handle.addEventListener('touchstart', (e) => {
    const t    = e.touches[0];
    const rect = el.getBoundingClientRect();
    const offX = t.clientX - rect.left;
    const offY = t.clientY - rect.top;

    pinToPosition(el, rect.left, rect.top);
    el.style.width = `${rect.width}px`;
    el.classList.add('is-dragging');

    const onMove = (e) => {
      e.preventDefault();
      const t       = e.touches[0];
      const newLeft = clamp(t.clientX - offX, 0, window.innerWidth  - rect.width);
      const newTop  = clamp(t.clientY - offY, 0, window.innerHeight - 56);
      el.style.left = `${newLeft}px`;
      el.style.top  = `${newTop}px`;
    };

    const onEnd = () => {
      handle.removeEventListener('touchmove', onMove);
      handle.removeEventListener('touchend',  onEnd);
      el.classList.remove('is-dragging');
      saveState(el.id, {
        dragged: true,
        left:    parseFloat(el.style.left),
        top:     parseFloat(el.style.top),
        width:   rect.width,
      });
    };

    handle.addEventListener('touchmove', onMove, { passive: false });
    handle.addEventListener('touchend',  onEnd);
  }, { passive: true });
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// ─── Hide / Show ───────────────────────────────────────────────────────────

export function hidePanel(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('is-panel-hidden');
  saveState(id, { hidden: true });
  refreshMenu();
}

export function showPanel(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('is-panel-hidden');
  saveState(id, { hidden: false });
  refreshMenu();
}

export function togglePanel(id) {
  const el = document.getElementById(id)
  if (!el) return

  if (el.classList.contains('is-panel-hidden')) showPanel(id)
  else hidePanel(id)
}

// ─── Drag handle & hide button injection ──────────────────────────────────

function injectControls(el) {
  // Avoid double-injection on hot reload
  if (el.querySelector('.panel-drag-handle')) return;

  const bar = document.createElement('div');
  bar.className = 'panel-control-bar';

  const handle = document.createElement('span');
  handle.className = 'panel-drag-handle';
  handle.title     = 'Drag to reposition';
  handle.setAttribute('aria-hidden', 'true');
  // Six-dot grip icon using Unicode braille
  handle.innerHTML = '<span class="drag-grip">⠿⠿</span>';

  const hideBtn = document.createElement('button');
  hideBtn.type      = 'button';
  hideBtn.className = 'panel-hide-btn';
  hideBtn.title     = 'Hide panel';
  hideBtn.setAttribute('aria-label', 'Hide this panel');
  hideBtn.textContent = '⊟';
  hideBtn.addEventListener('click', () => hidePanel(el.id));

  bar.appendChild(handle);
  bar.appendChild(hideBtn);
  el.prepend(bar);

  makeDraggable(el, handle);
}

// ─── Floating panel menu ───────────────────────────────────────────────────

function buildMenu() {
  document.getElementById('hudPanelControls')?.remove();
  if (_panelMenuOutsideClick) {
    document.removeEventListener('click', _panelMenuOutsideClick);
    _panelMenuOutsideClick = null;
  }

  const root = document.createElement('div');
  root.id        = 'hudPanelControls';
  root.className = 'hud-panel-controls';
  root.innerHTML = `
    <button class="hud-panel-fab" id="panelFab" title="Panel visibility" type="button">
      <span class="fab-icon">⊞</span>
    </button>
    <div class="hud-panel-menu is-hidden" id="panelMenu">
      <div class="panel-menu-title">HUD Panels</div>
      ${MANAGED_PANELS.map(p => `
        <button class="panel-menu-item" type="button" data-target="${p.id}" id="menu-${p.id}">
          <span class="menu-dot" id="dot-${p.id}"></span>
          <span>${p.label}</span>
        </button>
      `).join('')}
      <div class="panel-menu-sep"></div>
      <button class="panel-menu-reset" type="button" id="panelMenuReset">Reset layout</button>
    </div>
  `;

  document.getElementById('appHud').appendChild(root);

  // Toggle menu
  document.getElementById('panelFab').addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('panelMenu').classList.toggle('is-hidden');
    refreshMenu();
  });

  // Close on outside click
  _panelMenuOutsideClick = (e) => {
    const menu = document.getElementById('panelMenu');
    if (menu && !root.contains(e.target)) menu.classList.add('is-hidden');
  };
  document.addEventListener('click', _panelMenuOutsideClick);

  // Per-panel toggles
  root.querySelectorAll('.panel-menu-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.target;
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.contains('is-panel-hidden') ? showPanel(id) : hidePanel(id);
    });
  });

  // Reset layout
  document.getElementById('panelMenuReset').addEventListener('click', resetLayout);
}

function refreshMenu() {
  MANAGED_PANELS.forEach(({ id }) => {
    const el  = document.getElementById(id);
    const dot = document.getElementById(`dot-${id}`);
    if (!dot) return;
    const visible = el && !el.classList.contains('is-panel-hidden');
    dot.classList.toggle('is-visible', !!visible);
  });
}

function resetLayout() {
  MANAGED_PANELS.forEach(({ id }) => {
    clearState(id);
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('is-panel-hidden');
    el.style.cssText = '';                      // wipe all inline styles
    el.removeAttribute('data-dragged');
  });
  document.getElementById('panelMenu')?.classList.add('is-hidden');
  refreshMenu();
}

// ─── Public init ──────────────────────────────────────────────────────────

export function initPanelManager() {
  MANAGED_PANELS.forEach(({ id }) => {
    const el = document.getElementById(id);
    if (!el) return;

    // Restore persisted state before injecting controls (order matters)
    const state = loadState(id);
    if (state?.hidden) el.classList.add('is-panel-hidden');
    restorePosition(el, state);

    injectControls(el);
  });

  buildMenu();
  refreshMenu();
}

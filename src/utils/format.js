export function formatNumber(value) {
  if (value == null || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-US').format(value);
}

export function formatCompactNumber(value) {
  if (value == null || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatAltitudeFeet(meters) {
  if (meters == null || Number.isNaN(meters)) return '—';
  return `${formatNumber(Math.round(meters * 3.281))} ft`;
}

export function formatAltitudeFeetShort(meters) {
  if (meters == null || Number.isNaN(meters)) return '—';
  return `${formatCompactNumber(Math.round(meters * 3.281))} ft`;
}

export function formatSpeedKnots(metersPerSecond) {
  if (metersPerSecond == null || Number.isNaN(metersPerSecond)) return '—';
  return `${formatNumber(Math.round(metersPerSecond * 1.944))} kts`;
}

export function formatHeading(degrees) {
  if (degrees == null || Number.isNaN(degrees)) return '—';
  return `${Math.round(((degrees % 360) + 360) % 360)}°`;
}

export function formatVerticalRate(metersPerSecond) {
  if (metersPerSecond == null || Number.isNaN(metersPerSecond)) return '—';

  const feetPerMinute = Math.round(Math.abs(metersPerSecond) * 196.85);

  if (metersPerSecond > 0.5) return `Climbing ${formatNumber(feetPerMinute)} ft/min`;
  if (metersPerSecond < -0.5) return `Descending ${formatNumber(feetPerMinute)} ft/min`;
  return 'Level flight';
}

export function formatCoordinates(lat, lon) {
  if (lat == null || lon == null || Number.isNaN(lat) || Number.isNaN(lon)) return '—';
  return `${lat.toFixed(3)}°, ${lon.toFixed(3)}°`;
}

export function formatRelativeTime(timestamp) {
  if (!timestamp) return 'Waiting for data';

  const value = timestamp instanceof Date ? timestamp.getTime() : Number(timestamp);
  if (Number.isNaN(value)) return 'Waiting for data';

  const deltaSeconds = Math.max(0, Math.round((Date.now() - value) / 1000));

  if (deltaSeconds < 5) return 'just now';
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;

  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;

  const deltaHours = Math.floor(deltaMinutes / 60);
  return `${deltaHours}h ago`;
}

export function formatAbsoluteTime(timestamp) {
  if (!timestamp) return '—';

  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '—';

  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

export function formatFlightIdentity(aircraft) {
  const callsign = String(aircraft?.callsign || '').trim();
  return callsign || aircraft?.icao24 || 'Unknown flight';
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

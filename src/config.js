const trim = (value) => (typeof value === 'string' ? value.trim() : '');
const cleanBaseUrl = (value) => trim(value).replace(/\/+$/, '');

export const appConfig = {
  appName: 'SkyView',
  cesiumIonToken: trim(import.meta.env.VITE_CESIUM_ION_TOKEN),
  googleMapsApiKey: trim(import.meta.env.VITE_GOOGLE_MAPS_API_KEY),
  apiBaseUrl: cleanBaseUrl(import.meta.env.VITE_SKYVIEW_API_BASE_URL),
  enableMinimap: import.meta.env.VITE_SKYVIEW_ENABLE_MINIMAP !== 'false',
  enableSatellites: import.meta.env.VITE_SKYVIEW_ENABLE_SATELLITES !== 'false',
  enableWeather: import.meta.env.VITE_SKYVIEW_ENABLE_WEATHER !== 'false',
  enableCameras: import.meta.env.VITE_SKYVIEW_ENABLE_CAMERAS !== 'false',
  environment: import.meta.env.PROD ? 'production' : 'development',
};

export function getApiUrl(path) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  if (appConfig.apiBaseUrl) {
    return `${appConfig.apiBaseUrl}${normalizedPath}`;
  }

  if (import.meta.env.DEV) {
    return `/api/skyview${normalizedPath}`;
  }

  return null;
}

export function getRuntimeWarnings() {
  const warnings = [];

  if (!appConfig.cesiumIonToken) {
    warnings.push('Cesium Ion token is missing. Some terrain and imagery features may be limited.');
  }

  if (!appConfig.googleMapsApiKey) {
    warnings.push('Google Maps API key is missing. Photorealistic 3D tiles may not load.');
  }

  if (!getApiUrl('/opensky/states')) {
    warnings.push('No public SkyView API endpoint is configured. Live flight data will fall back to demo mode.');
  }

  if (appConfig.enableSatellites && !hasSatelliteBackend()) {
    warnings.push('No N2YO backend is configured. Satellite tracking will remain unavailable.');
  }

  if (appConfig.enableCameras && !hasCamerasBackend()) {
    warnings.push(
      'No SkyView API base URL is configured for this build. Webcams need VITE_SKYVIEW_API_BASE_URL, or use npm run dev so the Vite Windy proxy is used.',
    );
  }

  return warnings;
}

export function hasLiveFlightBackend() {
  return Boolean(getApiUrl('/opensky/states'));
}

export function hasSatelliteBackend() {
  return Boolean(getApiUrl('/n2yo/above/0/0/0/70/0'));
}

export function hasCamerasBackend() {
  return Boolean(getApiUrl('/windy/webcams'));
}

# SkyView

SkyView is a browser-based 3D globe built with Vite and Cesium. It layers flight traffic, airports, landmarks, optional weather and satellite feeds, and related UI on a Google Photorealistic 3D Tiles globe when keys are present, with sensible fallbacks when they are not.

## Screenshots

Place images in [`screenshots/`](screenshots/) (PNG or WebP). Filenames below are suggestions; rename the files and update the paths if you prefer.

| Globe overview | Sidebar & layers |
| :------------: | :--------------: |
| ![Globe overview](screenshots/globe-overview.png) | ![Sidebar and layers](screenshots/sidebar-layers.png) |

| Flight / entity detail |
| :--------------------: |
| ![Detail panel](screenshots/detail-panel.png) |

**Capturing:** run `npm run dev`, use your OS screenshot tool (on macOS: Cmd+Shift+4), or the browser’s “Capture screenshot” in devtools. Aim for **1200–1600px** width so the README stays readable on GitHub.

## Prerequisites

- [Node.js](https://nodejs.org/) 18 or newer (there is no `engines` field in `package.json`; this matches typical Vite 8 requirements).

## Quick start

```bash
npm install
npm run dev
```

Open the URL printed in the terminal (usually `http://localhost:5173`).

## Environment variables

Create a `.env` file in the project root (see `.env.example`). Never commit `.env` or real secrets.

### Client (`VITE_*`)

These are embedded in the production bundle. Treat them as public configuration, not secrets. Use restricted API keys where the provider allows (e.g. HTTP referrer restrictions for Google Maps).

| Variable | Purpose |
| -------- | ------- |
| `VITE_CESIUM_ION_TOKEN` | Cesium Ion access token for terrain, imagery, and Cesium defaults. |
| `VITE_GOOGLE_MAPS_API_KEY` | Google Maps Platform key for Photorealistic 3D Tiles. |
| `VITE_SKYVIEW_API_BASE_URL` | Optional absolute base URL for live API paths in production (no trailing slash). If unset in production, browser calls to `/api/skyview/...` have no dev proxy. |
| `VITE_SKYVIEW_ENABLE_MINIMAP` | Set to `false` to disable the minimap (default: enabled). |
| `VITE_SKYVIEW_ENABLE_SATELLITES` | Set to `false` to disable satellite UI (default: enabled). |
| `VITE_SKYVIEW_ENABLE_WEATHER` | Set to `false` to disable weather UI (default: enabled). |
| `VITE_SKYVIEW_ENABLE_CAMERAS` | Set to `false` to disable webcam UI (default: enabled). |

### Server-only (Vite dev server)

Used only by `vite.config.js` middleware and **not** prefixed with `VITE_` so they are never exposed to the browser. In production, implement equivalent endpoints on your own backend or set `VITE_SKYVIEW_API_BASE_URL` to a server that does.

| Variable | Purpose |
| -------- | ------- |
| `OPENSKY_CLIENT_ID` | OpenSky OAuth2 client id for the dev token exchange at `/api/skyview/opensky/token`. |
| `OPENSKY_CLIENT_SECRET` | OpenSky OAuth2 client secret (same route). |
| `N2YO_API_KEY` | N2YO REST API key; proxied under `/api/skyview/n2yo/*`. |
| `WINDY_WEBCAMS_API_KEY` | Windy Webcams API key; proxied under `/api/skyview/windy/*`. |

## Development vs production APIs

In **development**, Vite serves middleware and proxies so the app can call paths like `/api/skyview/opensky/states`, `/api/skyview/aircraft`, `/api/skyview/callsign`, and the routes above without a separate backend.

A **static** `dist/` build has no Node server. Configure `VITE_SKYVIEW_API_BASE_URL` to point at a deployment that implements the same URL shapes, or live features that depend on those routes will fall back or show as unavailable.

## Build

```bash
npm run build
```

Output is written to `dist/`: root `index.html`, hashed assets under `dist/assets/`, and Cesium static assets under `dist/cesium/` (from `vite-plugin-cesium`).

Preview locally:

```bash
npm run preview
```

## License

This project is licensed under the MIT License; see [LICENSE](LICENSE).

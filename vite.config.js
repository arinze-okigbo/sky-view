import { defineConfig, loadEnv } from 'vite';
import cesium from 'vite-plugin-cesium';

const OPENSKY_TOKEN_URL =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const N2YO_BASE_URL = 'https://api.n2yo.com/rest/v1/satellite';
const WINDY_WEBCAMS_BASE_URL = 'https://webcams.windy.com/webcams/api/v3';

export default defineConfig(({ mode }) => {
  // Load ALL env vars (including those without VITE_ prefix) for server-side use only.
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [
      cesium({ cesiumBaseUrl: 'cesium' }),

      // Dev-only: server-side OpenSky OAuth2 token exchange.
      // Credentials stay in Node.js; the browser only calls /api/skyview/opensky/token.
      {
        name: 'opensky-oauth',
        configureServer(server) {
          server.middlewares.use('/api/skyview/opensky/token', (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.end();
              return;
            }

            const clientId     = env.OPENSKY_CLIENT_ID;
            const clientSecret = env.OPENSKY_CLIENT_SECRET;

            if (!clientId || !clientSecret) {
              res.statusCode = 503;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'OpenSky credentials not configured in .env' }));
              return;
            }

            fetch(OPENSKY_TOKEN_URL, {
              method:  'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body:    new URLSearchParams({
                grant_type:    'client_credentials',
                client_id:     clientId,
                client_secret: clientSecret,
              }),
            })
              .then(async (upstream) => {
                const text = await upstream.text();
                res.setHeader('Content-Type', 'application/json');
                res.statusCode = upstream.status;
                res.end(text);
              })
              .catch((err) => {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: err.message }));
              });
          });
        },
      },

      // Dev-only: server-side N2YO proxy.
      // The browser talks to /api/skyview/n2yo/* while the API key remains in Node.js.
      {
        name: 'n2yo-proxy',
        configureServer(server) {
          server.middlewares.use('/api/skyview/n2yo', async (req, res) => {
            if (req.method !== 'GET') {
              res.statusCode = 405;
              res.end();
              return;
            }

            const apiKey = env.N2YO_API_KEY;
            if (!apiKey) {
              res.statusCode = 503;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'N2YO API key not configured in .env' }));
              return;
            }

            const upstreamPath = req.url?.startsWith('/') ? req.url : `/${req.url || ''}`;
            const separator = upstreamPath.includes('?') ? '&' : '?';
            const upstreamUrl = `${N2YO_BASE_URL}${upstreamPath}${separator}apiKey=${encodeURIComponent(apiKey)}`;

            try {
              const upstream = await fetch(upstreamUrl, {
                headers: {
                  Accept: 'application/json',
                },
              });

              const text = await upstream.text();
              res.statusCode = upstream.status;
              res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
              res.end(text);
            } catch (error) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: error.message }));
            }
          });
        },
      },

      // Dev-only: Windy Webcams API proxy.
      // Adds the x-windy-api-key header server-side so the key never reaches the browser.
      {
        name: 'windy-webcams-proxy',
        configureServer(server) {
          server.middlewares.use('/api/skyview/windy', async (req, res) => {
            if (req.method !== 'GET') {
              res.statusCode = 405;
              res.end();
              return;
            }

            const apiKey = env.WINDY_WEBCAMS_API_KEY;
            if (!apiKey) {
              res.statusCode = 503;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Windy Webcams API key not configured in .env' }));
              return;
            }

            // req.url is relative to the mount point, e.g. "/webcams?bbox=..."
            const upstreamUrl = `${WINDY_WEBCAMS_BASE_URL}${req.url || ''}`;

            try {
              const upstream = await fetch(upstreamUrl, {
                headers: {
                  Accept: 'application/json',
                  'x-windy-api-key': apiKey,
                },
              });

              const text = await upstream.text();
              res.statusCode = upstream.status;
              res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
              res.end(text);
            } catch (error) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: error.message }));
            }
          });
        },
      },
    ],

    assetsInclude: ['**/*.glb'],

    server: {
      proxy: {
        '/api/skyview/opensky/states': {
          target:       'https://opensky-network.org',
          changeOrigin: true,
          rewrite:      () => '/api/states/all',
        },
        '/api/skyview/aircraft': {
          target:       'https://api.adsbdb.com/v0',
          changeOrigin: true,
          rewrite:      (path) => path.replace(/^\/api\/skyview\/aircraft/, '/aircraft'),
        },
        '/api/skyview/callsign': {
          target:       'https://api.adsbdb.com/v0',
          changeOrigin: true,
          rewrite:      (path) => path.replace(/^\/api\/skyview\/callsign/, '/callsign'),
        },
      },
    },

    build: { sourcemap: true },
  };
});

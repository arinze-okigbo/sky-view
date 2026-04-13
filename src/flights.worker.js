const MAX_AIRCRAFT = 5_000;
const CULL_THRESHOLD = 6_000;

const SEMI_MAJOR = 6_378_137.0;
const SEMI_MINOR = 6_356_752.3142451793;
const MINOR2 = (SEMI_MINOR / SEMI_MAJOR) ** 2;

const COUNTRY_FLAGS = {
  'United States': 'US',
  Germany: 'DE',
  France: 'FR',
  'United Kingdom': 'GB',
  China: 'CN',
  Japan: 'JP',
  Canada: 'CA',
  Australia: 'AU',
  Russia: 'RU',
  Brazil: 'BR',
  Spain: 'ES',
  Italy: 'IT',
  Netherlands: 'NL',
  Turkey: 'TR',
  'South Korea': 'KR',
  India: 'IN',
  Mexico: 'MX',
  Poland: 'PL',
  UAE: 'AE',
  Singapore: 'SG',
  Thailand: 'TH',
  Malaysia: 'MY',
  Switzerland: 'CH',
  Austria: 'AT',
  Sweden: 'SE',
  Norway: 'NO',
  Denmark: 'DK',
  Finland: 'FI',
  Belgium: 'BE',
  Portugal: 'PT',
  Greece: 'GR',
  Ireland: 'IE',
  'Czech Republic': 'CZ',
  Hungary: 'HU',
  Romania: 'RO',
  Ukraine: 'UA',
  'South Africa': 'ZA',
  Qatar: 'QA',
  'Saudi Arabia': 'SA',
  Israel: 'IL',
  'New Zealand': 'NZ',
  Indonesia: 'ID',
  Argentina: 'AR',
  Chile: 'CL',
  Colombia: 'CO',
  Vietnam: 'VN',
  Philippines: 'PH',
  Pakistan: 'PK',
  'Hong Kong': 'HK',
  Taiwan: 'TW',
};

function fromDegrees(lon, lat, alt) {
  const lonR = lon * Math.PI / 180;
  const latR = lat * Math.PI / 180;
  const cosLat = Math.cos(latR);
  const sinLat = Math.sin(latR);
  const cosLon = Math.cos(lonR);
  const sinLon = Math.sin(lonR);
  const r2 = (SEMI_MAJOR * cosLat) ** 2 + (SEMI_MINOR * sinLat) ** 2;
  const n = SEMI_MAJOR * SEMI_MAJOR / Math.sqrt(r2);

  return {
    x: (n + alt) * cosLat * cosLon,
    y: (n + alt) * cosLat * sinLon,
    z: (n * MINOR2 + alt) * sinLat,
  };
}

function distSq(ax, ay, az, bx, by, bz) {
  const dx = ax - bx;
  const dy = ay - by;
  const dz = az - bz;

  return dx * dx + dy * dy + dz * dz;
}

function toFlag(country) {
  const code = COUNTRY_FLAGS[country];
  if (!code || code.length !== 2) return 'GL';

  return [...code.toUpperCase()]
    .map((char) => String.fromCodePoint(127397 + char.charCodeAt(0)))
    .join('');
}

self.onmessage = function onmessage(event) {
  const { states, camX, camY, camZ, now, requestId } = event.data;

  if (!Array.isArray(states) || states.length === 0) {
    self.postMessage({
      requestId,
      aircraft: [],
      countries: [],
      fastest: null,
      highest: null,
      mostActiveCountry: null,
      groundCount: 0,
      airborneCount: 0,
    });
    return;
  }

  const groundCount = states.reduce((total, state) => total + (state?.[8] === true ? 1 : 0), 0);

  let airborneStates = states.filter((state) =>
    state &&
    state[8] !== true &&
    state[5] != null &&
    state[6] != null
  );

  if (airborneStates.length > CULL_THRESHOLD) {
    airborneStates = airborneStates
      .map((state) => {
        const position = fromDegrees(state[5], state[6], Math.max(state[7] ?? 0, 50));
        return {
          state,
          distanceSquared: distSq(camX, camY, camZ, position.x, position.y, position.z),
        };
      })
      .sort((left, right) => left.distanceSquared - right.distanceSquared)
      .slice(0, MAX_AIRCRAFT)
      .map((entry) => entry.state);
  }

  const countryMap = new Map();
  const aircraft = [];
  let fastest = null;
  let highest = null;

  for (const state of airborneStates) {
    const icao24 = state[0];
    const callsign = (state[1] || '').trim();
    const country = state[2] || '';
    const lon = state[5];
    const lat = state[6];
    const altitude = Math.max(state[7] ?? 0, 50);
    const velocity = state[9];
    const heading = state[10] ?? 0;
    const verticalRate = state[11] ?? 0;
    const position = fromDegrees(lon, lat, altitude);

    if (country) {
      countryMap.set(country, (countryMap.get(country) || 0) + 1);
    }

    if (velocity != null && (!fastest || velocity > fastest.velocity)) {
      fastest = { icao24, callsign, velocity };
    }

    if (!highest || altitude > highest.altitude) {
      highest = { icao24, callsign, altitude };
    }

    aircraft.push({
      icao24,
      callsign,
      country,
      lon,
      lat,
      alt: altitude,
      heading,
      velocity,
      vertRate: verticalRate,
      x: position.x,
      y: position.y,
      z: position.z,
      lastSeen: now,
    });
  }

  let mostActiveCountry = null;
  let maxCountryCount = 0;

  for (const [country, count] of countryMap) {
    if (count > maxCountryCount) {
      maxCountryCount = count;
      mostActiveCountry = {
        country,
        count,
        flag: toFlag(country),
      };
    }
  }

  self.postMessage({
    requestId,
    aircraft,
    countries: [...countryMap.keys()],
    fastest,
    highest,
    mostActiveCountry,
    groundCount,
    airborneCount: aircraft.length,
  });
};

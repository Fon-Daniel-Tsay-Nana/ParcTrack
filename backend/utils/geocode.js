// Place lookups with several free OpenStreetMap-based providers, tried in order.
// Hosted servers (e.g. Render) share IP addresses, and Nominatim often rate-limits or blocks them,
// so Photon and Open-Meteo are used as fallbacks. Set GEOCODING=off to disable lookups entirely.

const UA = 'ParcTrackLogistics/1.0 (parcel tracking)';
const TIMEOUT_MS = 6000;
const cache = new Map(); // query -> results (successful lookups only)
const remember = (key, value) => { if (cache.size > 1000) cache.clear(); cache.set(key, value); };
let lastNominatim = 0;

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const round = (n) => Math.round(n * 1e6) / 1e6;
const place = (lat, lng, name) => (Number.isFinite(lat) && Number.isFinite(lng) && name ? { lat: round(lat), lng: round(lng), name } : null);
const join = (...parts) => [...new Set(parts.filter(Boolean))].join(', ');

// ---------- providers: each returns an array of { lat, lng, name } ----------
async function nominatimSearch(q, limit) {
  // Nominatim usage policy: max 1 request per second
  const waitMs = Math.max(0, lastNominatim + 1100 - Date.now());
  if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
  lastNominatim = Date.now();
  const data = await getJson(`https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=${limit}&q=${encodeURIComponent(q)}`);
  return (data || []).map((h) => {
    const a = h.address || {};
    const name = join(h.name || a.road || a.suburb || a.village || a.town || a.city, a.city || a.town || a.village, a.state, a.country);
    return place(Number(h.lat), Number(h.lon), name || h.display_name);
  });
}

async function photonSearch(q, limit) {
  const data = await getJson(`https://photon.komoot.io/api/?lang=en&limit=${limit}&q=${encodeURIComponent(q)}`);
  return ((data && data.features) || []).map((f) => {
    const p = f.properties || {};
    const [lng, lat] = (f.geometry && f.geometry.coordinates) || [];
    return place(lat, lng, join(p.name || p.street, p.city, p.state, p.country));
  });
}

async function openMeteoSearch(q, limit) {
  // Open-Meteo matches place names only, so search the first part ("Tulsa" of "Tulsa, Oklahoma")
  const [name, ...rest] = q.split(',').map((s) => s.trim());
  const data = await getJson(`https://geocoding-api.open-meteo.com/v1/search?language=en&count=10&name=${encodeURIComponent(name)}`);
  let results = (data && data.results) || [];
  const hint = rest.join(' ').toLowerCase();
  if (hint) {
    const matching = results.filter((r) => [r.admin1, r.admin2, r.country, r.country_code].some((v) => v && hint.includes(String(v).toLowerCase())));
    if (matching.length) results = matching;
  }
  return results.slice(0, limit).map((r) => place(r.latitude, r.longitude, join(r.name, r.admin1, r.country)));
}

const PROVIDERS = [['nominatim', nominatimSearch], ['photon', photonSearch], ['open-meteo', openMeteoSearch]];

const PREFER_FIRST_MS = 1500; // give the first provider (most detailed) this long before taking a faster answer

function dedupe(list) {
  const seen = new Set();
  return list.filter((p) => {
    const k = p.name.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Up to `limit` suggestions for a typed place name.
// All providers are asked at once; the first provider's answer wins if it arrives quickly,
// otherwise the first non-empty answer from any provider is used.
async function searchPlaces(query, limit = 5) {
  const q = String(query || '').trim();
  if (!q || process.env.GEOCODING === 'off') return [];
  const key = `${limit}|${q.toLowerCase()}`;
  if (cache.has(key)) return cache.get(key);

  const attempts = PROVIDERS.map(([name, fn]) => fn(q, limit)
    .then((r) => dedupe(r.filter(Boolean)))
    .catch((err) => { console.warn(`[geocode] ${name} search failed for ${JSON.stringify(q)}: ${err.message}`); return []; }));

  const nonEmpty = (p) => p.then((r) => (r.length ? r : Promise.reject(new Error('empty'))));
  let results = await Promise.race([attempts[0], new Promise((res) => setTimeout(() => res(null), PREFER_FIRST_MS))]);
  if (!results || !results.length) {
    results = await Promise.any(attempts.map(nonEmpty)).catch(() => []);
  }
  if (results.length) remember(key, results);
  return results;
}

// Best single match: { lat, lng, name } or null
async function geocode(query) {
  const [first] = await searchPlaces(query, 1);
  return first || null;
}

// { lat, lng } -> "Broken Arrow, Oklahoma" (best-effort, null if unknown)
async function reverseGeocode(lat, lng) {
  if (process.env.GEOCODING === 'off') return null;
  const key = `rev|${lat.toFixed(3)},${lng.toFixed(3)}`;
  if (cache.has(key)) return cache.get(key);
  let name = null;
  try {
    const waitMs = Math.max(0, lastNominatim + 1100 - Date.now());
    if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
    lastNominatim = Date.now();
    const d = await getJson(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=14&addressdetails=1&lat=${lat}&lon=${lng}`);
    const a = (d && d.address) || {};
    name = join(a.suburb || a.village || a.town || a.city || a.municipality || a.county, a.state || a.country);
  } catch (err) {
    console.warn('[geocode] nominatim reverse failed:', err.message);
  }
  if (!name) {
    try {
      const d = await getJson(`https://photon.komoot.io/reverse?lang=en&lat=${lat}&lon=${lng}`);
      const p = (d && d.features && d.features[0] && d.features[0].properties) || {};
      name = join(p.city || p.district || p.name, p.state || p.country) || null;
    } catch (err) {
      console.warn('[geocode] photon reverse failed:', err.message);
    }
  }
  if (name) remember(key, name);
  return name || null;
}

module.exports = geocode;
module.exports.geocode = geocode;
module.exports.searchPlaces = searchPlaces;
module.exports.reverseGeocode = reverseGeocode;

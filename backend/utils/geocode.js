// Best-effort place lookups via OpenStreetMap Nominatim (forward + reverse).
// Set GEOCODING=off to disable. Failures never block the caller - they return null.

const cache = new Map();
let lastCall = 0;
const UA = 'ParcTrackLogistics/1.0 (parcel tracking)';

async function nominatim(pathAndQuery) {
  if (process.env.GEOCODING === 'off') return null;
  if (cache.has(pathAndQuery)) return cache.get(pathAndQuery);

  // Nominatim usage policy: max 1 request per second
  const waitMs = Math.max(0, lastCall + 1100 - Date.now());
  if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
  lastCall = Date.now();

  try {
    const res = await fetch('https://nominatim.openstreetmap.org/' + pathAndQuery, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    cache.set(pathAndQuery, data);
    return data;
  } catch (err) {
    console.warn('[geocode] lookup failed:', err.message);
    return null;
  }
}

// "Tulsa, Oklahoma" -> { lat, lng, name }
async function geocode(place) {
  const query = String(place || '').trim();
  if (!query) return null;
  const data = await nominatim('search?format=json&limit=1&q=' + encodeURIComponent(query));
  const hit = Array.isArray(data) && data[0];
  if (!hit) return null;
  const lat = Number(hit.lat);
  const lng = Number(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, name: shortName(hit) || query };
}

// { lat, lng } -> "Broken Arrow, Oklahoma"
async function reverseGeocode(lat, lng) {
  const data = await nominatim(`reverse?format=json&zoom=14&addressdetails=1&lat=${lat}&lon=${lng}`);
  return data && !data.error ? shortName(data) : null;
}

function shortName(hit) {
  const a = hit.address || {};
  const place = a.suburb || a.village || a.town || a.city || a.municipality || a.county || a.state;
  if (place) return [place, a.country].filter(Boolean).join(', ');
  return (hit.display_name || '').split(',').slice(0, 2).join(',').trim() || null;
}

module.exports = geocode;
module.exports.geocode = geocode;
module.exports.reverseGeocode = reverseGeocode;

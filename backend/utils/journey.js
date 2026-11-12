// Automatic parcel movement: the parcel travels along the road route and arrives at the estimated delivery time.
const J = require('../../public/js/journey.js');
const { reverseGeocode } = require('./geocode');
const { STATUSES } = require('../models/Shipment');

const MIN_LEAD_MS = 60 * 1000; // ETA must be at least 1 minute ahead to (re)start moving
const NAME_EVERY_MS = 5 * 60 * 1000; // refresh the place name at most every 5 minutes
const MAX_ROUTE_POINTS = 500;

const idx = (s) => STATUSES.indexOf(s);

// Road route via OSRM (OpenStreetMap). Falls back to a straight line if no road route exists.
async function buildRoute(origin, destination) {
  const straight = [{ lat: origin.lat, lng: origin.lng }, { lat: destination.lat, lng: destination.lng }];
  if (process.env.ROUTING === 'off') return { points: straight, source: 'straight' };
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${destination.lng},${destination.lat}?overview=full&geometries=geojson`;
    const res = await fetch(url, { headers: { 'User-Agent': 'ParcTrackLogistics/1.0 (parcel tracking)' }, signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    const coords = data && data.code === 'Ok' && data.routes && data.routes[0] && data.routes[0].geometry.coordinates;
    if (!coords || coords.length < 2) return { points: straight, source: 'straight' };
    // Downsample long routes, always keeping both ends
    const step = Math.ceil(coords.length / MAX_ROUTE_POINTS);
    const pts = coords.filter((_, i) => i % step === 0 || i === coords.length - 1).map(([lng, lat]) => ({ lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 }));
    // Start/end exactly at origin/destination
    pts[0] = straight[0];
    pts[pts.length - 1] = straight[1];
    return { points: pts, source: 'road' };
  } catch (err) {
    console.warn('[journey] routing failed, using straight line:', err.message);
    return { points: straight, source: 'straight' };
  }
}

function pushHistory(s, status, note, now) {
  s.history.push({ status, location: s.currentLocation, note, timestamp: now });
}

function setStatus(s, status, note, now) {
  if (s.status === status) return false;
  s.status = status;
  pushHistory(s, status, note, now);
  return true;
}

function etaError(s, now) {
  if (!s.estimatedDelivery) return 'Set an estimated delivery time first.';
  if (new Date(s.estimatedDelivery).getTime() < now + MIN_LEAD_MS) return 'The estimated delivery time has passed. Set a later time first.';
  return null;
}

// Begin (or restart) the journey from the origin
async function startJourney(s, now, actor) {
  if (!J.hasCoords(s.origin) || !J.hasCoords(s.destination)) return { error: 'Set the origin and destination on the map first.' };
  const err = etaError(s, now);
  if (err) return { error: err };

  const { points, source } = await buildRoute(s.origin, s.destination);
  s.route = points;
  s.currentLocation = { name: s.origin.name, lat: s.origin.lat, lng: s.origin.lng };
  s.locationUpdatedAt = new Date(now);
  s.trackingPaused = false;
  s.journey = { active: true, startedAt: new Date(now), startProgress: 0, arriveAt: s.estimatedDelivery, progress: 0, arrivedAt: null, namedAt: null };
  if (idx(s.status) < idx('Dispatched') || s.status === 'Delivered' || s.status === 'On Hold') {
    s.status = 'Dispatched';
    pushHistory(s, 'Dispatched', `Journey started by ${actor} (${source === 'road' ? 'road route' : 'direct route'})`, new Date(now));
  }
  return { ok: true, routeSource: source };
}

// Freeze the parcel where it is
function pauseJourney(s, now) {
  if (!s.journey || !s.journey.startedAt) return;
  const p = J.progressAt(s.journey, now);
  s.journey.progress = p;
  s.journey.active = false;
}

// Continue from the current point so the parcel still arrives at the ETA
function resumeJourney(s, now) {
  if (!s.journey || !s.journey.startedAt || s.journey.arrivedAt) return { ok: true };
  const err = etaError(s, now);
  if (err) return { error: err };
  s.journey.startProgress = s.journey.progress || 0;
  s.journey.startedAt = new Date(now);
  s.journey.arriveAt = s.estimatedDelivery;
  s.journey.active = true;
  return { ok: true };
}

// ETA changed while moving: re-time the rest of the trip
function retimeJourney(s, now) {
  if (!s.journey || !s.journey.active) return { ok: true };
  const err = etaError(s, now);
  if (err) return { error: err };
  const p = J.progressAt(s.journey, now);
  s.journey.progress = p;
  s.journey.startProgress = p;
  s.journey.startedAt = new Date(now);
  s.journey.arriveAt = s.estimatedDelivery;
  return { ok: true };
}

function resetJourney(s) {
  s.journey = { active: false, startedAt: null, startProgress: 0, arriveAt: null, progress: 0, arrivedAt: null, namedAt: null };
  s.route = [];
}

// Move the parcel to where it should be at `now`. Returns true if anything changed.
async function advance(s, now, { geocode = false } = {}) {
  const j = s.journey;
  if (!j || !j.active || !j.startedAt) return false;
  const path = J.pathFor(s);
  if (path.length < 2) return false;

  const p = J.progressAt(j, now);
  const pt = J.pointAt(path, p);
  const at = new Date(now);
  j.progress = p;

  if (p >= 1) {
    s.currentLocation = { name: s.destination.name, lat: s.destination.lat, lng: s.destination.lng };
    s.locationUpdatedAt = at;
    j.active = false;
    j.arrivedAt = at;
    setStatus(s, 'Delivered', 'Arrived at destination', at);
    return true;
  }

  let name = s.currentLocation && s.currentLocation.name;
  const enRoute = `En route to ${s.destination.name}`;
  if (p > 0 && (!name || name === s.origin.name)) name = enRoute;
  if (geocode && (!j.namedAt || now - new Date(j.namedAt).getTime() >= NAME_EVERY_MS)) {
    const place = await reverseGeocode(pt.lat, pt.lng);
    name = place ? `Near ${place}` : enRoute;
    j.namedAt = at;
  }
  s.currentLocation = { name, lat: Math.round(pt.lat * 1e6) / 1e6, lng: Math.round(pt.lng * 1e6) / 1e6 };
  s.locationUpdatedAt = at;

  // Automatic status: moves forward only; an admin's "On Hold" is respected until arrival
  if (s.status !== 'On Hold') {
    const target = p >= 0.9 ? 'Out for Delivery' : p > 0 ? 'In Transit' : 'Dispatched';
    if (idx(target) > idx(s.status)) setStatus(s, target, 'Automatic update', at);
  }
  return true;
}

module.exports = { buildRoute, startJourney, pauseJourney, resumeJourney, retimeJourney, resetJourney, advance, etaError };

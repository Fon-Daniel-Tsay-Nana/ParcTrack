/* ParcTrack Logistics - shared journey maths.
 * Used by the server (Node) AND the browser pages, so everyone computes the same position.
 *
 * A journey moves the parcel along `path` (origin -> destination) so that it arrives at `arriveAt`:
 *   progress(t) = startProgress + (1 - startProgress) * (t - startedAt) / (arriveAt - startedAt)
 * When the journey is paused (active = false) the progress is frozen at `progress`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BWJourney = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EARTH_KM = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const hasCoords = (p) => !!p && typeof p.lat === 'number' && typeof p.lng === 'number';

  function distanceKm(a, b) {
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // Route to follow: the stored road route, or a straight line origin -> destination
  function pathFor(s) {
    const route = (s.route || []).filter(hasCoords);
    if (route.length >= 2) return route;
    if (hasCoords(s.origin) && hasCoords(s.destination)) return [s.origin, s.destination];
    return [];
  }

  function totalKm(path) {
    let d = 0;
    for (let i = 1; i < path.length; i++) d += distanceKm(path[i - 1], path[i]);
    return d;
  }

  // Point at fraction f (0..1) of the path's length. Returns { lat, lng, index } (index = segment start).
  function pointAt(path, f) {
    if (!path.length) return null;
    if (path.length === 1 || f <= 0) return { lat: path[0].lat, lng: path[0].lng, index: 0 };
    const last = path[path.length - 1];
    if (f >= 1) return { lat: last.lat, lng: last.lng, index: path.length - 1 };
    const target = totalKm(path) * f;
    let walked = 0;
    for (let i = 1; i < path.length; i++) {
      const seg = distanceKm(path[i - 1], path[i]);
      if (walked + seg >= target) {
        const t = seg ? (target - walked) / seg : 0;
        return {
          lat: path[i - 1].lat + (path[i].lat - path[i - 1].lat) * t,
          lng: path[i - 1].lng + (path[i].lng - path[i - 1].lng) * t,
          index: i - 1,
        };
      }
      walked += seg;
    }
    return { lat: last.lat, lng: last.lng, index: path.length - 1 };
  }

  // Journey progress (0..1) at time `now` (ms)
  function progressAt(j, now) {
    if (!j || !j.startedAt) return 0;
    if (!j.active) return clamp(j.progress || 0, 0, 1);
    const t0 = new Date(j.startedAt).getTime();
    const t1 = new Date(j.arriveAt).getTime();
    const p0 = clamp(j.startProgress || 0, 0, 1);
    if (!(t1 > t0)) return 1;
    return clamp(p0 + (1 - p0) * clamp((now - t0) / (t1 - t0), 0, 1), 0, 1);
  }

  // The part of the path already travelled, ending exactly at the parcel
  function travelledPath(path, f) {
    const p = pointAt(path, f);
    if (!p) return [];
    return path.slice(0, p.index + 1).concat([{ lat: p.lat, lng: p.lng }]);
  }

  return { distanceKm, pathFor, totalKm, pointAt, progressAt, travelledPath, hasCoords };
});

// ParcTrack Logistics - customer tracking results page
(function () {
  'use strict';

  const TRACKING_CODE_RE = /^[0-9A-F]{16}$/;
  const MILESTONES = [
    'Shipment Created',
    'Processing',
    'Dispatched',
    'In Transit',
    'On Hold',
    'Out for Delivery',
    'Delivered',
  ];
  const HOLD = 'On Hold';

  const $ = (id) => document.getElementById(id);
  $('year').textContent = new Date().getFullYear();

  const rawCode = decodeURIComponent(window.location.pathname.split('/').filter(Boolean).pop() || '');
  const trackingCode = rawCode.trim().toUpperCase();

  let shipment = null;
  let map = null;
  let layers = {};
  let hasFitted = false;

  // ---------- Helpers ----------
  function formatDateTime(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (isNaN(d)) return '—';
    return d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function formatDate(value) {
    if (!value) return 'To be confirmed';
    const d = new Date(value);
    if (isNaN(d)) return 'To be confirmed';
    return d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  // "2 h 15 min" style remaining time
  function formatRemaining(ms) {
    if (ms <= 0) return 'arriving now';
    const min = Math.round(ms / 60000);
    if (min < 1) return 'less than a minute';
    if (min < 60) return min + ' min';
    const h = Math.floor(min / 60);
    if (h < 48) return h + ' h ' + (min % 60) + ' min';
    return Math.round(h / 24) + ' days';
  }

  const J = window.BWJourney;
  const journeyOf = (s) => (s && s.journey) || { started: false };
  // Live progress (0..1) right now, computed with the same formula as the server
  const liveProgress = (s) => (J && journeyOf(s).started ? J.progressAt(journeyOf(s), Date.now()) : 0);

  function hasCoords(loc) {
    return !!loc && typeof loc.lat === 'number' && typeof loc.lng === 'number';
  }

  function locationText(loc, fallback) {
    if (!loc) return fallback;
    if (loc.name) return loc.name;
    if (hasCoords(loc)) return loc.lat.toFixed(4) + ', ' + loc.lng.toFixed(4);
    return fallback;
  }

  function sameLocation(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return a.name === b.name && a.lat === b.lat && a.lng === b.lng;
  }

  function setText(id, text, flash) {
    const el = $(id);
    if (el.textContent === text) return;
    el.textContent = text;
    if (flash) {
      el.classList.remove('flash');
      void el.offsetWidth; // restart animation
      el.classList.add('flash');
    }
  }

  let toastTimer = null;
  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
  }

  function showState(name) {
    $('stateLoading').hidden = name !== 'loading';
    $('stateError').hidden = name !== 'error';
    $('stateResult').hidden = name !== 'result';
  }

  function showError(title, text) {
    $('errorTitle').textContent = title;
    $('errorText').textContent = text;
    document.title = title + ' | ParcTrack Logistics';
    showState('error');
  }

  // ---------- Map ----------
  const parcelSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/></svg>';

  function dotIcon(cls) {
    return L.divIcon({ className: '', html: '<div class="bw-marker ' + cls + '"></div>', iconSize: [18, 18], iconAnchor: [9, 9], popupAnchor: [0, -10] });
  }

  function parcelIcon(paused) {
    return L.divIcon({
      className: '',
      html: '<div class="bw-parcel' + (paused ? ' paused' : '') + '"><span class="ring"></span><span class="core">' + parcelSvg + '</span></div>',
      iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -18],
    });
  }

  function initMap() {
    map = L.map('map', { scrollWheelZoom: false }).setView([36.154, -95.9928], 7); // Tulsa, Oklahoma
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      referrerPolicy: 'strict-origin-when-cross-origin', // OSM requires a Referer

      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    map.on('focus', () => map.scrollWheelZoom.enable());
    map.on('blur', () => map.scrollWheelZoom.disable());
  }

  function popup(title, text) {
    const div = document.createElement('div');
    const b = document.createElement('strong');
    b.textContent = title;
    div.appendChild(b);
    div.appendChild(document.createElement('br'));
    div.appendChild(document.createTextNode(text));
    return div;
  }

  function upsertMarker(key, loc, icon, title, z) {
    if (!hasCoords(loc)) {
      if (layers[key]) { map.removeLayer(layers[key]); delete layers[key]; }
      return;
    }
    const latlng = [loc.lat, loc.lng];
    if (layers[key]) {
      layers[key].setLatLng(latlng).setIcon(icon);
      layers[key].setPopupContent(popup(title, locationText(loc, '')));
    } else {
      layers[key] = L.marker(latlng, { icon, zIndexOffset: z || 0, title, alt: title })
        .bindPopup(popup(title, locationText(loc, '')))
        .addTo(map);
    }
  }

  function upsertLine(key, points, options) {
    if (points.length < 2) {
      if (layers[key]) { map.removeLayer(layers[key]); delete layers[key]; }
      return;
    }
    if (layers[key]) layers[key].setLatLngs(points);
    else layers[key] = L.polyline(points, options).addTo(map);
  }

  function renderMap(s) {
    if (!map) {
      $('mapNote').textContent = 'The map could not be loaded. Shipment details and the timeline are still up to date.';
      $('mapNote').hidden = false;
      $('map').hidden = true;
      return;
    }
    upsertMarker('origin', s.origin, dotIcon('origin'), 'Origin');
    upsertMarker('dest', s.destination, dotIcon('dest'), 'Destination');
    upsertMarker('current', s.currentLocation, parcelIcon(s.trackingPaused), 'Current recorded location', 1000);

    // Planned route: the road route where available, otherwise a direct origin -> destination line
    const path = J ? J.pathFor(s) : [];
    upsertLine('planned', path.map((p) => [p.lat, p.lng]), { color: '#155EEF', weight: 3, opacity: 0.45, dashArray: '8 10' });

    moveParcel(); // place parcel + travelled line at the live position

    const pts = ['origin', 'dest', 'current'].filter((k) => layers[k]).map((k) => layers[k].getLatLng());
    $('mapNote').hidden = pts.length > 0;

    if (!hasFitted && pts.length) {
      const bounds = layers.planned ? layers.planned.getBounds() : L.latLngBounds(pts);
      pts.forEach((p) => bounds.extend(p));
      if (pts.length === 1 && !layers.planned) map.setView(pts[0], 12);
      else map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
      hasFitted = true;
    }
  }

  // Parcel position + travelled line + progress bar for "now".
  // While the journey is active this runs every second, so the parcel glides along the road between server updates.
  function moveParcel() {
    const s = shipment;
    if (!s) return;
    const j = journeyOf(s);
    const path = J ? J.pathFor(s) : [];
    const moving = j.started && path.length >= 2;
    const p = moving ? liveProgress(s) : 0;

    if (map) {
      if (moving && j.active && layers.current) {
        const pt = J.pointAt(path, p);
        layers.current.setLatLng([pt.lat, pt.lng]);
      }
      let travelled = [];
      if (moving) {
        travelled = J.travelledPath(path, p).map((q) => [q.lat, q.lng]);
      } else {
        // Not moving automatically: origin -> recorded history locations -> current location
        const push = (loc) => {
          if (!hasCoords(loc)) return;
          const last = travelled[travelled.length - 1];
          if (!last || last[0] !== loc.lat || last[1] !== loc.lng) travelled.push([loc.lat, loc.lng]);
        };
        push(s.origin);
        (s.history || []).forEach((h) => push(h.location));
        push(s.currentLocation);
      }
      upsertLine('travelled', travelled, { color: '#155EEF', weight: 4, opacity: 0.9 });
      if (layers.travelled) layers.travelled.bringToFront();
    }

    // Progress bar
    $('journeyRow').hidden = !j.started;
    if (j.started) {
      const pct = Math.round(p * 100);
      $('progressFill').style.width = pct + '%';
      const bar = $('progressBar');
      bar.setAttribute('aria-valuenow', String(pct));
      bar.className = 'progress' + (s.trackingPaused ? ' paused' : '') + (p >= 1 ? ' done' : '');
      let text;
      if (p >= 1) text = 'Arrived at destination';
      else if (s.trackingPaused || !j.active) text = pct + '% of the way. Parcel is stopped';
      else text = pct + '% of the way, about ' + formatRemaining(new Date(j.arriveAt).getTime() - Date.now()) + ' to go';
      $('progressText').textContent = text;
    }
  }

  setInterval(() => {
    if (shipment && journeyOf(shipment).active && !shipment.trackingPaused) moveParcel();
  }, 1000);

  // ---------- Timeline ----------
  const icons = {
    completed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"/></svg>',
    current: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" fill="currentColor"/></svg>',
    hold: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M9 7v10M15 7v10"/></svg>',
    pending: '',
    skipped: '',
  };

  function buildTimeline(s) {
    const history = s.history || [];
    const lastEntry = {};
    history.forEach((h) => { if (h.status) lastEntry[h.status] = h; });

    // Furthest regular milestone reached (On Hold is not progress)
    const progressOf = (status) => (status === HOLD ? -1 : MILESTONES.indexOf(status));
    let furthest = progressOf(s.status);
    history.forEach((h) => { furthest = Math.max(furthest, progressOf(h.status)); });
    const holdIdx = MILESTONES.indexOf(HOLD);
    const currentIdx = s.status === HOLD ? holdIdx : MILESTONES.indexOf(s.status);

    const ol = $('timeline');
    ol.textContent = '';

    MILESTONES.forEach((name, i) => {
      let state;
      if (name === HOLD) {
        if (s.status === HOLD) state = 'current';
        else if (lastEntry[HOLD]) state = 'completed';
        else if (furthest > holdIdx) state = 'skipped';
        else state = 'pending';
      } else if (s.status === HOLD) {
        state = i <= furthest ? 'completed' : 'pending';
      } else if (i < currentIdx) {
        state = 'completed';
      } else if (i === currentIdx) {
        state = s.status === 'Delivered' ? 'completed' : 'current';
      } else {
        state = 'pending';
      }

      const li = document.createElement('li');
      li.className = state + (name === HOLD && state === 'current' ? ' hold' : '');
      if (state === 'current') li.setAttribute('aria-current', 'step');

      const node = document.createElement('span');
      node.className = 'node';
      node.innerHTML = name === HOLD && state === 'current' ? icons.hold : icons[state];
      li.appendChild(node);

      const text = document.createElement('span');
      text.className = 'text';

      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = name;
      text.appendChild(label);

      const st = document.createElement('span');
      st.className = 'state';
      st.textContent = { completed: 'Completed', current: 'Current', pending: 'Pending', skipped: 'Not required' }[state];
      text.appendChild(st);

      const entry = lastEntry[name];
      if (entry && state !== 'pending') {
        const when = document.createElement('span');
        when.className = 'when';
        when.textContent = formatDateTime(entry.timestamp);
        text.appendChild(when);
        if (entry.location && entry.location.name) {
          const where = document.createElement('span');
          where.className = 'where';
          where.textContent = entry.location.name;
          text.appendChild(where);
        }
      }

      li.appendChild(text);
      ol.appendChild(li);
    });
  }

  // ---------- Render ----------
  function render(s, isUpdate) {
    $('trackingCode').textContent = s.trackingCode;
    document.title = 'Tracking ' + s.trackingCode + ' | ParcTrack Logistics';

    const pill = $('statusPill');
    pill.textContent = s.status;
    pill.className = 'status-pill' + (s.status === HOLD ? ' is-hold' : '') + (s.status === 'Delivered' ? ' is-delivered' : '');

    setText('dStatus', s.status, isUpdate);
    setText('dOrigin', locationText(s.origin, 'Not specified'), isUpdate);
    setText('dDestination', locationText(s.destination, 'Not specified'), isUpdate);
    setText('dDescription', s.description || 'Not specified', isUpdate);
    setText('dCurrent', locationText(s.currentLocation, 'Not yet recorded'), isUpdate);
    setText('dUpdated', formatDateTime(s.locationUpdatedAt), isUpdate);
    setText('dEta', s.status === 'Delivered' ? 'Delivered' : formatDate(s.estimatedDelivery), isUpdate);

    // Paused notification
    $('pausedBanner').hidden = !s.trackingPaused;
    if (s.trackingPaused) {
      $('pausedText').textContent = s.pauseMessage ||
        'The location shown is the last recorded position. Updates will resume shortly.';
    }
    updateLiveIndicator();

    renderMap(s);
    buildTimeline(s);
  }

  // ---------- Live updates ----------
  let connected = false;

  function updateLiveIndicator() {
    const el = $('liveIndicator');
    const text = $('liveText');
    el.classList.remove('is-live', 'is-paused');
    if (shipment && shipment.trackingPaused) {
      el.classList.add('is-paused');
      text.textContent = 'Updates paused';
    } else if (connected) {
      el.classList.add('is-live');
      text.textContent = 'Live';
    } else {
      text.textContent = 'Reconnecting…';
    }
  }

  function connectSocket() {
    if (typeof io !== 'function') return;
    const socket = io({ transports: ['websocket', 'polling'] });

    socket.on('connect', () => {
      connected = true;
      socket.emit('track:join', trackingCode);
      updateLiveIndicator();
      // Catch up on anything missed while disconnected
      if (shipment) refresh();
    });
    socket.on('disconnect', () => { connected = false; updateLiveIndicator(); });

    // Only updates for this shipment's room arrive here
    socket.on('shipment:update', (data) => {
      if (!data || !data.status) return;
      data.trackingCode = trackingCode;
      const prev = shipment;
      shipment = data;

      const messages = [];
      if (prev && prev.status !== data.status) messages.push('Status updated: ' + data.status);
      // automatic movement updates arrive every few seconds - only announce manual/one-off moves
      const autoMoving = data.journey && data.journey.active;
      if (prev && !autoMoving && !sameLocation(prev.currentLocation, data.currentLocation)) messages.push('Parcel location updated');
      if (prev && data.journey && prev.journey && !prev.journey.started && data.journey.started) messages.push('Your parcel is on its way');
      if (prev && data.journey && data.journey.arrivedAt && !(prev.journey && prev.journey.arrivedAt)) messages.push('Your parcel has arrived');
      if (prev && prev.trackingPaused !== data.trackingPaused) messages.push(data.trackingPaused ? 'Tracking updates paused' : 'Tracking updates resumed');

      render(data, true);

      if (map && prev && !sameLocation(prev.currentLocation, data.currentLocation) && layers.current) {
        const ll = layers.current.getLatLng();
        if (!map.getBounds().contains(ll)) map.panTo(ll);
      }
      if (messages.length) toast(messages.join(' · '));
    });
  }

  // ---------- Load ----------
  // Fetch with a time limit so a slow connection never leaves the page stuck loading
  async function fetchShipment(timeoutMs = 20000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch('/api/tracking/' + encodeURIComponent(trackingCode), {
        headers: { Accept: 'application/json' }, cache: 'no-store', signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      return { res, data };
    } finally {
      clearTimeout(timer);
    }
  }

  async function refresh() {
    try {
      const { res, data } = await fetchShipment();
      if (res.ok && data.ok) { shipment = data.shipment; render(shipment, true); }
    } catch (_) { /* keep showing last known data */ }
  }

  async function load() {
    if (!TRACKING_CODE_RE.test(trackingCode)) {
      showError('Invalid tracking code', 'Tracking codes are exactly 16 characters using digits 0–9 and letters A–F. Please check your code and try again.');
      return;
    }

    try {
      const { res, data } = await fetchShipment();
      if (res.status === 404) {
        showError('Shipment not found', "We couldn't find a shipment with tracking code " + trackingCode + '. Please check the code and try again.');
        return;
      }
      if (!res.ok || !data.ok) {
        showError('Tracking unavailable', data.error || 'We could not load this shipment right now. Please try again shortly.');
        return;
      }

      shipment = data.shipment;
      showState('result');
      // The map is optional: details, timeline and live updates work without it
      try {
        if (typeof L === 'undefined') throw new Error('Leaflet not loaded');
        initMap();
      } catch (mapErr) {
        console.warn('[track] map unavailable:', mapErr.message);
        map = null;
      }
      render(shipment, false);
      if (map) setTimeout(() => map.invalidateSize(), 0);
      connectSocket();
    } catch (err) {
      showError('Connection problem', 'We could not reach the tracking server. Please check your connection and try again.');
      $('retryBtn').hidden = false;
    }
  }

  $('retryBtn').addEventListener('click', () => {
    $('retryBtn').hidden = true;
    showState('loading');
    load();
  });

  load();
})();

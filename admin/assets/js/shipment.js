// ParcTrack Logistics - admin shipment management (/admin/shipments/:id)
// The parcel moves automatically along its route and arrives at the estimated delivery time.
// The admin can start, stop (pause) and resume it, change the ETA, status, origin and destination.
// Every saved change is pushed by the server to customers' tracking pages via Socket.IO.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const J = window.BWJourney;
  const shipmentId = decodeURIComponent(window.location.pathname.split('/').filter(Boolean).pop() || '');
  const DEFAULT_CENTER = [36.154, -95.9928]; // Tulsa, Oklahoma

  let shipment = null;
  let map = null;
  const layers = {};
  let mode = null; // 'origin' | 'destination' while picking on the map
  let pending = null; // { key, lat, lng }
  let hasFitted = false;

  // ---------- helpers ----------
  async function api(path, options = {}) {
    const res = await fetch(path, {
      credentials: 'same-origin',
      ...options,
      headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    });
    if (res.status === 401) {
      window.location.replace('/admin/login');
      throw new Error('unauthorized');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      const err = new Error(data.error || 'Request failed');
      err.data = data;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const fmtDateTime = (v) => (v ? new Date(v).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
  const fmtDate = (v) => (v ? new Date(v).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
  const hasCoords = (l) => !!l && typeof l.lat === 'number' && typeof l.lng === 'number';
  const locText = (l, fb) => (l && l.name) || (hasCoords(l) ? `${l.lat.toFixed(4)}, ${l.lng.toFixed(4)}` : fb);
  const setText = (id, t) => { $(id).textContent = t == null || t === '' ? '—' : t; };
  const journeyOf = (s) => (s && s.journey) || { started: false };
  const liveProgress = (s) => (journeyOf(s).started ? J.progressAt(journeyOf(s), Date.now()) : 0);

  function formatRemaining(ms) {
    if (ms <= 0) return 'arriving now';
    const min = Math.round(ms / 60000);
    if (min < 1) return 'less than a minute';
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    if (h < 48) return `${h} h ${min % 60} min`;
    return `${Math.round(h / 24)} days`;
  }

  // value for <input type="datetime-local"> in the admin's local time
  function toLocalInput(v) {
    const d = new Date(v);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  }

  let toastTimer;
  function toast(msg, isError) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3800);
  }

  async function withBusy(btn, label, fn) {
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = label;
    try { return await fn(); } finally {
      btn.disabled = false;
      // only restore the label if a re-render didn't already set a new one (e.g. Stop -> Resume)
      if (btn.textContent === label) btn.textContent = old;
    }
  }

  async function send(url, method, body, successMsg) {
    try {
      const data = await api(url, { method, body: JSON.stringify(body || {}) });
      shipment = data.shipment;
      render();
      if (successMsg) toast(typeof successMsg === 'function' ? successMsg(data) : successMsg);
      return data;
    } catch (e) {
      if (e.message !== 'unauthorized') toast(e.message || 'Could not save.', true);
      return null;
    }
  }
  const patch = (body, msg) => send('/api/admin/shipments/' + encodeURIComponent(shipmentId), 'PATCH', body, msg);

  // ---------- shell: sidebar, logout, admin chip ----------
  function setNav(open) {
    $('app').classList.toggle('nav-open', open);
    $('menuBtn').setAttribute('aria-expanded', String(open));
  }
  $('menuBtn').addEventListener('click', () => setNav(!$('app').classList.contains('nav-open')));
  $('navScrim').addEventListener('click', () => setNav(false));
  $('logoutBtn').addEventListener('click', async () => {
    try { await fetch('/api/admin/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', credentials: 'same-origin' }); } catch (_) {}
    window.location.replace('/admin/login');
  });
  api('/api/admin/me').then((me) => {
    $('adminEmail').textContent = me.admin.email;
    $('avatar').textContent = (me.admin.email || 'A').charAt(0).toUpperCase();
  }).catch(() => {});

  // ---------- map ----------
  const parcelSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/></svg>';
  const dotIcon = (cls) => L.divIcon({ className: '', html: `<div class="bw-marker ${cls}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] });
  const pendingIcon = () => L.divIcon({ className: '', html: '<div class="bw-marker pending"></div>', iconSize: [22, 22], iconAnchor: [11, 11] });
  const parcelIcon = (paused) => L.divIcon({
    className: '',
    html: `<div class="bw-parcel${paused ? ' paused' : ''}"><span class="ring"></span><span class="core">${parcelSvg}</span></div>`,
    iconSize: [34, 34], iconAnchor: [17, 17],
  });

  function initMap() {
    map = L.map('map').setView(DEFAULT_CENTER, 10);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      referrerPolicy: 'strict-origin-when-cross-origin', // OSM requires a Referer
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    map.on('click', (e) => { if (mode) startPending(mode, e.latlng.lat, e.latlng.lng); });
  }

  function setMarker(key, loc, icon, title, z) {
    if (!hasCoords(loc)) {
      if (layers[key]) { map.removeLayer(layers[key]); delete layers[key]; }
      return;
    }
    if (layers[key]) layers[key].setLatLng([loc.lat, loc.lng]).setIcon(icon);
    else layers[key] = L.marker([loc.lat, loc.lng], { icon, title, zIndexOffset: z || 0 }).addTo(map);
    layers[key].bindTooltip(`${title}: ${locText(loc, '')}`);
  }

  function setLine(key, pts, style) {
    if (pts.length < 2) {
      if (layers[key]) { map.removeLayer(layers[key]); delete layers[key]; }
      return;
    }
    if (layers[key]) layers[key].setLatLngs(pts);
    else layers[key] = L.polyline(pts, style).addTo(map);
  }

  function renderMap() {
    const s = shipment;
    setMarker('origin', s.origin, dotIcon('origin'), 'Origin');
    setMarker('dest', s.destination, dotIcon('dest'), 'Destination');
    setMarker('current', s.currentLocation, parcelIcon(s.trackingPaused), 'Parcel', 1000);
    setLine('planned', J.pathFor(s).map((p) => [p.lat, p.lng]), { color: '#155EEF', weight: 3, opacity: 0.45, dashArray: '8 10', interactive: false });
    moveParcel();

    if (!hasFitted) {
      const pts = ['origin', 'dest', 'current'].filter((k) => layers[k]).map((k) => layers[k].getLatLng());
      if (pts.length) {
        const bounds = layers.planned ? layers.planned.getBounds() : L.latLngBounds(pts);
        pts.forEach((p) => bounds.extend(p));
        if (pts.length === 1 && !layers.planned) map.setView(pts[0], 12);
        else map.fitBounds(bounds, { padding: [50, 50], maxZoom: 14 });
      }
      hasFitted = true;
    }
  }

  // Parcel position, travelled line and progress for "now" - runs every second while moving
  function moveParcel() {
    const s = shipment;
    if (!s) return;
    const j = journeyOf(s);
    const path = J.pathFor(s);
    const started = j.started && path.length >= 2;
    const p = started ? liveProgress(s) : 0;

    if (map) {
      if (started && j.active && layers.current) {
        const pt = J.pointAt(path, p);
        layers.current.setLatLng([pt.lat, pt.lng]);
      }
      setLine('travelled', started ? J.travelledPath(path, p).map((q) => [q.lat, q.lng]) : [], { color: '#155EEF', weight: 4, opacity: 0.9, interactive: false });
    }

    const pct = Math.round(p * 100);
    $('progressFill').style.width = pct + '%';
    $('progressBar').setAttribute('aria-valuenow', String(pct));
    $('progressBar').className = 'progress' + (s.trackingPaused ? ' paused' : '') + (j.arrivedAt || p >= 1 ? ' done' : '');
    let text;
    if (!j.started) text = 'Not started. The parcel is waiting at the origin.';
    else if (j.arrivedAt || p >= 1) text = `Arrived ${fmtDateTime(j.arrivedAt)}`;
    else if (!j.active) text = `${pct}% of the way. Stopped`;
    else text = `${pct}% of the way, about ${formatRemaining(new Date(j.arriveAt).getTime() - Date.now())} left`;
    $('progressText').textContent = text;
  }

  setInterval(() => { if (shipment && journeyOf(shipment).active) moveParcel(); }, 1000);
  // Pick up the server's 30s updates (place name, status changes) without a refresh
  setInterval(async () => {
    if (!shipment || !journeyOf(shipment).active || pending || document.hidden) return;
    try {
      const data = await api('/api/admin/shipments/' + encodeURIComponent(shipmentId));
      shipment = data.shipment;
      render();
    } catch (_) {}
  }, 30000);

  // ---------- origin / destination picking ----------
  const MODE_TEXT = {
    origin: { title: 'New origin', hint: 'Click on the map (or find a place) to set where the shipment starts.' },
    destination: { title: 'New destination', hint: 'Click on the map (or find a place) to set where the shipment is going.' },
  };
  const IDLE_HINT = 'The parcel moves along the road on its own and arrives at the estimated delivery time.';

  function setMode(m) {
    mode = mode === m ? null : m; // clicking the active button turns picking off
    document.querySelectorAll('.seg button').forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    });
    $('mapHint').textContent = mode ? MODE_TEXT[mode].hint : IDLE_HINT;
    $('placeSearch').hidden = !mode;
    $('map').classList.toggle('picking', !!mode);
    if (pending && pending.key !== mode) cancelPending();
  }
  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

  let reverseSeq = 0;
  async function startPending(key, lat, lng, knownName) {
    pending = { key, lat, lng };
    if (layers.pending) layers.pending.setLatLng([lat, lng]);
    else layers.pending = L.marker([lat, lng], { icon: pendingIcon(), interactive: false, zIndexOffset: 2000 }).addTo(map);

    $('pendingTitle').textContent = MODE_TEXT[key].title;
    $('pendingCoords').textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    $('pendingForm').hidden = false;
    const nameInput = $('pendingName');
    nameInput.value = knownName || '';
    nameInput.placeholder = 'Looking up place name…';
    if (!knownName) {
      const seq = ++reverseSeq;
      try {
        const data = await api(`/api/admin/geocode/reverse?lat=${lat}&lng=${lng}`);
        if (seq === reverseSeq && !nameInput.value) nameInput.value = data.name || '';
      } catch (_) { /* admin can type a name */ }
      if (seq === reverseSeq) nameInput.placeholder = 'e.g. Dallas, Texas';
    }
    nameInput.focus();
  }

  function cancelPending() {
    pending = null;
    reverseSeq++;
    $('pendingForm').hidden = true;
    if (layers.pending) { map.removeLayer(layers.pending); delete layers.pending; }
  }
  $('pendingCancel').addEventListener('click', cancelPending);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pending) cancelPending(); });

  $('pendingForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!pending) return;
    const name = $('pendingName').value.trim();
    if (!name) { $('pendingName').focus(); toast('Enter a place name customers will see.', true); return; }
    const key = pending.key;
    await withBusy($('pendingSave'), 'Saving…', async () => {
      const ok = await patch({ [key]: { name, lat: pending.lat, lng: pending.lng } },
        `${key === 'origin' ? 'Origin' : 'Destination'} saved. Press "Start journey" to send the parcel on the new route.`);
      if (ok) { cancelPending(); setMode(key); hasFitted = false; renderMap(); }
    });
  });

  $('placeSearch').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('placeInput').value.trim();
    if (!q || !mode) return;
    try {
      const { place } = await api('/api/admin/geocode/search?q=' + encodeURIComponent(q));
      map.setView([place.lat, place.lng], Math.max(map.getZoom(), 12));
      startPending(mode, place.lat, place.lng, place.name);
    } catch (err) {
      if (err.message !== 'unauthorized') toast(err.message, true);
    }
  });

  // ---------- journey controls ----------
  $('startBtn').addEventListener('click', () => {
    const restarting = journeyOf(shipment).started;
    if (restarting && !confirm('Restart the journey from the origin?')) return;
    withBusy($('startBtn'), 'Planning route…', () => send(
      `/api/admin/shipments/${encodeURIComponent(shipmentId)}/journey/start`, 'POST', {},
      (d) => `Journey started${d.routeSource === 'road' ? ' along the road route' : ' (direct route)'}. Arrives ${fmtDateTime(d.shipment.estimatedDelivery)}.`
    ));
  });

  $('pauseBtn').addEventListener('click', () => {
    const stopping = !shipment.trackingPaused;
    withBusy($('pauseBtn'), stopping ? 'Stopping…' : 'Resuming…', () => patch(
      { trackingPaused: stopping, pauseMessage: $('pauseMessage').value.trim() },
      stopping ? 'Parcel stopped. Customers are notified.' : 'Parcel moving again. It still arrives on time.'
    ));
  });

  $('statusForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const status = $('statusSelect').value;
    if (status === shipment.status) { toast('Choose a different status first.', true); return; }
    withBusy($('statusBtn'), 'Updating…', async () => {
      if (await patch({ status, note: $('statusNote').value.trim() }, `Status changed to ${status}.`)) $('statusNote').value = '';
    });
  });

  $('etaForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('etaInput').value;
    if (!v) return;
    patch({ estimatedDelivery: new Date(v).toISOString() }, (d) => `Estimated delivery set to ${fmtDateTime(d.shipment.estimatedDelivery)}.`);
  });

  $('reissueBtn').addEventListener('click', async () => {
    if (!confirm('Issue a new tracking code?\n\nThe current code will stop working immediately. Give the new code to the sender and recipient.')) return;
    await withBusy($('reissueBtn'), 'Issuing…', async () => {
      const data = await send(`/api/admin/shipments/${encodeURIComponent(shipmentId)}/reissue-code`, 'POST', {},
        "New tracking code issued. Copy it now, because it won't be shown again.");
      if (data) {
        $('newCode').textContent = data.trackingCode;
        $('newCodeBox').hidden = false;
      }
    });
  });

  $('deleteBtn').addEventListener('click', async () => {
    if (!confirm(`Delete shipment ${shipment.codeHint}${shipment.receiver.name ? ` for ${shipment.receiver.name}` : ''}?\n\nThis permanently removes it. Its tracking code will stop working. This cannot be undone.`)) return;
    await withBusy($('deleteBtn'), 'Deleting…', async () => {
      try {
        await api('/api/admin/shipments/' + encodeURIComponent(shipmentId), { method: 'DELETE', body: '{}' });
        window.location.replace('/admin/dashboard');
      } catch (err) {
        if (err.message !== 'unauthorized') toast(err.message || 'Could not delete the shipment.', true);
      }
    });
  });

  $('copyBtn').addEventListener('click', async () => {
    const code = $('newCode').textContent;
    let ok = false;
    try { await navigator.clipboard.writeText(code); ok = true; } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = code; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch (__) {}
      ta.remove();
    }
    $('copyBtn').textContent = ok ? 'Copied ✓' : 'Copy failed';
    setTimeout(() => { $('copyBtn').textContent = 'Copy'; }, 2000);
  });

  // ---------- render ----------
  function render() {
    const s = shipment;
    const j = journeyOf(s);
    document.title = `Shipment ${s.codeHint} | ParcTrack Admin`;
    $('codeHint').textContent = s.codeHint;
    $('codeHint2').textContent = s.codeHint;
    const badge = $('statusBadge');
    badge.textContent = s.status;
    badge.dataset.s = s.status;

    // Journey card
    const arrived = !!j.arrivedAt;
    $('pausedNotice').hidden = !s.trackingPaused;
    const ts = $('trackState');
    ts.className = 'track-state' + (s.trackingPaused || !j.active ? ' paused' : '');
    ts.innerHTML = '<span class="dot"></span>';
    ts.appendChild(document.createTextNode(
      !j.started ? 'Not started' : arrived ? 'Arrived at destination' : s.trackingPaused ? 'Stopped: customers see a notice' : 'Moving: customers see it live'
    ));
    const canStart = hasCoords(s.origin) && hasCoords(s.destination);
    $('startBtn').hidden = j.started && !arrived;
    $('startBtn').textContent = arrived ? 'Restart journey' : 'Start journey';
    $('startBtn').disabled = !canStart;
    $('startBtn').title = canStart ? '' : 'Set the origin and destination on the map first';
    $('pauseControls').hidden = !j.started || arrived;
    const pb = $('pauseBtn');
    pb.textContent = s.trackingPaused ? 'Resume' : 'Stop parcel';
    pb.className = 'btn btn-block ' + (s.trackingPaused ? 'btn-success' : 'btn-warn');
    if (document.activeElement !== $('pauseMessage')) $('pauseMessage').value = s.pauseMessage || '';

    const sel = $('statusSelect');
    if (document.activeElement !== sel) sel.value = s.status;
    if (s.estimatedDelivery && document.activeElement !== $('etaInput')) $('etaInput').value = toLocalInput(s.estimatedDelivery);

    setText('sumCurrent', locText(s.currentLocation, 'Not recorded'));
    setText('sumUpdated', fmtDateTime(s.locationUpdatedAt));
    setText('sumOrigin', locText(s.origin, 'Not set') + (hasCoords(s.origin) ? '' : ' (no map point)'));
    setText('sumDestination', locText(s.destination, 'Not set') + (hasCoords(s.destination) ? '' : ' (no map point)'));

    setText('dSender', s.sender.name);
    setText('dSenderLoc', s.sender.location);
    setText('dReceiver', s.receiver.name);
    setText('dEmail', s.receiver.email);
    setText('dPhone', s.receiver.phone);
    setText('dDescription', s.description);
    setText('dCategory', s.category);
    setText('dWeight', s.weightKg != null ? `${s.weightKg} kg` : '');
    setText('dCreated', fmtDate(s.createdAt));

    const ol = $('history');
    ol.textContent = '';
    [...(s.history || [])].reverse().forEach((h) => {
      const li = document.createElement('li');
      const top = document.createElement('div');
      top.className = 'h-top';
      const st = document.createElement('span'); st.className = 'h-status'; st.textContent = h.status;
      const tm = document.createElement('span'); tm.className = 'h-time'; tm.textContent = fmtDateTime(h.timestamp);
      top.append(st, tm);
      li.appendChild(top);
      if (h.location && (h.location.name || hasCoords(h.location))) {
        const loc = document.createElement('div'); loc.className = 'h-loc'; loc.textContent = locText(h.location, ''); li.appendChild(loc);
      }
      if (h.note) { const n = document.createElement('div'); n.className = 'h-note'; n.textContent = h.note; li.appendChild(n); }
      ol.appendChild(li);
    });

    if (map) renderMap();
    else moveParcel();
  }

  // ---------- load ----------
  async function load() {
    try {
      const data = await api('/api/admin/shipments/' + encodeURIComponent(shipmentId));
      shipment = data.shipment;
      const sel = $('statusSelect');
      data.statuses.forEach((st) => sel.add(new Option(st, st)));
      $('stateLoading').hidden = true;
      $('stateReady').hidden = false;
      try {
        if (typeof L === 'undefined') throw new Error('Leaflet not loaded');
        initMap();
      } catch (mapErr) {
        $('map').textContent = 'The map could not be loaded. Refresh the page to try again.';
      }
      render();
      if (map) setTimeout(() => map.invalidateSize(), 0);
    } catch (e) {
      if (e.message === 'unauthorized') return;
      $('stateLoading').hidden = true;
      $('stateError').hidden = false;
      if (e.status !== 404) {
        $('errorTitle').textContent = 'Could not load shipment';
        $('errorText').textContent = e.message;
      }
    }
  }

  load();
})();

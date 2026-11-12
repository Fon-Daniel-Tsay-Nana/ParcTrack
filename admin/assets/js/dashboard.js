// ParcTrack Logistics - admin dashboard
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const PAGE_SIZE = 20;
  const state = { page: 1, pages: 1, q: '', status: '' };

  // ---------- API helper ----------
  async function api(path, options = {}) {
    const res = await fetch(path, {
      credentials: 'same-origin',
      ...options,
      headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
    });
    if (res.status === 401) {
      window.location.replace('/admin/login');
      throw new Error('unauthorized');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      const err = new Error(data.error || 'Request failed');
      err.data = data;
      throw err;
    }
    return data;
  }

  const fmtDate = (v) => (v ? new Date(v).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

  function td(label, content, cls) {
    const cell = document.createElement('td');
    cell.dataset.label = label;
    if (cls) cell.className = cls;
    if (content instanceof Node) cell.appendChild(content);
    else cell.textContent = content == null || content === '' ? '—' : content;
    return cell;
  }

  // ---------- Init ----------
  async function init() {
    try {
      const me = await api('/api/admin/me');
      $('adminEmail').textContent = me.admin.email;
      $('avatar').textContent = (me.admin.name || me.admin.email || 'A').trim().charAt(0).toUpperCase();

      const statusSel = $('statusFilter');
      me.statuses.forEach((s) => statusSel.add(new Option(s, s)));
      const catSel = $('f-category');
      me.categories.forEach((c) => catSel.add(new Option(c, c)));
    } catch (e) {
      if (e.message === 'unauthorized') return;
    }
    loadStats();
    loadShipments();
  }

  // ---------- Stats ----------
  async function loadStats() {
    try {
      const { stats } = await api('/api/admin/stats');
      $('sTotal').textContent = stats.total;
      $('sTransit').textContent = stats.inTransit;
      $('sDelivered').textContent = stats.delivered;
      $('sPending').textContent = stats.pending;
      $('sHold').textContent = stats.onHold;
    } catch (_) { /* leave placeholders */ }
  }

  // ---------- Shipments table ----------
  let loadSeq = 0;
  async function loadShipments() {
    const seq = ++loadSeq;
    const tbody = $('shipmentRows');
    const params = new URLSearchParams({ page: state.page, limit: PAGE_SIZE });
    if (state.q) params.set('q', state.q);
    if (state.status) params.set('status', state.status);

    try {
      const data = await api('/api/admin/shipments?' + params);
      if (seq !== loadSeq) return; // a newer request superseded this one
      state.pages = data.pages;
      tbody.textContent = '';

      if (!data.shipments.length) {
        const tr = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 6;
        cell.className = 'table-empty';
        cell.textContent = state.q || state.status ? 'No shipments match your search.' : 'No shipments yet. Create your first shipment.';
        tr.appendChild(cell);
        tbody.appendChild(tr);
      }

      data.shipments.forEach((s) => {
        const tr = document.createElement('tr');
        const code = document.createElement('span');
        code.className = 'mono';
        code.textContent = s.codeHint;
        code.title = 'Only the last 4 characters are stored for display';
        tr.appendChild(td('Tracking Code', code));
        tr.appendChild(td('Recipient', s.recipient));
        tr.appendChild(td('Destination', s.destination));
        const badge = document.createElement('span');
        badge.className = 'status';
        badge.dataset.s = s.status;
        badge.textContent = s.status;
        tr.appendChild(td('Status', badge));
        tr.appendChild(td('Date', fmtDate(s.createdAt)));
        const actions = document.createElement('div');
        actions.className = 'row-actions';
        const view = document.createElement('a');
        view.className = 'btn btn-outline btn-sm';
        view.href = '/admin/shipments/' + encodeURIComponent(s.id);
        view.textContent = 'View';
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'btn btn-danger-outline btn-sm';
        del.textContent = 'Delete';
        del.setAttribute('aria-label', `Delete shipment ${s.codeHint} for ${s.recipient || 'recipient'}`);
        del.addEventListener('click', () => deleteShipment(s, del));
        actions.append(view, del);
        tr.appendChild(td('', actions, 'actions'));
        tbody.appendChild(tr);
      });

      const from = data.total ? (data.page - 1) * PAGE_SIZE + 1 : 0;
      const to = Math.min(data.page * PAGE_SIZE, data.total);
      $('tableSummary').textContent = data.total ? `Showing ${from}–${to} of ${data.total}` : '';
      $('prevPage').disabled = data.page <= 1;
      $('nextPage').disabled = data.page >= data.pages;
    } catch (e) {
      if (e.message === 'unauthorized' || seq !== loadSeq) return;
      tbody.innerHTML = '<tr><td colspan="6" class="table-empty"></td></tr>';
      tbody.querySelector('td').textContent = e.message || 'Could not load shipments.';
    }
  }

  // ---------- Delete ----------
  async function deleteShipment(s, btn) {
    const ok = confirm(`Delete shipment ${s.codeHint}${s.recipient ? ` for ${s.recipient}` : ''}?\n\nThis permanently removes it. Its tracking code will stop working. This cannot be undone.`);
    if (!ok) return;
    btn.disabled = true;
    btn.textContent = 'Deleting…';
    try {
      await api('/api/admin/shipments/' + encodeURIComponent(s.id), { method: 'DELETE', body: '{}' });
      toast(`Shipment ${s.codeHint} deleted.`);
      loadStats();
      loadShipments();
    } catch (e) {
      if (e.message === 'unauthorized') return;
      toast(e.message || 'Could not delete the shipment.', true);
      btn.disabled = false;
      btn.textContent = 'Delete';
    }
  }

  let toastTimer;
  function toast(msg, isError) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
  }

  let searchTimer;
  $('searchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = e.target.value.trim();
      state.page = 1;
      loadShipments();
    }, 300);
  });
  $('statusFilter').addEventListener('change', (e) => {
    state.status = e.target.value;
    state.page = 1;
    loadShipments();
  });
  $('prevPage').addEventListener('click', () => { if (state.page > 1) { state.page--; loadShipments(); } });
  $('nextPage').addEventListener('click', () => { if (state.page < state.pages) { state.page++; loadShipments(); } });

  // ---------- Sidebar (mobile) ----------
  function setNav(open) {
    $('app').classList.toggle('nav-open', open);
    $('menuBtn').setAttribute('aria-expanded', String(open));
  }
  $('menuBtn').addEventListener('click', () => setNav(!$('app').classList.contains('nav-open')));
  $('navScrim').addEventListener('click', () => setNav(false));
  document.querySelectorAll('[data-close-nav]').forEach((el) => el.addEventListener('click', () => setNav(false)));

  // ---------- Logout ----------
  $('logoutBtn').addEventListener('click', async () => {
    try { await fetch('/api/admin/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', credentials: 'same-origin' }); } catch (_) {}
    window.location.replace('/admin/login');
  });

  // ---------- Create shipment modal ----------
  const modal = $('createModal');
  const form = $('createForm');
  let lastFocus = null;

  // "now + minutes" as a value for <input type="datetime-local"> (local time)
  function localInputValue(minutesAhead) {
    const d = new Date(Date.now() + minutesAhead * 60000);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  }

  // ---------- Place suggestions (origin / destination) ----------
  // Typing shows suggestions; picking one stores its exact map point, which is sent with the form.
  // If the admin doesn't pick one, the best match is looked up when they leave the field or submit.
  function setupPlaceField(input) {
    const field = input.closest('.place-field');
    const list = field.querySelector('.suggest');
    const status = field.querySelector('.place-status');
    const note = field.querySelector('.place-note');
    const st = { point: null, items: [], active: -1, seq: 0, timer: null };

    function setPoint(p) {
      st.point = p ? { lat: p.lat, lng: p.lng } : null;
      field.classList.toggle('located', !!p);
      status.textContent = p ? '✓' : '';
      note.textContent = p ? `On the map: ${p.name}` : '';
    }
    function close() {
      list.hidden = true;
      st.active = -1;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }
    function highlight(i) {
      st.active = i;
      [...list.children].forEach((li, j) => li.classList.toggle('active', j === i));
      if (i >= 0) {
        input.setAttribute('aria-activedescendant', list.children[i].id);
        list.children[i].scrollIntoView({ block: 'nearest' });
      }
    }
    function render(items) {
      st.items = items;
      list.textContent = '';
      items.forEach((p, i) => {
        const li = document.createElement('li');
        li.id = `${list.id}-${i}`;
        li.setAttribute('role', 'option');
        const pin = document.createElement('span');
        pin.className = 'pin';
        pin.setAttribute('aria-hidden', 'true');
        li.append(pin, document.createTextNode(p.name));
        li.addEventListener('mousedown', (ev) => { ev.preventDefault(); choose(i); });
        list.appendChild(li);
      });
      list.hidden = !items.length;
      input.setAttribute('aria-expanded', String(!!items.length));
    }
    function choose(i) {
      const p = st.items[i];
      if (!p) return;
      input.value = p.name;
      setPoint(p);
      close();
      field.classList.remove('invalid');
    }
    async function lookup(limit) {
      const q = input.value.trim();
      if (q.length < 2) return [];
      const seq = ++st.seq;
      field.classList.add('loading');
      try {
        const d = await api(`/api/admin/geocode/search?limit=${limit}&q=${encodeURIComponent(q)}`);
        return seq === st.seq ? d.places || [] : null;
      } catch (_) {
        return seq === st.seq ? [] : null;
      } finally {
        if (seq === st.seq) field.classList.remove('loading');
      }
    }

    input.addEventListener('input', () => {
      setPoint(null);
      clearTimeout(st.timer);
      if (input.value.trim().length < 2) { close(); return; }
      st.timer = setTimeout(async () => {
        const items = await lookup(5);
        if (!items) return; // a newer search is running
        render(items);
        if (!items.length) note.textContent = 'No matches yet. Try adding the state or country, e.g. "Tulsa, Oklahoma".';
      }, 350);
    });
    input.addEventListener('keydown', (e) => {
      if (list.hidden) return;
      const n = st.items.length;
      if (e.key === 'ArrowDown') { e.preventDefault(); highlight((st.active + 1) % n); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); highlight((st.active - 1 + n) % n); }
      else if (e.key === 'Enter' && st.active >= 0) { e.preventDefault(); choose(st.active); }
      else if (e.key === 'Escape') { e.stopPropagation(); close(); }
    });
    input.addEventListener('blur', () => {
      setTimeout(close, 150);
      if (!st.point && input.value.trim().length >= 2) ensure(); // resolve typed text in the background
    });

    async function ensure() {
      if (st.point) return true;
      clearTimeout(st.timer);
      const items = await lookup(1);
      if (items && items[0]) { setPoint(items[0]); return true; }
      return !!st.point;
    }
    function reset() { clearTimeout(st.timer); st.seq++; setPoint(null); close(); field.classList.remove('loading'); }
    return { st, ensure, reset };
  }
  const places = { origin: setupPlaceField($('f-origin')), destination: setupPlaceField($('f-destination')) };

  function resetForm() {
    form.reset();
    places.origin.reset();
    places.destination.reset();
    form.querySelectorAll('.field').forEach((f) => f.classList.remove('invalid'));
    $('createError').classList.remove('show');
    $('f-eta').min = localInputValue(10);
    form.hidden = false;
    $('createResult').hidden = true;
    $('createBtn').disabled = false;
    $('createBtn').textContent = 'Create Shipment';
  }

  function openModal() {
    setNav(false);
    lastFocus = document.activeElement;
    resetForm();
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    setTimeout(() => $('f-sender-name').focus(), 30);
  }

  function closeModal() {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    $('newCode').textContent = ''; // don't leave the code in the DOM
    if (lastFocus) lastFocus.focus();
  }

  document.querySelectorAll('[data-open-create]').forEach((b) => b.addEventListener('click', openModal));
  modal.querySelectorAll('[data-close-modal]').forEach((b) => b.addEventListener('click', closeModal));
  document.addEventListener('keydown', (e) => {
    if (!modal.classList.contains('open')) return;
    if (e.key === 'Escape') closeModal();
    if (e.key === 'Tab') {
      // keep focus inside the dialog
      const items = [...modal.querySelectorAll('button, [href], input, select, textarea')].filter((el) => !el.disabled && el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  $('createAnother').addEventListener('click', () => { resetForm(); $('f-sender-name').focus(); });

  function setFieldError(name, message) {
    const input = form.elements[name];
    if (!input) return;
    const field = input.closest('.field');
    field.classList.add('invalid');
    field.querySelector('.err').textContent = message;
  }

  function clientValidate(v) {
    const errors = {};
    if (!v['sender.name']) errors['sender.name'] = 'Sender name is required.';
    if (!v['sender.location']) errors['sender.location'] = 'Sender location is required.';
    if (!v['receiver.name']) errors['receiver.name'] = 'Recipient name is required.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v['receiver.email'])) errors['receiver.email'] = 'Enter a valid email address.';
    if (!/^\+?[0-9 ()-]{6,20}$/.test(v['receiver.phone'])) errors['receiver.phone'] = 'Enter a valid phone number.';
    if (!v.description) errors.description = 'Goods description is required.';
    if (!v.category) errors.category = 'Choose a goods category.';
    if (!(Number(v.weightKg) > 0)) errors.weightKg = 'Enter a weight greater than 0 kg.';
    if (!v.origin) errors.origin = 'Origin is required.';
    if (!v.destination) errors.destination = 'Destination is required.';
    if (!v.estimatedDelivery) errors.estimatedDelivery = 'Choose an estimated delivery date and time.';
    else if (new Date(v.estimatedDelivery).getTime() < Date.now() + 10 * 60000) errors.estimatedDelivery = 'Estimated delivery must be at least 10 minutes from now.';
    return errors;
  }

  form.addEventListener('input', (e) => {
    const field = e.target.closest('.field');
    if (field) field.classList.remove('invalid');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    form.querySelectorAll('.field').forEach((f) => f.classList.remove('invalid'));
    $('createError').classList.remove('show');

    const v = {};
    [...form.elements].forEach((el) => { if (el.name) v[el.name] = el.value.trim(); });

    const errors = clientValidate(v);
    if (Object.keys(errors).length) {
      Object.entries(errors).forEach(([k, m]) => setFieldError(k, m));
      const firstBad = form.querySelector('.field.invalid input, .field.invalid select, .field.invalid textarea');
      if (firstBad) firstBad.focus();
      return;
    }

    const btn = $('createBtn');
    btn.disabled = true;
    btn.textContent = 'Finding places…';

    // Both places must be on the map before the shipment is created
    const [originOk, destOk] = await Promise.all([places.origin.ensure(), places.destination.ensure()]);
    if (!originOk || !destOk) {
      if (!originOk) setFieldError('origin', "We couldn't find this place on the map. Pick a suggestion, or add the state/country.");
      if (!destOk) setFieldError('destination', "We couldn't find this place on the map. Pick a suggestion, or add the state/country.");
      (originOk ? $('f-destination') : $('f-origin')).focus();
      btn.disabled = false;
      btn.textContent = 'Create Shipment';
      return;
    }

    const payload = {
      sender: { name: v['sender.name'], location: v['sender.location'] },
      receiver: { name: v['receiver.name'], email: v['receiver.email'], phone: v['receiver.phone'] },
      description: v.description,
      category: v.category,
      weightKg: Number(v.weightKg),
      origin: $('f-origin').value.trim(),
      destination: $('f-destination').value.trim(),
      originPoint: places.origin.st.point,
      destinationPoint: places.destination.st.point,
      estimatedDelivery: new Date(v.estimatedDelivery).toISOString(), // local date & time -> UTC
    };

    btn.textContent = 'Creating…';
    try {
      const data = await api('/api/admin/shipments', { method: 'POST', body: JSON.stringify(payload) });
      $('newCode').textContent = data.trackingCode;
      $('viewNewBtn').href = '/admin/shipments/' + encodeURIComponent(data.shipment.id);
      $('copyBtn').textContent = 'Copy';

      $('geoNote').hidden = false;
      $('geoNote').textContent = 'The parcel is on its way. It moves along the road and arrives at the estimated delivery time.';

      form.hidden = true;
      $('createResult').hidden = false;
      $('copyBtn').focus();
      loadStats();
      state.page = 1;
      loadShipments();
    } catch (err) {
      if (err.message === 'unauthorized') return;
      const fields = err.data && err.data.fields;
      if (fields) Object.entries(fields).forEach(([k, m]) => setFieldError(k, m));
      $('createError').textContent = err.message || 'Could not create the shipment.';
      $('createError').classList.add('show');
      btn.disabled = false;
      btn.textContent = 'Create Shipment';
    }
  });

  // ---------- Copy code ----------
  $('copyBtn').addEventListener('click', async () => {
    const code = $('newCode').textContent;
    let ok = false;
    try {
      await navigator.clipboard.writeText(code);
      ok = true;
    } catch (_) {
      // Fallback for non-secure contexts
      const ta = document.createElement('textarea');
      ta.value = code;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch (__) {}
      ta.remove();
    }
    $('copyBtn').textContent = ok ? 'Copied ✓' : 'Copy failed';
    setTimeout(() => { $('copyBtn').textContent = 'Copy'; }, 2000);
  });

  init();
  // Links from other admin pages: /admin/dashboard#new opens the create form
  if (window.location.hash === '#new') {
    history.replaceState(null, '', '/admin/dashboard');
    openModal();
  }
})();

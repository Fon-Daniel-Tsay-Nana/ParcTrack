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
        const view = document.createElement('a');
        view.className = 'btn btn-outline btn-sm';
        view.href = '/admin/shipments/' + encodeURIComponent(s.id);
        view.textContent = 'View';
        tr.appendChild(td('', view, 'actions'));
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

  function resetForm() {
    form.reset();
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

    const payload = {
      sender: { name: v['sender.name'], location: v['sender.location'] },
      receiver: { name: v['receiver.name'], email: v['receiver.email'], phone: v['receiver.phone'] },
      description: v.description,
      category: v.category,
      weightKg: Number(v.weightKg),
      origin: v.origin,
      destination: v.destination,
      estimatedDelivery: new Date(v.estimatedDelivery).toISOString(), // local date & time -> UTC
    };

    const btn = $('createBtn');
    btn.disabled = true;
    btn.textContent = 'Creating…';
    try {
      const data = await api('/api/admin/shipments', { method: 'POST', body: JSON.stringify(payload) });
      $('newCode').textContent = data.trackingCode;
      $('viewNewBtn').href = '/admin/shipments/' + encodeURIComponent(data.shipment.id);
      $('copyBtn').textContent = 'Copy';

      const missing = [];
      if (!data.geocoded.origin) missing.push('origin');
      if (!data.geocoded.destination) missing.push('destination');
      $('geoNote').hidden = !missing.length;
      $('geoNote').hidden = false;
      $('geoNote').textContent = missing.length
        ? `Map coordinates could not be found for the ${missing.join(' and ')}. Set them on the shipment page, then press "Start journey".`
        : 'The parcel is on its way. It moves along the road and arrives at the estimated delivery time.';

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

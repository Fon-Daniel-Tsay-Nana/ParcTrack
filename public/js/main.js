// ParcTrack Logistics - homepage behaviour
(function () {
  const TRACKING_CODE_RE = /^[0-9A-F]{16}$/;

  document.getElementById('year').textContent = new Date().getFullYear();

  // ---- Mobile navigation ----
  const navToggle = document.getElementById('navToggle');
  const nav = document.getElementById('mainNav');

  function setNav(open) {
    nav.classList.toggle('open', open);
    navToggle.setAttribute('aria-expanded', String(open));
    navToggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  }

  navToggle.addEventListener('click', () => setNav(!nav.classList.contains('open')));
  nav.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => setNav(false)));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setNav(false); });

  // ---- Tracking form ----
  const form = document.getElementById('trackForm');
  const input = document.getElementById('trackingCode');
  const button = document.getElementById('trackBtn');
  const errorBox = document.getElementById('trackError');

  function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.add('show');
    input.classList.add('is-invalid');
    input.setAttribute('aria-invalid', 'true');
  }

  function clearError() {
    errorBox.textContent = '';
    errorBox.classList.remove('show');
    input.classList.remove('is-invalid');
    input.removeAttribute('aria-invalid');
  }

  function setLoading(loading) {
    button.disabled = loading;
    button.textContent = loading ? 'Checking…' : 'Track Now';
  }

  // Keep the field uppercase and strip spaces as the user types/pastes
  input.addEventListener('input', () => {
    const cleaned = input.value.replace(/\s+/g, '').toUpperCase();
    if (cleaned !== input.value) input.value = cleaned;
    if (errorBox.classList.contains('show')) clearError();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();

    const code = input.value.replace(/\s+/g, '').toUpperCase();

    if (!code) {
      showError('Please enter your tracking code.');
      input.focus();
      return;
    }
    if (!TRACKING_CODE_RE.test(code)) {
      showError('Invalid tracking code. It must be exactly 16 characters using digits 0–9 and letters A–F.');
      input.focus();
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/tracking/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackingCode: code }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.ok) {
        window.location.href = '/track/' + encodeURIComponent(data.trackingCode);
        return;
      }
      showError(data.error || 'We could not find that shipment. Please check the code and try again.');
    } catch (err) {
      showError('Unable to reach the server. Please check your connection and try again.');
    }
    setLoading(false);
    input.focus();
  });
})();

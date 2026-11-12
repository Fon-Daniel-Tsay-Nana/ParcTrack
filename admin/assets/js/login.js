// Admin login -> POST /api/admin/login (session is set as an httpOnly cookie)
(function () {
  const form = document.getElementById('loginForm');
  const email = document.getElementById('email');
  const password = document.getElementById('password');
  const btn = document.getElementById('loginBtn');
  const errorBox = document.getElementById('loginError');
  const pwToggle = document.getElementById('pwToggle');

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.classList.add('show');
  }

  pwToggle.addEventListener('click', () => {
    const show = password.type === 'password';
    password.type = show ? 'text' : 'password';
    pwToggle.textContent = show ? 'Hide' : 'Show';
    pwToggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.classList.remove('show');

    const emailVal = email.value.trim();
    if (!emailVal || !password.value) {
      showError('Please enter your email and password.');
      (emailVal ? password : email).focus();
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email: emailVal, password: password.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        window.location.replace('/admin/dashboard');
        return;
      }
      showError(data.error || 'Sign in failed. Please try again.');
      password.value = '';
      password.focus();
    } catch (_) {
      showError('Unable to reach the server. Please check your connection.');
    }
    btn.disabled = false;
    btn.textContent = 'Sign in';
  });
})();

(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  let mode = location.hash === '#signup' ? 'up' : 'in';

  function render() {
    const up = mode === 'up';
    $('tabIn').setAttribute('aria-selected', String(!up));
    $('tabUp').setAttribute('aria-selected', String(up));
    $('authTitle').textContent = up ? 'Create your account' : 'Welcome back';
    $('authSub').textContent = up ? 'Free. Bring your own API key if you want the AI to run on it.' : 'Sign in to use your own API keys and connect MCP servers.';
    $('nameField').hidden = !up;
    $('pwHint').hidden = !up;
    $('password').autocomplete = up ? 'new-password' : 'current-password';
    $('submit').textContent = up ? 'Create account' : 'Sign in';
    $('err').hidden = true;
  }
  $('tabIn').addEventListener('click', () => { mode = 'in'; history.replaceState(null, '', '#'); render(); });
  $('tabUp').addEventListener('click', () => { mode = 'up'; history.replaceState(null, '', '#signup'); render(); });
  render();
  // The header's "Sign up" link only changes the #hash when you are already on this page.
  window.addEventListener('hashchange', () => { mode = location.hash === '#signup' ? 'up' : 'in'; render(); });

  fetch('/api/me').then(r => r.json()).then(d => { if (d.user) location.replace('/account.html'); }).catch(() => {});

  $('authForm').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('err');
    err.hidden = true;
    const email = $('email').value.trim();
    const password = $('password').value;
    if (!email || !password) { err.textContent = 'Enter your email and password.'; err.hidden = false; return; }
    const btn = $('submit');
    btn.disabled = true;
    try {
      const res = await fetch(mode === 'up' ? '/api/auth/signup' : '/api/auth/login', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password, name: $('name').value }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { err.textContent = d.error || 'Something went wrong. Try again.'; err.hidden = false; return; }
      location.href = '/account.html';
    } catch {
      err.textContent = 'Could not reach the server. Check your connection.';
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
})();

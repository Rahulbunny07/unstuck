(function () {
  'use strict';
  const host = document.getElementById('navAuth');
  if (!host) return;

  function el(tag, props, text) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) e.setAttribute(k, v);
    if (text) e.textContent = text;
    return e;
  }

  fetch('/api/me').then(r => r.json()).then(({ user }) => {
    host.replaceChildren();
    if (user) {
      host.append(el('a', { href: '/account.html', class: 'navlink' }, user.name || user.email));
      const out = el('button', { type: 'button', class: 'navlink btnlink' }, 'Sign out');
      out.addEventListener('click', async () => {
        await fetch('/api/auth/logout', { method: 'POST' });
        location.href = '/';
      });
      host.append(out);
    } else {
      host.append(el('a', { href: '/auth.html', class: 'navlink' }, 'Sign in'));
      host.append(el('a', { href: '/auth.html#signup', class: 'navcta' }, 'Sign up'));
    }
  }).catch(() => {});
})();

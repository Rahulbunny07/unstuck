(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const get = () => { try { return sessionStorage.getItem('unstuck_admin') || ''; } catch { return ''; } };
  const put = v => { try { sessionStorage.setItem('unstuck_admin', v); } catch { /* storage blocked */ } };

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
    return el;
  }

  async function api(path, method, body) {
    const res = await fetch(path, { method: method || 'GET', headers: { 'x-admin-token': get(), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || 'Something went wrong.');
    return d;
  }

  async function load() {
    $('err').hidden = true;
    try {
      const { claims } = await api('/api/admin/claims');
      $('gate').hidden = true;
      const list = $('list');
      if (!claims.length) { list.replaceChildren(h('p', { class: 'empty', text: 'No claims waiting.' })); return; }
      list.replaceChildren(...claims.map(c => {
        const credits = h('input', { type: 'text', value: '20', 'aria-label': 'Credits to add', class: 'creditbox' });
        const msg = h('p', { class: 'form-error', role: 'alert', hidden: true });
        const act = (path, body) => async () => {
          try { await api(path, 'POST', body); load(); } catch (e) { msg.textContent = e.message; msg.hidden = false; }
        };
        return h('div', { class: 'card item col' },
          h('div', { class: 'item-main' }, h('b', { text: c.payment_ref }), h('span', { class: 'meta', text: c.email }), h('span', { class: 'meta', text: c.created_at })),
          c.note ? h('p', { class: 'meta', text: 'Note: ' + c.note }) : null,
          h('div', { class: 'item-actions' },
            h('label', { class: 'meta' }, 'Credits: ', credits),
            h('button', { type: 'button', class: 'primary sm', text: 'Approve', onclick: () => act(`/api/admin/claims/${c.id}/approve`, { credits: Number(credits.value) })() }),
            h('button', { type: 'button', class: 'ghost sm danger', text: 'Reject', onclick: act(`/api/admin/claims/${c.id}/reject`) })),
          msg);
      }));
    } catch (e) {
      $('gate').hidden = false;
      $('err').textContent = e.message; $('err').hidden = false;
    }
  }

  $('go').addEventListener('click', () => { put($('tok').value.trim()); load(); });
  $('tok').addEventListener('keydown', e => { if (e.key === 'Enter') $('go').click(); });
  if (get()) load();
})();

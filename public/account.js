(function () {
  'use strict';
  const $ = id => document.getElementById(id);

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
    const res = await fetch(path, { method: method || 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const d = await res.json().catch(() => ({}));
    if (res.status === 401) { location.href = '/auth.html'; throw new Error('signed out'); }
    if (!res.ok) throw new Error(d.error || 'Something went wrong. Try again.');
    return d;
  }

  const PROV = { anthropic: 'Anthropic', openai: 'OpenAI', groq: 'Groq', custom: 'Custom', agenticorg: 'AgenticOrg' };
  $('provider').addEventListener('change', () => {
    const p = $('provider').value;
    $('customFields').hidden = p !== 'custom' && p !== 'agenticorg';
    $('baseField').hidden = p === 'agenticorg';
    $('kmodelLabel').textContent = p === 'agenticorg' ? 'Agent ID' : 'Model name';
    $('kmodelHint').hidden = p !== 'agenticorg';
    $('kmodel').placeholder = p === 'agenticorg' ? '00000000-0000-0000-0000-000000000000' : "As written in the provider's docs";
  });

  function showErr(id, msg) { const e = $(id); e.textContent = msg || ''; e.hidden = !msg; }

  function renderKeys(keys) {
    const host = $('keyList');
    host.replaceChildren();
    if (!keys.length) { host.append(h('p', { class: 'empty', text: 'No keys yet. Without one, new errors use the site owner\'s AI if available.' })); return; }
    keys.forEach(k => host.append(h('div', { class: 'item' },
      h('div', { class: 'item-main' },
        h('b', { text: `${PROV[k.provider] || k.provider}${k.label ? ' - ' + k.label : ''}` }),
        h('span', { class: 'meta', text: `ends in ${k.last4}${k.model ? ' - ' + k.model : ''}` }),
        k.isDefault ? h('span', { class: 'badge confirmed', text: 'Default' }) : null),
      h('div', { class: 'item-actions' },
        k.isDefault ? null : h('button', { type: 'button', class: 'ghost sm', text: 'Make default', onclick: async () => renderKeys((await api(`/api/keys/${k.id}/default`, 'POST')).keys) }),
        h('button', { type: 'button', class: 'ghost sm danger', text: 'Remove', onclick: async () => { if (confirm('Remove this key?')) renderKeys((await api(`/api/keys/${k.id}`, 'DELETE')).keys); } })))));
  }

  $('keyForm').addEventListener('submit', async e => {
    e.preventDefault();
    showErr('keyErr', '');
    const key = $('kval').value.trim();
    if (!key) { showErr('keyErr', 'Paste your API key first.'); return; }
    const btn = $('keyBtn');
    btn.disabled = true; btn.textContent = 'Checking with provider...';
    try {
      await api('/api/keys', 'POST', { provider: $('provider').value, label: $('klabel').value, key, baseUrl: $('kbase').value, model: $('kmodel').value });
      $('kval').value = ''; $('klabel').value = '';
      renderKeys((await api('/api/keys')).keys);
    } catch (err) { showErr('keyErr', err.message); }
    finally { btn.disabled = false; btn.textContent = 'Check and save key'; }
  });

  let catalog = [];
  let picked = null;

  function renderCatalog() {
    const host = $('catChips');
    host.replaceChildren();
    catalog.forEach(c => {
      const b = h('button', { type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(picked === c.id), text: c.name });
      b.addEventListener('click', () => {
        picked = c.id;
        $('murl').value = c.url;
        $('catHint').textContent = c.hint;
        renderCatalog();
      });
      host.append(b);
    });
  }

  function renderMcp(list) {
    const host = $('mcpList');
    host.replaceChildren();
    if (!list.length) { host.append(h('p', { class: 'empty', text: 'No servers connected yet.' })); return; }
    list.forEach(s => {
      const enabled = new Set(s.enabledTools);
      const toolsBox = h('div', { class: 'tools' });
      s.tools.forEach(t => {
        const cb = h('input', { type: 'checkbox', id: `t${s.id}_${t.name}` });
        cb.checked = enabled.has(t.name);
        cb.addEventListener('change', async () => {
          const names = [...toolsBox.querySelectorAll('input:checked')].map(i => i.dataset.name);
          try { await api(`/api/mcp/${s.id}/tools`, 'POST', { enabled: names }); } catch (err) { cb.checked = !cb.checked; alert(err.message); }
        });
        cb.dataset.name = t.name;
        toolsBox.append(h('label', { class: 'tool', for: cb.id }, cb, h('span', {}, h('b', { text: t.name }), ' ', h('span', { class: 'tag ' + (t.readOnly ? 'ro' : 'rw'), text: t.readOnly ? 'read-only' : 'can change things' }), t.description ? h('span', { class: 'meta block', text: t.description }) : null)));
      });
      const msg = h('p', { class: 'form-error', role: 'alert', hidden: true });
      host.append(h('div', { class: 'item col' },
        h('div', { class: 'item-main' },
          h('b', { text: s.name }),
          h('span', { class: 'meta', text: s.server.name ? `${s.server.name} ${s.server.version || ''}`.trim() : s.url }),
          h('span', { class: 'meta', text: `${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}, ${s.enabledTools.length} on` })),
        h('div', { class: 'item-actions' },
          h('button', { type: 'button', class: 'ghost sm', text: 'Re-check', onclick: async () => { try { await api(`/api/mcp/${s.id}/test`, 'POST'); renderMcp((await api('/api/mcp')).servers); } catch (err) { msg.textContent = err.message; msg.hidden = false; } } }),
          h('button', { type: 'button', class: 'ghost sm danger', text: 'Remove', onclick: async () => { if (confirm('Remove this server?')) renderMcp((await api(`/api/mcp/${s.id}`, 'DELETE')).servers); } })),
        msg,
        s.tools.length ? h('details', { class: 'more' }, h('summary', { text: 'Choose which tools Unstuck may use' }), toolsBox) : null));
    });
  }

  $('mcpForm').addEventListener('submit', async e => {
    e.preventDefault();
    showErr('mcpErr', '');
    if (!picked) { showErr('mcpErr', 'Choose a server first.'); return; }
    const url = $('murl').value.trim();
    if (!url) { showErr('mcpErr', 'Enter the server URL.'); return; }
    const btn = $('mcpBtn');
    btn.disabled = true; btn.textContent = 'Connecting...';
    try {
      await api('/api/mcp', 'POST', { catalogId: picked, url, token: $('mtoken').value });
      $('mtoken').value = '';
      renderMcp((await api('/api/mcp')).servers);
    } catch (err) { showErr('mcpErr', err.message); }
    finally { btn.disabled = false; btn.textContent = 'Connect and check'; }
  });

  const money = paise => '₹' + (paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const STATUS = { PAID: 'Paid', PENDING: 'Waiting for payment', CREATED: 'Started', FAILED: 'Failed', CANCELLED: 'Cancelled', MISMATCH: 'Needs review' };

  function renderBilling(b) {
    $('balanceNum').textContent = b.balance;
    $('testNote').hidden = !(b.configured && b.testMode);
    const list = $('packList');
    list.replaceChildren();
    if (!b.configured) {
      list.append(h('p', { class: 'empty', text: b.reason === 'storage'
        ? 'Buying credits is paused until the site has permanent storage, so nobody pays and then loses their credits.'
        : 'Pay with the Razorpay button, then tell us your payment ID. We check it and add your credits.' }),
      h('a', { class: 'primary sm linkbtn', href: '/pay.html', text: 'Buy credits' }));
    } else {
      b.packs.forEach(p => list.append(h('div', { class: 'pack' },
        h('b', { text: p.label }),
        h('span', { class: 'meta', text: money(p.paise) }),
        h('button', { type: 'button', class: 'primary sm', text: 'Buy', onclick: e => buy(p.id, e.currentTarget) }))));
    }
    $('historyBox').hidden = !b.orders.length;
    $('orderList').replaceChildren(...b.orders.map(o => h('div', { class: 'item' },
      h('div', { class: 'item-main' }, h('b', { text: `${o.credits} credits` }), h('span', { class: 'meta', text: money(o.amount_paise) }), h('span', { class: 'meta', text: o.created_at })),
      h('span', { class: 'badge ' + (o.status === 'PAID' ? 'confirmed' : o.status === 'PENDING' || o.status === 'CREATED' ? 'unverified' : 'curated'), text: STATUS[o.status] || o.status }))));
  }

  function say(text) { const b = $('payBanner'); b.textContent = text; b.hidden = !text; }

  function loadRazorpay() {
    return new Promise((resolve, reject) => {
      if (window.Razorpay) return resolve();
      const s = document.createElement('script');
      s.src = 'https://checkout.razorpay.com/v1/checkout.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load the payment window. Check your connection or an ad blocker, then try again.'));
      document.head.append(s);
    });
  }

  // Razorpay's window runs on Razorpay's own page, so card and UPI details never reach this site.
  async function openRazorpay(o, btn) {
    await loadRazorpay();
    const reset = () => { btn.disabled = false; btn.textContent = 'Buy'; };
    const rzp = new window.Razorpay({
      key: o.key, amount: o.amount, currency: o.currency, name: o.name, description: o.description,
      order_id: o.order_id, prefill: o.prefill, theme: { color: '#4f46e5' },
      handler: async resp => {
        say('Confirming your payment...');
        try {
          const v = await api('/api/billing/razorpay/verify', 'POST', resp);
          say(v.outcome === 'success' ? 'Payment received. Your credits are added.'
            : v.outcome === 'failed' ? 'The payment did not go through. If money left your account, contact us.'
              : 'Your payment is still being confirmed. This page will update when it is.');
          renderBilling(await api('/api/billing/me'));
        } catch (err) {
          say('We could not confirm the payment yet. If money left your account it will be credited automatically, or reload this page in a minute.');
          reset();
        }
      },
      modal: { ondismiss: reset },
    });
    rzp.on('payment.failed', () => say('The payment did not go through, and nothing was charged. You can try again.'));
    rzp.open();
  }

  async function buy(packId, btn) {
    showErr('buyErr', '');
    btn.disabled = true; btn.textContent = 'Starting...';
    try {
      const r = await api('/api/billing/checkout', 'POST', { packId });
      if (r.provider === 'razorpay') await openRazorpay(r, btn);
      else location.href = r.url;
    } catch (err) { showErr('buyErr', err.message); btn.disabled = false; btn.textContent = 'Buy'; }
  }

  async function initBilling() {
    const banner = $('payBanner');
    const result = new URLSearchParams(location.search).get('payment');
    const say = {
      success: 'Payment received. Your credits are added.',
      pending: 'Your payment is still being confirmed. This page will update, or check again in a minute.',
      failed: 'The payment did not go through, and nothing was charged. You can try again.',
      unknown: 'We could not match that payment to an order. If money left your account, contact us with the time and amount.',
    }[result];
    if (say) { banner.textContent = say; banner.hidden = false; history.replaceState(null, '', location.pathname); }
    try {
      // Pick up payments finished in another tab, or before the redirect back reached us.
      await api('/api/billing/reconcile', 'POST', {});
    } catch { /* optional */ }
    try { renderBilling(await api('/api/billing/me')); } catch { /* signed out or offline */ }
  }

  (async function init() {
    try {
      const me = await api('/api/me');
      if (!me.user) { location.href = '/auth.html'; return; }
      $('who').textContent = me.user.name ? `Hi, ${me.user.name}` : me.user.email;
      initBilling();
      renderKeys((await api('/api/keys')).keys);
      catalog = (await api('/api/mcp/catalog')).catalog;
      renderCatalog();
      renderMcp((await api('/api/mcp')).servers);
    } catch { /* redirected or offline */ }
  })();
})();

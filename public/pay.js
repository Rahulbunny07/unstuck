(function () {
  'use strict';
  const $ = id => document.getElementById(id);

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
    return el;
  }

  const STATUS = { PENDING: 'Waiting for a check', APPROVED: 'Credits added', REJECTED: 'Not accepted' };
  const KIND = { PENDING: 'unverified', APPROVED: 'confirmed', REJECTED: 'curated' };

  async function load() {
    const me = await fetch('/api/me').then(r => r.json()).catch(() => ({ user: null }));
    if (!me.user) { $('signedOut').hidden = false; return; }
    $('claimForm').hidden = false;
    $('balanceRow').hidden = false;
    refresh();
  }

  async function refresh() {
    const r = await fetch('/api/billing/claims');
    if (!r.ok) return;
    const d = await r.json();
    $('balanceNum').textContent = d.balance;
    $('claimList').replaceChildren(...d.claims.map(c => h('div', { class: 'item' },
      h('div', { class: 'item-main' }, h('b', { text: c.payment_ref }), h('span', { class: 'meta', text: c.created_at })),
      h('span', { class: 'badge ' + KIND[c.status], text: c.status === 'APPROVED' && c.credits ? `${c.credits} credits added` : STATUS[c.status] }))));
  }

  $('claimForm').addEventListener('submit', async e => {
    e.preventDefault();
    $('claimErr').hidden = true; $('claimOk').hidden = true;
    const paymentId = $('payId').value.trim();
    if (!paymentId) { $('claimErr').textContent = 'Paste your payment ID first.'; $('claimErr').hidden = false; return; }
    const btn = $('claimBtn');
    btn.disabled = true;
    try {
      const res = await fetch('/api/billing/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paymentId, note: $('payNote').value }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { $('claimErr').textContent = d.error || 'Something went wrong. Try again.'; $('claimErr').hidden = false; return; }
      $('claimOk').textContent = 'Thanks. We will check this payment and add your credits.';
      $('claimOk').hidden = false;
      $('payId').value = ''; $('payNote').value = '';
      refresh();
    } catch {
      $('claimErr').textContent = 'Could not reach the server. Check your connection.'; $('claimErr').hidden = false;
    } finally { btn.disabled = false; }
  });

  load();
})();

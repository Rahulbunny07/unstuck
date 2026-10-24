(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
    return el;
  }
  async function api(path, method, body) {
    const res = await fetch(path, { method: method || 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const d = await res.json().catch(() => ({}));
    if (res.status === 401) { location.href = '/auth.html'; throw new Error('Sign in first.'); }
    if (!res.ok) throw new Error(d.error || 'Something went wrong.');
    return d;
  }
  const show = (id, msg) => { const e = $(id); e.textContent = msg || ''; e.hidden = !msg; };
  const KIND = { APPROVED: 'confirmed', PENDING: 'unverified', REJECTED: 'curated' };
  const LABEL = { APPROVED: 'Approved', PENDING: 'Waiting for the owner', REJECTED: 'Rejected' };

  function render(d) {
    $('noTeam').hidden = Boolean(d.team);
    $('hasTeam').hidden = !d.team;
    if (!d.team) return;
    const owner = d.team.role === 'owner';
    $('teamTitle').textContent = d.team.name;
    $('teamMeta').textContent = owner
      ? `You are the owner. Share this code so teammates can join: ${d.team.join_code}. Their records wait for your approval.`
      : 'You are a member. Your records wait for the owner to approve them.';
    $('recList').replaceChildren(...(d.records.length ? d.records.map(r => h('div', { class: 'card item col' },
      h('div', { class: 'item-main' }, h('b', { text: r.title }), h('span', { class: 'badge ' + KIND[r.status], text: LABEL[r.status] })),
      r.environment ? h('p', { class: 'meta', text: 'Environment: ' + r.environment }) : null,
      h('p', { class: 'meta', text: 'Cause: ' + r.cause }),
      h('p', { class: 'meta', text: 'Resolution: ' + r.resolution }),
      owner && r.status === 'PENDING' ? h('div', { class: 'item-actions' },
        h('button', { type: 'button', class: 'primary sm', text: 'Approve', onclick: () => decide(r.id, 'approve') }),
        h('button', { type: 'button', class: 'ghost sm danger', text: 'Reject', onclick: () => decide(r.id, 'reject') })) : null))
      : [h('p', { class: 'empty', text: 'No records yet. Add the first one above.' })]));
  }

  const load = async () => render(await api('/api/team'));
  async function decide(id, action) { try { await api(`/api/team/records/${id}/${action}`, 'POST', {}); load(); } catch (e) { show('recErr', e.message); } }

  $('createForm').addEventListener('submit', async e => { e.preventDefault(); show('teamErr'); try { await api('/api/team', 'POST', { name: $('teamName').value }); load(); } catch (x) { show('teamErr', x.message); } });
  $('joinForm').addEventListener('submit', async e => { e.preventDefault(); show('teamErr'); try { await api('/api/team/join', 'POST', { code: $('joinCode').value }); load(); } catch (x) { show('teamErr', x.message); } });
  $('recForm').addEventListener('submit', async e => {
    e.preventDefault(); show('recErr'); show('recOk');
    try {
      const r = await api('/api/team/records', 'POST', { title: $('rTitle').value, signature: $('rSig').value, environment: $('rEnv').value, cause: $('rCause').value, resolution: $('rRes').value, verification: $('rVer').value, rollback: $('rRoll').value });
      ['rTitle', 'rSig', 'rEnv', 'rCause', 'rRes', 'rVer', 'rRoll'].forEach(i => { $(i).value = ''; });
      show('recOk', r.status === 'APPROVED' ? 'Saved and approved.' : 'Saved. The owner will review it.');
      load();
    } catch (x) { show('recErr', x.message); }
  });
  load().catch(() => {});
})();

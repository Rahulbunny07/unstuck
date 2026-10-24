(function () {
  'use strict';

  const TOOLS = [['lovable', 'Lovable'], ['replit', 'Replit'], ['bolt', 'Bolt'], ['cursor', 'Cursor'], ['other', 'Other']];
  const PLATS = [['supabase', 'Supabase'], ['vercel', 'Vercel'], ['netlify', 'Netlify'], ['firebase', 'Firebase'], ['other', 'Not sure']];

  const SAMPLES = {
    rls: 'Error: new row violates row-level security policy for table "todos"\n    at insertTodo (src/lib/api.ts:41:11)\ncode: 42501\nmessage: new row violates row-level security policy for table "todos"',
    cors: "Access to fetch at 'https://api.myapp.com/orders' from origin 'https://myapp.lovable.app' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.",
    novel: "Uncaught ReferenceError: process is not defined\n    at Object.<anonymous> (src/config.ts:3:21)\n    at __require (chunk-3XJ2KQ.js:12:50)\nThe app worked in the preview but shows a white screen after publishing.",
  };

  const $ = id => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
  };
  const rid = () => {
    const a = new Uint8Array(12);
    crypto.getRandomValues(a);
    return Array.from(a, b => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
  };

  const state = {
    tool: 'lovable', platform: 'other',
    userId: store.get('unstuck_uid') || rid(),
    sessionId: null, sample: false, sampleText: null, busy: false, attemptId: null,
  };
  store.set('unstuck_uid', state.userId);

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

  function chipGroup(host, items, key) {
    host.replaceChildren();
    items.forEach(([val, label]) => {
      const b = h('button', { type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(state[key] === val), 'data-v': val, text: label });
      b.addEventListener('click', () => {
        state[key] = val;
        host.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-checked', String(c.dataset.v === val)));
      });
      host.append(b);
    });
  }

  chipGroup($('toolChips'), TOOLS, 'tool');
  chipGroup($('platChips'), PLATS, 'platform');

  const errorBox = $('errorBox');
  const updateCount = () => { $('count').textContent = errorBox.value.length.toLocaleString() + ' characters'; };
  errorBox.addEventListener('input', updateCount);
  updateCount();

  document.querySelectorAll('[data-sample]').forEach(b => b.addEventListener('click', () => {
    const t = SAMPLES[b.dataset.sample];
    errorBox.value = t;
    state.sampleText = t;
    updateCount();
    errorBox.focus();
  }));

  // Config files are read in the browser and appended to the config box. Nothing is uploaded
  // until the user presses Get fix, and secrets are removed on the server before analysis.
  $('ctxFile').addEventListener('change', async e => {
    const note = $('fileNote');
    const added = [];
    const skipped = [];
    for (const file of e.target.files) {
      if (file.size > 60 * 1024) { skipped.push(`${file.name} (over 60 KB)`); continue; }
      let text;
      try { text = await file.text(); } catch { skipped.push(`${file.name} (could not read)`); continue; }
      if (text.includes('\u0000')) { skipped.push(`${file.name} (not a text file)`); continue; }
      $('ctxBox').value += `${$('ctxBox').value ? '\n\n' : ''}// file: ${file.name}\n${text.trim()}`;
      added.push(file.name);
    }
    if ($('ctxBox').value.length > 4000) skipped.push('only the first 4,000 characters of all files together are analysed');
    note.textContent = (added.length ? `Added ${added.join(', ')}. ` : '') + (skipped.length ? `Skipped or limited: ${skipped.join('; ')}.` : '');
    e.target.value = '';
    if (added.length) $('more').open = true;
  });

  function showFormError(msg) {
    const el = $('formError');
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  function newProblem() {
    state.sessionId = null;
    state.attemptId = null;
    $('out').replaceChildren();
    $('newBtn').hidden = true;
    showFormError('');
    errorBox.focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  $('newBtn').addEventListener('click', newProblem);

  function loadingView() {
    const steps = ['Cleaning your log and removing secrets', 'Checking known fixes', 'Working out the root cause'];
    const rows = steps.map(s => h('div', { class: 'row' }, h('span', { class: 'spin' }), h('span', { text: s })));
    const queueNote = h('p', { class: 'queue', hidden: true });
    const box = h('div', { class: 'card loading', role: 'status' }, rows, queueNote);
    let i = 0;
    const timer = setInterval(() => {
      if (i < rows.length - 1) {
        rows[i].classList.add('done');
        rows[i].firstChild.replaceWith(h('span', { class: 'tick', text: '✓' }));
        i += 1;
      }
    }, 900);
    // If the AI is busy, say so instead of leaving a silent spinner.
    const poll = setInterval(async () => {
      try {
        const q = await (await fetch('/api/queue')).json();
        if (q.enabled && q.waiting > 0 && q.etaSeconds >= 2) {
          queueNote.textContent = `Lots of people are using Unstuck right now. ${q.waiting} ${q.waiting === 1 ? 'request is' : 'requests are'} in line, about ${q.etaSeconds} seconds to go.`;
          queueNote.hidden = false;
        } else queueNote.hidden = true;
      } catch { /* the note is optional */ }
    }, 2000);
    return { node: box, stop: () => { clearInterval(timer); clearInterval(poll); } };
  }

  async function copyText(text, btn, done) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = h('textarea', { 'aria-hidden': 'true' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
    }
    const old = btn.textContent;
    btn.textContent = done;
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = old; btn.classList.remove('copied'); }, 1800);
  }

  function section(n, title, ...kids) {
    return h('div', { class: 'sec' }, h('h3', {}, h('span', { class: 'num', text: String(n) }), title), kids);
  }

  function renderResult(d) {
    const f = d.fix;
    const out = $('out');
    out.replaceChildren();

    const dots = h('div', { class: 'att', 'aria-label': `Attempt ${d.attempt} of ${d.maxAttempts}` },
      Array.from({ length: d.maxAttempts }, (_, i) => h('i', { class: i < d.attempt ? 'on' : '' })));

    const metaBits = [];
    if (d.source === 'team') metaBits.push(`Matched a validated record from your team (${d.match}% similar). No AI used.`);
    else if (d.source === 'library') metaBits.push(`Matched a known fix (${d.match}% similar). No AI used.`);
    else metaBits.push('New error: written by AI just now' + (d.tokens && d.tokens.in + d.tokens.out ? ` (${(d.tokens.in + d.tokens.out).toLocaleString()} AI tokens used).` : '.'));
    if (d.quota && d.quota.usedCredit) metaBits.push(`1 credit used, ${d.quota.credits} left.`);
    else if (d.quota) metaBits.push(`${d.quota.remaining} of ${d.quota.limit} free AI answers left today${d.quota.signedIn ? (d.quota.credits ? ` (plus ${d.quota.credits} credits)` : '') : ' (sign in for more)'}.`);
    if (d.redactions) metaBits.push(`${d.redactions} secret${d.redactions === 1 ? '' : 's'} removed.`);
    if (d.trimmed) metaBits.push('Long log shortened to the useful lines.');

    const card = h('article', { class: 'card' },
      h('div', { class: 'res-top' }, h('span', { class: 'badge ' + f.badge.kind, text: f.badge.label }), h('span', { class: 'meta', text: `Attempt ${d.attempt} of ${d.maxAttempts}` })),
      dots,
      h('h2', { class: 'title', text: f.title }),
      h('p', { class: 'meta', text: metaBits.join(' ') }),
      traceBox(d.trace),
      siteBox(d.site),
      section(1, 'Why it broke',
        h('p', { text: f.cause }),
        f.evidence && f.evidence.length ? h('ul', { class: 'ev' }, f.evidence.map(e => h('li', { text: e }))) : null,
        f.evidence_note ? h('p', { class: 'meta', text: f.evidence_note }) : null,
        f.env_note ? h('div', { class: 'need', text: f.env_note }) : null,
        h('p', { class: 'conf ' + f.confidence }, 'Confidence: ', h('b', { text: f.confidence }))),
      d.source === 'ai' && (f.need_more || f.confidence === 'low') ? evidenceBox(f.need_more) : null,
      section(2, 'Paste this into your builder',
        h('div', { class: 'codebox', id: 'promptText', text: f.fix_prompt }),
        h('div', { class: 'copyrow' },
          h('button', { type: 'button', class: 'copybtn', text: 'Copy prompt', onclick: e => copyText(f.fix_prompt, e.currentTarget, 'Copied') }),
          h('span', { class: 'meta', text: 'One small change. It tells the builder not to touch anything else.' }))),
      section(3, 'How to check it worked', h('p', { text: f.verify_steps })),
      section(4, 'If it gets worse', h('p', { text: f.rollback })),
      voteBox(d));

    out.append(card);
    $('newBtn').hidden = false;
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function traceBox(trace) {
    if (!trace || !trace.length) return null;
    return h('details', { class: 'trace' }, h('summary', { text: 'How we solved this' }), h('ol', {}, trace.map(t => h('li', { text: t }))));
  }

  function siteBox(site) {
    if (!site) return null;
    if (!site.ok) return h('div', { class: 'need', text: 'Live site check: ' + site.error });
    const items = [...site.findings.map(t => h('li', { class: 'bad', text: t })), ...site.facts.map(t => h('li', { text: t }))];
    return h('div', { class: 'sitecheck' }, h('b', { text: 'Live site check' }), h('ul', {}, items));
  }

  function evidenceBox(ask) {
    const ta = h('textarea', { rows: 4, spellcheck: 'false', placeholder: 'Paste it here. Keys and tokens are removed automatically.' });
    const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
    return h('div', { class: 'need evidence' },
      h('p', { class: 'evtitle', text: 'Not sure yet. More evidence would help.' }),
      h('p', { text: ask || 'Add the console output or the failing request details.' }),
      ta, err,
      h('button', { type: 'button', class: 'ghost', text: 'Re-check with this', onclick: () => {
        if (ta.value.trim().length < 8) { err.textContent = 'Paste the extra evidence first.'; err.hidden = false; return; }
        go({ refine: true, evidence: ta.value.trim() });
      } }));
  }

  function voteBox(d) {
    const box = h('div', { class: 'vote' });
    const ask = () => {
      box.replaceChildren(
        h('p', { text: 'Did it work? Your tap helps the next person.' }),
        h('div', { class: 'vote-btns' },
          h('button', { type: 'button', class: 'vbtn yes', text: 'Worked', onclick: () => vote(d, 'worked', box) }),
          h('button', { type: 'button', class: 'vbtn no', text: "Didn't work", onclick: () => vote(d, 'failed', box) })));
    };
    ask();
    return box;
  }

  async function vote(d, v, box) {
    box.querySelectorAll('button').forEach(b => { b.disabled = true; });
    try {
      const r = await fetch('/api/vote', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ attemptId: d.attemptId, userId: d.userId, vote: v }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok && r.status !== 409) throw new Error(j.error || 'Vote failed');
    } catch (e) {
      box.append(h('p', { class: 'form-error', text: 'Could not save your vote. Try again.' }));
      box.querySelectorAll('button').forEach(b => { b.disabled = false; });
      return;
    }
    refreshStats();
    if (v === 'worked') {
      state.sessionId = null;
      box.replaceChildren(h('p', { class: 'thanks', text: 'Saved. This fix now counts for the next person with the same error.' }),
        h('button', { type: 'button', class: 'ghost', text: 'Fix another error', onclick: newProblem }));
      return;
    }
    const retry = h('textarea', { rows: 4, spellcheck: 'false', placeholder: 'Paste the new error or describe what you see now. Leave empty to use the same error.' });
    box.replaceChildren(
      h('p', { text: 'Thanks. We will not suggest that again.' }),
      h('div', { class: 'retry' },
        h('p', { text: 'What happened after you tried it?' }), retry,
        h('button', { type: 'button', class: 'primary', text: 'Try a different fix', onclick: () => { if (retry.value.trim()) errorBox.value = retry.value; updateCount(); go({ retry: true }); } })));
    retry.focus();
  }

  function renderReset(d) {
    const out = $('out');
    out.replaceChildren(h('article', { class: 'card' },
      h('div', { class: 'res-top' }, h('span', { class: 'badge unverified', text: 'Time to reset' })),
      h('h2', { class: 'title', text: 'Start a fresh chat in your builder' }),
      h('p', { text: d.message }),
      section(1, 'Paste this as the first message in a new chat',
        h('div', { class: 'codebox', text: d.summary }),
        h('div', { class: 'copyrow' }, h('button', { type: 'button', class: 'copybtn', text: 'Copy summary', onclick: e => copyText(d.summary, e.currentTarget, 'Copied') }))),
      section(2, 'Why this helps', h('p', { text: 'Long builder chats pile up wrong assumptions. A clean chat with the list of failed fixes stops the same mistake from repeating and saves credits.' })),
      h('div', { class: 'vote' }, h('button', { type: 'button', class: 'ghost', text: 'Start a new problem', onclick: newProblem }))));
  }

  async function go(opts) {
    if (state.busy) return;
    showFormError('');
    const error = errorBox.value.trim();
    if (error.length < 8) { showFormError('Paste the error message or log first.'); errorBox.focus(); return; }

    const isSample = state.sampleText && errorBox.value === state.sampleText;
    // A retry keeps the session so failed fixes are remembered. A fresh "Get fix"
    // is a new problem and starts clean.
    const isRefine = Boolean(opts && opts.refine);
    const isRetry = Boolean(opts && opts.retry) || isRefine;
    if (!state.sessionId || !isRetry || state.sample !== Boolean(isSample)) {
      state.sessionId = rid();
      state.sample = Boolean(isSample);
    }
    const userId = state.sample ? 'sample_' + state.userId : state.userId;

    state.busy = true;
    const btn = $('goBtn');
    btn.disabled = true;
    btn.textContent = 'Analysing...';
    const out = $('out');
    const lv = loadingView();
    out.replaceChildren(lv.node);

    try {
      const res = await fetch('/api/fix', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tool: state.tool, platform: state.platform, error,
          context: $('ctxBox').value.slice(0, 6000), prompt: $('promptBox').value, siteUrl: $('siteBox').value,
          refine: isRefine, evidence: isRefine ? opts.evidence : undefined,
          userId, sessionId: state.sessionId,
        }),
      });
      const d = await res.json().catch(() => ({}));
      lv.stop();
      if (!res.ok) {
        out.replaceChildren();
        showFormError(d.error || 'Something went wrong. Try again.');
        return;
      }
      state.attemptId = d.attemptId;
      d.userId = userId;
      if (d.status === 'reset') renderReset(d); else renderResult(d);
      refreshStats();
    } catch {
      lv.stop();
      out.replaceChildren();
      showFormError('Could not reach the server. Check your connection and try again.');
    } finally {
      state.busy = false;
      btn.disabled = false;
      btn.textContent = 'Get fix';
    }
  }

  $('goBtn').addEventListener('click', () => go());
  errorBox.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') go(); });

  async function refreshStats() {
    try {
      const r = await fetch('/api/stats');
      if (!r.ok) return;
      const s = await r.json();
      const live = $('liveStats');
      const people = s.uniqueUsers;
      // Real use first; the library size is the fallback while nobody has used it yet.
      $('liveText').textContent = people > 0
        ? `${people} ${people === 1 ? 'person has' : 'people have'} signed up`
        : `${s.fixesInLibrary} fixes in the library`;
      const hero = $('liveHero');
      if (hero) {
        hero.hidden = people === 0 && s.totalAnswers === 0;
        hero.textContent = `${people} signed-up ${people === 1 ? 'person' : 'people'} · ${s.totalAnswers} ${s.totalAnswers === 1 ? 'answer' : 'answers'} given`;
      }
      live.hidden = false;

      const cells = [
        [s.fixesInLibrary, 'Fixes in the library'],
        [s.fixesConfirmedByUsers, 'Confirmed by users'],
        [s.totalAnswers, 'Answers given'],
        [s.servedFromLibrary, 'Served from library'],
        [s.workedRate == null ? '–' : s.workedRate + '%', 'Said it worked'],
        [people, 'People signed up'],
        [s.aiTokensUsed.toLocaleString(), 'AI tokens used (measured)'],
        [s.estTokensSaved.toLocaleString(), `AI tokens avoided (${s.savedBasis})`],
      ];
      const grid = $('statsGrid');
      grid.replaceChildren(...cells.map(([v, l]) => h('div', { class: 'stat' }, h('b', { text: String(v) }), h('span', { text: l }))));
      $('statsBox').hidden = false;
    } catch { /* stats are optional */ }
  }
  refreshStats();
  setInterval(refreshStats, 30000); // keeps the live count current while the page stays open
})();

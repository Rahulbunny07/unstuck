const { assertSafeUrl } = require('./mcp');

const TIMEOUT_MS = 8000;
const MAX_BYTES = 400 * 1024;
const MAX_HOPS = 3;

// Fetches one URL while re-checking every redirect target, so a public site cannot
// bounce the server onto an internal address.
async function safeGet(rawUrl) {
  let url = rawUrl;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const u = await assertSafeUrl(url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(u, { redirect: 'manual', signal: ctrl.signal, headers: { 'user-agent': 'UnstuckSiteCheck/1.0', accept: '*/*' } });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = new URL(res.headers.get('location'), u).toString();
        await res.arrayBuffer().catch(() => {});
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      return { url: u.toString(), status: res.status, type: (res.headers.get('content-type') || '').toLowerCase(), body: buf.subarray(0, MAX_BYTES).toString('utf8') };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('Too many redirects.');
}

// Looks at the deployed site from the outside and reports only things it can prove.
// Markers (unstuck-finding:...) let the library match these without any AI call.
async function checkSite(rawUrl) {
  const facts = [];
  const findings = [];
  let root;
  try {
    root = await safeGet(String(rawUrl).trim());
  } catch (e) {
    return { ok: false, error: e.message || 'Could not reach that site.', facts, findings, markers: [] };
  }
  const origin = new URL(root.url).origin;
  facts.push(`Home page answered with status ${root.status} (${root.type.split(';')[0] || 'unknown type'}).`);
  if (root.status >= 500) findings.push({ id: 'server-error', text: `The site returns a server error (${root.status}) on the home page.` });
  if (root.status === 404) findings.push({ id: 'root-404', text: 'The home page itself returns 404, so the deploy may point at the wrong output folder.' });

  const html = root.type.includes('html') ? root.body : '';
  const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]).slice(0, 3);
  let badScript = false;
  for (const src of scripts) {
    let abs;
    try { abs = new URL(src, root.url); } catch { continue; }
    if (abs.origin !== origin) continue;
    try {
      const r = await safeGet(abs.toString());
      const label = abs.pathname.split('/').pop() || abs.pathname;
      if (r.status >= 400) { findings.push({ id: 'script-missing', text: `Script ${label} returns ${r.status}.` }); badScript = true; }
      else if (r.type.includes('html')) { findings.push({ id: 'script-html', text: `Script ${label} is served as a web page (text/html), not JavaScript. The browser cannot run it, so the page stays blank.` }); badScript = true; }
    } catch { /* one failed asset does not stop the check */ }
  }
  if (scripts.length) facts.push(`Checked ${scripts.length} script file${scripts.length === 1 ? '' : 's'} on the page.`);

  const emptyRoot = /<div id=["']root["']>\s*<\/div>/i.test(html) && scripts.length > 0;
  if (emptyRoot && !badScript) facts.push('The page is a single-page app shell: content appears only after JavaScript runs, so a runtime error would give a blank page. Check the browser console.');

  // A single-page app should serve its shell for deep links. A 404 means the host has no rewrite.
  if (root.status === 200 && emptyRoot) {
    try {
      const probe = await safeGet(`${origin}/unstuck-probe-${Math.random().toString(36).slice(2, 8)}`);
      if (probe.status === 404) findings.push({ id: 'spa-404', text: 'A direct link to a made-up page returns 404. Page refreshes on routes like /dashboard will fail until a catch-all rewrite is added.' });
      else facts.push('Deep links return the app shell, so route refreshes should work.');
    } catch { /* probe is best effort */ }
  }

  const map = { 'script-html': 'script-served-as-html', 'spa-404': 'spa-refresh-404' };
  // Only the most fundamental problem is used to pick a library fix; the rest are still
  // shown to the user. If the first fix does not work, the next attempt moves on.
  const order = ['script-html', 'spa-404'];
  const top = order.find(id => findings.some(f => f.id === id));
  const markers = top ? [`unstuck-finding:${map[top]}`] : [];
  return { ok: true, url: root.url, facts, findings, markers };
}

module.exports = { checkSite };

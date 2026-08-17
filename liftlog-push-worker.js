/**
 * Lift Log — push subscription registry
 *
 * A tiny Cloudflare Worker that remembers which devices want notifications, so
 * every user can turn push on from the app itself. Nobody but the owner ever
 * touches GitHub.
 *
 * Setup (all in the Cloudflare dashboard, no CLI needed):
 *   1. Workers & Pages → Create → Worker. Name it "liftlog-push". Deploy.
 *   2. Edit code → paste this file → Deploy.
 *   3. Settings → Bindings → Add → KV namespace.
 *        Variable name: SUBS      Namespace: create one called "liftlog-subs"
 *   4. Settings → Variables and Secrets → Add → Secret.
 *        Name: ADMIN_KEY          Value: a long random string you invent
 *      Put that same string in the GitHub secret PUSH_ADMIN_KEY.
 *
 * Routes:
 *   POST /subscribe    { endpoint, keys, lang }  — public, called by the app
 *   POST /unsubscribe  { endpoint }              — public
 *   GET  /list?key=ADMIN_KEY                     — owner only, used by CI
 *   POST /prune?key=ADMIN_KEY  { endpoints:[] }  — owner only, drops dead subs
 *   GET  /count                                  — public, how many devices
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS }
  });

// A push endpoint is long and contains characters KV dislikes as a key, so key
// each record by a short stable hash of it instead.
async function keyFor(endpoint) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return 'sub:' + [...new Uint8Array(buf)].slice(0, 16)
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time-ish comparison so the admin key can't be guessed byte by byte.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (!env.SUBS) return json({ error: 'KV namespace "SUBS" is not bound to this Worker' }, 500);

    // ── Public: a device registers itself ──
    if (path === '/subscribe' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'invalid JSON' }, 400); }
      const { endpoint, keys, lang } = body || {};
      if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
        return json({ error: 'expected { endpoint, keys:{p256dh, auth} }' }, 400);
      }
      // Only accept real push-service endpoints.
      if (!/^https:\/\//.test(endpoint)) return json({ error: 'endpoint must be https' }, 400);

      const k = await keyFor(endpoint);
      const existing = await env.SUBS.get(k, 'json');
      await env.SUBS.put(k, JSON.stringify({
        endpoint, keys,
        lang: (lang === 'en' ? 'en' : 'ja'),
        added: existing?.added || new Date().toISOString(),
        seen: new Date().toISOString()
      }));
      return json({ ok: true, renewed: !!existing });
    }

    // ── Public: a device opts out ──
    if (path === '/unsubscribe' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'invalid JSON' }, 400); }
      if (!body || !body.endpoint) return json({ error: 'expected { endpoint }' }, 400);
      await env.SUBS.delete(await keyFor(body.endpoint));
      return json({ ok: true });
    }

    // ── Public: how many devices are registered (no personal data) ──
    if (path === '/count' && request.method === 'GET') {
      let total = 0, cursor;
      do {
        const page = await env.SUBS.list({ prefix: 'sub:', cursor });
        total += page.keys.length;
        cursor = page.list_complete ? null : page.cursor;
      } while (cursor);
      return json({ count: total });
    }

    // ── Owner only: the full list, for the sender ──
    if (path === '/list' && request.method === 'GET') {
      if (!env.ADMIN_KEY) return json({ error: 'ADMIN_KEY secret is not set' }, 500);
      if (!safeEqual(url.searchParams.get('key') || '', env.ADMIN_KEY)) return json({ error: 'unauthorized' }, 401);
      const out = [];
      let cursor;
      do {
        const page = await env.SUBS.list({ prefix: 'sub:', cursor });
        for (const k of page.keys) {
          const v = await env.SUBS.get(k.name, 'json');
          if (v && v.endpoint) out.push(v);
        }
        cursor = page.list_complete ? null : page.cursor;
      } while (cursor);
      return json({ subscriptions: out });
    }

    // ── Owner only: drop endpoints the push service rejected ──
    if (path === '/prune' && request.method === 'POST') {
      if (!env.ADMIN_KEY) return json({ error: 'ADMIN_KEY secret is not set' }, 500);
      if (!safeEqual(url.searchParams.get('key') || '', env.ADMIN_KEY)) return json({ error: 'unauthorized' }, 401);
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'invalid JSON' }, 400); }
      const list = Array.isArray(body?.endpoints) ? body.endpoints : [];
      for (const ep of list) await env.SUBS.delete(await keyFor(ep));
      return json({ ok: true, removed: list.length });
    }

    return json({ error: 'not found', routes: ['/subscribe', '/unsubscribe', '/count', '/list', '/prune'] }, 404);
  }
};

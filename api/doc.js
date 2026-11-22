'use strict';
const L = require('./_lib');

const route = L.handler(async (req, res) => {
  const c = req.q.c, id = req.q.id;
  if ((c !== 'matches' && c !== 'snapshots' && c !== 'raw' && c !== 'schema') || !L.ID_OK.test(id || '')) return L.send(res, 400, { error: 'bad_target' });
  const p = c + '/' + id + '.json';
  /* Reading: matches are public; an event is public only once published (admins can read drafts). */
  /* raw: the uploaded Match Ledger exactly as parsed, kept so any later feature can be rebuilt from it. Admin only, never cached, never cross-origin.
     schema: what the fields of earlier ledgers looked like, used to mark new, removed and changed fields. Same rules as raw. */
  if ((c === 'raw' || c === 'schema') && req.method === 'GET') {
    const stR = await L.readState(); if (!L.isAdmin(L.session(req), stR)) return L.send(res, 403, { error: 'admin_only' });
    const dr = await L.getJSON(p); if (!dr) return L.send(res, 404, { error: 'not_found' });
    res.statusCode = 200; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'private, no-store');
    return res.end(JSON.stringify(dr));
  }
  if (req.method === 'GET') {
    if (c === 'snapshots') { const st0 = await L.readState(); if (!st0.published[id] && !L.isAdmin(L.session(req), st0)) return L.send(res, 404, { error: 'not_found' }); }
    const d = await L.getJSON(p); if (!d) return L.send(res, 404, { error: 'not_found' });
    res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
    /* CORS for public matches only; snapshots stay private until published, so they never get the header */
    if (c === 'matches') res.setHeader('Access-Control-Allow-Origin', '*');
    /* the page asks with &v=<version>, so each version has its own URL and can be cached hard */
    res.setHeader('Cache-Control', c === 'matches' ? 'public, max-age=31536000, immutable' : 'private, max-age=60');
    return res.end(JSON.stringify(d));
  }
  const st = await L.readState();
  if (!L.isAdmin(L.session(req), st)) return L.send(res, 403, { error: 'admin_only' });
  if (req.method === 'PUT') {
    const d = await L.body(req, c === 'raw' ? 4 * 1024 * 1024 : 3.5 * 1024 * 1024);
    if (!d || typeof d !== 'object' || Array.isArray(d)) return L.send(res, 400, { error: 'bad_doc' });
    await L.putJSON(p, d);
    if (c === 'matches' && Array.isArray(d.players)) {
      const names = d.players.map(x => x && x.name).filter(n => typeof n === 'string' && n && n.length <= 60 && !L.isBot(n));
      if (names.length) await L.mutate(s => { names.forEach(n => { s.players[n] = 1; }); });
    }
    return L.send(res, 200, { ok: true });
  }
  if (req.method === 'DELETE') { await L.delPath(p); if (c === 'matches') await L.delPath('raw/' + id + '.json'); if (c === 'snapshots') await L.mutate(s => { delete s.published[id]; }); return L.send(res, 200, { ok: true }); }
  L.send(res, 405, { error: 'method' });
});

/* CORS preflight is answered here, ahead of L.handler (which rejects every non-GET without a same-origin Origin).
   Only matches are cross-origin readable; any other target gets a bare 204 with no CORS headers. */
module.exports = (req, res) => {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    const u = new URL(req.url, 'http://x');
    if (u.searchParams.get('c') === 'matches') {
      res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Methods', 'GET'); res.setHeader('Access-Control-Allow-Headers', 'content-type');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    return res.end();
  }
  return route(req, res);
};

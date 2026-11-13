'use strict';
const L = require('./_lib');

module.exports = L.handler(async (req, res) => {
  const c = req.q.c, id = req.q.id;
  if ((c !== 'matches' && c !== 'snapshots') || !L.ID_OK.test(id || '')) return L.send(res, 400, { error: 'bad_target' });
  const p = c + '/' + id + '.json';
  /* Reading: matches are public; an event is public only once published (admins can read drafts). */
  if (req.method === 'GET') {
    if (c === 'snapshots') { const st0 = await L.readState(); if (!st0.published[id] && !L.isAdmin(L.session(req), st0)) return L.send(res, 404, { error: 'not_found' }); }
    const d = await L.getJSON(p); if (!d) return L.send(res, 404, { error: 'not_found' });
    res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
    /* the page asks with &v=<version>, so each version has its own URL and can be cached hard */
    res.setHeader('Cache-Control', c === 'matches' ? 'public, max-age=31536000, immutable' : 'private, max-age=60');
    return res.end(JSON.stringify(d));
  }
  const st = await L.readState();
  if (!L.isAdmin(L.session(req), st)) return L.send(res, 403, { error: 'admin_only' });
  if (req.method === 'PUT') {
    const d = await L.body(req, 3.5 * 1024 * 1024);
    if (!d || typeof d !== 'object' || Array.isArray(d)) return L.send(res, 400, { error: 'bad_doc' });
    await L.putJSON(p, d);
    if (c === 'matches' && Array.isArray(d.players)) {
      const names = d.players.map(x => x && x.name).filter(n => typeof n === 'string' && n && n.length <= 60 && !L.isBot(n));
      if (names.length) await L.mutate(s => { names.forEach(n => { s.players[n] = 1; }); });
    }
    return L.send(res, 200, { ok: true });
  }
  if (req.method === 'DELETE') { await L.delPath(p); if (c === 'snapshots') await L.mutate(s => { delete s.published[id]; }); return L.send(res, 200, { ok: true }); }
  L.send(res, 405, { error: 'method' });
});

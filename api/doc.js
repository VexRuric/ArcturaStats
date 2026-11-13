'use strict';
const L = require('./_lib');

module.exports = L.handler(async (req, res) => {
  const st = await L.readState();
  if (!L.isAdmin(L.session(req), st)) return L.send(res, 403, { error: 'admin_only' });
  const c = req.q.c, id = req.q.id;
  if ((c !== 'matches' && c !== 'snapshots') || !L.ID_OK.test(id || '')) return L.send(res, 400, { error: 'bad_target' });
  const p = c + '/' + id + '.json';
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

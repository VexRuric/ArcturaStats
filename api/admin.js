'use strict';
const L = require('./_lib');

module.exports = L.handler(async (req, res) => {
  const st0 = await L.readState(), s0 = L.session(req);
  if (!L.isAdmin(s0, st0)) return L.send(res, 403, { error: 'admin_only' });

  if (req.method === 'GET') {
    const users = Object.keys(st0.users).map(id => ({ id, name: st0.users[id].name, avatar: st0.users[id].avatar || null, seen: st0.users[id].seen || 0, admin: st0.admins.indexOf(id) >= 0, claim: st0.byUser[id] || null }))
      .sort((a, b) => (b.admin - a.admin) || a.name.localeCompare(b.name));
    return L.send(res, 200, { users, players: Object.keys(st0.players).length, bugs: st0.bugs || {} });
  }
  if (req.method !== 'POST') return L.send(res, 405, { error: 'method' });

  const b = await L.body(req, 2048), op = b.op;
  const out = await L.mutate(st => {
    if (op === 'makeAdmin') {
      if (!st.users[b.id]) return { code: 404, error: 'no_such_user' };
      if (st.admins.indexOf(b.id) < 0) st.admins.push(b.id);
      return { code: 200, ok: true };
    }
    if (op === 'removeAdmin') {
      const left = st.admins.filter(x => x !== b.id);
      if (left.length === 0) return { code: 409, error: 'last_admin' };
      st.admins = left; return { code: 200, ok: true };
    }
    if (op === 'publish' || op === 'unpublish') {
      if (!L.ID_OK.test(String(b.id || ''))) return { code: 400, error: 'bad_id' };
      if (op === 'unpublish') { delete st.published[b.id]; return { code: 200, ok: true }; }
      return L.getJSON('snapshots/' + b.id + '.json').then(d => { if (!d) return { code: 404, error: 'no_such_snapshot' }; st.published[b.id] = true; return { code: 200, ok: true }; });
    }
    /* Bug tracker: status of a flagged log problem. 'open' is the default and is not stored. */
    if (op === 'bugStatus') {
      const key = String(b.key || ''), status = String(b.status || '');
      if (!/^[A-Za-z0-9_-]{1,40}:[A-Za-z0-9_-]{1,80}$/.test(key)) return { code: 400, error: 'bad_key' };
      if (['open', 'devs', 'fixed', 'ignored'].indexOf(status) < 0) return { code: 400, error: 'bad_status' };
      if (status === 'open') { delete st.bugs[key]; return { code: 200, ok: true }; }
      if (!st.bugs[key] && Object.keys(st.bugs).length >= 3000) return { code: 409, error: 'too_many_bugs' };
      st.bugs[key] = { s: status, by: s0.id || null, at: Date.now() };
      return { code: 200, ok: true };
    }
    if (op === 'release') {
      const id = st.claims[b.player]; if (!id) return { code: 404, error: 'not_claimed' };
      delete st.claims[b.player]; delete st.byUser[id]; return { code: 200, ok: true };
    }
    return { code: 400, error: 'bad_op' };
  });
  L.send(res, out.code, out);
});

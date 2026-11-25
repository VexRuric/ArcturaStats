'use strict';
const L = require('./_lib');

module.exports = L.handler(async (req, res) => {
  const st0 = await L.readState(), s0 = L.session(req);
  const isA = L.isAdmin(s0, st0);
  if (!isA && !L.isDesigner(s0, st0)) return L.send(res, 403, { error: 'admin_only' });

  if (req.method === 'GET') {
    /* saved bug reports: ids and versions, the page fetches each one from /api/doc?c=reports */
    const reports = await L.listDocs('reports/');
    /* a designer sees the bug tracker only, never the account list */
    if (!isA) return L.send(res, 200, { users: [], players: Object.keys(st0.players).length, bugs: st0.bugs || {}, reports });
    const users = Object.keys(st0.users).map(id => ({ id, name: st0.users[id].name, avatar: st0.users[id].avatar || null, seen: st0.users[id].seen || 0, admin: st0.admins.indexOf(id) >= 0, designer: (st0.designers || []).indexOf(id) >= 0, claim: st0.byUser[id] || null, theme: (st0.users[id].theme || {}).t || null }))
      .sort((a, b) => (b.admin - a.admin) || (b.designer - a.designer) || a.name.localeCompare(b.name));
    return L.send(res, 200, { users, players: Object.keys(st0.players).length, bugs: st0.bugs || {}, reports });
  }
  if (req.method !== 'POST') return L.send(res, 405, { error: 'method' });

  const b = await L.body(req, 2048), op = b.op;
  if (op !== 'bugStatus' && !isA) return L.send(res, 403, { error: 'admin_only' });
  const out = await L.mutate(st => {
    if (op === 'makeAdmin') {
      if (!st.users[b.id]) return { code: 404, error: 'no_such_user' };
      if (st.admins.indexOf(b.id) < 0) st.admins.push(b.id);
      st.designers = (st.designers || []).filter(x => x !== b.id);
      return { code: 200, ok: true };
    }
    if (op === 'makeDesigner') {
      if (!st.users[b.id]) return { code: 404, error: 'no_such_user' };
      if (st.admins.indexOf(b.id) >= 0) return { code: 409, error: 'is_admin' };
      st.designers = st.designers || [];
      if (st.designers.indexOf(b.id) < 0) st.designers.push(b.id);
      return { code: 200, ok: true };
    }
    if (op === 'removeDesigner') { st.designers = (st.designers || []).filter(x => x !== b.id); return { code: 200, ok: true }; }
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
      const bd = String(b.build || '').slice(0, 40), who = st.users && st.users[s0.id] && st.users[s0.id].name;
      st.bugs[key] = { s: status, by: s0.id || null, n: who ? String(who).slice(0, 40) : null, at: Date.now(), b: /^[A-Za-z0-9_.-]*$/.test(bd) ? bd : '' };
      return { code: 200, ok: true };
    }
    /* Test accounts: an admin sets (or clears, with an empty theme) the appearance of any account. */
    if (op === 'setTheme') {
      const u = st.users[b.id]; if (!u) return { code: 404, error: 'no_such_user' };
      const t = String(b.theme || '');
      if (t === '') { delete u.theme; return { code: 200, ok: true }; }
      if (L.THEMES.indexOf(t) < 0) return { code: 400, error: 'bad_theme' };
      u.theme = { t, d: (u.theme && u.theme.d) || 'comfortable' };
      return { code: 200, ok: true };
    }
    /* Builds in the stats: an admin switches a build (its skills hash) off so its matches are left out of the public stats.
       Designers and the admin tools still see every build. 'setBuilds' replaces the whole list of switched-off builds. */
    if (op === 'setBuild' || op === 'setBuilds') {
      const ok = h => typeof h === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(h);
      const off = Object.assign({}, (st.builds && st.builds.off) || {});
      if (op === 'setBuild') { if (!ok(b.hash)) return { code: 400, error: 'bad_build' }; if (b.on) delete off[b.hash]; else off[b.hash] = 1; }
      else {
        if (!Array.isArray(b.off) || b.off.length > 200 || !b.off.every(ok)) return { code: 400, error: 'bad_build' };
        Object.keys(off).forEach(k => delete off[k]); b.off.forEach(h => { off[h] = 1; });
      }
      st.builds = { off, at: Date.now(), by: s0.id || null };
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

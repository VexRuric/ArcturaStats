'use strict';
const L = require('./_lib');

/* An account keeps its own appearance. Any Discord login may change its own; an admin may set another account's from Admin, Accounts. */
module.exports = L.handler(async (req, res) => {
  if (req.method !== 'POST') return L.send(res, 405, { error: 'method' });
  const s0 = L.session(req);
  if (!s0 || s0.k !== 'd') return L.send(res, 401, { error: 'login_with_discord' });
  const b = await L.body(req, 512), t = String(b.theme || ''), d = String(b.density || 'comfortable');
  if (L.THEMES.indexOf(t) < 0) return L.send(res, 400, { error: 'bad_theme' });
  if (L.DENSITIES.indexOf(d) < 0) return L.send(res, 400, { error: 'bad_density' });
  const out = await L.mutate(st => {
    if (!st.users[s0.id]) return { code: 401, error: 'login_with_discord' };
    st.users[s0.id].theme = { t, d };
    return { code: 200, ok: true, theme: { t, d } };
  });
  L.send(res, out.code, out);
});

'use strict';
const L = require('./_lib');

/* Every stored match is public. Events (snapshots) are public only once an admin publishes them; admins also see drafts. */
const route = L.handler(async (req, res) => {
  /* Public read-only data may be fetched cross-origin. No credentials are allowed (no Allow-Credentials), so the
     session cookie is never part of a cross-origin request and the caller only ever sees the public view. */
  if (req.method === 'GET') res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return L.send(res, 405, { error: 'method' });
  const [st, m, s] = await Promise.all([L.readState(), L.listDocs('matches/'), L.listDocs('snapshots/')]);
  const s0 = L.session(req), me = L.who(s0, st), admin = L.isAdmin(s0, st);
  const matches = m, snapshots = admin ? s : s.filter(x => st.published[x.id]);
  const claims = {};
  Object.keys(st.claims).forEach(p => { const u = st.users[st.claims[p]]; claims[p] = { name: u ? u.name : 'Unknown', avatar: u ? u.avatar || null : null }; });
  L.send(res, 200, { matches, snapshots, pub: snapshots.filter(x => st.published[x.id]).map(x => x.id), claims, builds: Object.keys((st.builds && st.builds.off) || {}), me, discord: !!process.env.DISCORD_CLIENT_ID });
});

/* CORS preflight is answered here, ahead of L.handler (which rejects every non-GET without a same-origin Origin). */
module.exports = (req, res) => {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Methods', 'GET'); res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.end();
  }
  return route(req, res);
};

'use strict';
const L = require('./_lib');

module.exports = L.handler(async (req, res) => {
  if (req.method !== 'GET') return L.send(res, 405, { error: 'method' });
  const [st, m, s] = await Promise.all([L.readState(), L.listDocs('matches/'), L.listDocs('snapshots/')]);
  const s0 = L.session(req), me = L.who(s0, st);
  const claims = {};
  Object.keys(st.claims).forEach(p => { const u = st.users[st.claims[p]]; claims[p] = { name: u ? u.name : 'Unknown', avatar: u ? u.avatar || null : null }; });
  L.send(res, 200, { matches: m, snapshots: s, claims, me, discord: !!process.env.DISCORD_CLIENT_ID });
});

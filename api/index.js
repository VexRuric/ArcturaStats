'use strict';
const L = require('./_lib');

/* Admins see everything. Everyone else sees only snapshots an admin has published, and only the matches inside them. */
module.exports = L.handler(async (req, res) => {
  if (req.method !== 'GET') return L.send(res, 405, { error: 'method' });
  const [st, m, s] = await Promise.all([L.readState(), L.listDocs('matches/'), L.listDocs('snapshots/')]);
  const s0 = L.session(req), me = L.who(s0, st), admin = L.isAdmin(s0, st);
  let matches = m, snapshots = s;
  if (!admin) {
    snapshots = s.filter(x => st.published[x.id]);
    const docs = await Promise.all(snapshots.map(x => L.getJSON('snapshots/' + x.id + '.json')));
    const ok = new Set(); docs.forEach(d => { if (d && Array.isArray(d.matchIds)) d.matchIds.forEach(i => ok.add(i)); });
    matches = m.filter(x => ok.has(x.id));
  }
  const claims = {};
  Object.keys(st.claims).forEach(p => { const u = st.users[st.claims[p]]; claims[p] = { name: u ? u.name : 'Unknown', avatar: u ? u.avatar || null : null }; });
  L.send(res, 200, { matches, snapshots, pub: snapshots.filter(x => st.published[x.id]).map(x => x.id), claims, me, discord: !!process.env.DISCORD_CLIENT_ID });
});

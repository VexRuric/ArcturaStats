'use strict';
const crypto = require('crypto');
const L = require('./_lib');

module.exports = L.handler(async (req, res) => {
  const a = req.q.a;

  if (a === 'logout' && req.method === 'POST') {
    L.setCookie(res, L.COOKIE, '', 0); return L.send(res, 200, { ok: true });
  }

  /* Discord: step 1, send the person to Discord */
  if (a === 'discord' && req.method === 'GET') {
    const cid = process.env.DISCORD_CLIENT_ID;
    if (!cid) return L.redirect(res, '/?authError=not_configured#players');
    const n = crypto.randomBytes(16).toString('hex');
    L.setCookie(res, L.OCOOKIE, L.sign({ n, exp: Date.now() + 600e3 }), 600);
    const u = L.DISCORD() + '/oauth2/authorize?response_type=code&scope=identify&prompt=none&client_id=' + encodeURIComponent(cid) +
      '&redirect_uri=' + encodeURIComponent(L.site(req) + '/auth/callback') + '&state=' + n;
    return L.redirect(res, u);
  }

  /* Discord: step 2, Discord sends them back with a code */
  if (a === 'callback' && req.method === 'GET') {
    const o = L.unsign(L.cookies(req)[L.OCOOKIE]);
    L.setCookie(res, L.OCOOKIE, '', 0);
    if (req.q.error) return L.redirect(res, '/?authError=cancelled#players');
    if (!o || !req.q.state || !L.safeEq(o.n, req.q.state) || !req.q.code) return L.redirect(res, '/?authError=state#players');
    let me;
    try {
      const tr = await fetch(L.DISCORD() + '/api/oauth2/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: process.env.DISCORD_CLIENT_ID, client_secret: process.env.DISCORD_CLIENT_SECRET || '', grant_type: 'authorization_code', code: req.q.code, redirect_uri: L.site(req) + '/auth/callback' })
      });
      const t = await tr.json(); if (!tr.ok || !t.access_token) throw new Error('token');
      const ur = await fetch(L.DISCORD() + '/api/users/@me', { headers: { authorization: 'Bearer ' + t.access_token } });
      me = await ur.json(); if (!ur.ok || !me.id) throw new Error('user');
    } catch (e) { return L.redirect(res, '/?authError=discord#players'); }
    const id = String(me.id), name = String(me.global_name || me.username || 'Discord user').slice(0, 60);
    const avatar = me.avatar ? 'https://cdn.discordapp.com/avatars/' + id + '/' + me.avatar + '.png?size=64' : null;
    await L.mutate(async st => {
      st.users[id] = { name, avatar, seen: Date.now() };
    });
    L.setCookie(res, L.COOKIE, L.sign({ k: 'd', id, exp: Date.now() + 30 * 86400e3 }), 30 * 86400);
    return L.redirect(res, '/#players');
  }

  L.send(res, 404, { error: 'not_found' });
});

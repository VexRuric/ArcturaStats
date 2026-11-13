'use strict';
const crypto = require('crypto');
const L = require('./_lib');

const fails = new Map();
function blocked(ip) { const now = Date.now(), a = (fails.get(ip) || []).filter(t => now - t < 600000); fails.set(ip, a); return a.length >= 8; }
function fail(ip) { const a = fails.get(ip) || []; a.push(Date.now()); fails.set(ip, a); }
const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

module.exports = L.handler(async (req, res) => {
  const a = req.q.a;

  /* Admin account with a username and password (the bootstrap account) */
  if (a === 'login' && req.method === 'POST') {
    const b = await L.body(req, 4096), ip = ipOf(req);
    if (blocked(ip)) return L.send(res, 429, { error: 'too_many_attempts' });
    const st = await L.readState();
    const user = process.env.BOOTSTRAP_USER || 'Admin', pass = process.env.BOOTSTRAP_PASSWORD;
    const ok = !!pass && !st.bootstrapDeleted && L.safeEq(String(b.user || ''), user) & L.safeEq(String(b.pass || ''), pass);
    if (!ok) { fail(ip); await new Promise(r => setTimeout(r, 600)); return L.send(res, 401, { error: 'bad_login' }); }
    L.setCookie(res, L.COOKIE, L.sign({ k: 'b', name: user, exp: Date.now() + 12 * 3600e3 }), 12 * 3600);
    return L.send(res, 200, { ok: true });
  }

  if (a === 'logout' && req.method === 'POST') {
    L.setCookie(res, L.COOKIE, '', 0); return L.send(res, 200, { ok: true });
  }

  /* Discord: step 1, send the person to Discord */
  if (a === 'discord' && req.method === 'GET') {
    const cid = process.env.DISCORD_CLIENT_ID;
    if (!cid) return L.redirect(res, '/?authError=not_configured#players');
    const st = await L.readState(), s0 = L.session(req);
    const promote = req.q.promote === '1' && s0 && s0.k === 'b' && !st.bootstrapDeleted;
    const n = crypto.randomBytes(16).toString('hex');
    L.setCookie(res, L.OCOOKIE, L.sign({ n, promote, exp: Date.now() + 600e3 }), 600);
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
    let promoted = false;
    await L.mutate(async st => {
      st.users[id] = { name, avatar, seen: Date.now() };
      if (o.promote && !st.bootstrapDeleted && st.admins.indexOf(id) < 0) { st.admins.push(id); promoted = true; }
    });
    L.setCookie(res, L.COOKIE, L.sign({ k: 'd', id, exp: Date.now() + 30 * 86400e3 }), 30 * 86400);
    return L.redirect(res, o.promote ? '/#admin' : '/#players');
  }

  L.send(res, 404, { error: 'not_found' });
});

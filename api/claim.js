'use strict';
const L = require('./_lib');

/* A Discord account claims one player. One player belongs to one Discord account. */
module.exports = L.handler(async (req, res) => {
  if (req.method !== 'POST') return L.send(res, 405, { error: 'method' });
  const s0 = L.session(req);
  if (!s0 || s0.k !== 'd') return L.send(res, 401, { error: 'login_with_discord' });
  const b = await L.body(req, 2048), player = String(b.player || '').trim();
  if (!player || player.length > 60 || L.isBot(player)) return L.send(res, 400, { error: 'bad_player' });
  const out = await L.mutate(st => {
    if (!st.users[s0.id]) return { code: 401, error: 'login_with_discord' };
    if (!st.players[player]) return { code: 404, error: 'unknown_player' };
    if (st.byUser[s0.id]) return { code: 409, error: 'you_already_claimed', player: st.byUser[s0.id] };
    if (st.claims[player]) return { code: 409, error: 'taken' };
    st.claims[player] = s0.id; st.byUser[s0.id] = player;
    return { code: 200, ok: true, player };
  });
  L.send(res, out.code, out);
});

'use strict';
const crypto = require('crypto'), fs = require('fs'), path = require('path');

const COOKIE = 'arctura_sess', OCOOKIE = 'arctura_oauth';
const SECRET = () => process.env.SESSION_SECRET || '';
const SB_URL = () => (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = () => process.env.SUPABASE_SECRET_KEY || '';
const useDb = () => !!(SB_URL() && SB_KEY());
const LOCAL = process.env.LOCAL_DATA || path.join(process.cwd(), '.data');
const AUTHP = () => 'auth/' + (process.env.AUTH_PATH || 'local') + '/state.json';
const DISCORD = () => process.env.DISCORD_BASE || 'https://discord.com';

/* ---------- storage (Supabase Postgres in production, plain files when SUPABASE_* is not set) ----------
   Two tables, both locked down with row-level security and reachable only with the server-side secret key:
   docs(path, body, v) holds every match and event document; app_state(id=1, version, data) holds account state. */
async function sb(method, pq, body, prefer) {
  const k = SB_KEY();
  const r = await fetch(SB_URL() + '/rest/v1/' + pq, {
    method, signal: AbortSignal.timeout(8000),
    headers: { apikey: k, authorization: 'Bearer ' + k, 'content-type': 'application/json', prefer: prefer || 'return=minimal' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const t = await r.text();
  if (!r.ok) throw new Error('db_' + r.status + ' ' + t.slice(0, 200));
  return t ? JSON.parse(t) : null;
}
const eq = p => 'eq.' + encodeURIComponent(p);

async function putJSON(p, obj) {
  if (useDb()) { await sb('POST', 'docs', { path: p, body: obj, v: Date.now() }, 'resolution=merge-duplicates,return=minimal'); return; }
  const f = path.join(LOCAL, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj));
}
async function delPath(p) {
  if (useDb()) { await sb('DELETE', 'docs?path=' + eq(p)); return; }
  fs.rmSync(path.join(LOCAL, p), { force: true });
}
/* ids and versions only; the page fetches each document from /api/doc (cached by version) */
async function listDocs(prefix) {
  const c = prefix.replace(/\/$/, '');
  if (useDb()) {
    let out = [], off = 0;
    for (;;) {
      const rows = await sb('GET', 'docs?select=path,v&path=like.' + encodeURIComponent(prefix + '*') + '&order=path&limit=1000&offset=' + off, undefined, 'count=none');
      out = out.concat(rows.map(r => ({ id: r.path.slice(prefix.length).replace(/\.json$/, ''), url: '/api/doc?c=' + c + '&id=' + encodeURIComponent(r.path.slice(prefix.length).replace(/\.json$/, '')), v: Number(r.v) })));
      if (rows.length < 1000) break; off += 1000;
    }
    return out;
  }
  const d = path.join(LOCAL, prefix); if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter(n => n.endsWith('.json')).map(n => ({ id: n.slice(0, -5), url: '/api/doc?c=' + c + '&id=' + encodeURIComponent(n.slice(0, -5)), v: Math.floor(fs.statSync(path.join(d, n)).mtimeMs) }));
}
async function getJSON(p) {
  if (useDb()) { const rows = await sb('GET', 'docs?select=body&path=' + eq(p) + '&limit=1'); return rows && rows[0] ? rows[0].body : null; }
  const f = path.join(LOCAL, p); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

/* ---------- account state: one small document, changed one request at a time ---------- */
const blank = () => ({ users: {}, admins: [], claims: {}, byUser: {}, players: {}, published: {}, bugs: {} });
let chain = Promise.resolve();

/* State is also encrypted (AES-256-GCM, key derived from SESSION_SECRET) before it is written.
   Rotating SESSION_SECRET makes the saved state unreadable. */
const stateKey = () => crypto.createHash('sha256').update('arctura-state-v1:' + SECRET()).digest();
function seal(obj) {
  if (!SECRET()) throw new Error('SESSION_SECRET is required to save state');
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', stateKey(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { enc: 1, d: Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64') };
}
function unseal(doc) {
  if (!doc || doc.enc !== 1) return doc;
  if (!SECRET()) throw new Error('SESSION_SECRET is required to read state');
  const buf = Buffer.from(String(doc.d), 'base64'), d = crypto.createDecipheriv('aes-256-gcm', stateKey(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
}
/* Saves are compare-and-swap on a version number: a writer that lost a race gets a conflict, re-reads and
   applies its change again, so two requests at once cannot erase each other. */
async function readStateV() {
  if (!useDb()) return { s: Object.assign(blank(), unseal(await getJSON(AUTHP())) || {}), n: 0 };
  const rows = await sb('GET', 'app_state?select=version,data&id=eq.1');
  if (!rows || !rows.length) return { s: blank(), n: 0 };
  return { s: Object.assign(blank(), unseal(rows[0].data)), n: rows[0].version };
}
async function writeState(s, n) {
  const sealed = seal(s);
  if (!useDb()) { await putJSON(AUTHP(), sealed); return; }
  const rows = n === 0
    ? await sb('POST', 'app_state', { id: 1, version: 1, data: sealed }, 'resolution=ignore-duplicates,return=representation')
    : await sb('PATCH', 'app_state?id=eq.1&version=eq.' + n, { version: n + 1, data: sealed }, 'return=representation');
  if (!rows || !rows.length) throw Object.assign(new Error('conflict'), { conflict: true });
}
async function readState() { return (await readStateV()).s; }
function mutate(fn) {
  const run = chain.then(async () => {
    for (let a = 0; a < 8; a++) {
      const { s, n } = await readStateV(), out = await fn(s);
      try { await writeState(s, n); return out; }
      catch (e) { if (!e.conflict) throw e; await new Promise(r => setTimeout(r, 25 + Math.random() * 100)); }
    }
    throw Object.assign(new Error('busy_try_again'), { code: 409 });
  });
  chain = run.catch(() => {}); return run;
}

/* ---------- sessions ---------- */
function sign(o) {
  const b = Buffer.from(JSON.stringify(o)).toString('base64url');
  return b + '.' + crypto.createHmac('sha256', SECRET()).update(b).digest('base64url');
}
function unsign(s) {
  if (!s || !SECRET()) return null;
  const i = s.lastIndexOf('.'); if (i < 0) return null;
  const b = s.slice(0, i), m = s.slice(i + 1), e = crypto.createHmac('sha256', SECRET()).update(b).digest('base64url');
  if (m.length !== e.length || !crypto.timingSafeEqual(Buffer.from(m), Buffer.from(e))) return null;
  try { const o = JSON.parse(Buffer.from(b, 'base64url').toString()); return o.exp > Date.now() ? o : null; } catch (e) { return null; }
}
function cookies(req) {
  const o = {}; (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return o;
}
function setCookie(res, name, val, maxAge) {
  const secure = process.env.LOCAL_DATA || process.env.INSECURE_COOKIES ? '' : '; Secure';
  const c = name + '=' + encodeURIComponent(val) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + secure;
  const prev = res.getHeader('Set-Cookie'); res.setHeader('Set-Cookie', prev ? [].concat(prev, c) : c);
}
const session = req => unsign(cookies(req)[COOKIE]);

function isAdmin(s, st) {
  if (!s) return false;
  return s.k === 'd' && st.admins.indexOf(s.id) >= 0;
}
function who(s, st) {
  if (!s) return { role: null };
  const u = st.users[s.id]; if (!u) return { role: null };
  return { role: st.admins.indexOf(s.id) >= 0 ? 'admin' : 'user', via: 'discord', id: s.id, name: u.name, avatar: u.avatar || null, claim: st.byUser[s.id] || null };
}

/* ---------- http helpers ---------- */
function send(res, code, obj) {
  res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(obj));
}
function redirect(res, loc) { res.statusCode = 302; res.setHeader('Location', loc); res.setHeader('Cache-Control', 'no-store'); res.end(); }
async function body(req, max) {
  if (req.body !== undefined && req.body !== null && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  let raw = '';
  if (typeof req.body === 'string') raw = req.body;
  else raw = await new Promise((ok, no) => { const ch = []; let n = 0; req.on('data', c => { n += c.length; if (n > max) { no(Object.assign(new Error('too_large'), { code: 413 })); req.destroy(); return; } ch.push(c); }); req.on('end', () => ok(Buffer.concat(ch).toString('utf8'))); req.on('error', no); });
  if (raw.length > max) throw Object.assign(new Error('too_large'), { code: 413 });
  try { return raw ? JSON.parse(raw) : {}; } catch (e) { throw Object.assign(new Error('bad_json'), { code: 400 }); }
}
function sameOrigin(req) {
  const o = req.headers.origin; if (!o) return false;
  try { return new URL(o).host === req.headers.host; } catch (e) { return false; }
}
function site(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || (process.env.LOCAL_DATA ? 'http' : 'https');
  return proto + '://' + req.headers.host;
}
const handler = fn => async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x'); req.q = Object.fromEntries(u.searchParams);
    if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) return send(res, 403, { error: 'bad_origin' });
    await fn(req, res);
  } catch (e) { console.error(e); send(res, e.code >= 400 && e.code < 500 ? e.code : 500, { error: e.code >= 400 && e.code < 500 ? e.message : 'server' }); }
};
const safeEq = (a, b) => { const h = x => crypto.createHash('sha256').update(String(x)).digest(); return crypto.timingSafeEqual(h(a), h(b)); };
const isBot = n => /^SpawnedPlayer_\d+$/i.test(n) || /^(BP_|Roshan)/i.test(n) || /_C_\d+$/.test(n);
const ID_OK = /^[A-Za-z0-9_-]{1,80}$/;

module.exports = { COOKIE, OCOOKIE, DISCORD, putJSON, delPath, listDocs, getJSON, readState, mutate, sign, unsign, cookies, setCookie, session, isAdmin, who, send, redirect, body, site, handler, safeEq, isBot, ID_OK };

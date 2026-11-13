'use strict';
const crypto = require('crypto'), fs = require('fs'), path = require('path');

const COOKIE = 'arctura_sess', OCOOKIE = 'arctura_oauth';
const SECRET = () => process.env.SESSION_SECRET || '';
const useBlob = !!process.env.BLOB_READ_WRITE_TOKEN;
const LOCAL = process.env.LOCAL_DATA || path.join(process.cwd(), '.data');
const AUTHP = () => 'auth/' + (process.env.AUTH_PATH || 'local') + '/state.json';
const DISCORD = () => process.env.DISCORD_BASE || 'https://discord.com';
let _blob = null;
const B = () => _blob || (_blob = require('@vercel/blob'));

/* ---------- storage (Vercel Blob in production, files when no token) ---------- */
async function putJSON(p, obj) {
  const body = JSON.stringify(obj);
  if (useBlob) { await B().put(p, body, { access: 'public', allowOverwrite: true, addRandomSuffix: false, contentType: 'application/json', cacheControlMaxAge: 60 }); return; }
  const f = path.join(LOCAL, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body);
}
async function delPath(p) {
  if (useBlob) { const r = await B().list({ prefix: p, limit: 5 }); const hit = r.blobs.filter(b => b.pathname === p).map(b => b.url); if (hit.length) await B().del(hit); return; }
  fs.rmSync(path.join(LOCAL, p), { force: true });
}
async function listDocs(prefix) {
  if (useBlob) {
    let out = [], cursor;
    do {
      const r = await B().list({ prefix, cursor, limit: 1000 });
      out = out.concat(r.blobs.map(b => ({ id: b.pathname.slice(prefix.length).replace(/\.json$/, ''), url: b.url, v: new Date(b.uploadedAt).getTime() })));
      cursor = r.hasMore ? r.cursor : null;
    } while (cursor);
    return out;
  }
  const d = path.join(LOCAL, prefix); if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter(n => n.endsWith('.json')).map(n => ({ id: n.slice(0, -5), url: '/local/' + prefix + n, v: Math.floor(fs.statSync(path.join(d, n)).mtimeMs) }));
}
async function getJSON(p) {
  if (useBlob) {
    const r = await B().list({ prefix: p, limit: 5 }); const b = r.blobs.find(x => x.pathname === p); if (!b) return null;
    const res = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' }); return res.ok ? res.json() : null;
  }
  const f = path.join(LOCAL, p); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

/* ---------- account state: one small document, changed one request at a time ---------- */
const blank = () => ({ users: {}, admins: [], claims: {}, byUser: {}, players: {}, published: {}, bootstrapDeleted: false });
let chain = Promise.resolve();
async function readState() { const s = await getJSON(AUTHP()); return Object.assign(blank(), s || {}); }
function mutate(fn) {
  const run = chain.then(async () => { const s = await readState(); const out = await fn(s); await putJSON(AUTHP(), s); return out; });
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
  if (s.k === 'b') return !st.bootstrapDeleted;
  return s.k === 'd' && st.admins.indexOf(s.id) >= 0;
}
function who(s, st) {
  if (!s) return { role: null };
  if (s.k === 'b') return st.bootstrapDeleted ? { role: null } : { role: 'admin', via: 'bootstrap', id: 'bootstrap', name: s.name || 'Admin' };
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

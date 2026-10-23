'use strict';
// Man Hunt server. No dependencies. State lives in memory (lobbies expire after 6 hours of inactivity).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC = __dirname;
const MAX_ONE_SEEKER = 8;          // above this many players there are two seekers
const MAX_PLAYERS = 40;
const TTL = 6 * 3600 * 1000;
const AWAY_MS = 45 * 1000;

const lobbies = new Map();
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode() {
  for (let i = 0; i < 100; i++) {
    const b = crypto.randomBytes(4);
    let c = '';
    for (let j = 0; j < 4; j++) c += ALPHA[b[j] % ALPHA.length];
    if (!lobbies.has(c)) return c;
  }
  return null;
}
function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function cleanName(n) {
  return String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
}
function addPlayer(l, name) {
  const p = {
    id: crypto.randomBytes(4).toString('hex'),
    token: crypto.randomBytes(16).toString('hex'),
    name, joinedAt: Date.now(), seen: Date.now(),
    caught: false, lat: null, lng: null, acc: null, t: null,
  };
  l.players.set(p.token, p);
  return p;
}
// setting 0 = automatic (one seeker, two above 8 players). Otherwise the host's number, always leaving at least one hider.
const seekerCount = (n, setting) => (setting ? Math.max(1, Math.min(setting, n - 1)) : (n > MAX_ONE_SEEKER ? 2 : 1));

function view(l, tok) {
  const me = l.players.get(tok);
  const meSeeker = l.seekers.includes(me.id);
  const players = [...l.players.values()].sort((a, b) => a.joinedAt - b.joinedAt).map(p => {
    const o = { id: p.id, name: p.name, caught: p.caught, joinedAt: p.joinedAt, away: Date.now() - p.seen > AWAY_MS };
    // Locations are only sent to the person who is allowed to see them:
    // you see yourself, seekers see free hiders and the other seekers. Hiders never see anyone.
    const visible = l.status === 'playing' && p.lat != null && (p === me || (meSeeker && !p.caught));
    if (visible) { o.lat = p.lat; o.lng = p.lng; o.acc = p.acc; o.t = p.t; }
    return o;
  });
  return {
    you: me.id,
    lobby: { code: l.code, hostId: l.hostId, status: l.status, seekers: l.seekers, seekerSetting: l.seekerSetting, round: l.round, startedAt: l.startedAt },
    players,
  };
}

function fail(code, msg) { const e = new Error(msg); e.status = code; return e; }
function getLobby(code) {
  const l = lobbies.get(String(code || '').toUpperCase());
  if (!l) throw fail(404, 'לא נמצא משחק עם הקוד הזה');
  l.touched = Date.now();
  return l;
}
function auth(code, token) {
  const l = getLobby(code);
  const me = l.players.get(String(token || ''));
  if (!me) throw fail(403, 'אינך חלק מהמשחק הזה');
  me.seen = Date.now();
  return { l, me };
}
function checkEnd(l) {
  if (l.status !== 'playing') return;
  const hiders = [...l.players.values()].filter(p => !l.seekers.includes(p.id));
  if (hiders.length === 0 || hiders.every(p => p.caught)) l.status = 'ended';
  else if (!l.seekers.some(id => [...l.players.values()].some(p => p.id === id))) l.status = 'ended';
}

const routes = {
  'POST /api/create'(b) {
    const name = cleanName(b.name);
    if (!name) throw fail(400, 'חסר שם');
    const code = newCode();
    if (!code) throw fail(503, 'השרת עמוס, נסה שוב');
    const l = { code, status: 'lobby', seekers: [], seekerSetting: 0, round: 0, players: new Map(), touched: Date.now(), hostId: null };
    const p = addPlayer(l, name);
    l.hostId = p.id;
    lobbies.set(code, l);
    return { code, token: p.token, id: p.id };
  },
  'POST /api/join'(b) {
    const name = cleanName(b.name);
    if (!name) throw fail(400, 'חסר שם');
    const l = getLobby(b.code);
    if (l.status !== 'lobby') throw fail(409, 'המשחק כבר התחיל');
    if (l.players.size >= MAX_PLAYERS) throw fail(409, 'הלובי מלא');
    const p = addPlayer(l, name);
    return { code: l.code, token: p.token, id: p.id };
  },
  'GET /api/state'(b) {
    const { l, me } = auth(b.code, b.token);
    return view(l, me.token);
  },
  'POST /api/loc'(b) {
    const { l, me } = auth(b.code, b.token);
    const lat = Number(b.lat), lng = Number(b.lng);
    if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) throw fail(400, 'מיקום לא תקין');
    if (l.status === 'playing' && !me.caught) {
      me.lat = lat; me.lng = lng; me.acc = Math.round(Number(b.acc) || 0); me.t = Date.now();
    }
    return { ok: true };
  },
  'POST /api/settings'(b) {
    const { l, me } = auth(b.code, b.token);
    if (l.hostId !== me.id) throw fail(403, 'רק המארח יכול לשנות הגדרות');
    if (l.status !== 'lobby') throw fail(409, 'אפשר לשנות רק בלובי');
    const n = Math.floor(Number(b.seekers));
    if (!(n >= 0 && n <= MAX_PLAYERS)) throw fail(400, 'מספר לא תקין');
    l.seekerSetting = n;
    return { ok: true };
  },
  'POST /api/start'(b) {
    const { l, me } = auth(b.code, b.token);
    if (l.hostId !== me.id) throw fail(403, 'רק המארח יכול להתחיל');
    if (l.players.size < 2) throw fail(409, 'צריך לפחות שני שחקנים');
    const ids = [...l.players.values()].map(p => p.id);
    l.seekers = shuffle(ids).slice(0, seekerCount(ids.length, l.seekerSetting));
    for (const p of l.players.values()) { p.caught = false; p.lat = p.lng = p.acc = p.t = null; }
    l.round += 1; l.status = 'playing'; l.startedAt = Date.now();
    return { ok: true };
  },
  'POST /api/catch'(b) {
    const { l, me } = auth(b.code, b.token);
    if (l.status !== 'playing') throw fail(409, 'המשחק לא פעיל');
    if (!l.seekers.includes(me.id)) throw fail(403, 'רק מחפש יכול לתפוס');
    const t = [...l.players.values()].find(p => p.id === b.target);
    if (!t || l.seekers.includes(t.id)) throw fail(400, 'שחקן לא תקין');
    t.caught = true; t.lat = t.lng = t.acc = t.t = null;
    checkEnd(l);
    return { ok: true };
  },
  'POST /api/end'(b) {
    const { l, me } = auth(b.code, b.token);
    if (l.hostId !== me.id) throw fail(403, 'רק המארח יכול לסיים');
    l.status = 'ended';
    return { ok: true };
  },
  'POST /api/lobby'(b) {
    const { l, me } = auth(b.code, b.token);
    if (l.hostId !== me.id) throw fail(403, 'רק המארח יכול לחזור ללובי');
    l.status = 'lobby'; l.seekers = [];
    for (const p of l.players.values()) { p.caught = false; p.lat = p.lng = p.acc = p.t = null; }
    return { ok: true };
  },
  'POST /api/leave'(b) {
    const { l, me } = auth(b.code, b.token);
    l.players.delete(me.token);
    l.seekers = l.seekers.filter(id => id !== me.id);
    if (l.players.size === 0) { lobbies.delete(l.code); return { ok: true }; }
    if (l.hostId === me.id) l.hostId = [...l.players.values()].sort((a, c) => a.joinedAt - c.joinedAt)[0].id;
    checkEnd(l);
    return { ok: true };
  },
};

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    const ext = path.extname(file);
    res.writeHead(200, {
      'content-type': TYPES[ext] || 'application/octet-stream',
      'cache-control': ext === '.png' ? 'public, max-age=86400' : 'no-cache',
    });
    res.end(data);
  });
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};
function sendJson(res, status, obj) {
  res.writeHead(status, Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, CORS));
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, url.pathname);
  }
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  const handler = routes[req.method + ' ' + url.pathname];
  if (!handler) return sendJson(res, 404, { error: 'לא נמצא' });
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 4096) req.destroy(); });
  req.on('end', () => {
    try {
      let body = {};
      if (req.method === 'GET') url.searchParams.forEach((v, k) => { body[k] = v; });
      else if (raw) body = JSON.parse(raw);
      sendJson(res, 200, handler(body));
    } catch (e) {
      if (e instanceof SyntaxError) return sendJson(res, 400, { error: 'בקשה לא תקינה' });
      sendJson(res, e.status || 500, { error: e.status ? e.message : 'שגיאת שרת' });
      if (!e.status) console.error(e);
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [c, l] of lobbies) if (now - l.touched > TTL) lobbies.delete(c);
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => console.log('Man Hunt listening on ' + PORT));
module.exports = server;

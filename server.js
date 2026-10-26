// Kings Corner web server. No packages needed: run with `npm start` (or `node server.js`).
// Serves the game page and runs online games in memory. Players get live updates
// over Server-Sent Events and send moves with small JSON POST requests.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = Number(process.env.PORT) || 3000;
const INDEX = path.join(__dirname, 'index.html');

// The game rules live inside index.html (the <script id="kc-engine"> block) so the
// page and the server always use the same rules and there are fewer files to upload.
function loadPage() {
  if (!fs.existsSync(INDEX)) {
    console.error('ERROR: index.html was not found next to server.js.');
    console.error('Upload index.html, server.js and package.json together, at the top level of your repository.');
    process.exit(1);
  }
  const html = fs.readFileSync(INDEX, 'utf8');
  const m = html.match(/<script id="kc-engine">([\s\S]*?)<\/script>/);
  if (!m) {
    console.error('ERROR: index.html is missing the game rules block (<script id="kc-engine">). Use the index.html that came with server.js.');
    process.exit(1);
  }
  const mod = { exports: {} };
  new Function('module', 'self', m[1])(mod, undefined);
  return { html: Buffer.from(html), E: mod.exports };
}
const { html: PAGE, E } = loadPage();
const MAX_ROOMS = 2000;
const AWAY_GRACE_MS = 8000;      // how long a dropped player has to come back before being marked away
const AWAY_FIRST_MS = 4000;      // pause before auto-playing an away player's turn
const BOT_MOVE_MS = 1300;
const ROOM_IDLE_MS = 3 * 60 * 60 * 1000;


/** code -> { code, host, seats:[{pid,name}], g, clients: Map(pid -> res), leaveTimers: Map, bot, touched } */
const rooms = new Map();

const cleanName = s => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14);
const validPid = s => typeof s === 'string' && /^[a-z0-9]{6,24}$/i.test(s);
const normCode = s => String(s || '').trim().toUpperCase();

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (let tries = 0; tries < 50; tries++) {
    let s = '';
    for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
    if (!rooms.has(s)) return s;
  }
  return null;
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, data = '';
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 16 * 1024) { reject(new Error('too big')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// ---------- room state ----------
function viewFor(room, pid) {
  const seat = room.g ? room.g.players.findIndex(p => p.pid === pid) : -1;
  return {
    code: room.code,
    host: room.host,
    seats: room.seats.map(s => ({ pid: s.pid, name: s.name, online: room.clients.has(s.pid) })),
    game: room.g ? E.redact(room.g, seat) : null,
  };
}

function broadcast(room) {
  room.touched = Date.now();
  for (const [pid, res] of room.clients) {
    try { res.write(`data: ${JSON.stringify(viewFor(room, pid))}\n\n`); } catch (e) { /* closed; cleanup happens on close */ }
  }
}

function pickNewHost(room) {
  if (room.seats.some(s => s.pid === room.host)) return;
  const online = room.seats.find(s => room.clients.has(s.pid));
  room.host = (online || room.seats[0] || {}).pid || null;
}

function removeFromLobby(room, pid) {
  room.seats = room.seats.filter(s => s.pid !== pid);
  if (!room.seats.length) { closeRoom(room); return; }
  pickNewHost(room);
}

function markAway(room, pid) {
  if (!room.g) return;
  const p = room.g.players.find(x => x.pid === pid);
  if (p) p.away = true;
  if (room.host === pid) {
    const online = room.seats.find(s => room.clients.has(s.pid));
    if (online) room.host = online.pid;
  }
}

function closeRoom(room) {
  clearTimeout(room.bot);
  for (const t of room.leaveTimers.values()) clearTimeout(t);
  for (const res of room.clients.values()) { try { res.end(); } catch (e) {} }
  rooms.delete(room.code);
}

// Away players get their turns played for them so the game never stalls.
function queueBot(room) {
  const g = room.g;
  if (room.bot || !g || g.over) return;
  const p = g.players[g.turn];
  if (!p.away) return;
  room.bot = setTimeout(() => {
    room.bot = null;
    const g2 = room.g;
    if (!g2 || g2.over || !g2.players[g2.turn].away) return;
    const seat = g2.turn;
    const m = E.findMove(g2, seat);
    E.apply(g2, seat, m || { type: 'end' });
    broadcast(room);
    queueBot(room);
  }, g.moved ? BOT_MOVE_MS : AWAY_FIRST_MS);
}

// ---------- API ----------
async function api(req, res, route, url) {
  if (route === 'events' && req.method === 'GET') return openStream(req, res, url);
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' });

  let b;
  try { b = await readBody(req); } catch (e) { return json(res, 400, { error: 'Bad request.' }); }
  const pid = b.pid;
  if (!validPid(pid)) return json(res, 400, { error: 'Reload the page and try again.' });

  if (route === 'create') {
    const name = cleanName(b.name);
    if (!name) return json(res, 400, { error: 'Type your name first.' });
    if (rooms.size >= MAX_ROOMS) return json(res, 503, { error: 'The server is full right now. Try again in a few minutes.' });
    const code = newCode();
    if (!code) return json(res, 503, { error: 'Could not make a game code. Try again.' });
    rooms.set(code, { code, host: pid, seats: [{ pid, name }], g: null, clients: new Map(), leaveTimers: new Map(), bot: null, touched: Date.now() });
    return json(res, 200, { code });
  }

  const room = rooms.get(normCode(b.code));
  if (!room) return json(res, 404, { error: `No game found with code ${normCode(b.code) || '----'}. Check the code with your host.` });
  room.touched = Date.now();
  const seatInfo = room.seats.find(s => s.pid === pid);

  if (route === 'join') {
    const name = cleanName(b.name);
    if (!name) return json(res, 400, { error: 'Type your name first.' });
    if (seatInfo) {
      seatInfo.name = name;
      if (room.g) { const p = room.g.players.find(x => x.pid === pid); if (p) p.name = name; }
    } else {
      if (room.g) return json(res, 409, { error: 'That game has already started.' });
      if (room.seats.length >= 4) return json(res, 409, { error: 'That game is full. Four players is the limit.' });
      room.seats.push({ pid, name });
    }
    broadcast(room);
    return json(res, 200, { code: room.code });
  }

  if (!seatInfo) return json(res, 403, { error: "You're not in this game." });

  if (route === 'start') {
    const hostHere = room.clients.has(room.host);
    if (pid !== room.host && hostHere) return json(res, 403, { error: 'Only the host can deal.' });
    if (room.g && !room.g.over) return json(res, 409, { error: 'A game is already being played.' });
    if (room.seats.length < 2) return json(res, 409, { error: 'You need at least 2 players.' });
    if (pid !== room.host) room.host = pid;
    clearTimeout(room.bot); room.bot = null;
    room.g = E.newGame(room.seats.map(s => ({ pid: s.pid, name: s.name, away: !room.clients.has(s.pid) })));
    broadcast(room);
    queueBot(room);
    return json(res, 200, { ok: true });
  }

  if (route === 'act') {
    if (!room.g) return json(res, 409, { error: 'The game has not started yet.' });
    const seat = room.g.players.findIndex(p => p.pid === pid);
    if (seat !== room.g.turn) return json(res, 409, { error: "It's not your turn." });
    if (!E.apply(room.g, seat, b.a)) {
      broadcast(room);
      return json(res, 400, { error: "That move isn't allowed." });
    }
    broadcast(room);
    queueBot(room);
    return json(res, 200, { ok: true });
  }

  if (route === 'leave') {
    const stream = room.clients.get(pid);
    room.clients.delete(pid);
    if (stream) { try { stream.end(); } catch (e) {} }
    if (!room.g) removeFromLobby(room, pid); else markAway(room, pid);
    if (rooms.has(room.code)) { broadcast(room); queueBot(room); }
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'Unknown request.' });
}

function openStream(req, res, url) {
  const room = rooms.get(normCode(url.searchParams.get('code')));
  const pid = url.searchParams.get('pid');
  if (!room || !validPid(pid) || !room.seats.some(s => s.pid === pid)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('gone');
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');

  const old = room.clients.get(pid);
  if (old && old !== res) { try { old.end(); } catch (e) {} }
  room.clients.set(pid, res);
  clearTimeout(room.leaveTimers.get(pid));
  room.leaveTimers.delete(pid);
  if (room.g) { const p = room.g.players.find(x => x.pid === pid); if (p) p.away = false; }
  broadcast(room);

  req.on('close', () => {
    if (room.clients.get(pid) !== res) return;
    room.clients.delete(pid);
    room.leaveTimers.set(pid, setTimeout(() => {
      room.leaveTimers.delete(pid);
      if (!rooms.has(room.code) || room.clients.has(pid)) return;
      if (!room.g) removeFromLobby(room, pid); else markAway(room, pid);
      if (rooms.has(room.code)) { broadcast(room); queueBot(room); }
    }, AWAY_GRACE_MS));
  });
}

// Keep live connections open through proxies, and clear out abandoned games.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    for (const res of room.clients.values()) { try { res.write(': ping\n\n'); } catch (e) {} }
    if (!room.clients.size && now - room.touched > ROOM_IDLE_MS) closeRoom(room);
  }
}, 20000).unref();

// ---------- the page ----------
function servePage(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(req.method === 'HEAD' ? undefined : PAGE);
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400); return res.end(); }
  if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (url.pathname.startsWith('/api/')) {
    return api(req, res, url.pathname.slice(5), url).catch(err => {
      console.error(err);
      if (!res.headersSent) json(res, 500, { error: 'Something went wrong on the server. Try again.' });
    });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  servePage(req, res);
});
server.keepAliveTimeout = 65000;
server.on('error', err => { console.error('Server could not start:', err.message); process.exit(1); });
server.listen(PORT, '0.0.0.0', () => console.log(`Kings Corner is running on port ${PORT}`));

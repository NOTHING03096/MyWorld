'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'messages.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const SCHED_FILE = path.join(DATA_DIR, 'scheduled.json');
const QUOTE_FILE = path.join(DATA_DIR, 'daily.json');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

// ============================================================
// Constants
// ============================================================
const TTL_MS = {
  '10s': 10 * 1000,
  '1m':  60 * 1000,
  '1h':  60 * 60 * 1000,
  '3h':  3 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000
};
const DEFAULT_TTL       = '3h';
const SESSION_TTL       = 30 * 24 * 60 * 60 * 1000;    // 30 days
const MAX_STORED_MSGS   = 5000;
const MAX_UNSEEN_AGE    = 30 * 24 * 60 * 60 * 1000;    // 30 days
const MAX_PINNED        = 20;
const LOGIN_WINDOW_MS   = 15 * 60 * 1000;
const LOGIN_MAX         = 10;

// ============================================================
// Accounts (password can be overridden via env)
// ============================================================
const USERS = {
  GF091007: { password: process.env.GF_PW || 'piyush0907', name: 'Fancy 💗' },
  BF030609: { password: process.env.BF_PW || 'fancy0306',  name: '💛' }
};
const partnerOf = (u) => (u === 'GF091007' ? 'BF030609' : 'GF091007');

// ============================================================
// Signed media URLs (HMAC) — used so <img>/<video> can't be hotlinked
// ============================================================
const URL_SECRET = process.env.URL_SECRET || crypto.randomBytes(32).toString('hex');

function signMediaUrl(filename) {
  const exp = Date.now() + 365 * 24 * 60 * 60 * 1000;   // 1 year
  const sig = crypto.createHmac('sha256', URL_SECRET)
    .update(filename + ':' + exp).digest('base64url');
  return '/uploads/' + filename + '?exp=' + exp + '&sig=' + sig;
}
function verifySignedUrl(filename, exp, sig) {
  if (!exp || !sig) return false;
  if (Date.now() > Number(exp)) return false;
  const expected = crypto.createHmac('sha256', URL_SECRET)
    .update(filename + ':' + exp).digest('base64url');
  try {
    return crypto.timingSafeEqual(Buffer.from(String(sig)), Buffer.from(expected));
  } catch (_) { return false; }
}

// ============================================================
// Persistence
// ============================================================
let messages = [];
let pinned   = [];
let scheduled = [];
const scheduledTimers = new Map();
const stats = {
  GF091007: { messages: 0, photos: 0, videos: 0, calls: 0, notes: 0 },
  BF030609: { messages: 0, photos: 0, videos: 0, calls: 0, notes: 0 }
};
let dailySent = { GF091007: '', BF030609: '' };

function readJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return def; }
}
function writeJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data), 'utf8'); }
  catch (e) { console.error('Save error', file, e); }
}
function saveData()      { writeJson(DATA_FILE, { messages, pinned }); }
function saveStats()     { writeJson(STATS_FILE, stats); }
function saveScheduled() { writeJson(SCHED_FILE, { scheduled }); }
function saveDaily()     { writeJson(QUOTE_FILE, dailySent); }

function scheduleDelete(id, at) {
  setTimeout(() => {
    const i = messages.findIndex((m) => m.id === id);
    if (i !== -1) { messages.splice(i, 1); saveData(); }
  }, Math.max(0, at - Date.now()));
}

function loadData() {
  const raw = readJson(DATA_FILE, {});
  messages = raw.messages || [];
  pinned   = raw.pinned   || [];

  const now = Date.now();
  messages = messages.filter((m) => {
    if (m.seenAt) {
      const delAt = m.seenAt + (m.ttlMs || TTL_MS[DEFAULT_TTL]);
      if (delAt <= now) return false;
      scheduleDelete(m.id, delAt);
    }
    return true;
  });
  saveData();

  Object.assign(stats, readJson(STATS_FILE, {}));
  dailySent = readJson(QUOTE_FILE, dailySent);

  const s = readJson(SCHED_FILE, {});
  scheduled = (s.scheduled || []).filter((x) => x.at > now - 60 * 1000);
  saveScheduled();
  // reschedule after io is ready (moved below io init)
}

function purgeOldMessages() {
  const now = Date.now();
  const before = messages.length;
  messages = messages.filter((m) => {
    if (m.seenAt) return (now - m.seenAt) < (m.ttlMs || TTL_MS[DEFAULT_TTL]);
    return (now - (m.createdAt || 0)) < MAX_UNSEEN_AGE;
  });
  if (messages.length > MAX_STORED_MSGS) {
    messages = messages.slice(-MAX_STORED_MSGS);
  }
  if (messages.length !== before) saveData();
}
setInterval(purgeOldMessages, 60 * 60 * 1000);

// ============================================================
// Session tracking (with idle TTL)
// ============================================================
const sessions        = new Map();
const sessionLastSeen = new Map();
const online          = new Map();

function createSession(token, username) {
  sessions.set(token, username);
  sessionLastSeen.set(token, Date.now());
}
function touchSession(token) {
  if (token && sessions.has(token)) sessionLastSeen.set(token, Date.now());
}
setInterval(() => {
  const now = Date.now();
  for (const [t, ts] of sessionLastSeen.entries()) {
    if (now - ts > SESSION_TTL) {
      sessions.delete(t);
      sessionLastSeen.delete(t);
    }
  }
}, 60 * 60 * 1000);

// ============================================================
// Express app
// ============================================================
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

function authFrom(req) {
  const token =
    req.headers['x-auth-token'] ||
    (req.body && req.body.token) ||
    (req.query && req.query.t);
  if (!token) return null;
  touchSession(String(token));
  const username = sessions.get(String(token));
  return username ? { token: String(token), username } : null;
}

// ---- login rate limit ----
const loginAttempts = new Map();
function rateLimitLogin(ip) {
  const now = Date.now();
  const arr = (loginAttempts.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  loginAttempts.set(ip, arr);
  if (arr.length >= LOGIN_MAX) return true;
  arr.push(now);
  return false;
}

app.post('/api/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (rateLimitLogin(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }
  const { username, password } = req.body || {};
  const u = USERS[username];
  if (!u || u.password !== password) {
    return res.status(401).json({ error: 'Wrong ID or password 💔' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  createSession(token, username);
  const partner = partnerOf(username);
  res.json({
    token,
    username,
    displayName: u.name,
    partner,
    partnerName: USERS[partner].name,
    stats: stats[username]
  });
});

app.post('/api/logout', (req, res) => {
  const token = (req.body && req.body.token) || req.headers['x-auth-token'];
  if (token) { sessions.delete(token); sessionLastSeen.delete(token); }
  res.json({ ok: true });
});

app.get('/api/stats', (req, res) => {
  const a = authFrom(req);
  if (!a) return res.status(401).json({ error: 'Not logged in' });
  const me = a.username, p = partnerOf(me);
  res.json({ me: stats[me], partner: stats[p] });
});

app.get('/api/pins', (req, res) => {
  const a = authFrom(req);
  if (!a) return res.status(401).json({ error: 'Not logged in' });
  res.json(pinned);
});

// ============================================================
// Uploads
// ============================================================
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = (path.extname(file.originalname) || '').toLowerCase().slice(0, 12);
    cb(null, Date.now() + '-' + crypto.randomBytes(6).toString('hex') + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 60 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = /^(image\/(jpeg|png|gif|webp)|video\/(mp4|webm|quicktime|x-matroska)|audio\/(webm|mpeg|ogg|wav|x-m4a))$/i.test(file.mimetype);
    cb(ok ? null : new Error('Unsupported file type'), ok);
  }
});

app.post('/api/upload', (req, res, next) => {
  if (!authFrom(req)) return res.status(401).json({ error: 'Not logged in' });
  next();
}, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    if (!req.file) return res.status(400).json({ error: 'No file' });
    res.json({
      url:  signMediaUrl(req.file.filename),
      name: req.file.originalname,
      mime: req.file.mimetype,
      size: req.file.size
    });
  });
});

app.get('/api/download/:file', (req, res) => {
  if (!authFrom(req)) return res.status(401).json({ error: 'Not logged in' });
  const file = path.basename(req.params.file);
  const full = path.join(UPLOAD_DIR, file);
  if (!full.startsWith(UPLOAD_DIR) || !fs.existsSync(full)) {
    return res.status(404).send('Not found');
  }
  const niceName = req.query.name ? String(req.query.name) : file;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition',
    'attachment; filename="' + encodeURIComponent(niceName) + '"');
  res.setHeader('Content-Type', 'application/octet-stream');
  fs.createReadStream(full).pipe(res);
});

// Authenticated media endpoint (replaces open express.static of /uploads)
app.get('/uploads/:file', (req, res) => {
  const file = path.basename(req.params.file);
  const full = path.join(UPLOAD_DIR, file);
  if (!full.startsWith(UPLOAD_DIR) || !fs.existsSync(full)) {
    return res.status(404).end();
  }
  const sigOk   = verifySignedUrl(file, req.query.exp, req.query.sig);
  const tokenOk = req.query.t && sessions.has(String(req.query.t));
  if (!sigOk && !tokenOk) return res.status(403).end();
  if (tokenOk) touchSession(String(req.query.t));

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(full, (err) => { if (err) res.status(404).end(); });
});

app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// Socket.IO
// ============================================================
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e7,
  pingInterval: 15000,
  pingTimeout: 20000,
  transports: ['websocket', 'polling']
});

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  touchSession(token);
  const username = token && sessions.get(token);
  if (!username) return next(new Error('unauthorized'));
  socket.username = username;
  next();
});

function emitTo(username, event, data) {
  const sid = online.get(username);
  if (sid) io.to(sid).emit(event, data);
}

function pushStats() {
  saveStats();
  for (const u of Object.keys(USERS)) {
    const p = partnerOf(u);
    emitTo(u, 'stats:update', { me: stats[u], partner: stats[p] });
  }
}

// ============================================================
// Scheduled messages
// ============================================================
function scheduleSend(item) {
  const delay = Math.max(0, item.at - Date.now());
  const t = setTimeout(() => sendScheduled(item.id), delay);
  scheduledTimers.set(item.id, t);
}
function sendScheduled(id) {
  const i = scheduled.findIndex((s) => s.id === id);
  if (i === -1) return;
  const item = scheduled.splice(i, 1)[0];
  const tm = scheduledTimers.get(id);
  if (tm) { clearTimeout(tm); scheduledTimers.delete(id); }
  saveScheduled();

  const p = item.payload || {};
  const ttlKey = (p.ttl && TTL_MS[p.ttl]) ? p.ttl : DEFAULT_TTL;
  const msg = {
    id: crypto.randomUUID(),
    from: item.from, to: item.to,
    type: p.type || 'text',
    text: String(p.text || '').slice(0, 4000),
    caption: String(p.caption || '').slice(0, 400),
    url: p.url || '', name: p.name || '',
    mime: p.mime || '', size: p.size || 0,
    link: p.link || '',
    ttl: ttlKey, ttlMs: TTL_MS[ttlKey],
    replyTo: null, reactions: {},
    createdAt: Date.now(), seenAt: 0
  };
  messages.push(msg);

  const t = msg.type;
  if (t === 'text' || t === 'link') stats[item.from].messages++;
  else if (t === 'image') stats[item.from].photos++;
  else if (t === 'video') stats[item.from].videos++;
  else if (t === 'voice') stats[item.from].notes++;

  saveData();
  emitTo(item.to,   'message:new', msg);
  emitTo(item.from, 'message:scheduledSent', { message: msg });
  pushStats();
}

function scheduledListFor(username) {
  return scheduled
    .filter((s) => s.from === username)
    .map((s) => ({ id: s.id, at: s.at, payload: s.payload }));
}

// ============================================================
// Message builder
// ============================================================
function buildMessage(from, to, payload) {
  const type = payload.type || 'text';
  const ttlKey = (payload.ttl && TTL_MS[payload.ttl]) ? payload.ttl : DEFAULT_TTL;
  return {
    id: crypto.randomUUID(),
    from, to, type,
    text: String(payload.text || '').slice(0, 4000),
    caption: String(payload.caption || '').slice(0, 400),
    url: payload.url || '', name: payload.name || '',
    mime: payload.mime || '', size: payload.size || 0,
    link: payload.link || '',
    ttl: ttlKey, ttlMs: TTL_MS[ttlKey],
    replyTo: payload.replyTo || null,
    reactions: {},
    createdAt: Date.now(), seenAt: 0
  };
}

// ============================================================
// Daily quotes
// ============================================================
const DAILY_QUOTES = [
  "You are my favorite hello and my hardest goodbye 💗",
  "Every day with you feels like a warm hug ☕",
  "You make ordinary moments extraordinary ✨",
  "In your smile, I see something more beautiful than stars 🌟",
  "Loving you is my favorite thing to do ❤️",
  "You + Me = Forever 💞",
  "You're the reason my heart keeps smiling 😊"
];
function dailyQuote() {
  const day = new Date().toDateString();
  const i = day.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % DAILY_QUOTES.length;
  return DAILY_QUOTES[i];
}

// ============================================================
// Connection
// ============================================================
io.on('connection', (socket) => {
  const me = socket.username;
  const partner = partnerOf(me);
  online.set(me, socket.id);

  const visible = (m) => {
    if (m.from === me && m.hiddenForFrom) return false;
    if (m.to   === me && m.hiddenForTo)   return false;
    return m.from === me || m.to === me;
  };

  socket.emit('messages:pending', messages.filter(visible));
  socket.emit('stats:update', { me: stats[me], partner: stats[partner] });
  socket.emit('pins:list', pinned);
  socket.emit('scheduled:list', scheduledListFor(me));

  const today = new Date().toDateString();
  if (dailySent[me] !== today) {
    dailySent[me] = today;
    saveDaily();
    socket.emit('daily:quote', { text: dailyQuote() });
  }

  emitTo(partner, 'presence', { user: me, online: true });
  socket.emit('presence', { user: partner, online: online.has(partner) });

  // ---------------- messages ----------------
  socket.on('message:send', (payload, ack) => {
    const msg = buildMessage(me, partner, payload || {});
    messages.push(msg);

    const t = msg.type;
    if (t === 'text' || t === 'link') stats[me].messages++;
    else if (t === 'image') stats[me].photos++;
    else if (t === 'video') stats[me].videos++;
    else if (t === 'voice') stats[me].notes++;

    saveData();
    emitTo(partner, 'message:new', msg);
    if (typeof ack === 'function') ack({ ok: true, message: msg });
    pushStats();
  });

  socket.on('message:seen', ({ ids }) => {
    if (!Array.isArray(ids)) return;
    const now = Date.now();
    const seen = [];
    for (const id of ids) {
      const m = messages.find((x) => x.id === id && x.to === me && !x.seenAt);
      if (m) {
        m.seenAt = now;
        seen.push(id);
        scheduleDelete(id, now + (m.ttlMs || TTL_MS[DEFAULT_TTL]));
      }
    }
    if (seen.length) {
      saveData();
      emitTo(partner, 'message:seen', { ids: seen, by: me });
    }
  });

  socket.on('message:react', ({ id, emoji }) => {
    const m = messages.find((x) => x.id === id);
    if (!m) return;
    if (!m.reactions) m.reactions = {};
    if (m.reactions[me] === emoji) delete m.reactions[me];
    else m.reactions[me] = emoji;
    saveData();
    socket.emit('message:reaction', { id, reactions: m.reactions });
    emitTo(partner, 'message:reaction', { id, reactions: m.reactions });
  });

  socket.on('message:hideForMe', ({ id }) => {
    const m = messages.find((x) => x.id === id);
    if (!m) return;
    if (m.from === me) m.hiddenForFrom = true;
    if (m.to   === me) m.hiddenForTo   = true;
    saveData();
    socket.emit('message:hidden', { id });
  });

  socket.on('message:deleteForAll', ({ id }) => {
    const i = messages.findIndex((x) => x.id === id);
    if (i === -1 || messages[i].from !== me) return;
    messages.splice(i, 1);
    saveData();
    socket.emit('message:deleted', { id });
    emitTo(partner, 'message:deleted', { id });
  });

  // ---------------- pins ----------------
  socket.on('note:pin', ({ id }) => {
    const m = messages.find((x) => x.id === id);
    if (!m) return;
    if (pinned.find((p) => p.id === id)) return;
    pinned.unshift({
      id,
      text: m.text || m.caption || '',
      type: m.type,
      from: m.from,
      at: Date.now()
    });
    if (pinned.length > MAX_PINNED) pinned.pop();
    saveData();
    io.emit('pins:list', pinned);
  });
  socket.on('note:unpin', ({ id }) => {
    const i = pinned.findIndex((p) => p.id === id);
    if (i !== -1) pinned.splice(i, 1);
    saveData();
    io.emit('pins:list', pinned);
  });

  // ---------------- typing ----------------
  socket.on('typing', (v) => emitTo(partner, 'typing', { from: me, typing: !!v }));

  // ---------------- scheduled ----------------
  socket.on('message:schedule', ({ at, payload }, ack) => {
    if (typeof at !== 'number' || at < Date.now() + 3000) {
      return ack && ack({ ok: false, error: 'Pick a time at least 3 seconds ahead' });
    }
    if (!payload) return ack && ack({ ok: false, error: 'Empty payload' });
    if ((payload.type === 'text' || !payload.type) && !String(payload.text || '').trim()) {
      return ack && ack({ ok: false, error: 'Empty message' });
    }
    const item = {
      id: crypto.randomUUID(),
      from: me, to: partner, at,
      payload: {
        type:    payload.type || 'text',
        text:    String(payload.text || '').slice(0, 4000),
        caption: String(payload.caption || '').slice(0, 400),
        url:     payload.url || '',
        name:    payload.name || '',
        mime:    payload.mime || '',
        size:    payload.size || 0,
        link:    payload.link || '',
        ttl:     payload.ttl || DEFAULT_TTL
      }
    };
    scheduled.push(item);
    saveScheduled();
    scheduleSend(item);
    socket.emit('scheduled:list', scheduledListFor(me));
    ack && ack({ ok: true, id: item.id });
  });
  socket.on('message:cancelSchedule', ({ id }) => {
    const i = scheduled.findIndex((s) => s.id === id && s.from === me);
    if (i === -1) return;
    scheduled.splice(i, 1);
    const tm = scheduledTimers.get(id);
    if (tm) { clearTimeout(tm); scheduledTimers.delete(id); }
    saveScheduled();
    socket.emit('scheduled:list', scheduledListFor(me));
  });

  // ---------------- calls ----------------
  socket.on('call:invite', (data) => {
    if (!online.has(partner)) return socket.emit('call:unavailable');
    emitTo(partner, 'call:incoming', { from: me, kind: data.kind, sdp: data.sdp });
  });
  socket.on('call:accept', (data) => {
    // successful call → count on the caller (so totals aren't doubled)
    stats[partner].calls++;
    pushStats();
    emitTo(partner, 'call:accepted', { sdp: data.sdp });
  });
  socket.on('call:reject', () => emitTo(partner, 'call:rejected'));
  socket.on('call:end',    () => emitTo(partner, 'call:ended'));
  socket.on('call:cancel', () => emitTo(partner, 'call:cancelled'));
  socket.on('call:switch-cam', () => emitTo(partner, 'call:peer-switched-cam'));
  socket.on('call:react', ({ emoji }) => emitTo(partner, 'call:react-in', { emoji }));
  socket.on('call:chat',  ({ text })  => emitTo(partner, 'call:chat-in',  { text }));
  socket.on('call:typing', (v) => emitTo(partner, 'call:typing-in', { typing: !!v }));
  socket.on('webrtc:ice',  (data) => emitTo(partner, 'webrtc:ice', data));

  // ---------------- disconnect (grace period so a blip doesn't kill calls) ----------------
  socket.on('disconnect', () => {
    if (online.get(me) !== socket.id) return;
    online.delete(me);
    emitTo(partner, 'presence', { user: me, online: false });
    setTimeout(() => {
      if (!online.has(me)) emitTo(partner, 'call:ended');
    }, 10000);
  });
});

// ============================================================
// Load + schedule, then listen
// ============================================================
loadData();
scheduled.forEach((item) => {
  if (item.at > Date.now()) scheduleSend(item);
  else sendScheduled(item.id);
});

server.listen(PORT, () => {
  console.log(`💕 Our Little World running → http://localhost:${PORT}`);
});

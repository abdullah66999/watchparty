const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {}

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = serverless();
function serverless() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/search') return handleSearch(url, res);
    if (url.pathname === '/auth/google') return handleAuthStart(req, res);
    if (url.pathname === '/callback') return handleAuthCallback(req, res);
    if (url.pathname === '/api/me') return handleMe(req, res);
    if (url.pathname === '/api/logout') return handleLogout(req, res);
    if (url.pathname === '/api/drive/videos') return handleDriveVideos(req, res);
    if (url.pathname === '/api/drive/open' && req.method === 'POST') return handleDriveOpen(req, res);
    if (url.pathname.startsWith('/api/drive/media/')) return handleDriveMedia(req, res);
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    const full = path.join(PUBLIC_DIR, path.normalize(file));
    if (!full.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end();
    }
    fs.readFile(full, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end('Not found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
      res.end(data);
    });
  });
}

function walk(node, cb) {
  if (node && typeof node === 'object') {
    cb(node);
    for (const k in node) walk(node[k], cb);
  }
}

async function handleSearch(url, res) {
  const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
  const provider = url.searchParams.get('provider') || 'youtube';
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (!q) return res.end(JSON.stringify({ results: [], error: 'Пустой запрос' }));
  try {
    if (provider === 'vk') {
      if (!process.env.VK_TOKEN) {
        return res.end(JSON.stringify({ results: [], error: 'Поиск по VK Видео требует токен сообщества (VK_TOKEN). Пока можно вставить ссылку вручную.' }));
      }
      const r = await fetch(
        `https://api.vk.com/method/video.search?q=${encodeURIComponent(q)}&count=15&access_token=${process.env.VK_TOKEN}&v=5.135`
      );
      const j = await r.json();
      if (j.error) {
        return res.end(JSON.stringify({ results: [], error: `VK API: ${j.error.error_msg} (код ${j.error.error_code})` }));
      }
      const items = (j.response && j.response.items) || [];
      return res.end(
        JSON.stringify({
          results: items.map((v) => ({
            kind: 'vk',
            oid: v.owner_id,
            id: v.id,
            title: v.title,
            thumb: (v.image || []).slice(-1)[0]?.url || '',
            dur: v.duration ? `${Math.floor(v.duration / 60)}:${String(v.duration % 60).padStart(2, '0')}` : '',
            channel: v.user_id ? 'VK' : 'Сообщество',
          })),
        })
      );
    }
    const r = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ru,en;q=0.8' },
    });
    const html = await r.text();
    const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
    if (!m) return res.end(JSON.stringify({ results: [], error: 'Не удалось разобрать выдачу YouTube' }));
    const data = JSON.parse(m[1]);
    const results = [];
    walk(data, (o) => {
      const v = o.videoRenderer;
      if (!v || results.length >= 15) return;
      results.push({
        kind: 'youtube',
        videoId: v.videoId,
        title: (v.title?.runs || []).map((x) => x.text).join(''),
        thumb: v.thumbnail?.snapshots?.slice(-1)[0]?.url || `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
        dur: v.lengthText?.simpleText || '',
        channel: v.ownerText?.runs?.[0]?.text || '',
      });
    });
    res.end(JSON.stringify({ results }));
  } catch (e) {
    res.end(JSON.stringify({ results: [], error: String((e && e.message) || e) }));
  }
}

// ---------- Google: вход + Drive ----------
const gSessions = new Map(); // sid -> { token, exp, email, name }

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function redirect(res, loc) {
  res.writeHead(302, { Location: loc });
  res.end();
}

function jsonRes(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function proto(req) {
  const xf = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return xf === 'https' ? 'https' : 'http';
}

function redirectUri(req) {
  return `${proto(req)}://${req.headers.host}/callback`;
}

function handleAuthStart(req, res) {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) {
    return jsonRes(res, 400, { error: 'В .env не заданы GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET' });
  }
  const state = crypto.randomBytes(12).toString('hex');
  const ret = String(new URL(req.url, `http://${req.headers.host}`).searchParams.get('r') || '');
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', id);
  u.searchParams.set('redirect_uri', redirectUri(req));
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'openid email https://www.googleapis.com/auth/drive');
  u.searchParams.set('state', state);
  u.searchParams.set('prompt', 'consent');
  const secure = proto(req) === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', [
    `wp_gs=${state}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax${secure}`,
    /^[A-Za-z0-9_-]{1,64}$/.test(ret) ? `wp_ret=${ret}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax${secure}` : 'wp_ret=; Path=/; Max-Age=0',
  ]);
  redirect(res, u.toString());
}

async function handleAuthCallback(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const cookies = parseCookies(req);
    if (!code || !state || !cookies.wp_gs || cookies.wp_gs !== state) return redirect(res, '/?auth_error=state');
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri(req),
        grant_type: 'authorization_code',
      }),
    });
    const j = await r.json();
    if (!j.access_token) return redirect(res, '/?auth_error=' + encodeURIComponent(j.error || 'token'));
    let ui = {};
    try {
      ui = await (
        await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
          headers: { Authorization: `Bearer ${j.access_token}` },
        })
      ).json();
    } catch {}
    const sid = crypto.randomBytes(16).toString('hex');
    gSessions.set(sid, {
      token: j.access_token,
      exp: Date.now() + ((j.expires_in || 3000) - 60) * 1000,
      email: ui.email || '',
      name: ui.name || '',
    });
    res.setHeader('Set-Cookie', `wp_sid=${sid}; Path=/; HttpOnly; SameSite=Lax${proto(req) === 'https' ? '; Secure' : ''}`);
    const back = /^[A-Za-z0-9_-]{1,64}$/.test(cookies.wp_ret || '') ? `/?room=${cookies.wp_ret}` : '/';
    redirect(res, back);
  } catch (e) {
    redirect(res, '/?auth_error=server');
  }
}

function driveSession(req) {
  const sid = parseCookies(req).wp_sid;
  const s = sid && gSessions.get(sid);
  if (!s || s.exp < Date.now()) return null;
  return s;
}

function handleMe(req, res) {
  const s = driveSession(req);
  jsonRes(res, 200, s ? { user: { email: s.email, name: s.name } } : { user: null });
}

function handleLogout(req, res) {
  const sid = parseCookies(req).wp_sid;
  if (sid) gSessions.delete(sid);
  res.setHeader('Set-Cookie', 'wp_sid=; Path=/; Max-Age=0');
  jsonRes(res, 200, { ok: true });
}

async function readBody(req) {
  let raw = '';
  for await (const c of req) raw += c;
  if (raw.length > 10_000) throw new Error('body too large');
  return JSON.parse(raw || '{}');
}

async function handleDriveVideos(req, res) {
  const s = driveSession(req);
  if (!s) return jsonRes(res, 200, { results: [], error: 'Нужно войти через Google (кнопка сверху)' });
  const url = new URL(req.url, `http://${req.headers.host}`);
  const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
  const parts = ["trashed = false", "mimeType contains 'video/'"];
  if (q) parts.push(`name contains '${q.replace(/[\\'"]/g, '').trim()}'`);
  try {
    const search = parts.join(' and ');
    const u = new URL('https://www.googleapis.com/drive/v3/files');
    u.searchParams.set('q', search);
    u.searchParams.set('orderBy', 'modifiedTime desc');
    u.searchParams.set('pageSize', '25');
    u.searchParams.set('fields', 'files(id,name,mimeType,size,modifiedTime)');
    const r = await fetch(u, { headers: { Authorization: `Bearer ${s.token}` } });
    const j = await r.json();
    if (j.error) return jsonRes(res, 200, { results: [], error: `Drive API: ${j.error.message}` });
    jsonRes(res, 200, {
      results: (j.files || []).map((f) => ({
        kind: 'drive',
        fileId: f.id,
        title: f.name,
        thumb: `https://drive.google.com/thumbnail?id=${f.id}&sz=w320`,
        channel: 'Google Диск',
        dur: f.size ? `${Math.round(Number(f.size) / 1e6)} МБ` : '',
      })),
    });
  } catch (e) {
    jsonRes(res, 200, { results: [], error: String((e && e.message) || e) });
  }
}

async function handleDriveOpen(req, res) {
  const s = driveSession(req);
  if (!s) return jsonRes(res, 200, { ok: false, error: 'Нужно войти через Google' });
  let fileId;
  try {
    fileId = String((await readBody(req)).fileId || '');
  } catch {
    return jsonRes(res, 400, { ok: false, error: 'bad json' });
  }
  if (!/^[\w-]{10,200}$/.test(fileId)) return jsonRes(res, 200, { ok: false, error: 'плохой fileId' });
  try {
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'reader', type: 'anyone' }),
    });
    const j = await r.json();
    if (j.error) return jsonRes(res, 200, { ok: false, error: `Drive API: ${j.error.message}` });
    jsonRes(res, 200, { ok: true, fileId, tok: streamTok(fileId) });
  } catch (e) {
    jsonRes(res, 200, { ok: false, error: String((e && e.message) || e) });
  }
}

// ---------- Drive streaming proxy (гости смотрят через <video>, без своего Google-логина) ----------
const STREAM_SECRET = crypto.randomBytes(16);
function streamTok(fid) {
  return crypto.createHmac('sha256', STREAM_SECRET).update(fid).digest('hex').slice(0, 32);
}

async function handleDriveMedia(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const fid = url.pathname.slice('/api/drive/media/'.length);
  if (!/^[\w-]{10,200}$/.test(fid)) {
    res.writeHead(400);
    return res.end('bad fileId');
  }
  const want = streamTok(fid);
  const got = String(url.searchParams.get('tok') || '');
  if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) {
    res.writeHead(403);
    return res.end('bad token');
  }
  const s = driveSession(req) || [...gSessions.values()].find((x) => x.exp > Date.now());
  if (!s) {
    console.error('[drive] нет живой Google-сессии для', fid);
    res.writeHead(503);
    return res.end('хосту нужно заново войти через Google');
  }
  try {
    const headers = { Authorization: `Bearer ${s.token}` };
    if (req.headers.range) headers.Range = req.headers.range;
    const up = await fetch(`https://www.googleapis.com/drive/v3/files/${fid}?alt=media&supportsAllDrives=true`, { headers });
    if (!up.ok && up.status !== 206) console.error('[drive] upstream', up.status, fid);
    if (!up.ok && up.status === 401) {
      gSessions.delete(parseCookies(req).wp_sid);
      res.writeHead(502);
      return res.end('Google-сессия истекла — войди заново');
    }
    const h = { 'Content-Type': up.headers.get('content-type') || 'video/mp4', 'Accept-Ranges': 'bytes' };
    for (const k of ['content-length', 'content-range']) {
      const v = up.headers.get(k);
      if (v) h[k[0].toUpperCase() + k.slice(1)] = v;
    }
    res.writeHead(up.status, h);
    const reader = up.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise((r) => res.once('drain', r));
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) res.writeHead(502);
    res.end('ошибка загрузки из Drive: ' + String((e && e.message) || e));
  }
}

// room id -> { clients: Map<ws, member>, media, state, chat }
const rooms = new Map();

function getRoom(id) {
  let room = rooms.get(id);
  if (!room) {
    room = {
      clients: new Map(),
      media: null, // { kind, videoId, url }
      state: { playing: false, time: 0, at: Date.now() },
      chat: [],
    };
    rooms.set(id, room);
  }
  return room;
}

function broadcast(room, msg, except) {
  const data = JSON.stringify(msg);
  for (const ws of room.clients.keys()) {
    if (ws !== except && ws.readyState === 1) ws.send(data);
  }
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function presence(room) {
  return [...room.clients.values()].map((m) => ({ id: m.id, name: m.name, host: m.host }));
}

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = (url.searchParams.get('room') || '').slice(0, 64);
  const name = (url.searchParams.get('name') || 'Гость').slice(0, 32);
  if (!roomId) return ws.close();

  const room = getRoom(roomId);
  const id = crypto.randomBytes(6).toString('hex');
  const isHost = room.clients.size === 0;
  const member = { id, name, host: isHost };
  room.clients.set(ws, member);

  send(ws, {
    type: 'hello',
    you: id,
    host: isHost,
    presence: presence(room),
    media: room.media,
    state: projectedState(room),
    chat: room.chat.slice(-100),
  });
  broadcast(room, { type: 'presence', presence: presence(room) });
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    handleMessage(room, member, ws, msg);
  });
  ws.on('close', () => {
    room.clients.delete(ws);
    if (member.host) {
      const next = room.clients.values().next().value;
      if (next) {
        next.host = true;
        broadcast(room, { type: 'presence', presence: presence(room) });
      }
    }
    broadcast(room, { type: 'presence', presence: presence(room) });
    if (room.clients.size === 0) rooms.delete(roomId);
  });
});

function projectedState(room) {
  const s = room.state;
  if (s.playing) {
    return { ...s, time: s.time + (Date.now() - s.at) / 1000 };
  }
  return s;
}

function handleMessage(room, member, ws, msg) {
  switch (msg.type) {
    case 'chat': {
      const text = String(msg.text || '').slice(0, 500).trim();
      if (!text) return;
      const entry = { from: member.name, id: member.id, text, at: Date.now() };
      room.chat.push(entry);
      if (room.chat.length > 300) room.chat.shift();
      broadcast(room, { type: 'chat', entry });
      break;
    }
    case 'setMedia': {
      if (!member.host) return send(ws, { type: 'error', text: 'Только хост может менять видео' });
      const media = sanitizeMedia(msg.media) || parseMedia(String(msg.url || ''));
      if (!media) return send(ws, { type: 'error', text: 'Не удалось распознать ссылку YouTube или VK Видео' });
      room.media = media;
      room.state = { playing: false, time: 0, at: Date.now() };
      broadcast(room, { type: 'media', media: room.media, state: room.state });
      break;
    }
    case 'sync': {
      if (!member.host) return;
      room.state = { playing: !!msg.playing, time: Number(msg.time) || 0, at: Date.now() };
      broadcast(room, { type: 'state', state: room.state }, ws);
      break;
    }
  }
}

function sanitizeMedia(m) {
  if (!m || typeof m !== 'object') return null;
  if (m.kind === 'youtube' && /^[\w-]{11}$/.test(String(m.videoId || ''))) {
    return { kind: 'youtube', videoId: m.videoId };
  }
  if (m.kind === 'vk' && Number.isFinite(Number(m.oid)) && Number.isFinite(Number(m.id)) && Number(m.id) > 0) {
    return { kind: 'vk', oid: Number(m.oid), id: Number(m.id) };
  }
  if (m.kind === 'drive' && /^[\w-]{10,200}$/.test(String(m.fileId || ''))) {
    const out = { kind: 'drive', fileId: m.fileId };
    if (/^[0-9a-f]{32}$/.test(String(m.tok || ''))) out.tok = m.tok;
    return out;
  }
  return null;
}

function parseMedia(url) {
  const yt =
    url.match(/(?:youtube\.com\/(?:watch\?v=|live\/|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/) ||
    url.match(/^[\w-]{11}$/);
  if (yt) return { kind: 'youtube', videoId: yt[1] || yt[0] };
  const vk = url.match(/(?:vk\.com|vkvideo\.ru)\/(?:#|video|clip)(-?\d+)_(\d+)/);
  if (vk) return { kind: 'vk', oid: Number(vk[1]), id: Number(vk[2]) };
  const drive =
    url.match(/drive\.google\.com\/file\/d\/([\w-]+)/) ||
    url.match(/drive\.google\.com\/(?:open|uc|thumbnail)\?id=([\w-]+)/);
  if (drive) return { kind: 'drive', fileId: drive[1] };
  return null;
}

server.listen(PORT, () => console.log(`WatchParty MVP: http://localhost:${PORT}`));

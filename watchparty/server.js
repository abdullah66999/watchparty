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
    if (url.pathname === '/vk/play') return handleVkPlay(url, res);
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

// Плеер из video.get про авторизованную сессию: в замерах 7 минут фильма он шёл без вставок,
// анонимный embed рекламит чаще. Это не гарантия — ad-машина в app.js прикрывает и такой случай.
// hash/api_hash живут ~30 минут, поэтому держим кэш чуть меньше.
const vkPlayerCache = new Map();
async function handleVkPlay(url, res) {
  const oid = Number(url.searchParams.get('oid'));
  const id = Number(url.searchParams.get('id'));
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (!Number.isInteger(oid) || !Number.isInteger(id)) return res.end(JSON.stringify({ error: 'Нужны oid и id' }));
  if (!process.env.VK_TOKEN) return res.end(JSON.stringify({ error: 'Нет VK_TOKEN' }));
  const key = `${oid}_${id}`;
  const hit = vkPlayerCache.get(key);
  if (hit && Date.now() - hit.at < 20 * 60 * 1000) return res.end(JSON.stringify(hit.body));
  try {
    const r = await fetch(`https://api.vk.com/method/video.get?videos=${key}&access_token=${process.env.VK_TOKEN}&v=5.135`);
    const j = await r.json();
    const v = j.response && j.response.items && j.response.items[0];
    if (j.error || !v || !v.player) {
      return res.end(JSON.stringify({ error: j.error ? `VK API: ${j.error.error_msg}` : 'VK API не дал плеер' }));
    }
    // наружу отдаём только публичное: токен владельца не должен работать ключом к его личным видео
    if (Array.isArray(v.privacy) && v.privacy.length && !v.privacy.includes('all')) {
      return res.end(JSON.stringify({ error: 'Видео не публичное' }));
    }
    const body = { player: v.player, duration: v.duration || 0, title: v.title || '' };
    vkPlayerCache.set(key, { at: Date.now(), body });
    res.end(JSON.stringify(body));
  } catch (e) {
    res.end(JSON.stringify({ error: 'VK API недоступен: ' + e.message }));
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
        return res.end(JSON.stringify({ results: [], error: 'Поиск по VK Видео не подключён: на сервере нет токена VK. Вставь ссылку на ролик — она открывается как есть.' }));
      }
      const r = await fetch(
        `https://api.vk.com/method/video.search?q=${encodeURIComponent(q)}&count=15&access_token=${process.env.VK_TOKEN}&v=5.135`
      );
      const j = await r.json();
      if (j.error) {
        // 5 — токен протух или выдан с другого IP (у провайдера адрес меняются). Не показываем
        // пользователю служебный текст VK: он ничего не делает с ним, кроме как пугается.
        const msg =
          j.error.error_code === 5
            ? 'Поиск по VK Видео отключился: токен приложения устарел. Переподключи VK — а пока просто вставь ссылку на ролик, она работает.'
            : `VK API не принял запрос поиска (${j.error.error_msg}). Можно вставить ссылку на видео напрямую.`;
        return res.end(JSON.stringify({ results: [], error: msg }));
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
      orphanHostCid: null, // вкладка-хост, потерянная минуту назад (обрыв WS у прокси), — ей возвращаем хостство
      orphanAt: 0,
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
  return [...room.clients.values()].map((m) => ({ id: m.id, name: m.name, host: m.host, voice: !!m.voice }));
}

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = (url.searchParams.get('room') || '').slice(0, 64);
  const name = (url.searchParams.get('name') || 'Гость').slice(0, 32);
  const cid = (url.searchParams.get('cid') || '').slice(0, 64);
  if (!roomId) return ws.close();

  const room = getRoom(roomId);
  const id = crypto.randomBytes(6).toString('hex');

  // эта же вкладка после refresh/переподключения — забираем её старого «призрака» и его хостство
  let tookOverHost = false;
  if (cid) {
    for (const [oldWs, old] of room.clients) {
      if (old.cid === cid) {
        if (old.host) tookOverHost = true;
        old.gone = true;
        old.host = false;
        room.clients.delete(oldWs);
        try {
          oldWs.close(1000, 'replaced');
        } catch {}
        break;
      }
    }
  }

  // вкладка-хост вернулась в течение минуты после обрыва (прокси хостинга рвёт WS на паузе) —
  // хостство принадлежит ей, а не тому, кого успели назначить на её месте
  const restoresHost = !!cid && room.orphanHostCid === cid && Date.now() - room.orphanAt < 60000;
  if (restoresHost) {
    for (const m of room.clients.values()) m.host = false;
    room.orphanHostCid = null;
  }

  const isHost = tookOverHost || restoresHost || room.clients.size === 0;
  const member = { id, name, cid, host: isHost, voice: false };
  if (isHost) room.orphanHostCid = null;
  room.clients.set(ws, member);
  ws.isAlive = true;
  ws.lastBeat = Date.now();
  ws.on('pong', () => {
    ws.isAlive = true;
  });

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
    ws.isAlive = true;
    ws.lastBeat = Date.now(); // живой кадр от вкладки важнее протокольного pong: прокси хостинга отвечает на ping сам
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    handleMessage(room, member, ws, msg);
  });
  ws.on('close', () => {
    if (member.gone) return; // его уже заменило новое соединение этой же вкладки
    room.clients.delete(ws);
    if (member.host) {
      room.orphanHostCid = member.cid || null;
      room.orphanAt = Date.now();
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

// «призраки» (закрытые браузеры без корректного close) вычищаются за ~25 секунд.
// Порог по молчанию вкладки, а не по протокольному pong: за прокси хостинга на ping отвечает
// сам край прокси, поэтому мёртвое соединение могло висеть в комнате бесконечно.
// Живая вкладка шлёт кадр каждые 3 с (даже в фоне — таймер сидит в Web Worker).
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    for (const [ws] of room.clients) {
      if (!ws.isAlive || now - (ws.lastBeat || 0) > 20000) {
        try {
          ws.terminate();
        } catch {}
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {}
    }
  }
}, 5000).unref();

function projectedState(room) {
  const s = room.state;
  if (s.playing) {
    return { ...s, time: s.time + (Date.now() - s.at) / 1000 };
  }
  return s;
}

function handleMessage(room, member, ws, msg) {
  switch (msg.type) {
    case 'ping':
      return send(ws, { type: 'pong' }); // служебный кадр keepalive'а вкладки
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
    case 'voice': {
      member.voice = !!msg.on;
      broadcast(room, { type: 'presence', presence: presence(room) });
      break;
    }
    case 'signal': {
      // WebRTC-рукопожатие: ретранслируем SDP/ICE адресату в комнате, ничего не разбирая
      const to = String(msg.to || '');
      const data = msg.data;
      if (!to || !data || typeof data !== 'object') return;
      for (const [ws2, m2] of room.clients) {
        if (m2.id === to) return send(ws2, { type: 'signal', from: member.id, data });
      }
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
  return null;
}

function parseMedia(url) {
  const yt =
    url.match(/(?:youtube\.com\/(?:watch\?v=|live\/|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/) ||
    url.match(/^[\w-]{11}$/);
  if (yt) return { kind: 'youtube', videoId: yt[1] || yt[0] };
  const vk = url.match(/(?:vk\.com|vkvideo\.ru)\/(?:#|video|clip)(-?\d+)_(\d+)/);
  if (vk) return { kind: 'vk', oid: Number(vk[1]), id: Number(vk[2]) };
  return null;
}

server.listen(PORT, () => console.log(`WatchParty MVP: http://localhost:${PORT}`));

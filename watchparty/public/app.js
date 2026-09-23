const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(location.search);
let room = params.get('room');
const savedName = localStorage.getItem('wp_name') || '';
let name = savedName;
if (!name) {
  name = (params.get('name') || '').trim() || 'Гость';
}
localStorage.setItem('wp_name', name);
$('nameInput').value = name;
$('lobbyName').value = savedName;

let ws;
let me = null;
let isHost = false;
let player = null;
let playerReady = false;
let applyingRemote = false;
let currentVideo = null;
let leaving = false;

// ---------- Лобби: создать / войти по коду ----------
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function genCode() {
  const buf = new Uint32Array(6);
  crypto.getRandomValues(buf);
  return [...buf].map((n) => CODE_ALPHABET[n % CODE_ALPHABET.length]).join('');
}

function showLobby(hint) {
  document.body.classList.remove('in-room');
  $('lobby').classList.remove('hidden');
  $('lobbyHint').textContent = hint || '';
}

function enterRoom(code) {
  room = code;
  history.replaceState(null, '', `/?room=${code}`);
  $('lobby').classList.add('hidden');
  document.body.classList.add('in-room');
  $('roomLabel').innerHTML = `<span class="lbl">Код&nbsp;</span>${escapeHtml(code)}`;
  connect();
}

$('createRoom').onclick = () => {
  const n = $('lobbyName').value.trim();
  if (!n) return ($('lobbyHint').textContent = 'Введи имя — так друзья тебя узнают');
  name = n;
  localStorage.setItem('wp_name', name);
  $('nameInput').value = name;
  enterRoom(genCode());
};

$('joinRoom').onclick = () => {
  const code = $('joinCode').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z0-9]{4,8}$/.test(code)) return ($('lobbyHint').textContent = 'Код — 4–8 букв/цифр, как K3F9ZQ');
  const n = $('lobbyName').value.trim();
  if (n) {
    name = n;
    localStorage.setItem('wp_name', name);
    $('nameInput').value = name;
  }
  enterRoom(code);
};

$('joinCode').addEventListener('keydown', (e) => e.key === 'Enter' && $('joinRoom').click());
$('lobbyName').addEventListener('keydown', (e) => e.key === 'Enter' && $('createRoom').click());

$('leaveRoom').onclick = () => {
  leaving = true;
  sessionStorage.setItem('wp_left', '1'); // не даём bfcache-странице переподключиться
  if (ws) ws.close();
  location.href = '/';
};

// страница вернулась из bfcache после «Выйти» — выходим по-настоящему
window.addEventListener('pageshow', (e) => {
  if (e.persisted && sessionStorage.getItem('wp_left')) location.replace('/');
});

$('nameInput').addEventListener('change', (e) => {
  name = e.target.value.trim() || 'Гость';
  localStorage.setItem('wp_name', name);
  if (ws) ws.close();
});

// ---------- WebSocket ----------
let CID = sessionStorage.getItem('wp_cid');
if (!CID) {
  CID = Math.random().toString(36).slice(2) + Date.now().toString(36);
  sessionStorage.setItem('wp_cid', CID);
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(
    `${proto}://${location.host}/ws?room=${encodeURIComponent(room)}&name=${encodeURIComponent(name)}&cid=${encodeURIComponent(CID)}`
  );
  ws.onclose = () => !leaving && setTimeout(connect, 1500);
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
}

function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// ---------- Голосовой чат: WebRTC P2P-сетка, сигнализация через тот же WS ----------
const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
let localStream = null;
let micOn = false;
const voicePeers = new Map(); // peerId -> { pc, polite, makingOffer, ignoreOffer }
const remoteAudio = new Map(); // peerId -> HTMLAudioElement

function getVoicePeer(id) {
  let e = voicePeers.get(id);
  if (e) return e;
  const pc = new RTCPeerConnection(RTC_CONFIG);
  e = { pc, polite: me < id, makingOffer: false, ignoreOffer: false };
  voicePeers.set(id, e);
  if (localStream) for (const t of localStream.getTracks()) pc.addTrack(t, localStream);
  pc.onnegotiationneeded = async () => {
    try {
      e.makingOffer = true;
      await pc.setLocalDescription();
      send({ type: 'signal', to: id, data: { description: pc.localDescription } });
    } catch (err) {
      console.error('negotiation', err);
    } finally {
      e.makingOffer = false;
    }
  };
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) send({ type: 'signal', to: id, data: { candidate } });
  };
  pc.ontrack = ({ streams }) => {
    if (streams && streams[0]) attachRemoteAudio(id, streams[0]);
  };
  return e;
}

async function handleSignal(from, data) {
  if (!from || !data) return;
  const e = getVoicePeer(from);
  const pc = e.pc;
  try {
    if (data.description) {
      const desc = data.description;
      const collision = desc.type === 'offer' && (e.makingOffer || pc.signalingState !== 'stable');
      e.ignoreOffer = !e.polite && collision;
      if (e.ignoreOffer) return;
      await pc.setRemoteDescription(desc);
      if (desc.type === 'offer') {
        await pc.setLocalDescription();
        send({ type: 'signal', to: from, data: { description: pc.localDescription } });
      }
    } else if (data.candidate) {
      try {
        await pc.addIceCandidate(data.candidate);
      } catch (err) {
        if (!e.ignoreOffer) console.error('ice', err);
      }
    }
  } catch (err) {
    console.error('signal', err);
  }
}

function syncVoicePeers(list) {
  const ids = new Set(list.filter((p) => p.id !== me).map((p) => p.id));
  for (const id of ids) getVoicePeer(id);
  for (const [id, e] of voicePeers) {
    if (!ids.has(id)) {
      try {
        e.pc.close();
      } catch {}
      detachRemoteAudio(id);
      voicePeers.delete(id);
    }
  }
}

function attachRemoteAudio(id, stream) {
  let a = remoteAudio.get(id);
  if (!a) {
    a = document.createElement('audio');
    a.autoplay = true;
    document.body.appendChild(a);
    remoteAudio.set(id, a);
  }
  if (a.srcObject !== stream) {
    a.srcObject = stream;
    a.play().catch(() => {});
  }
}

function detachRemoteAudio(id) {
  const a = remoteAudio.get(id);
  if (a) {
    a.pause();
    a.srcObject = null;
    a.remove();
    remoteAudio.delete(id);
  }
}

async function toggleMic() {
  if (!micOn) {
    if (!localStream) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return alert('Браузер не поддерживает микрофон');
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } catch {
        return alert('Нет доступа к микрофону — разреши его в настройках браузера');
      }
      for (const [, e] of voicePeers) for (const t of localStream.getTracks()) e.pc.addTrack(t, localStream);
    }
    localStream.getAudioTracks().forEach((t) => (t.enabled = true));
    micOn = true;
    send({ type: 'voice', on: true });
  } else {
    if (localStream) localStream.getAudioTracks().forEach((t) => (t.enabled = false));
    micOn = false;
    send({ type: 'voice', on: false });
  }
  updateMicBtn();
}

function updateMicBtn() {
  const b = $('micBtn');
  if (!b) return;
  b.classList.toggle('on', micOn);
  b.title = micOn ? 'Выключить микрофон' : 'Включить микрофон';
  b.setAttribute('aria-label', b.title);
}

$('micBtn').onclick = toggleMic;

function onMessage(msg) {
  switch (msg.type) {
    case 'hello':
      me = msg.you;
      setHost(msg.host);
      renderPresence(msg.presence);
      syncVoicePeers(msg.presence);
      if (msg.media) loadMedia(msg.media, msg.state);
      msg.chat.forEach(addChat);
      break;
    case 'presence':
      renderPresence(msg.presence);
      syncVoicePeers(msg.presence);
      {
        const mine = msg.presence.find((p) => p.id === me);
        if (mine) setHost(mine.host);
        else if (!msg.presence.some((p) => p.host)) setHost(true);
      }
      break;
    case 'signal':
      handleSignal(msg.from, msg.data);
      break;
    case 'media':
      loadMedia(msg.media, msg.state);
      break;
    case 'state':
      if (!isHost) applyState(msg.state);
      break;
    case 'chat':
      addChat(msg.entry);
      break;
    case 'error':
      alert(msg.text);
      break;
  }
}

// ---------- Player ----------
window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player('player', {
    events: {
      onReady: () => {
        playerReady = true;
        if (currentVideo) player.loadVideoById(currentVideo.videoId);
      },
      onStateChange: (e) => {
        if (isHost && !applyingRemote) reportState();
      },
    },
  });
};

function setHost(v) {
  isHost = v;
  document.body.dataset.role = v ? 'host' : 'guest';
  $('qInput').placeholder = v ? 'Название или ссылка…' : 'Видео выбирает хост — просто смотри';
  $('searchHint').textContent = v ? 'Кликни по карточке — видео включится у всех. Можно вставить и ссылку.' : '';
  if (!v) hideHint();
}

function hideAllPlayers() {
  $('player').classList.add('hidden');
  $('vkBox').classList.add('hidden');
}

let mediaToken = 0;

// Плеер от VK API (по токену на сервере) в замерах крутил фильм без вставок, анонимный video_ext.php
// рекламит чаще. Это не гарантия — на подстраховке ниже ad-машина.
async function vkEmbedSrc(oid, id) {
  const origin = encodeURIComponent(location.origin);
  try {
    const r = await fetch(`/vk/play?oid=${encodeURIComponent(oid)}&id=${encodeURIComponent(id)}`);
    const j = await r.json();
    if (j.player && /^https:\/\/(vk\.(com|ru)|vkvideo\.ru)\/video_ext\.php\?/.test(j.player)) {
      return j.player + (j.player.includes('js_api=1') ? '' : `&js_api=1&origin=${origin}`);
    }
  } catch {}
  return `https://vk.com/video_ext.php?oid=${oid}&id=${id}&hd=2&js_api=1&origin=${origin}`;
}

function loadMedia(media, state) {
  currentVideo = media;
  const token = ++mediaToken;
  lastSeekAt = 0;
  stuckTicks = 0;
  hideHint();
  $('placeholder').classList.add('hidden');
  if (media.kind === 'vk') {
    if (playerReady) {
      try {
        player.pauseVideo();
      } catch {}
    }
    hideAllPlayers();
    $('vkBox').classList.remove('hidden');
    vkTime = 0;
    vkPlaying = false;
    vkAd = false;
    vkAdUntil = 0;
    vkDuration = 0;
    vkEmbedSrc(media.oid, media.id).then((src) => {
      if (token !== mediaToken) return; // к тому моменту уже поставили другое видео
      $('vkFrame').src = src;
      // хост сам решает, когда жать ▶; зрителю подставляем состояние комнаты, когда iframe поднялся
      setTimeout(() => token === mediaToken && !isHost && state && applyState(state), 1500);
    });
    return;
  }
  hideAllPlayers();
  $('vkFrame').src = 'about:blank';
  $('player').classList.remove('hidden');
  if (playerReady) {
    applyingRemote = true;
    player.loadVideoById(media.videoId);
    if (state && !state.playing) {
      try {
        player.pauseVideo();
      } catch {}
    }
    setTimeout(() => {
      applyingRemote = false;
      if (token === mediaToken && !isHost && state) applyState(state);
    }, 800);
  }
}

// ---------- VK player (js_api=1 protocol) ----------
let vkTime = 0;
let vkPlaying = false;
let vkDuration = 0;
let vkAd = false;
let vkAdUntil = 0; // реклама «подозревается» до этого момента — флаг обязан самогаситься
let lastSeekAt = 0;
let stuckTicks = 0;

function vkCommand(method, value) {
  const f = $('vkFrame');
  if (!f || !f.contentWindow) return;
  const msg = { method };
  if (method === 'seek') msg.time = value || 0;
  if (method === 'set_volume') msg.volume = value;
  f.contentWindow.postMessage(msg, '*');
}

function vkAdStart(reason, adDur) {
  if (!vkAd) console.log('VK: рекламная вставка — комната ждёт', reason);
  vkAd = true;
  // окно самогашения: сама реклама + запас, но не меньше 25 с и не больше 90 с —
  // длинный ролик не должен «протечь» в время фильма, а застрявший флаг не держит комнату вечно
  vkAdUntil = Date.now() + Math.min(90000, Math.max(25000, (adDur > 0 ? adDur : 0) * 1000 + 15000));
  vkPlaying = false; // фильм на рекламе стоит — все должны стоять
  if (isHost) reportState();
}

function vkAdEnd(reason) {
  if (!vkAd) return;
  vkAd = false;
  vkAdUntil = 0;
  console.log('VK: реклама кончилась', reason);
  // закрывающим событием часто является timeupdate уже вернувшегося фильма, который ещё
  // не обновил vkTime/vkPlaying в этом обработчике — рапортуем следующим тиком микрозадач
  setTimeout(() => {
    if (isHost) reportState();
    else if (lastState) applyState(lastState); // догоняем фильм сразу, не ждём тика
  }, 0);
}

// Длительность в событии совпадает с фильмом (а не с рекламным роликом)?
function vkDurIsFilm(d) {
  return typeof d.duration === 'number' && d.duration > 0 && vkDuration > 300 && Math.abs(d.duration - vkDuration) < 60;
}

const VK_ORIGINS = ['https://vk.com', 'https://vk.ru', 'https://vkvideo.ru'];
window.addEventListener('message', (e) => {
  if (!VK_ORIGINS.includes(e.origin)) return;
  if (!currentVideo || currentVideo.kind !== 'vk') return;
  const d = e.data;
  if (!d || typeof d !== 'object' || !d.event) return;
  const ev = d.event;
  const now = Date.now();

  if (ev === 'adStarted' || ev === 'adBreak') return vkAdStart(ev, vkDurIsFilm(d) ? 0 : d.duration);
  if (ev === 'adCompleted' || ev === 'adEnd' || ev === 'adSkipped') return vkAdEnd(ev);

  // adStarted приходит не всегда (у embed-плеера он под флагом send_ad_events),
  // поэтому рекламу ещё определяем по её следам в самих событиях:
  const shortForThisFilm = typeof d.duration === 'number' && d.duration > 0 && vkDuration > 300 && d.duration < Math.min(180, vkDuration / 4);
  const timeJumpedBack = typeof d.time === 'number' && vkTime > 30 && d.time < vkTime - 25 && !vkDurIsFilm(d);
  if (shortForThisFilm || timeJumpedBack) return vkAdStart(shortForThisFilm ? 'duration=' + d.duration : 'rollback=' + d.time, shortForThisFilm ? d.duration : 0);

  if (vkAd) {
    // фильм вернулся: длительность снова фильмовая, а время не уехало в другой конец
    const filmBack = vkDurIsFilm(d) && (typeof d.time !== 'number' || Math.abs(d.time - vkTime) < 45);
    if (now > vkAdUntil) vkAdEnd('timeout');
    else if (filmBack) vkAdEnd('film');
    else return; // время рекламного ролика — не время фильма
  }

  if (typeof d.time === 'number' && (ev === 'seeked' || Math.abs(d.time - vkTime) < 30)) {
    if (d.time > vkTime + 0.4) vkPlaying = true; // время пошло вперёд — фильм играет (после рекламы VK возобновляет его молча)
    vkTime = d.time;
  }
  if (typeof d.duration === 'number' && d.duration > vkDuration) vkDuration = d.duration;
  if (ev === 'started' || ev === 'resumed') vkPlaying = true;
  if (ev === 'paused' || ev === 'ended') vkPlaying = false;
  if (isHost && !applyingRemote && ['started', 'resumed', 'paused', 'seeked', 'ended'].includes(ev)) reportState();
});

function playerTime() {
  try {
    return player.getCurrentTime() || 0;
  } catch {
    return 0;
  }
}

function reportState() {
  if (!isHost) return;
  if (currentVideo && currentVideo.kind === 'vk') {
    return send({ type: 'sync', playing: vkPlaying, time: vkTime });
  }
  if (!playerReady) return;
  let playing = false;
  try {
    playing = player.getPlayerState() === YT.PlayerState.PLAYING;
  } catch {}
  send({ type: 'sync', playing, time: playerTime() });
}

function nowPlaying() {
  if (!currentVideo) return true;
  if (currentVideo.kind === 'vk') return vkPlaying;
  try {
    return !playerReady || player.getPlayerState() === YT.PlayerState.PLAYING;
  } catch {
    return true;
  }
}

function playNow() {
  if (!currentVideo) return;
  if (currentVideo.kind === 'vk') vkCommand('play');
  else if (playerReady) {
    try {
      player.playVideo();
    } catch {}
  }
}

function hideHint() {
  stuckTicks = 0;
  const h = $('syncHint');
  if (h) h.classList.add('hidden');
}

$('syncHint').onclick = () => {
  hideHint();
  playNow();
  if (lastState) applyState(lastState);
};

// Зритель: подтягиваемся к состоянию комнаты. Команды шлём только при реальном расхождении —
// иначе каждые 2 секунды летит лишний play/pause/seek и плеер «заикается» на одном устройстве.
function applyState(state) {
  if (!currentVideo || !state || isHost) return;
  if (document.hidden) return; // фоновая вкладка всё равно не играет — вернёмся на visibilitychange
  if (currentVideo.kind === 'vk' && vkAd) return; // время рекламы — не время фильма
  const expected = state.playing ? state.time + (Date.now() - state.at) / 1000 : state.time;
  const drift = Math.abs(currentVideo.kind === 'vk' ? vkTime - expected : playerTime() - expected);

  if (state.playing && !nowPlaying()) playNow();
  if (!state.playing && nowPlaying()) {
    if (currentVideo.kind === 'vk') vkCommand('pause');
    else if (playerReady) player.pauseVideo();
  }
  if (drift > 2 && Date.now() - lastSeekAt > 4000) {
    lastSeekAt = Date.now();
    if (currentVideo.kind === 'vk') {
      vkTime = expected; // не ждём события seeked: с ним VK иногда не отвечает и мы мотали каждые 2с
      vkCommand('seek', expected);
    } else if (playerReady) {
      applyingRemote = true;
      player.seekTo(expected, true);
      setTimeout(() => (applyingRemote = false), 500);
    }
  }

  if (state.playing && !nowPlaying()) {
    if (++stuckTicks >= 3) $('syncHint').classList.remove('hidden');
  } else {
    stuckTicks = 0;
    $('syncHint').classList.add('hidden');
  }
}

// host: heartbeat sync + guest drift check
setInterval(() => {
  if (currentVideo && currentVideo.kind === 'vk' && vkAd && Date.now() > vkAdUntil) vkAdEnd('heartbeat');
  if (isHost) reportState();
  else if (lastState) applyState(lastState);
}, 2000);
let lastState = null;
const origOnMessage = onMessage;
onMessage = (msg) => {
  if (msg.type === 'state') lastState = msg.state;
  if (msg.type === 'hello') lastState = msg.state;
  origOnMessage(msg);
};

document.addEventListener('visibilitychange', () => !document.hidden && lastState && !isHost && applyState(lastState));

// ---------- UI ----------
async function copyRoomLink(btn) {
  const lbl = btn.querySelector('.lbl');
  const target = lbl || btn;
  const old = target.textContent;
  try {
    await navigator.clipboard.writeText(location.href);
    target.textContent = 'Скопировано!';
  } catch {
    target.textContent = room || '';
  }
  setTimeout(() => (target.textContent = old), 1500);
}

$('copyLink').onclick = (e) => copyRoomLink(e.currentTarget);
$('roomLabel').onclick = (e) => copyRoomLink(e.currentTarget);

// ---------- Поиск в каталоге (как в Rave) ----------
let provider = 'youtube';
const LINK_RE = /(?:youtube\.com\/(?:watch\?v=|live\/|embed\/|shorts\/)|youtu\.be\/)[\w-]{11}|(?:vk\.com|vkvideo\.ru)\/(?:#|video|clip)-?\d+_\d+/;

document.querySelectorAll('.tabs button').forEach((b) => {
  b.onclick = () => {
    provider = b.dataset.p;
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    if (LINK_RE.test($('qInput').value.trim())) return;
    if ($('qInput').value.trim() || $('results').children.length) doSearch(); // ищем сразу в этой вкладке
  };
});
$('searchBtn').onclick = doSearch;
$('qInput').addEventListener('keydown', (e) => e.key === 'Enter' && doSearch());

async function doSearch() {
  const q = $('qInput').value.trim();
  if (!q) return;
  if (!isHost) return alert('Видео выбирает хост — попроси его');
  if (LINK_RE.test(q)) {
    $('results').innerHTML = '';
    send({ type: 'setMedia', url: q }); // ссылка прямо в строке поиска
    $('qInput').value = '';
    return;
  }
  $('results').innerHTML = '<div class="hint">Ищу…</div>';
  let data;
  try {
    data = await (await fetch(`/search?provider=${provider}&q=${encodeURIComponent(q)}`)).json();
  } catch {
    $('results').innerHTML = '<div class="hint">Сервер недоступен</div>';
    return;
  }
  const results = data.results || [];
  if (!results.length) {
    $('results').innerHTML = `<div class="hint">${escapeHtml(data.error || 'Ничего не найдено')}</div>`;
    return;
  }
  $('results').innerHTML = results
    .map(
      (v, i) =>
        `<div class="res" data-i="${i}"><img loading="lazy" src="${escapeHtml(v.thumb)}" alt="" /><div class="meta"><div class="t">${escapeHtml(v.title)}</div><div class="s">${escapeHtml(v.channel || '')}${v.dur ? ' · ' + escapeHtml(v.dur) : ''}</div></div></div>`
    )
    .join('');
  $('results').querySelectorAll('.res').forEach((el) => {
    el.onclick = () => pick(results[+el.dataset.i]);
  });
}

async function pick(v) {
  if (!isHost) return alert('Видео выбирает хост — попроси его кликнуть');
  send({ type: 'setMedia', media: v });
  $('results').innerHTML = '';
  $('qInput').value = '';
}

$('chatForm').onsubmit = (e) => {
  e.preventDefault();
  const text = $('chatInput').value.trim();
  if (!text) return;
  send({ type: 'chat', text });
  $('chatInput').value = '';
};

function renderPresence(list) {
  $('presence').innerHTML = list
    .map((p) => `<li>${p.host ? '👑 ' : ''}${escapeHtml(p.name)}${p.voice ? ' 🎤' : ''}${p.id === me ? ' <em>(ты)</em>' : ''}</li>`)
    .join('');
}

function addChat(entry) {
  const div = document.createElement('div');
  div.className = 'msg' + (entry.id === me ? ' mine' : '');
  div.innerHTML = `<b>${escapeHtml(entry.from)}</b> <span>${escapeHtml(entry.text)}</span>`;
  $('chat').appendChild(div);
  $('chat').scrollTop = $('chat').scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

room ? enterRoom(room) : showLobby();

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
  showConn('Подключаемся к серверу…');
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
  // предыдущий сокет (вкладка сменила комнату либо переподключилась) гасим полностью:
  // иначе он остаётся «призраком» в старой комнате, а его onclose тайком пересоздаёт
  // текущий ws — вкладка метает соединения и рвёт то плеер, то хостство
  if (ws) {
    const old = ws;
    old.onopen = old.onclose = old.onmessage = null;
    try {
      old.close();
    } catch {}
  }
  const sock = new WebSocket(
    `${proto}://${location.host}/ws?room=${encodeURIComponent(room)}&name=${encodeURIComponent(name)}&cid=${encodeURIComponent(CID)}`
  );
  ws = sock;
  sock.onopen = () => ws === sock && hideConn();
  sock.onclose = () => {
    if (ws !== sock || leaving) return;
    showConn('Переподключаемся к серверу…');
    setTimeout(connect, 1500);
  };
  sock.onmessage = (e) => ws === sock && onMessage(JSON.parse(e.data));
}

// ---------- Статус канала ----------
// Бесплатный Render засыпает после простоя и просыпается около минуты; всё это время комната
// выглядит сломанной (чёрный плеер, никого не видно), хотя соединение просто устанавливается.
let connTimer = null;
function showConn(text) {
  const p = $('connState');
  if (!p) return;
  p.textContent = text;
  p.classList.remove('hidden');
  clearTimeout(connTimer);
  connTimer = setTimeout(() => {
    if (!p.classList.contains('hidden')) p.textContent = 'Сервер ещё не ответил — вероятно, он «спит» после простоя. Попробуй перезагрузить страницу через минуту.';
  }, 12000);
}

function hideConn() {
  clearTimeout(connTimer);
  const p = $('connState');
  if (p) p.classList.add('hidden');
}

function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// Хостинг (Render/Cloudflare) рвёт WS без исходящих кадров примерно через 5 с — на паузе плеера
// комната тихо отваливалась и переподключалась. Служебный кадр держит канал живым.
// Основной таймер — из Web Worker: Chrome ограничивает фоновую вкладку одним пробуждением в
// минуту, и спрятанная вкладка иначе сама роняла бы себе канал. Обычный setInterval остаётся
// запасным на случай, если Worker недоступен.
setInterval(() => send({ type: 'ping' }), 3000);
try {
  const beat = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(1), 3000);'], { type: 'text/javascript' })));
  beat.onmessage = () => send({ type: 'ping' });
} catch {}

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
    case 'hello': {
      hideConn();
      me = msg.you;
      setHost(msg.host);
      renderPresence(msg.presence);
      syncVoicePeers(msg.presence);
      // переподключение не должно перезапускать плеер: то же видео уже стоит — только догоняем время
      if (msg.media && sameMedia(msg.media, currentVideo)) {
        if (!isHost && msg.state) applyState(msg.state);
      } else if (msg.media) {
        loadMedia(msg.media, msg.state);
      }
      renderChat(msg.chat); // история приходит целиком — дописывать её к прежней нельзя, будут дубли
      break;
    }
    case 'presence':
      syncVoicePeers(msg.presence);
      {
        const mine = msg.presence.find((p) => p.id === me);
        // роль обновляем ДО отрисовки списка: на ней завязана кнопка «передать лидерку»
        if (mine) setHost(mine.host);
        else if (!msg.presence.some((p) => p.host)) setHost(true);
      }
      renderPresence(msg.presence);
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
    playerVars: { playsinline: 1, rel: 0 },
    events: {
      onReady: () => {
        playerReady = true;
        if (currentVideo && currentVideo.kind !== 'vk') player.loadVideoById(currentVideo.videoId);
      },
      onError: (e) => {
        ytError(+e.data);
      },
      onStateChange: (e) => {
        if (+e.data === YT.PlayerState.PLAYING) clearYtBlock();
        if (+e.data === YT.PlayerState.PLAYING && !mutedNow()) ytMutedStart = false; // звук включили
        // PAUSED без нашей команды — это пользователь сам нажал паузу: больше не ждём запуска
        if (+e.data === YT.PlayerState.PAUSED && !applyingRemote) wantPlay = false;
        if (isHost && !applyingRemote) reportState();
      },
    },
  });
};

// YouTube либо сообщает ошибку кодом (2/5/100/101/150/153), либо молча не поднимает плеер:
// на перезагруженных фильмах показывается «подтвердите, что вы не бот», состояние остаётся -1,
// длительность — 0. Без обработки это вечный спиннер на чёрном экране, поэтому держим дозор.
const YT_ERRORS = {
  2: 'Ссылка неверная — YouTube не находит такой ролик.',
  5: 'Ролик повреждён или недоступен во встроенном плеере.',
  100: 'Видео удалено, либо сделано приватным.',
  101: 'Владелец видео запретил встраивание на другие сайты.',
  150: 'Владелец запретил встраивание — за пределами youtube.com ролик не играет.',
  153: 'Встраивание ограничено владельцем — можно открыть только на YouTube.',
};

let ytTimer = null;
let ytRevive = null;

function ytStopTimers() {
  clearTimeout(ytTimer);
  clearInterval(ytRevive);
  ytTimer = ytRevive = null;
}

function clearYtBlock() {
  ytStopTimers();
  const b = $('ytBlock');
  if (b) b.classList.add('hidden');
}

function showYtBlock(text, videoId) {
  const b = $('ytBlock');
  if (!b) return;
  clearTimeout(ytTimer);
  ytTimer = null;
  $('ytBlockText').textContent = text;
  $('ytAlt').textContent = isHost
    ? 'Видео выбираешь ты — оно включится у всех. Смени результат в поиске ниже; если YouTube упрётся, возьми ролик во вкладке «VK Видео».'
    : 'Видео выбирает хост — предложи ему сменить ролик или переключиться на VK Видео.';
  const link = $('ytOpen');
  if (videoId) {
    link.href = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    link.classList.remove('hidden');
  } else {
    link.classList.add('hidden');
  }
  $('ytVk').classList.toggle('hidden', !isHost);
  b.classList.remove('hidden');
}

function ytError(code) {
  clearInterval(ytRevive);
  ytRevive = null;
  showYtBlock(YT_ERRORS[code] || `Плеер YouTube вернул ошибку ${code}.`, code ? currentYtId() : '');
}

function currentYtId() {
  return currentVideo && currentVideo.kind !== 'vk' ? currentVideo.videoId : '';
}

// Смотрим, ожил ли ролик. Если через разумный срок плеер так и не сообщил состояние или
// длительность — закрываем чёрный экран подсказкой, а не крутим спиннер вечно.
function ytAlive() {
  let st = -1;
  let dur = 0;
  try {
    st = player ? player.getPlayerState() : -1;
    dur = player ? player.getDuration() : 0;
  } catch {}
  return st >= 0 || dur > 0;
}

function watchYtStart(videoId) {
  ytStopTimers();
  const started = Date.now();
  const tick = () => {
    if (!currentVideo || currentVideo.kind === 'vk' || currentVideo.videoId !== videoId) return;
    if (ytAlive()) return; // плеер ожил — дальше разбирается сам
    const waited = Date.now() - started;
    const limit = playerReady ? 20000 : 26000;
    if (waited > limit) {
      showYtBlock(
        playerReady
          ? 'Ролик так и не запустился: YouTube не отдаёт его встроенному плееру и часто требует «подтвердите, что вы не бот». Помогает «Попробовать снова» или «Открыть на YouTube».'
          : 'Скрипт плеера YouTube не загрузился — его блокирует сеть или расширение. Проверьте доступ к youtube.com и перезагрузите страницу.',
        videoId
      );
      // подсказка мягкая: если видео всё-таки доедет, она обязана уйти сама
      ytRevive = setInterval(() => {
        if (!currentVideo || currentVideo.kind === 'vk' || currentVideo.videoId !== videoId) return clearInterval(ytRevive);
        if (ytAlive()) clearYtBlock();
      }, 2000);
      return;
    }
    ytTimer = setTimeout(tick, 1000);
  };
  ytTimer = setTimeout(tick, 1500);
}

$('ytRetry').onclick = () => {
  clearYtBlock();
  if (!currentVideo || currentVideo.kind === 'vk') return;
  const vid = currentVideo.videoId;
  if (!playerReady) {
    // сам API мог не подняться — перезагружаем страницу, это единственный способ переподключить скрипт
    location.reload();
    return;
  }
  applyingRemote = true;
  player.loadVideoById(vid);
  setTimeout(() => {
    applyingRemote = false;
    if (isHost) playNow();
    else if (lastState) applyState(lastState);
  }, 900);
  watchYtStart(vid);
};

function setHost(v) {
  const changed = isHost !== v;
  isHost = v;
  document.body.dataset.role = v ? 'host' : 'guest';
  $('qInput').placeholder = v ? 'Название или ссылка…' : 'Видео выбирает хост — просто смотри';
  $('searchHint').textContent = v ? 'Кликни по карточке — видео включится у всех. Можно вставить и ссылку.' : '';
  if (!v) hideHint();
  // после смены роли список участников перерисовываем: у нового хоста появляются короны-кнопки
  if (changed && lastPresence.length) renderPresence(lastPresence);
}

function hideAllPlayers() {
  $('player').classList.add('hidden');
  $('vkBox').classList.add('hidden');
}

let mediaToken = 0;

// Запрос к своему же серверу без таймаута — это вечный ожидатель: Render может «спать», а
// VK/YouTube на другой стороне держать соединение открытым без ответа. Ждём и отдаём управление.
async function getJson(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function vkEmbedSrc(oid, id) {
  // Анонимный embed: работает без токена и без запросов на сервер — VK сам отдаёт плеер по oid/id.
  // Рекламные вставки прикрывает ad-машина ниже. autoplay=1 — карточка должна начаться сразу,
  // а не ждать ещё одного клика по плееру.
  return `https://vk.com/video_ext.php?oid=${oid}&id=${id}&hd=2&autoplay=1&js_api=1&origin=${encodeURIComponent(location.origin)}`;
}

function loadMedia(media, state) {
  currentVideo = media;
  const token = ++mediaToken;
  lastSeekAt = 0;
  stuckTicks = 0;
  hideHint();
  clearYtBlock();
  $('placeholder').classList.add('hidden');
  // Сервер встречает любую новую карточку состоянием {playing:false, time:0} — это не настоящая
  // пауза, а «видео только что выбрали». Настоящая пауза — когда время больше нуля (возврат
  // в комнату посреди остановленного фильма), её и восстанавливаем.
  const fresh = !state || (!state.playing && !state.time);
  wantPlay = fresh || !!(state && state.playing);
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
    vkSeekTarget = -1;
    vkSeekCalmUntil = 0;
    $('vkFrame').src = vkEmbedSrc(media.oid, media.id);
    // зрители догоняют комнату, когда iframe поднялся; хост на свежей карточке сам даёт старт
    setTimeout(() => {
      if (token !== mediaToken) return;
      if (isHost) {
        if (fresh) playNow();
      } else if (!fresh) {
        applyState(state);
      }
    }, 1500);
    return;
  }
  hideAllPlayers();
  $('vkFrame').src = 'about:blank';
  $('player').classList.remove('hidden');
  // pauseVideo() сразу после loadVideoById обрывает начавшуюся загрузку: плеер откатывается
  // в «не запускался» и висит вечным спиннером — поэтому свежую карточку всегда запускаем.
  if (playerReady) {
    applyingRemote = true;
    if (ytMutedStart) {
      // эту сессию браузер пускает только без звука — новую карточку сразу запускаем тихо,
      // иначе снова получим 4 секунды чёрного экрана перед подсказкой
      try {
        player.mute();
      } catch {}
    }
    if (fresh || state.playing) player.loadVideoById(media.videoId);
    else player.cueVideoById(media.videoId);
    setTimeout(() => {
      applyingRemote = false;
      if (token !== mediaToken) return;
      if (!fresh && state.time) {
        try {
          player.seekTo(state.time, true);
        } catch {}
      }
      if (isHost) {
        if (fresh || state.playing) playNow();
      } else if (!fresh) {
        applyState(state); // на свежей карточке зритель уже играет с нуля — не трогаем
      }
    }, 800);
  }
  watchYtStart(media.videoId);
}

// ---------- VK player (js_api=1 protocol) ----------
let vkTime = 0;
let vkPlaying = false;
let vkDuration = 0;
let vkAd = false;
let vkAdUntil = 0; // реклама «подозревается» до этого момента — флаг обязан самогаситься
let lastSeekAt = 0;
let stuckTicks = 0;
let wantPlay = false; // мы хотели бы смотреть фильм; пауза по рукам пользователя сбрасывает это
// Дальная перемотка в анонимном VK-плеере догоняется несколько секунд. Пока плеер не доехал
// до нужной точки, любая проверка расхождения видит «отстаём» и шлёт новый seek — плеер
// мотается с точки на точку и не начинает играть. Это окно и закрывает такие попытки.
let vkSeekTarget = -1;
let vkSeekCalmUntil = 0; // до этого момента перемотку не повторяем

function vkCommand(method, value) {
  const f = $('vkFrame');
  if (!f || !f.contentWindow) return;
  const msg = { method };
  if (method === 'seek') {
    msg.time = value || 0;
    vkSeekTarget = msg.time;
    vkSeekCalmUntil = Date.now() + 12000; // дальше плеер либо сам рапортуется о приезде, либо окно погаснет
  }
  if (method === 'set_volume') msg.volume = value;
  // «paused» от анонимного плеера приходит не всегда — иначе зритель стоит с vkPlaying=true и
  // комната кажется рассинхронизированной. Команду-то мы отдали.
  if (method === 'pause') vkPlaying = false;
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
    if (vkSeekCalmUntil && Math.abs(d.time - vkSeekTarget) < 5) {
      vkSeekCalmUntil = 0; // домотали — можно снова следить за расхождением
      vkSeekTarget = -1;
    }
    if (d.time > vkTime + 0.4) vkPlaying = true; // время пошло вперёд — фильм играет (после рекламы VK возобновляет его молча)
    vkTime = d.time;
  }
  if (typeof d.duration === 'number' && d.duration > vkDuration) vkDuration = d.duration;
  if (ev === 'started' || ev === 'resumed') vkPlaying = true;
  if (ev === 'paused' || ev === 'ended') {
    vkPlaying = false;
    if (ev === 'paused' && !applyingRemote) wantPlay = false; // пользователь сам поставил на паузу
  }
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
  wantPlay = true;
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

// Зритель: подтягиваемся к состоянию комнаты. Команды шлём только при реальном расхождении —
// иначе каждые 2 секунды летит лишний play/pause/seek и плеер «заикается» на одном устройстве.
function applyState(state) {
  if (!currentVideo || !state || isHost) return;
  if (document.hidden) return; // фоновая вкладка всё равно не играет — вернёмся на visibilitychange
  if (currentVideo.kind === 'vk' && vkAd) return; // время рекламы — не время фильма
  // Перемотку плеер догоняет несколько секунд: в это окно не ищем заново и не restart-им старт,
  // иначе зритель мотается по кругу и не начинает играть никогда.
  const calm = currentVideo.kind === 'vk' && Date.now() < vkSeekCalmUntil;
  const expected = state.playing ? state.time + (Date.now() - state.at) / 1000 : state.time;
  const drift = Math.abs(currentVideo.kind === 'vk' ? vkTime - expected : playerTime() - expected);

  if (state.playing && !nowPlaying() && !calm) playNow();
  if (!state.playing && nowPlaying()) {
    if (currentVideo.kind === 'vk') vkCommand('pause');
    else if (playerReady) player.pauseVideo();
  }
  if (drift > 2 && !calm && Date.now() - lastSeekAt > 4000) {
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

  if (!state.playing && nowPlaying()) wantPlay = false;
}

// Браузер вправе не запускать видео без участия зрителя, и playVideo() из обработчика своей
// кнопки ему не помогает — активировать может только клик по самому плееру. Поэтому: сначала
// честная попытка со звуком, затем тихий старт (фильм хотя бы идёт и синхронизируется), и
// подсказка, куда нажать.
let ytMutedStart = false;

function mutedNow() {
  try {
    return !!player.isMuted();
  } catch {
    return false;
  }
}

function checkBlockedStart() {
  const h = $('syncHint');
  const want = wantPlay || (!isHost && lastState && lastState.playing);
  const adOnVk = currentVideo && currentVideo.kind === 'vk' && vkAd;
  const youtube = currentVideo && currentVideo.kind !== 'vk';
  if (!currentVideo || adOnVk || !want) {
    stuckTicks = 0;
    h.classList.add('hidden');
    return;
  }
  if (youtube && ytMutedStart && nowPlaying() && mutedNow()) {
    // фильм идёт, но тихо: снять мьют из кода нельзя — unMute() разрешают, но сразу ставят
    // паузу. Звук включает только клик пользователя по самому плееру.
    stuckTicks = 0;
    h.textContent = '🔇 Фильм идёт без звука: нажми на значок 🔇 в самом плеере';
    h.classList.remove('hidden');
    return;
  }
  if (nowPlaying()) {
    stuckTicks = 0;
    h.classList.add('hidden');
    return;
  }
  stuckTicks++;
  if (youtube && !ytMutedStart && stuckTicks >= 2 && stuckTicks < 6) {
    ytMutedStart = true;
    try {
      player.mute();
      player.loadVideoById(currentVideo.videoId);
    } catch {}
    return;
  }
  if (stuckTicks >= 2) {
    h.textContent = '▶ Нажми на ▶ в плеере — браузер не запускает видео сам';
    h.classList.remove('hidden');
  }
}

// host: heartbeat sync + guest drift check
setInterval(() => {
  if (currentVideo && currentVideo.kind === 'vk' && vkAd && Date.now() > vkAdUntil) vkAdEnd('heartbeat');
  if (isHost) reportState();
  else if (lastState) applyState(lastState);
  checkBlockedStart();
}, 2000);
let lastState = null;
const origOnMessage = onMessage;
// Часы телефона и ноутбука расходятся на секунды и минуты — мобильные сети синхронизируют
// время не так, как десктоп. Сервер ставит в state.at СВОЙ timestamp, а зритель вычитает из
// него СВОЁ время: из этих часов получается фантомный дрейф, и зрителя навсегда уносит на
// величину расхождения (на записи: телефон-хост и ноутбук-зритель в разных концах фильма).
// Поэтому помечаем состояние местным временем приёма — тогда `Date.now() - at` это честное
// «сколько секунд прошло с тех пор, как я это услышал», и часы сервера вообще не важны.
onMessage = (msg) => {
  if (msg.state) msg.state = { ...msg.state, at: Date.now() };
  if (msg.type === 'state' || msg.type === 'hello') lastState = msg.state;
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
const PH_YT = 'Название фильма, клипа, шоу…';
const PH_VK = 'Ссылка на ролик: vkvideo.ru/video-123456_789';

document.querySelectorAll('.tabs button').forEach((b) => {
  b.onclick = () => {
    provider = b.dataset.p;
    $('qInput').placeholder = provider === 'vk' ? PH_VK : PH_YT;
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    if (LINK_RE.test($('qInput').value.trim())) return;
    if ($('qInput').value.trim() || $('results').children.length) doSearch(); // ищем сразу в этой вкладке
  };
});
$('searchBtn').onclick = doSearch;
$('qInput').addEventListener('keydown', (e) => e.key === 'Enter' && doSearch());

// «Искать в VK Видео» с подложки YouTube: та же строка, только другая вкладка
$('ytVk').onclick = () => {
  const q = $('qInput');
  if (LINK_RE.test(q.value.trim())) q.value = '';
  const vkTab = document.querySelector('.tabs button[data-p="vk"]');
  if (vkTab) vkTab.click();
  $('searchPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  q.focus();
};

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
  // У VK-видео нет публичного поиска без пользовательского токена, и заводить токен ради
  // вечеринки нечем: ролик находится в самом VK, а сюда попадает ссылкой.
  if (provider === 'vk') {
    $('results').innerHTML = `<div class="hint">Вставь ссылку на ролик из <b>vkvideo.ru</b> или <b>vk.com</b> — он запустится прямо в комнате. Искать по названию здесь не нужно.</div>`;
    return;
  }
  $('results').innerHTML = '<div class="hint">Ищу…</div>';
  const slow = setTimeout(() => {
    const h = $('results').querySelector('.hint');
    if (h && h.textContent === 'Ищу…') h.textContent = 'Долго ищет: сервер, скорее всего, «спит» после простоя. Сейчас проснётся — попробуй ещё раз через минуту.';
  }, 9000);
  let data;
  try {
    data = await getJson(`/search?provider=${provider}&q=${encodeURIComponent(q)}`, 25000);
  } catch {
    $('results').innerHTML = '<div class="hint">Поиск не ответил. Проверь, открыт ли сервер (он мог уснуть на бесплатном хостинге), и нажми «Поиск» ещё раз.</div>';
    return;
  } finally {
    clearTimeout(slow);
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

let lastPresence = []; // последний список участников — нужен, чтобы перерисовать его при смене роли

function renderPresence(list) {
  lastPresence = list || [];
  const canPass = isHost && lastPresence.length > 1;
  $('presence').innerHTML = lastPresence
    .map(
      (p) =>
        `<li data-id="${p.id}" data-name="${escapeHtml(p.name)}"><span>${p.host ? '👑 ' : ''}${escapeHtml(p.name)}${
          p.voice ? ' 🎤' : ''
        }${p.id === me ? ' <em>(ты)</em>' : ''}</span>${
          canPass && !p.host ? '<button class="pass" title="Передать управление" aria-label="Передать управление">👑</button>' : ''
        }</li>`
    )
    .join('');
  $('presence').querySelectorAll('.pass').forEach((b) => {
    b.onclick = () => {
      const name = b.closest('li').dataset.name;
      if (confirm(`Передать управление ${name}? Ты станешь зрителем.`)) send({ type: 'passHost', to: b.closest('li').dataset.id });
    };
  });
}

function sameMedia(a, b) {
  return !!a && !!b && a.kind === b.kind && (a.kind === 'vk' ? a.oid === b.oid && a.id === b.id : a.videoId === b.videoId);
}

function renderChat(list) {
  $('chat').innerHTML = '';
  (list || []).forEach(addChat);
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

'use strict';

/**
 * Наскрізний smoke-тест: піднімає сервер на тимчасових каталогах і перевіряє
 * авторизацію, завантаження, Range (206), лайки, коментарі, кімнати (socket.io) та вебхук.
 * Запуск: npm install && npm run smoke
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwaves-smoke-'));
const ADMIN_PASSWORD = 'smoke-admin-pass-1';

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor() {
    this.cookie = '';
  }
  async req(method, url, body, headers = {}) {
    const opts = { method, headers: { ...headers } };
    if (this.cookie) opts.headers.Cookie = this.cookie;
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(BASE + url, opts);
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of set) {
      const pair = c.split(';')[0];
      if (pair.endsWith('=')) this.cookie = '';
      else this.cookie = pair;
    }
    let data = null;
    if ((res.headers.get('content-type') || '').includes('json')) data = await res.json().catch(() => null);
    return { status: res.status, data, headers: res.headers, res };
  }
}

function makeWav(seconds = 1, rate = 8000) {
  const samples = seconds * rate;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 12000), 44 + i * 2);
  return buf;
}

// Мінімальний валідний PNG 1x1.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==', 'base64');

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(BASE + '/healthz');
      if (r.ok) return true;
    } catch (_) {
      /* ще піднімається */
    }
    await sleep(150);
  }
  return false;
}

async function main() {
  console.log(`AI Waves smoke-test · порт ${PORT} · дані: ${TMP}`);

  // Приймач вебхуків
  const hooks = [];
  const hookServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      hooks.push({ headers: req.headers, raw });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise((r) => hookServer.listen(0, '127.0.0.1', r));
  const hookUrl = `http://127.0.0.1:${hookServer.address().port}/hook`;

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      DATA_DIR: path.join(TMP, 'data'),
      UPLOAD_DIR: path.join(TMP, 'uploads'),
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD,
      JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));

  const cleanup = async () => {
    server.kill('SIGTERM');
    hookServer.close();
    await sleep(300);
    fs.rmSync(TMP, { recursive: true, force: true });
  };

  try {
    if (!(await waitForServer())) {
      console.log(serverLog);
      throw new Error('Сервер не стартував');
    }

    console.log('\nБазові ендпоінти');
    const guest = new Client();
    let r = await guest.req('GET', '/healthz');
    check('healthz', r.status === 200 && r.data.ok === true);
    r = await guest.req('GET', '/api/settings/public');
    check('публічні налаштування', r.status === 200 && r.data.registrationOpen === true);
    r = await guest.req('GET', '/');
    check('SPA index віддається', r.status === 200 && (r.headers.get('content-type') || '').includes('html'));
    r = await guest.req('GET', '/api/tracks');
    check('гість бачить порожній список', r.status === 200 && Array.isArray(r.data.tracks));
    r = await guest.req('POST', '/api/tracks', new FormData());
    check('гість не може завантажувати (401)', r.status === 401);

    console.log('\nАвторизація');
    const admin = new Client();
    r = await admin.req('POST', '/api/auth/login', { username: 'admin', password: 'wrong-password' });
    check('невірний пароль → 401', r.status === 401);
    r = await admin.req('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PASSWORD });
    check('вхід адміна', r.status === 200 && r.data.user.role === 'admin');
    const user = new Client();
    r = await user.req('POST', '/api/auth/register', { username: 'listener', password: 'listener-pass-1' });
    check('реєстрація користувача', r.status === 201 && r.data.user.role === 'user');
    r = await user.req('POST', '/api/auth/register', { username: 'listener', password: 'listener-pass-1' });
    check('дублікат логіна → 409', r.status === 409);
    r = await user.req('GET', '/api/auth/me');
    check('/me повертає користувача', r.data.user && r.data.user.username === 'listener');
    r = await user.req('GET', '/api/admin/stats');
    check('користувач не бачить адмін-статистику (403)', r.status === 403);
    r = await user.req('POST', '/api/tracks', new FormData());
    check('користувач не може завантажувати (403)', r.status === 403);

    console.log('\nТреки та Range');
    const wav = makeWav(2);
    const fd = new FormData();
    fd.set('title', 'Smoke Track');
    fd.set('artist', 'Test Bot');
    fd.set('genre', 'synthwave');
    fd.set('tags', 'night, neon, Night');
    fd.set('generator', 'Suno');
    fd.set('ai_model', 'v4.5');
    fd.set('ai_prompt', 'dreamy synthwave at night');
    fd.set('duration', '2');
    fd.set('published', '1');
    fd.set('cover', new Blob([PNG], { type: 'image/png' }), 'cover.png');
    fd.set('audio', new Blob([wav], { type: 'audio/wav' }), 'track.wav');
    r = await admin.req('POST', '/api/tracks', fd);
    check('адмін завантажує трек (201)', r.status === 201, r.data);
    const track = r.data && r.data.track;
    check('теги нормалізовано без дублікатів', track && track.tags.length === 2, track && track.tags);
    check('є URL обкладинки', track && /^\/uploads\/covers\/.+\.png$/.test(track.cover_url || ''));
    const audioFiles = fs.readdirSync(path.join(TMP, 'uploads', 'audio'));
    check('аудіофайл на диску з розширенням .wav', audioFiles.length === 1 && audioFiles[0].endsWith('.wav'), audioFiles);

    const bad = new FormData();
    bad.set('title', 'Fake');
    bad.set('audio', new Blob([Buffer.from('this is not audio at all')], { type: 'audio/mpeg' }), 'fake.mp3');
    r = await admin.req('POST', '/api/tracks', bad);
    check('підроблене аудіо відхилено (400)', r.status === 400, r.data);
    check('після відхилення сміття не лишилось', fs.readdirSync(path.join(TMP, 'uploads', 'audio')).length === 1);

    r = await guest.req('GET', '/api/tracks?q=smoke');
    check('пошук знаходить трек', r.data.total === 1);
    r = await guest.req('GET', `/api/tracks/${track.id}`);
    check('сторінка треку доступна гостю', r.status === 200 && r.data.track.ai_prompt.includes('synthwave'));

    r = await guest.req('GET', `/stream/${track.id}`, undefined, { Range: 'bytes=0-99' });
    check('Range → 206', r.status === 206);
    check('Content-Range коректний', r.headers.get('content-range') === `bytes 0-99/${wav.length}`, r.headers.get('content-range'));
    check('Content-Length = 100', r.headers.get('content-length') === '100');
    const part = Buffer.from(await r.res.arrayBuffer());
    check('тіло збігається з файлом', part.equals(wav.subarray(0, 100)));
    r = await guest.req('GET', `/stream/${track.id}`, undefined, { Range: 'bytes=-50' });
    check('суфіксний Range (останні 50 байт)', r.status === 206 && r.headers.get('content-range') === `bytes ${wav.length - 50}-${wav.length - 1}/${wav.length}`);
    r = await guest.req('GET', `/stream/${track.id}`, undefined, { Range: `bytes=${wav.length + 10}-` });
    check('Range за межами файлу → 416', r.status === 416);
    r = await guest.req('GET', `/stream/${track.id}`);
    check('без Range → 200 та Accept-Ranges', r.status === 200 && r.headers.get('accept-ranges') === 'bytes');

    const draft = new FormData();
    draft.set('title', 'Hidden Draft');
    draft.set('published', '0');
    draft.set('audio', new Blob([wav], { type: 'audio/wav' }), 'draft.wav');
    r = await admin.req('POST', '/api/tracks', draft);
    const draftTrack = r.data.track;
    r = await guest.req('GET', `/api/tracks/${draftTrack.id}`);
    check('чернетка прихована від гостя (404)', r.status === 404);
    r = await guest.req('GET', `/stream/${draftTrack.id}`);
    check('аудіо чернетки недоступне гостю', r.status === 404);
    r = await admin.req('GET', `/api/tracks/${draftTrack.id}`);
    check('адмін бачить чернетку', r.status === 200);
    r = await admin.req('PUT', `/api/tracks/${draftTrack.id}`, { published: true });
    check('публікація через PUT (JSON)', r.status === 200 && r.data.track.published === true);

    console.log('\nЛайки та коментарі');
    r = await guest.req('POST', `/api/tracks/${track.id}/like`);
    check('лайк без входу → 401', r.status === 401);
    r = await user.req('POST', `/api/tracks/${track.id}/like`);
    check('лайк', r.status === 200 && r.data.liked === true && r.data.likes === 1);
    r = await user.req('POST', `/api/tracks/${track.id}/like`);
    check('повторний лайк знімає його', r.data.liked === false && r.data.likes === 0);
    r = await user.req('POST', `/api/tracks/${track.id}/comments`, { text: 'Дроп на 1:23!', time: 1.5 });
    check('коментар на секунді', r.status === 201 && r.data.comment.time === 1.5);
    const commentId = r.data.comment.id;
    r = await user.req('POST', `/api/tracks/${track.id}/comments`, { text: 'пізній', time: 9999 });
    check('час коментаря обмежено тривалістю треку', r.status === 201 && r.data.comment.time <= 2.0001, r.data.comment && r.data.comment.time);
    r = await guest.req('GET', `/api/tracks/${track.id}/comments`);
    check('коментарі впорядковані за часом', r.data.comments.length === 2 && r.data.comments[0].time <= r.data.comments[1].time);
    const other = new Client();
    await other.req('POST', '/api/auth/register', { username: 'stranger', password: 'stranger-pass-1' });
    r = await other.req('DELETE', `/api/comments/${commentId}`);
    check('чужий коментар видалити не можна (403)', r.status === 403);
    r = await admin.req('DELETE', `/api/comments/${commentId}`);
    check('адмін модерує коментар', r.status === 200);
    r = await user.req('POST', `/api/tracks/${track.id}/comments`, { text: '   ', time: 1 });
    check('порожній коментар відхилено (400)', r.status === 400);

    console.log('\nCSRF та безпека');
    r = await user.req('POST', `/api/tracks/${track.id}/like`, undefined, { Origin: 'https://evil.example' });
    check('чужий Origin відхилено (403)', r.status === 403);
    r = await guest.req('GET', '/uploads/audio/anything.wav');
    check('сирі аудіофайли не віддаються статикою', r.status !== 200);

    console.log('\nLive Room (socket.io)');
    let ioClient;
    try {
      ioClient = require('socket.io-client').io;
    } catch (_) {
      ioClient = null;
    }
    if (!ioClient) {
      console.log('  – socket.io-client не встановлено, пропускаю');
    } else {
      r = await user.req('POST', '/api/rooms', { name: 'Smoke Room', isPublic: true });
      check('створення кімнати', r.status === 201, r.data);
      const roomId = r.data.room.id;
      r = await guest.req('POST', '/api/rooms', { name: 'x' });
      check('гість не створює кімнати (401)', r.status === 401);

      const connect = (cookie) =>
        new Promise((resolve, reject) => {
          const s = ioClient(BASE, { extraHeaders: cookie ? { Cookie: cookie } : {}, transports: ['websocket'], reconnection: false });
          s.on('connect', () => resolve(s));
          s.on('connect_error', reject);
        });
      const host = await connect(user.cookie);
      const viewer = await connect('');
      const ack = (s, ev, payload) => new Promise((resolve) => s.emit(ev, payload, resolve));
      const once = (s, ev, ms = 3000) =>
        new Promise((resolve) => {
          const t = setTimeout(() => resolve(null), ms);
          s.once(ev, (d) => {
            clearTimeout(t);
            resolve(d);
          });
        });

      const hostJoin = await ack(host, 'room:join', { roomId });
      check('власник стає хостом', hostJoin.ok && hostJoin.isHost === true && hostJoin.isOwner === true);
      const viewerJoin = await ack(viewer, 'room:join', { roomId });
      check('гість приєднується як слухач', viewerJoin.ok && viewerJoin.isHost === false);
      check('є серверний час для синхронізації', typeof viewerJoin.serverTime === 'number');
      const t0 = Date.now();
      const sync = await new Promise((resolve) => viewer.emit('time:sync', resolve));
      check('time:sync повертає час сервера', Math.abs(sync - t0) < 2000);

      let waiting = once(viewer, 'room:state');
      host.emit('room:control', { state: { trackId: track.id, playing: true, position: 12.5 }, reason: 'track' });
      const st = await waiting;
      check('слухач отримує стан від хоста', st && st.state.trackId === track.id && st.state.playing === true && st.state.position === 12.5, st);

      waiting = once(host, 'room:state', 600);
      viewer.emit('room:control', { state: { trackId: track.id, playing: false, position: 0 }, reason: 'seek' });
      check('слухач не може керувати кімнатою', (await waiting) === null);

      waiting = once(host, 'room:chat');
      viewer.emit('room:chat', { text: 'привіт з тесту' });
      const msg = await waiting;
      check('чат працює', msg && msg.text === 'привіт з тесту');
      waiting = once(host, 'room:reaction');
      viewer.emit('room:reaction', { emoji: '🔥' });
      const reaction = await waiting;
      check('реакція доходить до всіх', reaction && reaction.emoji === '🔥');
      waiting = once(host, 'room:reaction', 500);
      viewer.emit('room:reaction', { emoji: '💩' });
      check('невідомі емодзі ігноруються', (await waiting) === null);

      r = await guest.req('GET', '/api/rooms');
      check('публічна кімната у списку', r.data.rooms.some((x) => x.id === roomId && x.members === 2));

      const closed = once(viewer, 'room:closed');
      host.emit('room:close');
      check('закриття кімнати сповіщає учасників', (await closed) !== null);
      host.close();
      viewer.close();

      // Коментарі в реальному часі
      const watcher = await connect('');
      watcher.emit('track:watch', { trackId: track.id });
      await sleep(150);
      waiting = once(watcher, 'comment:new');
      await user.req('POST', `/api/tracks/${track.id}/comments`, { text: 'live!', time: 0.5 });
      const live = await waiting;
      check('новий коментар приходить у реальному часі', live && live.text === 'live!');
      watcher.close();
    }

    console.log('\nSmart Home вебхук');
    r = await admin.req('PUT', '/api/admin/settings', { webhook: { url: hookUrl, enabled: true, secret: 'topsecret', scope: 'admin', events: ['play', 'pause', 'track_change'] } });
    check('налаштування вебхука збережено', r.status === 200 && r.data.webhook.enabled && r.data.webhook.hasSecret);
    check('секрет не повертається клієнту', !JSON.stringify(r.data).includes('topsecret'));
    r = await admin.req('POST', '/api/player/event', { event: 'track_change', trackId: track.id, position: 0, colors: ['#7c5cff', '#00e5ff', 'not-a-color'] });
    check('подія плеєра приймається (204)', r.status === 204);
    await sleep(500);
    const hook = hooks[hooks.length - 1];
    check('вебхук доставлено', !!hook);
    if (hook) {
      const body = JSON.parse(hook.raw);
      check('payload містить метадані треку', body.event === 'track_change' && body.track.title === 'Smoke Track' && body.playing === true);
      check('невалідні кольори відфільтровано', body.colors.length === 2);
      const sig = 'sha256=' + crypto.createHmac('sha256', 'topsecret').update(hook.raw).digest('hex');
      check('HMAC-підпис вірний', hook.headers['x-aiwaves-signature'] === sig);
      check('є Bearer-токен', hook.headers.authorization === 'Bearer topsecret');
    }
    const before = hooks.length;
    await user.req('POST', '/api/player/event', { event: 'play', trackId: track.id, position: 1 });
    await sleep(300);
    check('при scope=admin слухачі вебхук не тригерять', hooks.length === before);
    r = await admin.req('POST', '/api/admin/webhook/test');
    check('тестовий вебхук', r.status === 200 && r.data.result.ok === true, r.data);

    console.log('\nОчищення');
    r = await admin.req('DELETE', `/api/tracks/${track.id}`);
    check('видалення треку', r.status === 200);
    r = await admin.req('DELETE', `/api/tracks/${draftTrack.id}`);
    check('видалення другого треку', r.status === 200);
    check('аудіофайли фізично видалено', fs.readdirSync(path.join(TMP, 'uploads', 'audio')).length === 0);
    check('обкладинку фізично видалено', fs.readdirSync(path.join(TMP, 'uploads', 'covers')).length === 0);
    r = await admin.req('DELETE', '/api/users/1');
    check('не можна видалити власний акаунт', r.status === 400);
  } catch (err) {
    failed++;
    console.log('\nКритична помилка тесту:', err && err.stack ? err.stack : err);
    console.log('--- лог сервера ---\n' + serverLog);
  } finally {
    await cleanup();
  }

  console.log(`\nПройдено: ${passed}, провалено: ${failed}`);
  process.exit(failed ? 1 : 0);
}

main();

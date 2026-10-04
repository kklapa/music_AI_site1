'use strict';

/**
 * AI Waves — self-hosted сайт стрімінгу та публікації ШІ-музики.
 * Express + SQLite (better-sqlite3) + socket.io + JWT (HTTP-only cookie) + multer.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const express = require('express');
const helmet = require('helmet');
const cookie = require('cookie');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');

/* ============================================================================
 * Конфігурація
 * ========================================================================== */

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(ROOT, 'uploads'));
const AUDIO_DIR = path.join(UPLOAD_DIR, 'audio');
const COVER_DIR = path.join(UPLOAD_DIR, 'covers');

const BASE_URL = (process.env.BASE_URL || '').trim().replace(/\/+$/, '');
const COOKIE_SECURE = String(
  process.env.COOKIE_SECURE !== undefined && process.env.COOKIE_SECURE !== ''
    ? process.env.COOKIE_SECURE
    : BASE_URL.startsWith('https://') ? 'true' : 'false'
) === 'true';
const MAX_AUDIO_MB = Math.max(1, parseInt(process.env.MAX_AUDIO_MB, 10) || 100);
const MAX_COVER_MB = Math.max(1, parseInt(process.env.MAX_COVER_MB, 10) || 10);
const SITE_NAME_DEFAULT = process.env.SITE_NAME || 'AI Waves';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function parseTrustProxy(v) {
  if (v === undefined || v === '') return 1;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  return v;
}

for (const dir of [DATA_DIR, UPLOAD_DIR, AUDIO_DIR, COVER_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadJwtSecret() {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv && fromEnv.length >= 24 && !/change[-_ ]?me/i.test(fromEnv)) return fromEnv;
  const file = path.join(DATA_DIR, '.jwt_secret');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved.length >= 32) return saved;
  } catch (_) {
    /* файлу ще немає */
  }
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  console.log('[security] JWT_SECRET не задано — згенеровано і збережено в', file);
  return secret;
}
const JWT_SECRET = loadJwtSecret();

/* ============================================================================
 * Допоміжні функції
 * ========================================================================== */

const clampStr = (v, max) => String(v === undefined || v === null ? '' : v).replace(/\u0000/g, '').trim().slice(0, max);

function toInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function toFloat(v, def, min, max) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function toBool(v, def = false) {
  if (v === undefined || v === null || v === '') return def;
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
}

function normTags(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(',');
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    const s = String(raw).replace(/#/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
    const k = s.toLowerCase();
    if (s && !seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
    if (out.length >= 12) break;
  }
  return out.join(',');
}

const escapeLike = (s) => s.replace(/[\\%_]/g, (m) => '\\' + m);

const escHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function safeUnlink(file) {
  if (!file) return;
  try {
    fs.unlinkSync(file);
  } catch (_) {
    /* вже видалено */
  }
}

function readHead(file, n = 16) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const read = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/** Визначає розширення аудіо за "магічними байтами". Повертає null, якщо формат не підтримується. */
function sniffAudioExt(b) {
  if (b.length < 4) return null;
  const s3 = b.toString('latin1', 0, 3);
  const s4 = b.toString('latin1', 0, 4);
  if (s3 === 'ID3') return 'mp3';
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'mp3';
  if (s4 === 'RIFF' && b.length >= 12 && b.toString('latin1', 8, 12) === 'WAVE') return 'wav';
  if (s4 === 'OggS') return 'ogg';
  if (s4 === 'fLaC') return 'flac';
  if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp') return 'm4a';
  return null;
}

function sniffImageExt(b) {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 8 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

const AUDIO_MIME = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
};

/* ============================================================================
 * База даних
 * ========================================================================== */

const db = new Database(path.join(DATA_DIR, 'aiwaves.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tracks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    artist      TEXT NOT NULL DEFAULT '',
    genre       TEXT NOT NULL DEFAULT '',
    tags        TEXT NOT NULL DEFAULT '',
    ai_prompt   TEXT NOT NULL DEFAULT '',
    ai_model    TEXT NOT NULL DEFAULT '',
    generator   TEXT NOT NULL DEFAULT '',
    lyrics      TEXT NOT NULL DEFAULT '',
    audio_file  TEXT NOT NULL,
    cover_file  TEXT,
    duration    REAL NOT NULL DEFAULT 0,
    plays       INTEGER NOT NULL DEFAULT 0,
    published   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_tracks_created ON tracks(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_tracks_genre ON tracks(genre);

  CREATE TABLE IF NOT EXISTS likes (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_id   INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, track_id)
  );
  CREATE INDEX IF NOT EXISTS idx_likes_track ON likes(track_id);

  CREATE TABLE IF NOT EXISTS comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id   INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text       TEXT NOT NULL,
    time_sec   REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_comments_track ON comments(track_id, time_sec);

  CREATE TABLE IF NOT EXISTS history (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_id  INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    played_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_history_user ON history(user_id, played_at DESC);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

function getSetting(key, def = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : def;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

const WEBHOOK_EVENTS = ['play', 'pause', 'track_change'];

function webhookSettings() {
  let events = WEBHOOK_EVENTS;
  try {
    const parsed = JSON.parse(getSetting('webhook_events', JSON.stringify(WEBHOOK_EVENTS)));
    if (Array.isArray(parsed)) events = parsed.filter((e) => WEBHOOK_EVENTS.includes(e));
  } catch (_) {
    /* лишаємо за замовчуванням */
  }
  let last = null;
  try {
    last = JSON.parse(getSetting('webhook_last', 'null'));
  } catch (_) {
    last = null;
  }
  return {
    url: getSetting('webhook_url', ''),
    enabled: getSetting('webhook_enabled', '0') === '1',
    secret: getSetting('webhook_secret', ''),
    scope: getSetting('webhook_scope', 'admin') === 'all' ? 'all' : 'admin',
    events,
    last,
  };
}

function seedAdmin() {
  const hasAdmin = db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get();
  if (hasAdmin) return;
  const username = clampStr(process.env.ADMIN_USERNAME || 'admin', 24) || 'admin';
  let password = process.env.ADMIN_PASSWORD || '';
  let generated = false;
  if (!password || password.length < 8 || /change[-_ ]?me/i.test(password)) {
    password = crypto.randomBytes(9).toString('base64url');
    generated = true;
  }
  const hash = bcrypt.hashSync(password, 12);
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    db.prepare("UPDATE users SET role = 'admin', password_hash = ? WHERE id = ?").run(hash, existing.id);
  } else {
    db.prepare("INSERT INTO users(username, password_hash, role) VALUES(?, ?, 'admin')").run(username, hash);
  }
  console.log('\n==============================================================');
  console.log(' Створено адміністратора');
  console.log('   логін:  ' + username);
  if (generated) {
    console.log('   пароль: ' + password + '   (згенеровано — змініть після входу!)');
  } else {
    console.log('   пароль: із змінної ADMIN_PASSWORD');
  }
  console.log('==============================================================\n');
}
seedAdmin();

/* ============================================================================
 * Авторизація
 * ========================================================================== */

const COOKIE_NAME = 'aw_token';
const stmtUserById = db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?');

function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
}

function setAuthCookie(res, user) {
  res.cookie(COOKIE_NAME, signToken(user), {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    maxAge: 30 * 24 * 3600 * 1000,
    path: '/',
  });
}

function userFromToken(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return stmtUserById.get(payload.sub) || null;
  } catch (_) {
    return null;
  }
}

const publicUser = (u) => (u ? { id: u.id, username: u.username, role: u.role, created_at: u.created_at } : null);

function authOptional(req, _res, next) {
  req.user = userFromToken(req.cookies && req.cookies[COOKIE_NAME]);
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Потрібно увійти в акаунт' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Потрібно увійти в акаунт' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Лише для адміністратора' });
  next();
}

/** Фіктивний хеш: вирівнює час відповіді, коли користувача не існує. */
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(12).toString('hex'), 11);

const USERNAME_RE = /^[\p{L}\p{N}_.-]{3,24}$/u;

function validateUsername(name) {
  if (!USERNAME_RE.test(name)) return 'Логін: 3–24 символи (літери, цифри, _ . -)';
  return null;
}

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Пароль має містити щонайменше 8 символів';
  if (pw.length > 128) return 'Пароль занадто довгий';
  return null;
}

/* ============================================================================
 * Express
 * ========================================================================== */

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));

const server = http.createServer(app);

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:', 'data:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
        workerSrc: ["'self'"],
        manifestSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    hsts: IS_PROD && COOKIE_SECURE ? undefined : false,
  })
);

app.use(cookieParser());
app.use(express.json({ limit: '64kb' }));

/** Захист від CSRF: для небезпечних методів перевіряємо Origin (SameSite=Lax працює як перша лінія). */
function allowedHosts(req) {
  const hosts = new Set();
  const h = req.get('host');
  if (h) hosts.add(h.toLowerCase());
  const xfh = req.get('x-forwarded-host');
  if (xfh) xfh.split(',').forEach((x) => hosts.add(x.trim().toLowerCase()));
  if (BASE_URL) {
    try {
      hosts.add(new URL(BASE_URL).host.toLowerCase());
    } catch (_) {
      /* ігноруємо */
    }
  }
  for (const o of ALLOWED_ORIGINS) {
    try {
      hosts.add(new URL(o).host.toLowerCase());
    } catch (_) {
      hosts.add(o.toLowerCase());
    }
  }
  return hosts;
}

app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  try {
    const host = new URL(origin).host.toLowerCase();
    if (allowedHosts(req).has(host)) return next();
  } catch (_) {
    /* некоректний Origin */
  }
  return res.status(403).json({ error: 'Заборонений Origin' });
});

app.use('/api', authOptional);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Забагато спроб. Спробуйте за кілька хвилин.' },
});
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Забагато запитів. Зачекайте хвилину.' },
});
const playerLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 90,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Забагато запитів' },
});

/* ============================================================================
 * Серіалізація
 * ========================================================================== */

function trackDTO(row) {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    genre: row.genre,
    tags: row.tags ? row.tags.split(',').filter(Boolean) : [],
    ai_prompt: row.ai_prompt,
    ai_model: row.ai_model,
    generator: row.generator,
    lyrics: row.lyrics,
    duration: row.duration,
    plays: row.plays,
    likes: row.likes || 0,
    comments: row.comments_count || 0,
    liked: !!row.liked,
    published: !!row.published,
    cover_url: row.cover_file ? '/uploads/covers/' + row.cover_file : null,
    audio_url: '/stream/' + row.id,
    created_at: row.created_at,
  };
}

const TRACK_SELECT = `
  SELECT t.*,
    (SELECT COUNT(*) FROM likes l WHERE l.track_id = t.id) AS likes,
    (SELECT COUNT(*) FROM comments c WHERE c.track_id = t.id) AS comments_count,
    EXISTS(SELECT 1 FROM likes l WHERE l.track_id = t.id AND l.user_id = @uid) AS liked
  FROM tracks t
`;

function getTrackRow(id, user) {
  return db
    .prepare(TRACK_SELECT + ' WHERE t.id = @id')
    .get({ id, uid: user ? user.id : 0 });
}

function canSeeTrack(row, user) {
  return row && (row.published || (user && user.role === 'admin'));
}

function commentDTO(row) {
  return {
    id: row.id,
    track_id: row.track_id,
    user_id: row.user_id,
    username: row.username,
    role: row.role,
    text: row.text,
    time: row.time_sec,
    created_at: row.created_at,
  };
}

const COMMENT_SELECT = `
  SELECT c.*, u.username, u.role
  FROM comments c JOIN users u ON u.id = c.user_id
`;

function absUrl(req, p) {
  const base = BASE_URL || `${req.protocol}://${req.get('host')}`;
  return base + p;
}

/* ============================================================================
 * Базові ендпоінти / автентифікація
 * ========================================================================== */

app.get('/healthz', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.get('/api/settings/public', (_req, res) => {
  res.json({
    siteName: getSetting('site_name', SITE_NAME_DEFAULT),
    registrationOpen: getSetting('registration_open', '1') === '1',
    maxAudioMb: MAX_AUDIO_MB,
  });
});

app.post('/api/auth/register', authLimiter, (req, res) => {
  if (getSetting('registration_open', '1') !== '1') {
    return res.status(403).json({ error: 'Реєстрацію вимкнено адміністратором' });
  }
  const username = clampStr(req.body && req.body.username, 24);
  const password = req.body && req.body.password;
  const uErr = validateUsername(username);
  if (uErr) return res.status(400).json({ error: uErr });
  const pErr = validatePassword(password);
  if (pErr) return res.status(400).json({ error: pErr });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: 'Такий логін уже зайнятий' });
  }
  const hash = bcrypt.hashSync(password, 11);
  const info = db.prepare("INSERT INTO users(username, password_hash, role) VALUES(?, ?, 'user')").run(username, hash);
  const user = stmtUserById.get(info.lastInsertRowid);
  setAuthCookie(res, user);
  res.status(201).json({ user: publicUser(user) });
});

app.post('/api/auth/login', authLimiter, (req, res) => {
  const username = clampStr(req.body && req.body.username, 24);
  const password = req.body && req.body.password;
  if (!username || typeof password !== 'string') {
    return res.status(400).json({ error: 'Вкажіть логін і пароль' });
  }
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const ok = bcrypt.compareSync(password, row ? row.password_hash : DUMMY_HASH);
  if (!row || !ok) return res.status(401).json({ error: 'Невірний логін або пароль' });
  setAuthCookie(res, row);
  res.json({ user: publicUser(row) });
});

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE, path: '/' });
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.put('/api/me/password', requireAuth, authLimiter, (req, res) => {
  const current = req.body && req.body.current;
  const next = req.body && req.body.next;
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (typeof current !== 'string' || !bcrypt.compareSync(current, row.password_hash)) {
    return res.status(400).json({ error: 'Поточний пароль невірний' });
  }
  const pErr = validatePassword(next);
  if (pErr) return res.status(400).json({ error: pErr });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(next, 11), row.id);
  res.json({ ok: true });
});

/* ============================================================================
 * Завантаження файлів (multer)
 * ========================================================================== */

const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const storage = multer.diskStorage({
  destination(_req, file, cb) {
    cb(null, file.fieldname === 'cover' ? COVER_DIR : AUDIO_DIR);
  },
  filename(_req, file, cb) {
    cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase());
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_AUDIO_MB * 1024 * 1024, files: 2, fields: 30, fieldSize: 64 * 1024 },
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (file.fieldname === 'audio') {
      return AUDIO_EXT.has(ext) ? cb(null, true) : cb(new Error('Аудіо: підтримуються MP3, WAV, OGG, FLAC, M4A'));
    }
    if (file.fieldname === 'cover') {
      return IMAGE_EXT.has(ext) ? cb(null, true) : cb(new Error('Обкладинка: підтримуються JPG, PNG, WEBP'));
    }
    return cb(new Error('Неочікуване поле файлу'));
  },
});

const trackUpload = upload.fields([
  { name: 'audio', maxCount: 1 },
  { name: 'cover', maxCount: 1 },
]);

function uploadedFiles(req) {
  const files = [];
  if (req.files) {
    for (const list of Object.values(req.files)) files.push(...list);
  }
  return files;
}

function cleanupUploads(req) {
  uploadedFiles(req).forEach((f) => safeUnlink(f.path));
}

function handleTrackUpload(req, res, next) {
  trackUpload(req, res, (err) => {
    if (err) {
      cleanupUploads(req);
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `Файл завеликий (максимум ${MAX_AUDIO_MB} МБ)` });
      }
      return res.status(400).json({ error: err.message || 'Помилка завантаження файлу' });
    }
    next();
  });
}

/** Перевіряє вміст файлів і виправляє розширення за реальним форматом. Повертає { audio, cover } або кидає Error. */
function validateAndFixFiles(req) {
  const out = { audio: null, cover: null };
  const audio = req.files && req.files.audio && req.files.audio[0];
  const cover = req.files && req.files.cover && req.files.cover[0];

  try {
    if (audio) {
      const ext = sniffAudioExt(readHead(audio.path));
      if (!ext) throw new Error('Файл не схожий на підтримуваний аудіоформат');
      out.audio = fixExtension(audio.path, ext);
    }
    if (cover) {
      if (cover.size > MAX_COVER_MB * 1024 * 1024) throw new Error(`Обкладинка завелика (максимум ${MAX_COVER_MB} МБ)`);
      const ext = sniffImageExt(readHead(cover.path));
      if (!ext) throw new Error('Файл обкладинки не є коректним зображенням (JPG/PNG/WEBP)');
      out.cover = fixExtension(cover.path, ext);
    }
  } catch (err) {
    // Прибираємо вже перейменовані файли, щоб не лишати сміття на диску.
    if (out.audio) safeUnlink(path.join(AUDIO_DIR, out.audio));
    if (out.cover) safeUnlink(path.join(COVER_DIR, out.cover));
    throw err;
  }
  return out;
}

function fixExtension(filePath, ext) {
  const current = path.extname(filePath).slice(1).toLowerCase();
  const normalized = current === 'jpeg' ? 'jpg' : current;
  if (normalized === ext || (ext === 'mp3' && current === 'aac')) return path.basename(filePath);
  const next = path.join(path.dirname(filePath), path.basename(filePath, path.extname(filePath)) + '.' + ext);
  fs.renameSync(filePath, next);
  return path.basename(next);
}

/* ============================================================================
 * Треки
 * ========================================================================== */

app.get('/api/genres', (req, res) => {
  const admin = req.user && req.user.role === 'admin';
  const rows = db
    .prepare(
      `SELECT genre, COUNT(*) AS n FROM tracks
       WHERE genre != '' AND (published = 1 OR @admin = 1)
       GROUP BY genre COLLATE NOCASE ORDER BY n DESC, genre LIMIT 40`
    )
    .all({ admin: admin ? 1 : 0 });
  res.json({ genres: rows });
});

app.get('/api/tracks', (req, res) => {
  const admin = req.user && req.user.role === 'admin';
  const q = clampStr(req.query.q, 80);
  const genre = clampStr(req.query.genre, 40);
  const tag = clampStr(req.query.tag, 24);
  const limit = toInt(req.query.limit, 24, 1, 100);
  const offset = toInt(req.query.offset, 0, 0, 100000);
  const sorts = {
    new: 't.created_at DESC, t.id DESC',
    popular: 't.plays DESC, t.id DESC',
    liked: 'likes DESC, t.id DESC',
  };
  const orderBy = sorts[req.query.sort] || sorts.new;

  const where = ['(t.published = 1 OR @admin = 1)'];
  const params = { uid: req.user ? req.user.id : 0, admin: admin ? 1 : 0, limit, offset };
  if (q) {
    where.push(
      "(t.title LIKE @like ESCAPE '\\' OR t.artist LIKE @like ESCAPE '\\' OR t.genre LIKE @like ESCAPE '\\' OR t.tags LIKE @like ESCAPE '\\' OR t.ai_model LIKE @like ESCAPE '\\')"
    );
    params.like = '%' + escapeLike(q) + '%';
  }
  if (genre) {
    where.push('t.genre = @genre COLLATE NOCASE');
    params.genre = genre;
  }
  if (tag) {
    where.push("(',' || LOWER(t.tags) || ',') LIKE @tag ESCAPE '\\'");
    params.tag = '%,' + escapeLike(tag.toLowerCase()) + ',%';
  }

  const whereSql = ' WHERE ' + where.join(' AND ');
  const rows = db
    .prepare(TRACK_SELECT + whereSql + ' ORDER BY ' + orderBy + ' LIMIT @limit OFFSET @offset')
    .all(params);
  const countParams = { ...params };
  delete countParams.uid;
  delete countParams.limit;
  delete countParams.offset;
  const total = db.prepare('SELECT COUNT(*) AS n FROM tracks t' + whereSql).get(countParams).n;
  res.json({ tracks: rows.map(trackDTO), total });
});

app.get('/api/tracks/:id', (req, res) => {
  const id = toInt(req.params.id, 0, 0, Number.MAX_SAFE_INTEGER);
  const row = getTrackRow(id, req.user);
  if (!canSeeTrack(row, req.user)) return res.status(404).json({ error: 'Трек не знайдено' });
  res.json({ track: trackDTO(row) });
});

function trackFieldsFromBody(body, { partial }) {
  const fields = {};
  const has = (k) => body[k] !== undefined;
  if (!partial || has('title')) fields.title = clampStr(body.title, 140);
  if (!partial || has('artist')) fields.artist = clampStr(body.artist, 80);
  if (!partial || has('genre')) fields.genre = clampStr(body.genre, 40);
  if (!partial || has('tags')) fields.tags = normTags(body.tags);
  if (!partial || has('ai_prompt')) fields.ai_prompt = clampStr(body.ai_prompt, 4000);
  if (!partial || has('ai_model')) fields.ai_model = clampStr(body.ai_model, 80);
  if (!partial || has('generator')) fields.generator = clampStr(body.generator, 40);
  if (!partial || has('lyrics')) fields.lyrics = clampStr(body.lyrics, 8000);
  if (has('duration')) fields.duration = toFloat(body.duration, 0, 0, 86400);
  if (!partial || has('published')) fields.published = toBool(body.published, true) ? 1 : 0;
  return fields;
}

app.post('/api/tracks', requireAdmin, writeLimiter, handleTrackUpload, (req, res) => {
  let files;
  try {
    const audio = req.files && req.files.audio && req.files.audio[0];
    if (!audio) throw new Error('Додайте аудіофайл (MP3 або WAV)');
    files = validateAndFixFiles(req);
    const f = trackFieldsFromBody(req.body || {}, { partial: false });
    if (!f.title) throw new Error('Вкажіть назву треку');
    const info = db
      .prepare(
        `INSERT INTO tracks(title, artist, genre, tags, ai_prompt, ai_model, generator, lyrics, audio_file, cover_file, duration, published)
         VALUES(@title, @artist, @genre, @tags, @ai_prompt, @ai_model, @generator, @lyrics, @audio_file, @cover_file, @duration, @published)`
      )
      .run({
        ...f,
        duration: f.duration || 0,
        audio_file: files.audio,
        cover_file: files.cover,
      });
    const row = getTrackRow(info.lastInsertRowid, req.user);
    io.emit('tracks:changed', { id: row.id, action: 'created' });
    res.status(201).json({ track: trackDTO(row) });
  } catch (err) {
    cleanupUploads(req);
    if (files) {
      if (files.audio) safeUnlink(path.join(AUDIO_DIR, files.audio));
      if (files.cover) safeUnlink(path.join(COVER_DIR, files.cover));
    }
    res.status(400).json({ error: err.message || 'Не вдалося створити трек' });
  }
});

app.put('/api/tracks/:id', requireAdmin, writeLimiter, handleTrackUpload, (req, res) => {
  const id = toInt(req.params.id, 0, 0, Number.MAX_SAFE_INTEGER);
  const existing = db.prepare('SELECT * FROM tracks WHERE id = ?').get(id);
  if (!existing) {
    cleanupUploads(req);
    return res.status(404).json({ error: 'Трек не знайдено' });
  }
  let files;
  try {
    files = validateAndFixFiles(req);
    const f = trackFieldsFromBody(req.body || {}, { partial: true });
    if (f.title !== undefined && !f.title) throw new Error('Назва не може бути порожньою');
    if (files.audio) f.audio_file = files.audio;
    if (files.cover) f.cover_file = files.cover;
    if (toBool(req.body && req.body.remove_cover) && !files.cover) f.cover_file = null;

    const keys = Object.keys(f);
    if (keys.length) {
      const sql = 'UPDATE tracks SET ' + keys.map((k) => `${k} = @${k}`).join(', ') + ' WHERE id = @id';
      db.prepare(sql).run({ ...f, id });
    }
    if (files.audio && existing.audio_file !== files.audio) safeUnlink(path.join(AUDIO_DIR, path.basename(existing.audio_file)));
    if (existing.cover_file && f.cover_file !== undefined && f.cover_file !== existing.cover_file) {
      safeUnlink(path.join(COVER_DIR, path.basename(existing.cover_file)));
    }
    const row = getTrackRow(id, req.user);
    io.emit('tracks:changed', { id, action: 'updated' });
    res.json({ track: trackDTO(row) });
  } catch (err) {
    cleanupUploads(req);
    if (files) {
      if (files.audio) safeUnlink(path.join(AUDIO_DIR, files.audio));
      if (files.cover) safeUnlink(path.join(COVER_DIR, files.cover));
    }
    res.status(400).json({ error: err.message || 'Не вдалося оновити трек' });
  }
});

app.delete('/api/tracks/:id', requireAdmin, (req, res) => {
  const id = toInt(req.params.id, 0, 0, Number.MAX_SAFE_INTEGER);
  const row = db.prepare('SELECT * FROM tracks WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Трек не знайдено' });
  db.prepare('DELETE FROM tracks WHERE id = ?').run(id);
  safeUnlink(path.join(AUDIO_DIR, path.basename(row.audio_file)));
  if (row.cover_file) safeUnlink(path.join(COVER_DIR, path.basename(row.cover_file)));
  io.emit('tracks:changed', { id, action: 'deleted' });
  res.json({ ok: true });
});

const recentPlays = new Map();
setInterval(() => {
  const cutoff = Date.now() - 120000;
  for (const [k, t] of recentPlays) if (t < cutoff) recentPlays.delete(k);
}, 60000).unref();

app.post('/api/tracks/:id/play', playerLimiter, (req, res) => {
  const id = toInt(req.params.id, 0, 0, Number.MAX_SAFE_INTEGER);
  const row = db.prepare('SELECT id, published FROM tracks WHERE id = ?').get(id);
  if (!row || !canSeeTrack(row, req.user)) return res.status(404).json({ error: 'Трек не знайдено' });
  const key = (req.user ? 'u' + req.user.id : 'ip' + req.ip) + ':' + id;
  const last = recentPlays.get(key) || 0;
  if (Date.now() - last > 30000) {
    db.prepare('UPDATE tracks SET plays = plays + 1 WHERE id = ?').run(id);
    if (req.user) db.prepare('INSERT INTO history(user_id, track_id) VALUES(?, ?)').run(req.user.id, id);
  }
  recentPlays.set(key, Date.now());
  res.json({ ok: true });
});

app.post('/api/tracks/:id/like', requireAuth, writeLimiter, (req, res) => {
  const id = toInt(req.params.id, 0, 0, Number.MAX_SAFE_INTEGER);
  const row = db.prepare('SELECT id, published FROM tracks WHERE id = ?').get(id);
  if (!row || !canSeeTrack(row, req.user)) return res.status(404).json({ error: 'Трек не знайдено' });
  const exists = db.prepare('SELECT 1 FROM likes WHERE user_id = ? AND track_id = ?').get(req.user.id, id);
  if (exists) db.prepare('DELETE FROM likes WHERE user_id = ? AND track_id = ?').run(req.user.id, id);
  else db.prepare('INSERT INTO likes(user_id, track_id) VALUES(?, ?)').run(req.user.id, id);
  const likes = db.prepare('SELECT COUNT(*) AS n FROM likes WHERE track_id = ?').get(id).n;
  res.json({ liked: !exists, likes });
});

/* ---- Стрімінг аудіо з підтримкою HTTP Range (206 Partial Content) ---------- */

app.get('/stream/:id', authOptional, (req, res) => {
  const id = toInt(req.params.id, 0, 0, Number.MAX_SAFE_INTEGER);
  const row = db.prepare('SELECT audio_file, published FROM tracks WHERE id = ?').get(id);
  if (!row || !canSeeTrack(row, req.user)) return res.status(404).end();

  const filePath = path.join(AUDIO_DIR, path.basename(row.audio_file));
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_) {
    return res.status(404).end();
  }

  const size = stat.size;
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const etag = `"${size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;

  res.set({
    'Accept-Ranges': 'bytes',
    'Content-Type': AUDIO_MIME[ext] || 'application/octet-stream',
    'Cache-Control': row.published ? 'public, max-age=86400' : 'private, no-store',
    ETag: etag,
    'Last-Modified': stat.mtime.toUTCString(),
    'X-Content-Type-Options': 'nosniff',
  });

  const range = req.headers.range;
  let start = 0;
  let end = size - 1;
  let status = 200;

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (!m || (m[1] === '' && m[2] === '')) {
      res.set('Content-Range', `bytes */${size}`);
      return res.status(416).end();
    }
    if (m[1] === '') {
      const suffix = parseInt(m[2], 10);
      if (!(suffix > 0)) {
        res.set('Content-Range', `bytes */${size}`);
        return res.status(416).end();
      }
      start = Math.max(0, size - suffix);
    } else {
      start = parseInt(m[1], 10);
      end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
    }
    if (start >= size || start > end) {
      res.set('Content-Range', `bytes */${size}`);
      return res.status(416).end();
    }
    status = 206;
    res.set('Content-Range', `bytes ${start}-${end}/${size}`);
  } else if (req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }

  res.status(status);
  res.set('Content-Length', String(end - start + 1));
  if (req.method === 'HEAD' || size === 0) return res.end();

  const stream = fs.createReadStream(filePath, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
});

/* ============================================================================
 * Коментарі на таймлайні
 * ========================================================================== */

app.get('/api/tracks/:id/comments', (req, res) => {
  const id = toInt(req.params.id, 0, 0, Number.MAX_SAFE_INTEGER);
  const track = db.prepare('SELECT id, published FROM tracks WHERE id = ?').get(id);
  if (!track || !canSeeTrack(track, req.user)) return res.status(404).json({ error: 'Трек не знайдено' });
  const rows = db
    .prepare(COMMENT_SELECT + ' WHERE c.track_id = ? ORDER BY c.time_sec ASC, c.id ASC LIMIT 1000')
    .all(id);
  res.json({ comments: rows.map(commentDTO) });
});

app.post('/api/tracks/:id/comments', requireAuth, writeLimiter, (req, res) => {
  const id = toInt(req.params.id, 0, 0, Number.MAX_SAFE_INTEGER);
  const track = db.prepare('SELECT id, published, duration FROM tracks WHERE id = ?').get(id);
  if (!track || !canSeeTrack(track, req.user)) return res.status(404).json({ error: 'Трек не знайдено' });
  const text = clampStr(req.body && req.body.text, 300);
  if (!text) return res.status(400).json({ error: 'Коментар не може бути порожнім' });
  const maxTime = track.duration > 0 ? track.duration : 86400;
  const time = toFloat(req.body && req.body.time, 0, 0, maxTime);
  const info = db
    .prepare('INSERT INTO comments(track_id, user_id, text, time_sec) VALUES(?, ?, ?, ?)')
    .run(id, req.user.id, text, time);
  const comment = commentDTO(db.prepare(COMMENT_SELECT + ' WHERE c.id = ?').get(info.lastInsertRowid));
  io.to('track:' + id).emit('comment:new', comment);
  res.status(201).json({ comment });
});

app.put('/api/comments/:id', requireAuth, writeLimiter, (req, res) => {
  const id = toInt(req.params.id, 0, 0, Number.MAX_SAFE_INTEGER);
  const row = db.prepare('SELECT * FROM comments WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Коментар не знайдено' });
  if (row.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Можна редагувати лише власні коментарі' });
  }
  const text = clampStr(req.body && req.body.text, 300);
  if (!text) return res.status(400).json({ error: 'Коментар не може бути порожнім' });
  db.prepare('UPDATE comments SET text = ? WHERE id = ?').run(text, id);
  const comment = commentDTO(db.prepare(COMMENT_SELECT + ' WHERE c.id = ?').get(id));
  io.to('track:' + row.track_id).emit('comment:updated', comment);
  res.json({ comment });
});

app.delete('/api/comments/:id', requireAuth, (req, res) => {
  const id = toInt(req.params.id, 0, 0, Number.MAX_SAFE_INTEGER);
  const row = db.prepare('SELECT * FROM comments WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Коментар не знайдено' });
  if (row.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Можна видаляти лише власні коментарі' });
  }
  db.prepare('DELETE FROM comments WHERE id = ?').run(id);
  io.to('track:' + row.track_id).emit('comment:deleted', { id, track_id: row.track_id });
  res.json({ ok: true });
});

/* ============================================================================
 * Кабінет користувача: лайки та історія
 * ========================================================================== */

app.get('/api/me/likes', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      TRACK_SELECT +
        ` JOIN likes my ON my.track_id = t.id AND my.user_id = @uid
          WHERE (t.published = 1 OR @admin = 1)
          ORDER BY my.created_at DESC LIMIT 200`
    )
    .all({ uid: req.user.id, admin: req.user.role === 'admin' ? 1 : 0 });
  res.json({ tracks: rows.map(trackDTO) });
});

app.get('/api/me/history', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT t.*,
         (SELECT COUNT(*) FROM likes l WHERE l.track_id = t.id) AS likes,
         (SELECT COUNT(*) FROM comments c WHERE c.track_id = t.id) AS comments_count,
         EXISTS(SELECT 1 FROM likes l WHERE l.track_id = t.id AND l.user_id = @uid) AS liked,
         h.last_played
       FROM (
         SELECT track_id, MAX(played_at) AS last_played, MAX(id) AS hid
         FROM history WHERE user_id = @uid GROUP BY track_id
       ) h
       JOIN tracks t ON t.id = h.track_id
       WHERE (t.published = 1 OR @admin = 1)
       ORDER BY h.hid DESC LIMIT 100`
    )
    .all({ uid: req.user.id, admin: req.user.role === 'admin' ? 1 : 0 });
  res.json({ tracks: rows.map((r) => ({ ...trackDTO(r), last_played: r.last_played })) });
});

app.delete('/api/me/history', requireAuth, (req, res) => {
  db.prepare('DELETE FROM history WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

app.get('/api/me/comments', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.*, u.username, u.role, t.title AS track_title
       FROM comments c JOIN users u ON u.id = c.user_id JOIN tracks t ON t.id = c.track_id
       WHERE c.user_id = ? ORDER BY c.id DESC LIMIT 100`
    )
    .all(req.user.id);
  res.json({ comments: rows.map((r) => ({ ...commentDTO(r), track_title: r.track_title })) });
});

/* ============================================================================
 * Керування користувачами (адмін)
 * ========================================================================== */

app.get('/api/users', requireAdmin, (_req, res) => {
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.role, u.created_at,
         (SELECT COUNT(*) FROM comments c WHERE c.user_id = u.id) AS comments,
         (SELECT COUNT(*) FROM likes l WHERE l.user_id = u.id) AS likes
       FROM users u ORDER BY u.id ASC`
    )
    .all();
  res.json({ users: rows });
});

app.post('/api/users', requireAdmin, writeLimiter, (req, res) => {
  const username = clampStr(req.body && req.body.username, 24);
  const password = req.body && req.body.password;
  const role = req.body && req.body.role === 'admin' ? 'admin' : 'user';
  const uErr = validateUsername(username);
  if (uErr) return res.status(400).json({ error: uErr });
  const pErr = validatePassword(password);
  if (pErr) return res.status(400).json({ error: pErr });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: 'Такий логін уже зайнятий' });
  }
  const info = db
    .prepare('INSERT INTO users(username, password_hash, role) VALUES(?, ?, ?)')
    .run(username, bcrypt.hashSync(password, 11), role);
  res.status(201).json({ user: publicUser(stmtUserById.get(info.lastInsertRowid)) });
});

function adminCount() {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
}

app.put('/api/users/:id', requireAdmin, writeLimiter, (req, res) => {
  const id = toInt(req.params.id, 0, 0, Number.MAX_SAFE_INTEGER);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'Користувача не знайдено' });
  const body = req.body || {};
  const sets = [];
  const params = { id };

  if (body.username !== undefined) {
    const username = clampStr(body.username, 24);
    const uErr = validateUsername(username);
    if (uErr) return res.status(400).json({ error: uErr });
    const clash = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, id);
    if (clash) return res.status(409).json({ error: 'Такий логін уже зайнятий' });
    sets.push('username = @username');
    params.username = username;
  }
  if (body.password !== undefined && body.password !== '') {
    const pErr = validatePassword(body.password);
    if (pErr) return res.status(400).json({ error: pErr });
    sets.push('password_hash = @hash');
    params.hash = bcrypt.hashSync(body.password, 11);
  }
  if (body.role !== undefined) {
    const role = body.role === 'admin' ? 'admin' : 'user';
    if (target.role === 'admin' && role !== 'admin' && adminCount() <= 1) {
      return res.status(400).json({ error: 'Не можна прибрати роль в останнього адміністратора' });
    }
    sets.push('role = @role');
    params.role = role;
  }
  if (!sets.length) return res.status(400).json({ error: 'Немає змін' });
  db.prepare('UPDATE users SET ' + sets.join(', ') + ' WHERE id = @id').run(params);
  res.json({ user: publicUser(stmtUserById.get(id)) });
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const id = toInt(req.params.id, 0, 0, Number.MAX_SAFE_INTEGER);
  if (id === req.user.id) return res.status(400).json({ error: 'Не можна видалити власний акаунт' });
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'Користувача не знайдено' });
  if (target.role === 'admin' && adminCount() <= 1) {
    return res.status(400).json({ error: 'Не можна видалити останнього адміністратора' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

/* ---- Модерація коментарів та статистика ----------------------------------- */

app.get('/api/admin/comments', requireAdmin, (req, res) => {
  const limit = toInt(req.query.limit, 100, 1, 500);
  const rows = db
    .prepare(
      `SELECT c.*, u.username, u.role, t.title AS track_title
       FROM comments c JOIN users u ON u.id = c.user_id JOIN tracks t ON t.id = c.track_id
       ORDER BY c.id DESC LIMIT ?`
    )
    .all(limit);
  res.json({ comments: rows.map((r) => ({ ...commentDTO(r), track_title: r.track_title })) });
});

app.get('/api/admin/stats', requireAdmin, (_req, res) => {
  const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  const plays = db.prepare('SELECT COALESCE(SUM(plays), 0) AS n FROM tracks').get().n;
  const top = db
    .prepare('SELECT id, title, plays FROM tracks ORDER BY plays DESC, id DESC LIMIT 5')
    .all();
  let diskBytes = 0;
  for (const dir of [AUDIO_DIR, COVER_DIR]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        try {
          diskBytes += fs.statSync(path.join(dir, f)).size;
        } catch (_) {
          /* файл зник */
        }
      }
    } catch (_) {
      /* каталог недоступний */
    }
  }
  res.json({
    tracks: count('tracks'),
    users: count('users'),
    comments: count('comments'),
    likes: count('likes'),
    plays,
    diskBytes,
    rooms: rooms.size,
    top,
  });
});

/* ============================================================================
 * Smart Home Webhooks
 * ========================================================================== */

function webhookTrackPayload(req, row) {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    genre: row.genre,
    tags: row.tags ? row.tags.split(',').filter(Boolean) : [],
    generator: row.generator,
    model: row.ai_model,
    duration: row.duration,
    cover_url: row.cover_file ? absUrl(req, '/uploads/covers/' + row.cover_file) : null,
    page_url: absUrl(req, '/track/' + row.id),
  };
}

async function fireWebhook(settings, payload) {
  const body = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'AI-Waves-Webhook/1.0' };
  if (settings.secret) {
    headers.Authorization = 'Bearer ' + settings.secret;
    headers['X-AIWaves-Signature'] =
      'sha256=' + crypto.createHmac('sha256', settings.secret).update(body).digest('hex');
  }
  const result = { at: new Date().toISOString(), event: payload.event, ok: false, status: 0, error: null };
  try {
    const resp = await fetch(settings.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(4000),
    });
    result.status = resp.status;
    result.ok = resp.ok;
    if (!resp.ok) result.error = 'HTTP ' + resp.status;
    try {
      await resp.arrayBuffer();
    } catch (_) {
      /* тіло відповіді не потрібне */
    }
  } catch (err) {
    result.error = err && err.name === 'TimeoutError' ? 'Тайм-аут (4 с)' : (err && err.cause && err.cause.code) || (err && err.message) || 'Помилка запиту';
  }
  try {
    setSetting('webhook_last', JSON.stringify(result));
  } catch (_) {
    /* не критично */
  }
  return result;
}

const PALETTE_RE = /^#[0-9a-f]{6}$/i;

app.post('/api/player/event', playerLimiter, (req, res) => {
  const body = req.body || {};
  const event = String(body.event || '');
  if (!WEBHOOK_EVENTS.includes(event)) return res.status(400).json({ error: 'Невідома подія' });
  const settings = webhookSettings();
  if (!settings.enabled || !settings.url || !settings.events.includes(event)) return res.status(204).end();
  if (settings.scope === 'admin' && !(req.user && req.user.role === 'admin')) return res.status(204).end();

  const trackId = toInt(body.trackId, 0, 0, Number.MAX_SAFE_INTEGER);
  const row = db.prepare('SELECT * FROM tracks WHERE id = ?').get(trackId);
  if (!row) return res.status(204).end();

  const colors = Array.isArray(body.colors) ? body.colors.filter((c) => PALETTE_RE.test(String(c))).slice(0, 4) : [];
  const payload = {
    source: 'ai-waves',
    event,
    timestamp: new Date().toISOString(),
    playing: event !== 'pause',
    position: toFloat(body.position, 0, 0, 86400),
    room: body.roomId ? clampStr(body.roomId, 16) : null,
    user: req.user ? req.user.username : null,
    colors,
    track: webhookTrackPayload(req, row),
  };
  fireWebhook(settings, payload).catch(() => {});
  res.status(204).end();
});

/* ---- Налаштування адмінки -------------------------------------------------- */

app.get('/api/admin/settings', requireAdmin, (_req, res) => {
  const w = webhookSettings();
  res.json({
    siteName: getSetting('site_name', SITE_NAME_DEFAULT),
    registrationOpen: getSetting('registration_open', '1') === '1',
    webhook: {
      url: w.url,
      enabled: w.enabled,
      hasSecret: !!w.secret,
      scope: w.scope,
      events: w.events,
      last: w.last,
    },
  });
});

function validateWebhookUrl(url) {
  if (!url) return null;
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    return 'Некоректний URL вебхука';
  }
  if (!['http:', 'https:'].includes(u.protocol)) return 'URL має починатися з http:// або https://';
  return null;
}

app.put('/api/admin/settings', requireAdmin, writeLimiter, (req, res) => {
  const body = req.body || {};
  if (body.siteName !== undefined) {
    const name = clampStr(body.siteName, 40);
    if (!name) return res.status(400).json({ error: 'Назва сайту не може бути порожньою' });
    setSetting('site_name', name);
  }
  if (body.registrationOpen !== undefined) setSetting('registration_open', toBool(body.registrationOpen) ? '1' : '0');

  const w = body.webhook;
  if (w && typeof w === 'object') {
    if (w.url !== undefined) {
      const url = clampStr(w.url, 500);
      const err = validateWebhookUrl(url);
      if (err) return res.status(400).json({ error: err });
      setSetting('webhook_url', url);
    }
    if (w.enabled !== undefined) setSetting('webhook_enabled', toBool(w.enabled) ? '1' : '0');
    if (w.secret !== undefined) setSetting('webhook_secret', clampStr(w.secret, 200));
    if (w.scope !== undefined) setSetting('webhook_scope', w.scope === 'all' ? 'all' : 'admin');
    if (Array.isArray(w.events)) {
      setSetting('webhook_events', JSON.stringify(w.events.filter((e) => WEBHOOK_EVENTS.includes(e))));
    }
  }
  const out = webhookSettings();
  res.json({
    ok: true,
    siteName: getSetting('site_name', SITE_NAME_DEFAULT),
    registrationOpen: getSetting('registration_open', '1') === '1',
    webhook: { url: out.url, enabled: out.enabled, hasSecret: !!out.secret, scope: out.scope, events: out.events, last: out.last },
  });
});

app.post('/api/admin/webhook/test', requireAdmin, writeLimiter, async (req, res) => {
  const settings = webhookSettings();
  if (!settings.url) return res.status(400).json({ error: 'Спершу вкажіть URL вебхука та збережіть налаштування' });
  const row = db.prepare('SELECT * FROM tracks ORDER BY id DESC LIMIT 1').get();
  const sample = row
    ? webhookTrackPayload(req, row)
    : { id: 0, title: 'Тестовий трек', artist: 'AI Waves', genre: 'test', tags: [], generator: '', model: '', duration: 0, cover_url: null, page_url: absUrl(req, '/') };
  const result = await fireWebhook(settings, {
    source: 'ai-waves',
    event: 'test',
    timestamp: new Date().toISOString(),
    playing: true,
    position: 0,
    room: null,
    user: req.user.username,
    colors: ['#7c5cff', '#00e5ff', '#ff3d9a'],
    track: sample,
  });
  res.json({ result });
});

/* ============================================================================
 * Live Listen Rooms (REST частина)
 * ========================================================================== */

const rooms = new Map();
const ROOM_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const REACTIONS = ['❤️', '🔥', '😍', '🎉', '👏', '😮', '🤯', '💜', '✨', '🙌'];
const HOST_GRACE_MS = 20000;
const EMPTY_ROOM_TTL_MS = 5 * 60 * 1000;

function newRoomId() {
  let id;
  do {
    id = Array.from(crypto.randomBytes(8), (b) => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join('');
  } while (rooms.has(id));
  return id;
}

function membersPayload(room) {
  return Array.from(room.members, ([sid, m]) => ({
    id: sid,
    name: m.name,
    userId: m.userId,
    isHost: sid === room.hostSocketId,
  }));
}

function roomInfo(room) {
  let track = null;
  if (room.state.trackId) {
    const t = db.prepare('SELECT id, title, artist, cover_file FROM tracks WHERE id = ?').get(room.state.trackId);
    if (t) track = { id: t.id, title: t.title, artist: t.artist, cover_url: t.cover_file ? '/uploads/covers/' + t.cover_file : null };
  }
  const host = room.hostSocketId && room.members.get(room.hostSocketId);
  return {
    id: room.id,
    name: room.name,
    isPublic: room.isPublic,
    ownerName: room.ownerName,
    hostName: host ? host.name : null,
    members: room.members.size,
    playing: room.state.playing,
    track,
    createdAt: room.createdAt,
  };
}

app.get('/api/rooms', (_req, res) => {
  const list = Array.from(rooms.values())
    .filter((r) => r.isPublic && r.members.size > 0)
    .sort((a, b) => b.members.size - a.members.size || b.createdAt - a.createdAt)
    .map(roomInfo);
  res.json({ rooms: list });
});

app.get('/api/rooms/:id', (req, res) => {
  const room = rooms.get(String(req.params.id).toLowerCase());
  if (!room) return res.status(404).json({ error: 'Кімнату не знайдено або вона вже закрита' });
  res.json({ room: roomInfo(room) });
});

app.post('/api/rooms', requireAuth, writeLimiter, (req, res) => {
  const owned = Array.from(rooms.values()).filter((r) => r.ownerId === req.user.id).length;
  if (owned >= 3) return res.status(429).json({ error: 'Можна мати не більше 3 активних кімнат' });
  const name = clampStr(req.body && req.body.name, 50) || `Кімната ${req.user.username}`;
  const room = {
    id: newRoomId(),
    name,
    isPublic: toBool(req.body && req.body.isPublic, true),
    ownerId: req.user.id,
    ownerName: req.user.username,
    hostSocketId: null,
    hostTimer: null,
    createdAt: Date.now(),
    emptySince: Date.now(),
    members: new Map(),
    chat: [],
    state: { trackId: null, playing: false, position: 0, updatedAt: Date.now(), seq: 0 },
  };
  rooms.set(room.id, room);
  io.emit('rooms:changed');
  res.status(201).json({ room: roomInfo(room) });
});

app.delete('/api/rooms/:id', requireAuth, (req, res) => {
  const room = rooms.get(String(req.params.id).toLowerCase());
  if (!room) return res.status(404).json({ error: 'Кімнату не знайдено' });
  if (room.ownerId !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Закрити кімнату може лише її власник' });
  }
  closeRoom(room, 'Кімнату закрито власником');
  res.json({ ok: true });
});

/* ============================================================================
 * Статика, SPA-fallback, Open Graph
 * ========================================================================== */

app.use(
  '/uploads/covers',
  express.static(COVER_DIR, { maxAge: '30d', immutable: true, index: false, dotfiles: 'deny', fallthrough: false })
);

app.get('/service-worker.js', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.set('Service-Worker-Allowed', '/');
  res.type('application/javascript');
  res.sendFile(path.join(PUBLIC_DIR, 'service-worker.js'));
});

app.get(['/admin', '/admin/'], (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

app.use(
  express.static(PUBLIC_DIR, {
    index: false,
    dotfiles: 'ignore',
    setHeaders(res, filePath) {
      if (/\.(html|js|css|json)$/.test(filePath)) res.set('Cache-Control', 'no-cache');
      else res.set('Cache-Control', 'public, max-age=604800');
    },
  })
);

const indexCache = { mtime: 0, html: '' };
function readIndexHtml() {
  const file = path.join(PUBLIC_DIR, 'index.html');
  const mtime = fs.statSync(file).mtimeMs;
  if (indexCache.mtime !== mtime) {
    indexCache.html = fs.readFileSync(file, 'utf8');
    indexCache.mtime = mtime;
  }
  return indexCache.html;
}

function renderIndex(req, meta) {
  let html = readIndexHtml();
  const site = getSetting('site_name', SITE_NAME_DEFAULT);
  const title = meta && meta.title ? `${meta.title} — ${site}` : null;
  const description = (meta && meta.description) || '';
  const tags = [];
  const pageUrl = absUrl(req, req.originalUrl.split('?')[0]);
  tags.push(`<meta property="og:site_name" content="${escHtml(site)}">`);
  tags.push(`<meta property="og:url" content="${escHtml(pageUrl)}">`);
  tags.push('<meta property="og:type" content="music.song">');
  if (title) {
    tags.push(`<meta property="og:title" content="${escHtml(title)}">`);
    tags.push(`<meta name="twitter:title" content="${escHtml(title)}">`);
  }
  if (description) {
    tags.push(`<meta property="og:description" content="${escHtml(description)}">`);
    tags.push(`<meta name="description" content="${escHtml(description)}">`);
  }
  const image = meta && meta.image ? absUrl(req, meta.image) : absUrl(req, '/icons/icon-512.png');
  tags.push(`<meta property="og:image" content="${escHtml(image)}">`);
  tags.push('<meta name="twitter:card" content="summary_large_image">');
  html = html.replace('<!--OG-->', tags.join('\n'));
  if (title) html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${escHtml(title)}</title>`);
  return html;
}

app.get(/^\/(?!api\/|stream\/|uploads\/|socket\.io\/).*/, (req, res, next) => {
  if (path.extname(req.path)) return next();
  let meta = null;
  const tm = /^\/track\/(\d+)\/?$/.exec(req.path);
  if (tm) {
    const row = db.prepare('SELECT * FROM tracks WHERE id = ? AND published = 1').get(parseInt(tm[1], 10));
    if (row) {
      const bits = [row.artist, row.genre, row.generator && `ШІ: ${row.generator}`].filter(Boolean).join(' · ');
      meta = { title: row.title, description: bits || 'Слухайте ШІ-музику онлайн', image: row.cover_file ? '/uploads/covers/' + row.cover_file : null };
    }
  } else if (/^\/room\/[a-z0-9]+\/?$/i.test(req.path)) {
    meta = { title: 'Спільне прослуховування', description: 'Приєднуйтесь до кімнати та слухайте музику разом у реальному часі' };
  }
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(renderIndex(req, meta));
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Ендпоінт не знайдено' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (err && err.status === 404) return res.status(404).end();
  console.error('[error]', req.method, req.originalUrl, err && err.stack ? err.stack : err);
  if (res.headersSent) return res.end();
  const status = err && err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  res.status(status).json({ error: status === 500 ? 'Внутрішня помилка сервера' : err.message });
});

/* ============================================================================
 * socket.io: Live Rooms, чат, реакції, live-коментарі
 * ========================================================================== */

const io = new Server(server, {
  maxHttpBufferSize: 1e5,
  pingInterval: 20000,
  pingTimeout: 25000,
  serveClient: true,
});

function rateOk(socket, key, max, windowMs) {
  const now = Date.now();
  socket.data.rl = socket.data.rl || {};
  const arr = (socket.data.rl[key] || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    socket.data.rl[key] = arr;
    return false;
  }
  arr.push(now);
  socket.data.rl[key] = arr;
  return true;
}

io.use((socket, next) => {
  const raw = socket.handshake.headers.cookie || '';
  let token;
  try {
    token = cookie.parse(raw)[COOKIE_NAME];
  } catch (_) {
    token = undefined;
  }
  const user = userFromToken(token);
  socket.data.user = user;
  socket.data.name = user ? user.username : 'Гість-' + (1000 + Math.floor(Math.random() * 9000));
  next();
});

function broadcastMembers(room) {
  io.to('room:' + room.id).emit('room:members', {
    members: membersPayload(room),
    hostId: room.hostSocketId,
  });
}

function pickNewHost(room) {
  if (room.hostSocketId && room.members.has(room.hostSocketId)) return;
  room.hostSocketId = null;
  let best = null;
  for (const [sid, m] of room.members) {
    if (m.userId && m.userId === room.ownerId) {
      best = sid;
      break;
    }
  }
  if (!best) {
    const sorted = Array.from(room.members).sort((a, b) => {
      const au = a[1].userId ? 0 : 1;
      const bu = b[1].userId ? 0 : 1;
      return au - bu || a[1].joinedAt - b[1].joinedAt;
    });
    if (sorted.length) best = sorted[0][0];
  }
  if (best) {
    room.hostSocketId = best;
    io.to('room:' + room.id).emit('room:host', { hostId: best, state: room.state, serverTime: Date.now() });
  }
  broadcastMembers(room);
  io.emit('rooms:changed');
}

function leaveRoom(socket) {
  const id = socket.data.roomId;
  if (!id) return;
  socket.data.roomId = null;
  socket.leave('room:' + id);
  const room = rooms.get(id);
  if (!room) return;
  room.members.delete(socket.id);
  if (room.members.size === 0) {
    room.emptySince = Date.now();
    room.hostSocketId = null;
    if (room.hostTimer) clearTimeout(room.hostTimer);
    room.hostTimer = null;
  } else if (room.hostSocketId === socket.id) {
    room.hostSocketId = null;
    if (room.hostTimer) clearTimeout(room.hostTimer);
    room.hostTimer = setTimeout(() => {
      room.hostTimer = null;
      if (rooms.has(room.id)) pickNewHost(room);
    }, HOST_GRACE_MS);
    room.hostTimer.unref();
  }
  broadcastMembers(room);
  io.emit('rooms:changed');
}

function closeRoom(room, reason) {
  if (room.hostTimer) clearTimeout(room.hostTimer);
  io.to('room:' + room.id).emit('room:closed', { reason: reason || 'Кімнату закрито' });
  for (const sid of room.members.keys()) {
    const s = io.sockets.sockets.get(sid);
    if (s) {
      s.leave('room:' + room.id);
      s.data.roomId = null;
    }
  }
  rooms.delete(room.id);
  io.emit('rooms:changed');
}

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.members.size === 0 && room.emptySince && now - room.emptySince > EMPTY_ROOM_TTL_MS) {
      closeRoom(room, 'Кімната неактивна');
    }
  }
}, 30000).unref();

function sanitizeState(input) {
  if (!input || typeof input !== 'object') return null;
  let trackId = null;
  if (input.trackId !== null && input.trackId !== undefined) {
    trackId = toInt(input.trackId, 0, 0, Number.MAX_SAFE_INTEGER);
    const exists = db.prepare('SELECT 1 FROM tracks WHERE id = ? AND published = 1').get(trackId);
    if (!exists) return null;
  }
  return {
    trackId,
    playing: !!input.playing,
    position: toFloat(input.position, 0, 0, 86400),
  };
}

io.on('connection', (socket) => {
  socket.on('time:sync', (cb) => {
    if (typeof cb === 'function') cb(Date.now());
  });

  /* ---- live-коментарі ---- */
  socket.on('track:watch', (payload) => {
    const id = toInt(payload && payload.trackId, 0, 0, Number.MAX_SAFE_INTEGER);
    if (!id) return;
    const watched = socket.data.watched || (socket.data.watched = new Set());
    if (watched.size >= 8 && !watched.has(id)) return;
    watched.add(id);
    socket.join('track:' + id);
  });

  socket.on('track:unwatch', (payload) => {
    const id = toInt(payload && payload.trackId, 0, 0, Number.MAX_SAFE_INTEGER);
    if (!id) return;
    if (socket.data.watched) socket.data.watched.delete(id);
    socket.leave('track:' + id);
  });

  /* ---- кімнати ---- */
  socket.on('room:join', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      const id = String((payload && payload.roomId) || '').toLowerCase();
      const room = rooms.get(id);
      if (!room) return reply({ ok: false, error: 'Кімнату не знайдено або вона вже закрита' });
      if (socket.data.roomId && socket.data.roomId !== id) leaveRoom(socket);
      socket.join('room:' + id);
      socket.data.roomId = id;
      room.members.set(socket.id, {
        name: socket.data.name,
        userId: socket.data.user ? socket.data.user.id : null,
        joinedAt: Date.now(),
      });
      room.emptySince = null;

      const isOwner = socket.data.user && socket.data.user.id === room.ownerId;
      if (isOwner) {
        if (room.hostTimer) clearTimeout(room.hostTimer);
        room.hostTimer = null;
        room.hostSocketId = socket.id;
      } else if (!room.hostSocketId || !room.members.has(room.hostSocketId)) {
        if (!room.hostTimer) room.hostSocketId = socket.id;
      }

      broadcastMembers(room);
      io.emit('rooms:changed');
      reply({
        ok: true,
        room: roomInfo(room),
        state: room.state,
        chat: room.chat.slice(-50),
        members: membersPayload(room),
        hostId: room.hostSocketId,
        isHost: room.hostSocketId === socket.id,
        isOwner: !!isOwner,
        selfId: socket.id,
        serverTime: Date.now(),
      });
    } catch (err) {
      console.error('[socket] room:join', err);
      reply({ ok: false, error: 'Не вдалося приєднатися до кімнати' });
    }
  });

  socket.on('room:leave', () => leaveRoom(socket));

  socket.on('room:control', (payload) => {
    try {
      const room = rooms.get(socket.data.roomId);
      if (!room || room.hostSocketId !== socket.id) return;
      if (!rateOk(socket, 'control', 40, 10000)) return;
      const next = sanitizeState(payload && payload.state);
      if (!next) return;
      const trackChanged = next.trackId !== room.state.trackId;
      const playingChanged = next.playing !== room.state.playing;
      room.state = { ...next, updatedAt: Date.now(), seq: room.state.seq + 1 };
      socket.to('room:' + room.id).emit('room:state', {
        state: room.state,
        reason: String((payload && payload.reason) || 'tick').slice(0, 16),
        serverTime: Date.now(),
      });
      if (trackChanged || playingChanged) io.emit('rooms:changed');
    } catch (err) {
      console.error('[socket] room:control', err);
    }
  });

  socket.on('room:chat', (payload) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    if (!rateOk(socket, 'chat', 6, 10000)) return;
    const text = clampStr(payload && payload.text, 300);
    if (!text) return;
    const msg = {
      id: crypto.randomUUID(),
      name: socket.data.name,
      userId: socket.data.user ? socket.data.user.id : null,
      text,
      ts: Date.now(),
    };
    room.chat.push(msg);
    if (room.chat.length > 100) room.chat.shift();
    io.to('room:' + room.id).emit('room:chat', msg);
  });

  socket.on('room:reaction', (payload) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    if (!rateOk(socket, 'react', 12, 3000)) return;
    const emoji = String((payload && payload.emoji) || '');
    if (!REACTIONS.includes(emoji)) return;
    io.to('room:' + room.id).emit('room:reaction', { emoji, name: socket.data.name, from: socket.id });
  });

  socket.on('room:close', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const user = socket.data.user;
    const allowed = user && (user.id === room.ownerId || user.role === 'admin');
    if (!allowed) return;
    closeRoom(room, 'Кімнату закрито власником');
  });

  socket.on('disconnect', () => leaveRoom(socket));
});

/* ============================================================================
 * Запуск та коректне завершення
 * ========================================================================== */

server.listen(PORT, HOST, () => {
  console.log(`[AI Waves] слухає http://${HOST}:${PORT}  (${NODE_ENV})`);
  console.log(`[AI Waves] дані: ${DATA_DIR}`);
  console.log(`[AI Waves] файли: ${UPLOAD_DIR}`);
  if (BASE_URL) console.log(`[AI Waves] BASE_URL: ${BASE_URL}`);
});

function shutdown(signal) {
  console.log(`\n[AI Waves] ${signal}: завершення роботи…`);
  io.close(() => {
    server.close(() => {
      try {
        db.close();
      } catch (_) {
        /* вже закрито */
      }
      process.exit(0);
    });
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

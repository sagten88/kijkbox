import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.js';
import { db } from './db.js';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const COOKIE = 'kb_session';

// ---- Geheime sleutel: versleutelt de stream-links die de browser te zien krijgt.
const keyPath = path.join(config.dataDir, 'secret.key');
if (!fs.existsSync(keyPath)) fs.writeFileSync(keyPath, crypto.randomBytes(32), { mode: 0o600 });
const secret = fs.readFileSync(keyPath);

const ivKey = crypto.createHmac('sha256', secret).update('kijkbox-iv').digest();

/**
 * Dezelfde invoer geeft altijd hetzelfde token. Dat is nodig: bij live-HLS vraagt de speler de
 * afspeellijst steeds opnieuw op en keurt die af als een segment ineens een andere link heeft.
 * De IV komt daarom uit een HMAC van de inhoud, zodat verschillende inhoud nooit dezelfde IV krijgt.
 */
export function seal(payload) {
  const plain = JSON.stringify(payload);
  const iv = crypto.createHmac('sha256', ivKey).update(plain).digest().subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secret, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

export function unseal(token) {
  try {
    const raw = Buffer.from(String(token), 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', secret, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString());
  } catch {
    return null;
  }
}

// ---- Wachtwoorden
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, 32, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [, salt, expected] = stored.split('$');
  const hash = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64'), 32, SCRYPT);
  return crypto.timingSafeEqual(hash, Buffer.from(expected, 'base64'));
}

// Voorkomt dat de reactietijd verraadt of een gebruikersnaam bestaat.
const dummyHash = await hashPassword(crypto.randomBytes(16).toString('hex'));

export const verifyOrDummy = (password, user) => verifyPassword(password, user?.password_hash ?? dummyHash);

// ---- Sessies
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const sessionMs = config.sessionDays * 86400 * 1000;

function cookieFlags(req, maxAge) {
  const secure = config.secureCookies || req.secure ? '; Secure' : '';
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), userId, Date.now() + sessionMs);
  res.append('Set-Cookie', `${COOKIE}=${token}; ${cookieFlags(req, config.sessionDays * 86400)}`);
}

function readCookie(req, wanted) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [name, value] = part.trim().split('=');
    if (name === wanted) return value;
  }
  return null;
}
const readToken = (req) => readCookie(req, COOKIE);

export function endSession(req, res) {
  const token = readToken(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.append('Set-Cookie', `${COOKIE}=; ${cookieFlags(req, 0)}`);
}

/** Wisselt op hetzelfde apparaat van account: de oude sessie vervalt, een nieuwe begint. */
export function replaceSession(req, res, userId) {
  const token = readToken(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  startSession(req, res, userId);
}

/**
 * Meldt de gebruiker overal af behalve in de huidige sessie. Ook gekoppelde tv's vervallen:
 * wie zijn wachtwoord wijzigt, wil niet dat een oude tv nog zonder wachtwoord kan wisselen.
 */
export function endOtherSessions(req, userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(userId, sha256(readToken(req) ?? ''));
  db.prepare('DELETE FROM device_accounts WHERE user_id = ? AND device_hash <> ?').run(userId, deviceHash(req) ?? '');
}

// ---- Apparaten (tv's): welke accounts zijn hier aangemeld, om tussen te wisselen
const DEVICE = 'kb_device';
const DEVICE_DAYS = 400; // langer bewaart een browser een cookie niet

export function deviceHash(req) {
  const token = readCookie(req, DEVICE);
  return token && /^[\w-]{20,100}$/.test(token) ? sha256(`device:${token}`) : null;
}

/** Koppelt dit account aan dit apparaat (en geeft het apparaat zo nodig eerst een eigen code). */
export function linkDevice(req, res, userId) {
  let hash = deviceHash(req);
  if (!hash) {
    const token = crypto.randomBytes(32).toString('base64url');
    res.append('Set-Cookie', `${DEVICE}=${token}; ${cookieFlags(req, DEVICE_DAYS * 86400)}`);
    hash = sha256(`device:${token}`);
  }
  db.prepare('INSERT OR IGNORE INTO device_accounts (device_hash, user_id, added_at) VALUES (?, ?, ?)').run(hash, userId, Date.now());
}

const findSession = db.prepare(`
  SELECT u.id, u.username, u.role, u.theme, u.appearance, s.expires_at, s.token_hash
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = ? AND s.expires_at > ?`);
const extendSession = db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?');

export function currentUser(req) {
  const token = readToken(req);
  if (!token) return null;
  const now = Date.now();
  const row = findSession.get(sha256(token), now);
  if (!row) return null;
  // Wie de site blijft gebruiken, blijft ingelogd. Eén keer per dag bijwerken is genoeg.
  if (row.expires_at - now < sessionMs - 86400 * 1000) extendSession.run(now + sessionMs, row.token_hash);
  return { id: row.id, username: row.username, role: row.role, theme: row.theme, appearance: row.appearance };
}

export function requireUser(req, res, next) {
  req.user = currentUser(req);
  if (!req.user) return res.status(401).json({ error: 'Log eerst in.' });
  next();
}

export function requireAdmin(req, res, next) {
  req.user = currentUser(req);
  if (!req.user) return res.status(401).json({ error: 'Log eerst in.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Alleen voor beheerders.' });
  next();
}

export function pruneSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
}

// ---- Beperking op inlogpogingen
const attempts = new Map();
const WINDOW = 15 * 60 * 1000;
const MAX_FAILS = 8;

export function loginBlocked(key) {
  const entry = attempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.first > WINDOW) {
    attempts.delete(key);
    return false;
  }
  return entry.fails >= MAX_FAILS;
}

export function loginFailed(key) {
  const entry = attempts.get(key);
  if (entry && Date.now() - entry.first <= WINDOW) entry.fails += 1;
  else attempts.set(key, { first: Date.now(), fails: 1 });
}

export const loginSucceeded = (key) => attempts.delete(key);

// ---- Invoercontrole
export const validUsername = (v) => typeof v === 'string' && /^[\p{L}\p{N}._-]{2,32}$/u.test(v);
export const validPassword = (v) => typeof v === 'string' && v.length >= 8 && v.length <= 200;

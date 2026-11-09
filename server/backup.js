// Back-ups van wat niet opnieuw op te halen is: accounts, bronnen, favorieten, verder kijken,
// verborgen landen/categorieën, instellingen en tv-profielen. De zender-, film- en gidslijsten
// zitten er niet in (die haalt Kijkbox gewoon weer bij de provider), dus een back-up is klein.
//
// Favorieten en voortgang worden bewaard met de code van de provider (bron + ext_key) in plaats
// van het interne nummer. Zo komen ze ook goed terug op een nieuwe server: wat nog niet bestaat,
// wordt toegevoegd zodra die bron opnieuw is ingelezen (applyPendingRestore).
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { db } from './db.js';

const DIR = path.join(config.dataDir, 'backups');
const KEEP = 10;
const FORMAT = 'kijkbox-backup';
const NAME = /^kijkbox-[0-9a-z-]+\.json$/;
fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });

export class BackupError extends Error {}

const stamp = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

function snapshot() {
  return {
    format: FORMAT,
    version: 1,
    app: config.version,
    createdAt: Date.now(),
    users: db.prepare('SELECT id, username, password_hash, role, created_at, theme, appearance, avatar, look, must_change_password FROM users').all(),
    sources: db.prepare(`SELECT id, name, type, url, username, password, content, epg_url, stream_format, user_agent FROM sources`).all(),
    settings: db.prepare(`SELECT key, value FROM settings WHERE key <> 'restore_pending'`).all(),
    hidden: db.prepare('SELECT user_id, kind, value FROM user_hidden').all(),
    devices: db.prepare('SELECT device_hash, user_id, added_at FROM device_accounts').all(),
    favorites: db.prepare(`SELECT f.user_id, f.created_at, i.source_id, i.ext_key
      FROM favorites f JOIN items i ON i.id = f.item_id`).all(),
    progress: db.prepare(`SELECT p.user_id, p.position, p.duration, p.updated_at, i.source_id, i.ext_key
      FROM progress p JOIN items i ON i.id = p.item_id`).all(),
  };
}

/** Maakt een back-up en ruimt oude op. reason komt in de bestandsnaam (bijv. "dagelijks"). */
export function createBackup(reason = 'handmatig') {
  const data = snapshot();
  const name = `kijkbox-${stamp(data.createdAt)}-${reason.replace(/[^a-z-]/g, '')}.json`;
  const file = path.join(DIR, name);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
  for (const old of listBackups().slice(KEEP)) fs.rmSync(path.join(DIR, old.name), { force: true });
  return listBackups().find((b) => b.name === name);
}

export function listBackups() {
  return fs.readdirSync(DIR).filter((name) => NAME.test(name)).map((name) => {
    const stat = fs.statSync(path.join(DIR, name));
    return { name, size: stat.size, at: stat.mtimeMs };
  }).sort((a, b) => b.at - a.at);
}

export function backupPath(name) {
  if (!NAME.test(String(name)) || !fs.existsSync(path.join(DIR, name))) throw new BackupError('Deze back-up bestaat niet.');
  return path.join(DIR, name);
}

export const readBackup = (name) => JSON.parse(fs.readFileSync(backupPath(name), 'utf8'));

const asArray = (value) => (Array.isArray(value) ? value : []);

function validate(data) {
  if (data?.format !== FORMAT || data.version !== 1) throw new BackupError('Dit is geen Kijkbox-back-up.');
  const users = asArray(data.users);
  if (!users.length || !users.some((u) => u.role === 'admin')) throw new BackupError('Deze back-up bevat geen beheerdersaccount.');
  for (const u of users) {
    if (!Number.isInteger(u.id) || typeof u.username !== 'string' || typeof u.password_hash !== 'string' || !['admin', 'viewer'].includes(u.role)) {
      throw new BackupError('De accounts in deze back-up zijn ongeldig.');
    }
  }
  for (const s of asArray(data.sources)) {
    if (!Number.isInteger(s.id) || !['m3u', 'm3u_text', 'xtream'].includes(s.type)) throw new BackupError('De bronnen in deze back-up zijn ongeldig.');
  }
}

const findItem = () => db.prepare('SELECT id FROM items WHERE source_id = ? AND ext_key = ?');

/** Favorieten en voortgang toevoegen voor zover de items bestaan; geeft terug wat nog ontbreekt. */
function applyRefs(favorites, progress) {
  const find = findItem();
  const addFav = db.prepare('INSERT OR IGNORE INTO favorites (user_id, item_id, created_at) VALUES (?, ?, ?)');
  const addProgress = db.prepare(`INSERT INTO progress (user_id, item_id, position, duration, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (user_id, item_id) DO UPDATE SET position = excluded.position, duration = excluded.duration, updated_at = excluded.updated_at`);
  const users = new Set(db.prepare('SELECT id FROM users').all().map((u) => u.id));
  const missing = { favorites: [], progress: [] };
  for (const f of favorites) {
    if (!users.has(f.user_id)) continue;
    const item = find.get(f.source_id, String(f.ext_key));
    if (item) addFav.run(f.user_id, item.id, Number(f.created_at) || Date.now());
    else missing.favorites.push(f);
  }
  for (const p of progress) {
    if (!users.has(p.user_id)) continue;
    const item = find.get(p.source_id, String(p.ext_key));
    if (item) addProgress.run(p.user_id, item.id, Number(p.position) || 0, Number(p.duration) || 0, Number(p.updated_at) || Date.now());
    else missing.progress.push(p);
  }
  return missing;
}

function savePending(missing) {
  if (!missing.favorites.length && !missing.progress.length) {
    db.prepare(`DELETE FROM settings WHERE key = 'restore_pending'`).run();
    return;
  }
  db.prepare(`INSERT INTO settings (key, value) VALUES ('restore_pending', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(JSON.stringify({ favorites: missing.favorites, progress: missing.progress, at: missing.at ?? Date.now() }));
}

/**
 * Zet een back-up terug. Maakt eerst zelf een back-up van de huidige stand, zodat je terug kunt.
 * Geeft terug welke bronnen opnieuw ingelezen moeten worden (die bestonden hier nog niet).
 */
export function restoreBackup(data) {
  validate(data);
  createBackup('voor-terugzetten');
  const users = asArray(data.users);
  const sources = asArray(data.sources);
  const existingSources = new Set(db.prepare('SELECT id FROM sources').all().map((s) => s.id));
  let missing;
  db.exec('BEGIN');
  try {
    // Accounts: bijwerken of toevoegen (geen REPLACE: dat zou sessies en favorieten wissen).
    const keepUsers = users.map((u) => u.id);
    db.prepare(`DELETE FROM users WHERE id NOT IN (${keepUsers.map(() => '?').join(',')})`).run(...keepUsers);
    const upsertUser = db.prepare(`INSERT INTO users (id, username, password_hash, role, created_at, theme, appearance, avatar, look, must_change_password)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET username = excluded.username,
      password_hash = excluded.password_hash, role = excluded.role, theme = excluded.theme, appearance = excluded.appearance,
      avatar = excluded.avatar, look = excluded.look, must_change_password = excluded.must_change_password`);
    for (const u of users) {
      upsertUser.run(u.id, u.username, u.password_hash, u.role, Number(u.created_at) || Date.now(), u.theme ?? '', u.appearance ?? '',
        typeof u.avatar === 'string' ? u.avatar : '', typeof u.look === 'string' ? u.look : '', u.must_change_password ? 1 : 0);
    }

    // Bronnen: dezelfde nummers houden, zodat favorieten en voortgang erbij blijven passen.
    const keepSources = sources.map((s) => s.id);
    db.prepare(`DELETE FROM sources WHERE id NOT IN (${keepSources.map(() => '?').join(',') || 'NULL'})`).run(...keepSources);
    const upsertSource = db.prepare(`INSERT INTO sources (id, name, type, url, username, password, content, epg_url, stream_format, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type,
      url = excluded.url, username = excluded.username, password = excluded.password, content = excluded.content,
      epg_url = excluded.epg_url, stream_format = excluded.stream_format, user_agent = excluded.user_agent`);
    for (const s of sources) {
      upsertSource.run(s.id, String(s.name ?? 'Bron'), s.type, s.url ?? '', s.username ?? '', s.password ?? '', s.content ?? '',
        s.epg_url ?? '', s.stream_format === 'hls' ? 'hls' : 'ts', s.user_agent ?? '');
    }

    const upsertSetting = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    for (const s of asArray(data.settings)) if (typeof s.key === 'string' && typeof s.value === 'string') upsertSetting.run(s.key, s.value);

    db.exec('DELETE FROM user_hidden; DELETE FROM device_accounts; DELETE FROM favorites; DELETE FROM progress;');
    const addHidden = db.prepare('INSERT OR IGNORE INTO user_hidden (user_id, kind, value) VALUES (?, ?, ?)');
    for (const h of asArray(data.hidden)) if (keepUsers.includes(h.user_id) && ['country', 'group'].includes(h.kind)) addHidden.run(h.user_id, h.kind, String(h.value));
    const addDevice = db.prepare('INSERT OR IGNORE INTO device_accounts (device_hash, user_id, added_at) VALUES (?, ?, ?)');
    for (const d of asArray(data.devices)) if (keepUsers.includes(d.user_id)) addDevice.run(String(d.device_hash), d.user_id, Number(d.added_at) || Date.now());

    missing = applyRefs(asArray(data.favorites), asArray(data.progress));
    savePending(missing);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return {
    users: users.length,
    sources: sources.length,
    favorites: asArray(data.favorites).length - missing.favorites.length,
    progress: asArray(data.progress).length - missing.progress.length,
    waiting: missing.favorites.length + missing.progress.length,
    refresh: sources.filter((s) => !existingSources.has(s.id)).map((s) => s.id),
  };
}

/** Na het inlezen van een bron: favorieten en voortgang uit een teruggezette back-up alsnog koppelen. */
export function applyPendingRestore() {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'restore_pending'`).get();
  if (!row) return;
  let pending;
  try { pending = JSON.parse(row.value); } catch { pending = null; }
  // Na een week geven we het op: die titels bestaan dan kennelijk niet meer bij de provider.
  if (!pending || Date.now() - pending.at > 7 * 86400 * 1000) return savePending({ favorites: [], progress: [] });
  db.exec('BEGIN');
  try {
    const missing = applyRefs(asArray(pending.favorites), asArray(pending.progress));
    savePending({ ...missing, at: pending.at });
    db.exec('COMMIT');
  } catch {
    db.exec('ROLLBACK');
  }
}

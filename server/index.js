import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import {
  currentUser, deviceHash, endOtherSessions, endSession, hashPassword, linkDevice, loginBlocked, loginFailed, loginSucceeded,
  pruneSessions, replaceSession, requireAdmin, requireUser, startSession, validPassword, validUsername, verifyOrDummy, verifyPassword,
} from './auth.js';
import { titleKey } from './titles.js';
import { itemsChanged, memo } from './cache.js';
import { isLocalAddress, NetworkError, networkSettings, saveProxy, trustProxyValue } from './network.js';
import { requestUpdate, setAutoUpdate, updateStatus, whatsNew } from './updates.js';
import { BackupError, backupPath, createBackup, listBackups, readBackup, restoreBackup } from './backup.js';
import { config, rootDir } from './config.js';
import {
  countryLabel, countryList, countryOf, FIRST_COUNTRY, firstCountryOnTop, groupsOfCountry, withoutCountry,
} from './countries.js';
import { db, normalize } from './db.js';
import { approvePairing, createPairing, pollPairing } from './pairing.js';
import { refreshEpg } from './epg.js';
import { isDue, nextNightly } from './schedule.js';
import { saveSubtitleSettings, SubtitleError, subtitleCues, subtitleSettings } from './subtitles.js';
import { catchupUrl, isRefreshing, loadBackdrop, loadEpisodes, providerStatus, refreshSource } from './sources.js';
import {
  releaseViewer, serveBackdrop, serveFfmpegFile, serveLogo, serveSubtitleCues, serveSubtitleList, serveManifest, playbackStatus, servePassthrough, startPlayback, stopAllSessions,
} from './stream.js';
import { parseMediaUrl, UpstreamError } from './upstream.js';
import { downloadSettings, downloadStatus, saveDownloadSettings, serveDownload, startDownload, stopDownloads } from './downloads.js';

const app = express();
app.disable('x-powered-by');

// Reverse proxy: uit TRUST_PROXY of uit de instellingen, en aan te passen zonder herstart.
function applyNetwork() {
  const { proxy } = networkSettings();
  config.trustProxy = trustProxyValue(proxy);
  app.set('trust proxy', config.trustProxy);
}
applyNetwork();

// Alleen het thuisnetwerk (en een reverse proxy daarop) mag erbij. Zie network.js.
app.use((req, res, next) => {
  if (config.allowPublic || isLocalAddress(req.socket.remoteAddress)) return next();
  res.status(403).type('text/plain; charset=utf-8')
    .send('Kijkbox is alleen bereikbaar op het thuisnetwerk. Gebruik een reverse proxy om hem van buitenaf te bereiken.');
});

const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
  "media-src 'self' blob:", "worker-src 'self' blob:", "connect-src 'self'",
  "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  next();
});

// Blokkeert verzoeken die vanaf een andere website worden verstuurd.
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.get('origin');
  const host = (config.trustProxy && req.get('x-forwarded-host')) || req.get('host');
  if (origin) {
    let originHost = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      /* ongeldige Origin wordt hieronder geweigerd */
    }
    if (originHost !== host) return res.status(403).json({ error: 'Verzoek geweigerd.' });
  }
  next();
});

const smallJson = express.json({ limit: '64kb' });
const largeJson = express.json({ limit: '80mb' });
// Grote verzoeken (een M3U-bestand, een back-up) alleen van een beheerder: eerst inloggen controleren,
// pas dan tot 80 MB inlezen. Anders kan iedereen op het netwerk de server bezighouden met enorme verzoeken.
const LARGE = new Set(['/sources', '/backups/restore']);
app.use('/api', (req, res, next) => {
  if (!LARGE.has(req.path) || req.method !== 'POST') return smallJson(req, res, next);
  requireAdmin(req, res, () => largeJson(req, res, next));
});

// ---- Eerste keer opstarten
const hasUsers = () => db.prepare('SELECT 1 FROM users LIMIT 1').get() !== undefined;
const setupCode = crypto.randomBytes(4).toString('hex').toUpperCase();

const loginKey = (req, name) => `${req.ip}|${String(name).toLowerCase()}`;
const publicUser = (u) => ({
  id: u.id, username: u.username, role: u.role, theme: u.theme ?? '', appearance: u.appearance ?? '',
  avatar: u.avatar ?? '', look: parseLook(u.look), mustChangePassword: Boolean(u.must_change_password),
});

// Eigen thema: hoe knoppen, hoeken, letters, kaarten en achtergrond eruitzien. Leeg = standaard.
const LOOK_OPTIONS = {
  corners: ['', 'round', 'square'],
  buttons: ['', 'pill', 'outline'],
  font: ['', 'rounded', 'serif', 'mono'],
  cards: ['', 'small', 'large'],
  // Leeg = glas (de standaard sinds 1.4.1); 'plain' = effen. 'glass' is de oude naam voor glas.
  background: ['', 'plain', 'gradient', 'glass'],
  pattern: ['', 'dots', 'grid', 'lines', 'waves', 'stars', 'bubbles', 'topo', 'aurora'],
};
function parseLook(value) {
  let raw = {};
  try { raw = typeof value === 'string' ? JSON.parse(value || '{}') : (value ?? {}); } catch { /* leeg */ }
  const look = {};
  for (const [key, allowed] of Object.entries(LOOK_OPTIONS)) look[key] = allowed.includes(raw?.[key]) ? raw[key] : '';
  if (look.background === 'glass') look.background = '';
  return look;
}

// Profielfoto's: a1 t/m a12 (getekend in de browser), of leeg voor de eerste letter.
const AVATARS = new Set(['', ...Array.from({ length: 12 }, (_, i) => `a${i + 1}`)]);

// Tijdelijk wachtwoord dat makkelijk over te nemen is: twee gewone woorden en een getal, zoals
// "boomkaas42". Het geldt maar één keer: bij het inloggen kiest de gebruiker meteen een eigen.
const TEMP_WORDS = ['appel', 'bloem', 'boom', 'boot', 'brood', 'deur', 'duin', 'eend', 'fiets', 'geit', 'gras', 'haas',
  'hond', 'huis', 'jas', 'kaas', 'kat', 'koe', 'kers', 'lamp', 'maan', 'meer', 'melk', 'mos', 'muis', 'peer', 'pen',
  'raam', 'regen', 'roos', 'schip', 'sneeuw', 'soep', 'ster', 'stoel', 'strand', 'tafel', 'taart', 'tent', 'thee',
  'trein', 'tulp', 'uil', 'vis', 'vogel', 'vos', 'wolk', 'zand', 'zee', 'zon'];
function tempPassword() {
  const word = () => TEMP_WORDS[crypto.randomInt(TEMP_WORDS.length)];
  let first = word();
  let second = word();
  while (second === first) second = word();
  return `${first}${second}${crypto.randomInt(10, 100)}`;
}
const APPEARANCES = new Set(['', 'light', 'oled']);

// Kleurthema's die een account kan kiezen. Leeg is het standaardgeel.
const THEMES = new Set(['', 'blauw', 'groen', 'rood', 'paars', 'roze', 'oranje', 'turquoise']);
// Of een eigen kleur (#rrggbb).
const validTheme = (theme) => typeof theme === 'string' && (THEMES.has(theme) || /^#[0-9a-f]{6}$/i.test(theme));

app.get('/api/state', (req, res) => {
  const user = currentUser(req);
  // Een tv die al was aangemeld voor deze versie, wordt zo meteen het eerste profiel.
  if (user && req.query.tv === '1') linkDevice(req, res, user.id);
  const profiles = req.query.tv === '1' ? deviceProfiles(deviceHash(req)).length : 0;
  res.set('Cache-Control', 'no-store').json({ needsSetup: !hasUsers(), user: user && publicUser(user), subtitles: Boolean(user) && subtitleSettings().configured, downloads: Boolean(user) && downloadSettings().enabled, profiles, version: config.version });
});

// ---- Netwerk: thuisnetwerk of via een reverse proxy (beheerder)
app.get('/api/network', requireAdmin, (req, res) => {
  res.json({ ...networkSettings(), viaProxy: Boolean(config.trustProxy) && req.socket.remoteAddress !== req.ip });
});

app.post('/api/network', requireAdmin, (req, res) => {
  try {
    const saved = saveProxy(req.body?.proxy);
    applyNetwork();
    res.json(saved);
  } catch (err) {
    res.status(400).json({ error: err instanceof NetworkError ? err.message : 'Opslaan mislukt.' });
  }
});

// ---- Updates (beheerder)
// Bij de updates ook wie er nu kijkt: dan kan de beheerder kiezen of de update toch meteen mag.
app.get('/api/update', requireAdmin, (req, res) => res.json({ ...updateStatus(), watching: playingNow() }));

// ---- Back-ups (beheerder)
app.get('/api/backups', requireAdmin, (req, res) => res.json(listBackups()));

app.post('/api/backups', requireAdmin, (req, res) => res.json(createBackup('handmatig')));

app.get('/api/backups/:name', requireAdmin, (req, res) => {
  try {
    res.download(backupPath(req.params.name), req.params.name);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Terugzetten: een back-up van deze server (name) of een geüpload bestand (data).
app.post('/api/backups/restore', requireAdmin, (req, res) => {
  try {
    const data = req.body?.name ? readBackup(req.body.name) : req.body?.data;
    const result = restoreBackup(data);
    itemsChanged();
    // Bronnen die hier nog niet bestonden meteen inlezen; favorieten volgen daarna vanzelf.
    for (const id of result.refresh) refreshAll(id).catch(() => {});
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof BackupError ? err.message : 'Terugzetten mislukt.' });
  }
});

// Wat er nieuw is na een update: iedereen ziet dat één keer op Home.
app.get('/api/whats-new', requireUser, (req, res) => res.json(whatsNew() ?? {}));

app.post('/api/update', requireAdmin, (req, res) => {
  try {
    if (typeof req.body?.auto === 'boolean') return res.json(setAutoUpdate(req.body.auto));
    res.json({ ...requestUpdate(req.body?.action), watching: playingNow() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Ondertitels (OpenSubtitles)
app.get('/api/subtitle-settings', requireAdmin, (req, res) => res.json(subtitleSettings()));

// ---- Downloaden voor offline kijken (zie downloads.js)
app.get('/api/download-settings', requireAdmin, (req, res) => res.json(downloadSettings()));
app.post('/api/download-settings', requireAdmin, (req, res) => res.json(saveDownloadSettings({ enabled: req.body?.enabled === true })));
app.get('/api/downloads/:id', requireUser, (req, res) => res.set('Cache-Control', 'no-store').json(downloadStatus(Number(req.params.id))));
app.post('/api/downloads/:id', requireUser, async (req, res) => {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'Niet gevonden.' });
  try {
    res.json(await startDownload(item));
  } catch (err) {
    res.status(err instanceof UpstreamError ? 409 : 502).json({ error: err instanceof UpstreamError ? err.message : 'Downloaden lukt nu niet.' });
  }
});
app.get('/api/downloads/:id/file', requireUser, (req, res) => serveDownload(req, res, Number(req.params.id)));

app.post('/api/subtitle-settings', requireAdmin, async (req, res) => {
  try {
    res.json(await saveSubtitleSettings(req.body ?? {}));
  } catch (err) {
    res.status(400).json({ error: err instanceof SubtitleError ? err.message : 'OpenSubtitles is niet bereikbaar. Probeer het later opnieuw.' });
  }
});

app.get('/api/subtitles/:id', requireUser, async (req, res) => {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'Niet gevonden.' });
  try {
    res.set('Cache-Control', 'private, max-age=3600').json({ cues: await subtitleCues(item, String(req.query.lang)) });
  } catch (err) {
    if (!(err instanceof SubtitleError)) console.error(`Ondertitels (item ${item.id}): ${err.name} ${err.code ?? ''}`);
    res.status(404).json({ error: err instanceof SubtitleError ? err.message : 'OpenSubtitles is niet bereikbaar. Probeer het later opnieuw.' });
  }
});

app.post('/api/setup', async (req, res) => {
  const { code, username, password } = req.body ?? {};
  if (hasUsers()) return res.status(409).json({ error: 'De site is al ingesteld.' });
  const key = loginKey(req, 'setup');
  if (loginBlocked(key)) return res.status(429).json({ error: 'Te veel pogingen. Probeer het over 15 minuten opnieuw.' });
  if (String(code ?? '').trim().toUpperCase() !== setupCode) {
    loginFailed(key);
    return res.status(403).json({ error: 'De installatiecode klopt niet. Je vindt hem in het servervenster.' });
  }
  if (!validUsername(username)) return res.status(400).json({ error: 'Kies een gebruikersnaam van 2 tot 32 tekens (letters, cijfers, punt, streepje).' });
  if (!validPassword(password)) return res.status(400).json({ error: 'Kies een wachtwoord van minimaal 8 tekens.' });
  const hash = await hashPassword(password);
  if (hasUsers()) return res.status(409).json({ error: 'De site is al ingesteld.' });
  const { lastInsertRowid } = db.prepare(`INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, 'admin', ?)`)
    .run(username, hash, Date.now());
  startSession(req, res, Number(lastInsertRowid));
  res.json({ user: { id: Number(lastInsertRowid), username, role: 'admin' } });
});

// ---- Inloggen en account
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== 'string' || typeof password !== 'string' || password.length > 200) {
    return res.status(400).json({ error: 'Vul je gebruikersnaam en wachtwoord in.' });
  }
  const key = loginKey(req, username);
  if (loginBlocked(key)) return res.status(429).json({ error: 'Te veel pogingen. Probeer het over 15 minuten opnieuw.' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const ok = await verifyOrDummy(password, user);
  if (!user || !ok) {
    loginFailed(key);
    return res.status(401).json({ error: 'Gebruikersnaam of wachtwoord klopt niet.' });
  }
  loginSucceeded(key);
  startSession(req, res, user.id);
  if (req.body.tv === true) linkDevice(req, res, user.id);
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  endSession(req, res);
  res.json({ ok: true });
});

// ---- Tv koppelen met een code
app.post('/api/pair/start', (req, res) => {
  const key = loginKey(req, 'pair-start');
  if (loginBlocked(key)) return res.status(429).json({ error: 'Te veel codes aangevraagd. Probeer het over 15 minuten opnieuw.' });
  loginFailed(key);
  const pairing = createPairing();
  if (!pairing) return res.status(503).json({ error: 'Probeer het zo opnieuw.' });
  res.json(pairing);
});

app.post('/api/pair/poll', (req, res) => {
  const result = pollPairing(req.body?.token);
  if (result.status === 'pending') return res.status(202).json({ pending: true });
  const user = result.status === 'approved' && db.prepare('SELECT * FROM users WHERE id = ?').get(result.userId);
  if (!user) return res.status(410).json({ error: 'Deze code is verlopen.' });
  // Was er op deze tv al iemand aangemeld, dan vervalt die sessie (het profiel blijft bewaard).
  replaceSession(req, res, user.id);
  if (req.body.tv === true) linkDevice(req, res, user.id);
  res.json({ user: publicUser(user) });
});

app.post('/api/pair/approve', requireUser, (req, res) => {
  const key = loginKey(req, `pair-approve-${req.user.id}`);
  if (loginBlocked(key)) return res.status(429).json({ error: 'Te veel pogingen. Probeer het over 15 minuten opnieuw.' });
  if (!approvePairing(req.body?.code, req.user.id)) {
    loginFailed(key);
    return res.status(404).json({ error: 'Deze code bestaat niet of is verlopen. Kijk op je tv voor de juiste code.' });
  }
  res.json({ ok: true });
});

app.post('/api/appearance', requireUser, (req, res) => {
  const value = req.body?.appearance;
  if (typeof value !== 'string' || !APPEARANCES.has(value)) return res.status(400).json({ error: 'Onbekende weergave.' });
  db.prepare('UPDATE users SET appearance = ? WHERE id = ?').run(value, req.user.id);
  res.json({ appearance: value });
});

// ---- Profielen op een tv: accounts die hier zijn aangemeld, om tussen te wisselen
const deviceProfiles = (hash) => (hash ? db.prepare(`SELECT u.id, u.username, u.theme, u.avatar FROM device_accounts d
  JOIN users u ON u.id = d.user_id WHERE d.device_hash = ? ORDER BY d.added_at`).all(hash) : []);

app.get('/api/profiles', (req, res) => {
  const user = currentUser(req);
  res.json({ profiles: deviceProfiles(deviceHash(req)), current: user?.id ?? null });
});

app.post('/api/profiles/:id/select', (req, res) => {
  const id = Number(req.params.id);
  if (!deviceProfiles(deviceHash(req)).some((p) => p.id === id)) {
    return res.status(403).json({ error: 'Dit account is niet op deze tv aangemeld.' });
  }
  replaceSession(req, res, id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) });
});

app.post('/api/profiles/:id/remove', (req, res) => {
  const id = Number(req.params.id);
  const hash = deviceHash(req);
  if (!hash) return res.status(404).json({ error: 'Niet gevonden.' });
  db.prepare('DELETE FROM device_accounts WHERE device_hash = ? AND user_id = ?').run(hash, id);
  // Was dit het account dat nu aan staat? Dan ook die sessie beëindigen.
  if (currentUser(req)?.id === id) endSession(req, res);
  res.json({ profiles: deviceProfiles(hash) });
});

app.post('/api/theme', requireUser, (req, res) => {
  const theme = req.body?.theme;
  if (!validTheme(theme)) return res.status(400).json({ error: 'Onbekend thema.' });
  db.prepare('UPDATE users SET theme = ? WHERE id = ?').run(theme.toLowerCase(), req.user.id);
  res.json({ theme: theme.toLowerCase() });
});

app.post('/api/look', requireUser, (req, res) => {
  const look = parseLook(req.body?.look);
  db.prepare('UPDATE users SET look = ? WHERE id = ?').run(JSON.stringify(look), req.user.id);
  res.json({ look });
});

app.post('/api/avatar', requireUser, (req, res) => {
  const avatar = req.body?.avatar;
  if (typeof avatar !== 'string' || !AVATARS.has(avatar)) return res.status(400).json({ error: 'Onbekende profielfoto.' });
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatar, req.user.id);
  res.json({ avatar });
});

app.post('/api/password', requireUser, async (req, res) => {
  const { current, next } = req.body ?? {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  // Net ingelogd met een tijdelijk wachtwoord: dat hoeft niet nog eens.
  const temporary = Boolean(user.must_change_password);
  if (!temporary && (typeof current !== 'string' || !(await verifyPassword(current, user.password_hash)))) {
    return res.status(403).json({ error: 'Je huidige wachtwoord klopt niet.' });
  }
  if (!validPassword(next)) return res.status(400).json({ error: 'Kies een wachtwoord van minimaal 8 tekens.' });
  if (temporary && (await verifyPassword(next, user.password_hash))) {
    return res.status(400).json({ error: 'Kies een ander wachtwoord dan het tijdelijke.' });
  }
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(await hashPassword(next), user.id);
  endOtherSessions(req, user.id);
  res.json({ ok: true });
});

// ---- Gebruikersbeheer
app.get('/api/users', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT id, username, role, created_at, theme, avatar, must_change_password FROM users ORDER BY username').all()
    .map(({ must_change_password: temp, ...u }) => ({ ...u, temporary: Boolean(temp) })));
});

app.post('/api/users', requireAdmin, async (req, res) => {
  const { username, role } = req.body ?? {};
  if (!validUsername(username)) return res.status(400).json({ error: 'Kies een gebruikersnaam van 2 tot 32 tekens (letters, cijfers, punt, streepje).' });
  if (role !== 'admin' && role !== 'viewer') return res.status(400).json({ error: 'Ongeldige rol.' });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: 'Deze gebruikersnaam bestaat al.' });
  }
  // De nieuwe gebruiker krijgt een tijdelijk wachtwoord en kiest bij de eerste keer inloggen een eigen.
  const password = tempPassword();
  db.prepare('INSERT INTO users (username, password_hash, role, created_at, must_change_password) VALUES (?, ?, ?, ?, 1)')
    .run(username, await hashPassword(password), role, Date.now());
  res.json({ ok: true, tempPassword: password });
});

app.patch('/api/users/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { resetPassword, role } = req.body ?? {};
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'Gebruiker niet gevonden.' });
  let password;
  if (resetPassword === true) {
    if (id === req.user.id) return res.status(400).json({ error: 'Wijzig je eigen wachtwoord bij Account.' });
    // Wachtwoord vergeten: nieuw tijdelijk wachtwoord, dat de gebruiker bij inloggen zelf vervangt.
    password = tempPassword();
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(await hashPassword(password), id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
  if (role !== undefined) {
    if (role !== 'admin' && role !== 'viewer') return res.status(400).json({ error: 'Ongeldige rol.' });
    if (target.role === 'admin' && role === 'viewer' && adminCount() <= 1) {
      return res.status(400).json({ error: 'Er moet minstens één beheerder overblijven.' });
    }
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  }
  res.json({ ok: true, tempPassword: password });
});

const adminCount = () => db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).get().n;

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Je kunt je eigen account niet verwijderen.' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---- Bronnen (alleen beheerders). Wachtwoorden en links gaan nooit terug naar de browser.
function publicSource(s) {
  const counts = Object.fromEntries(db.prepare(`
    SELECT type, COUNT(*) AS n FROM items WHERE source_id = ? AND type <> 'episode' GROUP BY type`)
    .all(s.id).map((row) => [row.type, row.n]));
  return {
    id: s.id, name: s.name, type: s.type, status: isRefreshing(s.id) ? 'bezig' : s.status, error: s.last_error,
    epgStatus: s.epg_status, lastRefresh: s.last_refresh, counts,
    nextRefresh: s.type === 'm3u_text' ? null : nextNightly(now(), config.refreshHour),
    account: s.account_info ? JSON.parse(s.account_info) : null,
    hasEpgUrl: Boolean(s.epg_url), streamFormat: s.stream_format,
  };
}

app.get('/api/sources', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM sources ORDER BY name').all().map(publicSource));
});

const text = (value, max = 2000) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

async function refreshAll(id) {
  await refreshSource(id);
  await refreshEpg(id);
}

app.post('/api/sources', requireAdmin, (req, res) => {
  const body = req.body ?? {};
  const name = text(body.name, 100);
  if (!name) return res.status(400).json({ error: 'Geef de bron een naam.' });
  const row = {
    name, type: body.type, url: text(body.url), username: text(body.username, 200), password: text(body.password, 200),
    content: '', epg_url: text(body.epgUrl), user_agent: text(body.userAgent, 300),
    stream_format: body.streamFormat === 'hls' ? 'hls' : 'ts',
  };
  try {
    if (row.type === 'single') {
      parseMediaUrl(row.url);
      row.type = 'm3u_text';
      row.content = `#EXTM3U\n#EXTINF:-1,${name.replace(/[\r\n]/g, ' ')}\n${row.url}\n`;
      row.url = '';
    } else if (row.type === 'm3u_text') {
      row.content = typeof body.content === 'string' ? body.content : '';
      if (!row.content.includes('http')) return res.status(400).json({ error: 'Deze tekst bevat geen streamlinks.' });
    } else if (row.type === 'm3u' || row.type === 'xtream') {
      parseMediaUrl(row.url);
      if (row.type === 'xtream' && (!row.username || !row.password)) {
        return res.status(400).json({ error: 'Vul de gebruikersnaam en het wachtwoord van je provider in.' });
      }
    } else {
      return res.status(400).json({ error: 'Onbekend brontype.' });
    }
    if (row.epg_url) parseMediaUrl(row.epg_url);
  } catch (err) {
    return res.status(400).json({ error: err instanceof UpstreamError ? err.message : 'Ongeldige invoer.' });
  }
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO sources (name, type, url, username, password, content, epg_url, user_agent, stream_format)
    VALUES (:name, :type, :url, :username, :password, :content, :epg_url, :user_agent, :stream_format)`).run(row);
  const id = Number(lastInsertRowid);
  refreshAll(id);
  res.json({ id });
});

app.post('/api/sources/:id/refresh', requireAdmin, (req, res) => {
  refreshAll(Number(req.params.id));
  res.json({ ok: true });
});

app.delete('/api/sources/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM sources WHERE id = ?').run(Number(req.params.id));
  itemsChanged();
  res.json({ ok: true });
});

// ---- Kijken
const now = () => Date.now();

function dto(row, nowOn) {
  const out = {
    id: row.id, type: row.type, name: row.name, group: row.grp, logo: row.logo ? `/api/img/${row.id}` : null,
    fav: Boolean(row.fav), rating: row.rating || undefined, year: row.year || undefined,
    plot: row.plot || undefined, season: row.season ?? undefined, episode: row.episode ?? undefined,
    parentId: row.parent_id ?? undefined,
    position: row.position ?? undefined, duration: row.duration ?? undefined,
    backdrop: row.backdrop && row.backdrop !== '-' ? `/api/backdrop/${row.id}` : undefined,
    versions: row.variants > 1 ? row.variants : undefined,
  };
  if (nowOn) out.now = nowOn.get(`${row.source_id}|${row.epg_id}`) ?? null;
  return out;
}

function currentProgrammes(rows) {
  const ids = [...new Set(rows.filter((r) => r.epg_id).map((r) => r.epg_id))];
  const found = new Map();
  if (!ids.length) return found;
  const marks = ids.map(() => '?').join(',');
  const time = now();
  const query = db.prepare(`SELECT source_id, epg_id, title, start, stop FROM programmes
    WHERE epg_id IN (${marks}) AND start <= ? AND stop > ?`);
  for (const p of query.all(...ids, time, time)) {
    found.set(`${p.source_id}|${p.epg_id}`, { title: p.title, start: p.start, stop: p.stop });
  }
  return found;
}

const BROWSE_COLUMNS = `i.*, f.user_id IS NOT NULL AS fav, p.position, p.duration`;
const BROWSE_JOINS = `
  LEFT JOIN favorites f ON f.item_id = i.id AND f.user_id = :user
  LEFT JOIN progress p ON p.item_id = i.id AND p.user_id = :user`;
const TYPES = new Set(['live', 'movie', 'series']);

function browseFilter(req, forcedType) {
  const { group, q, fav, country } = req.query;
  const type = forcedType ?? req.query.type;
  const where = [];
  const params = { user: req.user.id };
  if (TYPES.has(type)) {
    where.push('i.type = :type');
    params.type = type;
  } else {
    where.push(`i.type <> 'episode'`);
  }
  if (group) {
    where.push('i.grp = :group');
    params.group = String(group);
  }
  // Films en series in meerdere talen: zonder land- of categoriekeuze één kaart per titel.
  const merged = (type === 'movie' || type === 'series') && !group && !country && fav !== '1';
  const hidden = TYPES.has(type) ? hiddenGroups(req.user.id, type) : [];
  if (merged) where.push(primarySql(params, type, hidden));
  if (q) {
    const like = (text) => `%${text.replace(/[\\%_]/g, '\\$&')}%`;
    params.q = like(normalize(q));
    if (merged) {
      // Op de titelsleutel zoeken, zodat ook een anderstalige versie de hoofdkaart vindt.
      params.qk = like(titleKey(q) || normalize(q));
      where.push(`(i.title_key LIKE :qk ESCAPE '\\' OR i.name_lc LIKE :q ESCAPE '\\')`);
    } else {
      where.push(`i.name_lc LIKE :q ESCAPE '\\'`);
    }
  }
  // Vanuit de favorieten zoeken in plaats van alle items langs te lopen.
  if (fav === '1') where.push('i.id IN (SELECT item_id FROM favorites WHERE user_id = :user)');
  if (country && TYPES.has(type)) {
    const names = groupsOfCountry(groupsByType(type), String(country));
    where.push(names.length ? `i.grp IN (${namedList(params, 'c', names)})` : '1 = 0');
  }
  if (hidden.length) where.push(`i.grp NOT IN (${namedList(params, 'h', hidden)})`);
  return { sql: where.join(' AND '), params };
}

/**
 * Welke versie per titel de kaart wordt. Normaal de vooraf gekozen hoofdversie. Heeft dit account
 * een groep verborgen waar hoofdversies in zitten (bijvoorbeeld Nederland), dan per titel de beste
 * versie die nog wel zichtbaar is, zodat de film niet helemaal verdwijnt.
 */
function primarySql(params, type, hidden) {
  if (!hidden.length) return 'i.is_primary = 1';
  const affected = db.prepare(`SELECT 1 FROM items WHERE type = ? AND is_primary = 1 AND variants > 1 AND grp IN (${hidden.map(() => '?').join(',')}) LIMIT 1`)
    .get(type, ...hidden);
  if (!affected) return 'i.is_primary = 1';
  // Pas hier de waarden toevoegen: node:sqlite weigert waarden die de zoekopdracht niet gebruikt.
  const list = namedList(params, 'ph', hidden);
  return `(i.title_key = '' OR i.id IN (SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY title_key
        ORDER BY lang_rank, (year GLOB '[0-9][0-9][0-9][0-9]') DESC, sort, id) AS rn
      FROM items WHERE type = '${type === 'series' ? 'series' : 'movie'}' AND title_key <> '' AND grp NOT IN (${list})
    ) WHERE rn = 1))`;
}

// ---- Verborgen landen en categorieën (per account)
const hiddenRows = (userId) => db.prepare('SELECT kind, value FROM user_hidden WHERE user_id = ?').all(userId);

/** De groepen van dit type die dit account niet wil zien (door een verborgen land of categorie). */
function hiddenGroups(userId, type) {
  const rows = hiddenRows(userId);
  if (!rows.length) return [];
  const countries = new Set(rows.filter((r) => r.kind === 'country').map((r) => r.value));
  const groups = new Set(rows.filter((r) => r.kind === 'group').map((r) => r.value));
  return groupsByType(type).map((g) => g.name).filter((name) => groups.has(name) || countries.has(countryOf(name)));
}

// Groepen met aantallen. Dit telt ~190.000 rijen en verandert alleen bij verversen: dus bewaren.
const groupsByType = memo((type) => db.prepare('SELECT grp AS name, COUNT(*) AS count FROM items WHERE type = ? GROUP BY grp ORDER BY grp').all(type));

function namedList(params, prefix, values) {
  return values.map((value, index) => {
    params[`${prefix}${index}`] = value;
    return `:${prefix}${index}`;
  }).join(', ');
}

/**
 * Zonder landkeuze staat Nederland bovenaan. Bij films en series komt Engels daarna,
 * zodat een zoekopdracht niet begint met zeven anderstalige versies van dezelfde film.
 */
function browseOrder(type, req, params) {
  const plain = 'i.sort, i.name_lc';
  if (type === 'movie' || type === 'series') {
    // Sorteren op keuze; zonder keuze de volgorde van de provider (nieuwst toegevoegd eerst).
    // Beoordeling: boven 10 is ongeldig, en een 10 komt bij providers meestal van een handvol
    // stemmen. Die komen daarom achteraan, net als bij de aanbevelingen.
    const rated = `(CASE WHEN CAST(i.rating AS REAL) > 9.5 OR CAST(i.rating AS REAL) <= 0 THEN 0 ELSE CAST(i.rating AS REAL) END)`;
    const sorts = {
      year: `(i.year GLOB '[0-9][0-9][0-9][0-9]') DESC, i.year DESC, ${plain}`,
      rating: `${rated} DESC, ${plain}`,
      az: `i.title_key = '', i.title_key, i.name_lc`,
    };
    if (sorts[req.query.sort]) return sorts[req.query.sort];
    // Zoeken: precies de titel eerst, dan titels die ermee beginnen, dan de rest.
    let relevance = '';
    const key = req.query.q ? titleKey(String(req.query.q)) : '';
    if (key) {
      params.qe = key;
      params.qs = `${key.replace(/[\\%_]/g, '\\$&')}%`;
      relevance = `CASE WHEN i.title_key = :qe THEN 0 WHEN i.title_key LIKE :qs ESCAPE '\\' THEN 1 ELSE 2 END, `;
    }
    if (req.query.group || req.query.country) return `${relevance}${plain}`;
    return `${relevance}i.lang_rank, ${plain}`;
  }
  if (type !== 'live' || req.query.group || req.query.country) return plain;
  const top = groupsOfCountry(groupsByType('live'), FIRST_COUNTRY);
  return top.length ? `i.grp IN (${namedList(params, 'top', top)}) DESC, ${plain}` : plain;
}

const clampInt = (value, min, max, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? fallback : Math.min(max, Math.max(min, n));
};

app.get('/api/items', requireUser, (req, res) => {
  const { sql, params } = browseFilter(req);
  params.limit = clampInt(req.query.limit, 1, 200, 60);
  params.offset = clampInt(req.query.offset, 0, 10_000_000, 0);
  const order = browseOrder(req.query.type, req, params);
  const rows = db.prepare(`SELECT ${BROWSE_COLUMNS} FROM items i ${BROWSE_JOINS}
    WHERE ${sql} ORDER BY ${order} LIMIT :limit OFFSET :offset`).all(params);
  const live = req.query.type === 'live';
  const onNow = live ? currentProgrammes(rows) : null;
  const upNext = live && req.query.next === '1' ? nextProgrammes(rows) : null;
  res.json({
    items: rows.map((r) => {
      const out = dto(r, onNow);
      if (upNext) out.next = upNext.get(`${r.source_id}|${r.epg_id}`) ?? null;
      return out;
    }),
    more: rows.length === params.limit,
  });
});

/** Het programma dat hierna komt, per zender (voor de tegelweergave bij Live). */
function nextProgrammes(rows) {
  const found = new Map();
  const time = now();
  const query = db.prepare(`SELECT title, start FROM programmes WHERE source_id = ? AND epg_id = ? AND start > ? ORDER BY start LIMIT 1`);
  for (const r of rows) {
    if (!r.epg_id || found.has(`${r.source_id}|${r.epg_id}`)) continue;
    const p = query.get(r.source_id, r.epg_id, time);
    if (p) found.set(`${r.source_id}|${r.epg_id}`, { title: p.title, start: p.start });
  }
  return found;
}

app.get('/api/groups', requireUser, (req, res) => {
  const type = TYPES.has(req.query.type) ? req.query.type : 'live';
  const hidden = new Set(hiddenGroups(req.user.id, type));
  const groups = groupsByType(type).filter((g) => !hidden.has(g.name));
  const { country } = req.query;
  if (country) {
    const names = new Set(groupsOfCountry(groups, String(country)));
    return res.json(groups.filter((g) => names.has(g.name)).map((g) => ({ ...g, label: withoutCountry(g.name) })));
  }
  res.json(firstCountryOnTop(groups));
});

// ---- Nieuwe releases en aanbevelingen bij Films en Series
app.get('/api/highlights', requireUser, (req, res) => {
  const type = req.query.type === 'series' ? 'series' : 'movie';
  const thisYear = new Date().getFullYear();
  // Elke zoekopdracht krijgt alleen de waarden die hij gebruikt; node:sqlite weigert overbodige.
  const base = { user: req.user.id, type, maxYear: String(thisYear) };
  // Zonder landkeuze één kaart per titel (de Nederlandse of Engelse versie).
  const hidden = hiddenGroups(req.user.id, type);
  const countryNames = req.query.country ? groupsOfCountry(groupsByType(type), String(req.query.country)) : [];
  const countrySql = countryNames.length
    ? `AND i.grp IN (${namedList(base, 'c', countryNames)})`
    : `AND ${primarySql(base, type, hidden)}`;
  const hiddenSql = hidden.length ? ` AND i.grp NOT IN (${namedList(base, 'h', hidden)})` : '';
  const hasYear = `i.year GLOB '[0-9][0-9][0-9][0-9]' AND i.year <= :maxYear`;

  // Nieuw op releasejaar, niet op wanneer de provider het toevoegde. Met beoordeling eerst,
  // want titels zonder beoordeling zijn vaak nog niet echt uit of van twijfelachtige kwaliteit.
  const fresh = db.prepare(`SELECT ${BROWSE_COLUMNS} FROM items i ${BROWSE_JOINS}
    WHERE i.type = :type ${countrySql}${hiddenSql} AND ${hasYear} AND i.year >= :freshFrom
    ORDER BY i.year DESC, (CAST(i.rating AS REAL) > 0) DESC, i.sort LIMIT 45`).all({ ...base, freshFrom: String(thisYear - 1) });

  // Categorieën die je kijkt of als favoriet hebt; die gaan voor in de aanbevelingen.
  const mine = db.prepare(`SELECT DISTINCT COALESCE(s.grp, i.grp) AS grp FROM
      (SELECT item_id FROM progress WHERE user_id = ? UNION SELECT item_id FROM favorites WHERE user_id = ?) h
    JOIN items i ON i.id = h.item_id LEFT JOIN items s ON s.id = i.parent_id
    WHERE COALESCE(s.type, i.type) = ?`).all(req.user.id, req.user.id, type).map((r) => r.grp);
  const params = { ...base, recommendFrom: String(thisYear - 4) };
  const prefer = mine.length ? `(i.grp IN (${namedList(params, 'm', mine)})) DESC,` : '';
  const notStarted = type === 'series'
    ? `NOT EXISTS (SELECT 1 FROM progress pp JOIN items e ON e.id = pp.item_id WHERE pp.user_id = :user AND e.parent_id = i.id)`
    : 'p.item_id IS NULL';
  const freshIds = new Set(fresh.map((r) => r.id));
  // Een 10 is bij providers vaak een titel met een handvol stemmen; tot 9,5 is betrouwbaarder.
  const recommended = db.prepare(`SELECT ${BROWSE_COLUMNS} FROM items i ${BROWSE_JOINS}
    WHERE i.type = :type ${countrySql}${hiddenSql} AND ${hasYear} AND i.year >= :recommendFrom
      AND CAST(i.rating AS REAL) BETWEEN 7 AND 9.5 AND f.user_id IS NULL AND ${notStarted}
    ORDER BY ${prefer} CAST(i.rating AS REAL) DESC, i.year DESC LIMIT 60`).all(params)
    .filter((r) => !freshIds.has(r.id));

  // Providers zetten sportuitzendingen soms tussen de films. Die horen niet in deze secties.
  const EVENT = /\b(AEW|WWE|UFC|TNA|NJPW|ROH|PPV|Satfeed|Pay[- ]?Per[- ]?View)\b/i;
  const pick = (rows) => rows.filter((r) => !EVENT.test(r.name)).slice(0, 30).map((r) => dto(r));
  res.json({ fresh: pick(fresh), recommended: pick(recommended), personal: mine.length > 0 });
});

app.get('/api/countries', requireUser, (req, res) => {
  const type = TYPES.has(req.query.type) ? req.query.type : 'live';
  const hidden = new Set(hiddenGroups(req.user.id, type));
  res.json(countryList(groupsByType(type).filter((g) => !hidden.has(g.name)), { englishSecond: type !== 'live' }));
});

// ---- Verbergen: per account landen of categorieën uitzetten
app.get('/api/hidden', requireUser, (req, res) => {
  const rows = hiddenRows(req.user.id);
  const all = ['live', 'movie', 'series'].flatMap((type) => groupsByType(type));
  res.json({
    countries: countryList(all, { englishSecond: true }).filter((c) => c.code !== FIRST_COUNTRY),
    hiddenCountries: rows.filter((r) => r.kind === 'country').map((r) => r.value),
    hiddenGroups: rows.filter((r) => r.kind === 'group').map((r) => r.value),
  });
});

/** Categorieën zoeken om te verbergen (over alle soorten heen). */
app.get('/api/hidden/groups', requireUser, (req, res) => {
  const q = normalize(String(req.query.q ?? '')).trim();
  if (q.length < 2) return res.json([]);
  const rows = db.prepare(`SELECT grp AS name, type, COUNT(*) AS count FROM items
    WHERE type <> 'episode' AND lower(grp) LIKE ? ESCAPE '\\' GROUP BY grp, type ORDER BY grp LIMIT 60`)
    .all(`%${q.replace(/[\\%_]/g, '\\$&')}%`);
  res.json(rows);
});

app.post('/api/hidden', requireUser, (req, res) => {
  const { kind, value, hidden } = req.body ?? {};
  if (!['country', 'group'].includes(kind) || typeof value !== 'string' || !value || value.length > 200) {
    return res.status(400).json({ error: 'Ongeldige keuze.' });
  }
  if (hidden) db.prepare('INSERT OR IGNORE INTO user_hidden (user_id, kind, value) VALUES (?, ?, ?)').run(req.user.id, kind, value);
  else db.prepare('DELETE FROM user_hidden WHERE user_id = ? AND kind = ? AND value = ?').run(req.user.id, kind, value);
  res.json({ ok: true });
});

// Wanneer iets als uitgekeken telt: de aftiteling hoeft niemand af te kijken.
const WATCHED = 0.92;
const isWatched = (position, duration) => duration > 60 && position >= duration * WATCHED;

// Volgorde van afleveringen binnen een serie: eerst seizoen, dan aflevering.
const EPISODE_KEY = '(COALESCE(season, 0) * 10000 + COALESCE(episode, 0))';
const episodeKey = (item) => (item.season ?? 0) * 10000 + (item.episode ?? 0);

/** Wie verder kijkt in een serie, is klaar met de afleveringen daarvoor. */
function clearEarlierEpisodes(userId, item) {
  db.prepare(`DELETE FROM progress WHERE user_id = ? AND item_id IN
    (SELECT id FROM items WHERE parent_id = ? AND ${EPISODE_KEY} < ?)`).run(userId, item.parent_id, episodeKey(item));
}

/** Na een uitgekeken aflevering staat de volgende klaar in "Verder kijken", vanaf het begin. */
function queueNextEpisode(userId, item) {
  const next = db.prepare(`SELECT id FROM items WHERE parent_id = ? AND ${EPISODE_KEY} > ?
    ORDER BY ${EPISODE_KEY}, sort LIMIT 1`).get(item.parent_id, episodeKey(item));
  if (!next) return;
  db.prepare('INSERT OR IGNORE INTO progress (user_id, item_id, position, duration, updated_at) VALUES (?, ?, 0, 0, ?)')
    .run(userId, next.id, now());
}

app.get('/api/continue', requireUser, (req, res) => {
  const rows = db.prepare(`SELECT ${BROWSE_COLUMNS}, s.name AS series_name, s.logo AS series_logo FROM progress p2
    JOIN items i ON i.id = p2.item_id ${BROWSE_JOINS}
    LEFT JOIN items s ON s.id = i.parent_id
    WHERE p2.user_id = :user AND NOT (p2.duration > 60 AND p2.position >= p2.duration * ${WATCHED})
    ORDER BY p2.updated_at DESC LIMIT 200`).all({ user: req.user.id });
  // Per serie alleen de aflevering waar je het laatst mee bezig was.
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    const key = row.parent_id ? `serie-${row.parent_id}` : `item-${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const item = dto(row);
    if (row.parent_id) {
      item.seriesName = row.series_name ?? undefined;
      if (row.series_logo) item.logo = `/api/img/${row.parent_id}`;
    }
    result.push(item);
    if (result.length >= 20) break;
  }
  res.json(result);
});

app.get('/api/items/:id', requireUser, async (req, res) => {
  const params = { user: req.user.id, id: Number(req.params.id) };
  const find = () => db.prepare(`SELECT ${BROWSE_COLUMNS} FROM items i ${BROWSE_JOINS} WHERE i.id = :id`).get(params);
  let row = find();
  if (!row) return res.status(404).json({ error: 'Niet gevonden.' });
  const result = {};
  if (row.type === 'series') {
    try {
      await loadEpisodes(row);
    } catch {
      result.episodeError = 'De afleveringen konden niet worden opgehaald.';
    }
    row = find();
    result.episodes = db.prepare(`SELECT ${BROWSE_COLUMNS} FROM items i ${BROWSE_JOINS}
      WHERE i.parent_id = :id ORDER BY i.season, i.episode`).all(params).map((r) => dto(r));
  }
  if (row.type === 'live' && row.epg_id) {
    result.programmes = db.prepare(`SELECT title, descr, start, stop FROM programmes
      WHERE source_id = ? AND epg_id = ? AND stop > ? ORDER BY start LIMIT 24`).all(row.source_id, row.epg_id, now());
  }
  // Andere talen van dezelfde titel, om uit te kiezen.
  if ((row.type === 'movie' || row.type === 'series') && row.title_key) {
    result.versions = db.prepare(`SELECT id, grp, year, name FROM items WHERE type = ? AND title_key = ?
      ORDER BY lang_rank, sort LIMIT 40`).all(row.type, row.title_key).map((v) => ({
      id: v.id, year: v.year || undefined, current: v.id === row.id,
      country: countryOf(v.grp), language: countryLabel(countryOf(v.grp)), group: withoutCountry(v.grp),
    }));
  }
  res.json({ ...dto(row), ...result });
});

/** Achtergrondbeeld van een film: bij de eerste keer even bij de provider opvragen. */
app.get('/api/items/:id/backdrop', requireUser, async (req, res) => {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'Niet gevonden.' });
  try {
    await loadBackdrop(item);
  } catch { /* geen achtergrond is ook goed */ }
  const backdrop = db.prepare('SELECT backdrop FROM items WHERE id = ?').get(item.id).backdrop;
  res.json({ backdrop: backdrop && backdrop !== '-' ? `/api/backdrop/${item.id}` : null });
});
app.get('/api/backdrop/:id', requireUser, serveBackdrop);

app.get('/api/guide', requireUser, (req, res) => {
  const { sql, params } = browseFilter(req, 'live');
  params.limit = 40;
  params.offset = clampInt(req.query.offset, 0, 10_000_000, 0);
  const order = browseOrder('live', req, params);
  const rows = db.prepare(`SELECT ${BROWSE_COLUMNS} FROM items i ${BROWSE_JOINS}
    WHERE ${sql} ORDER BY ${order} LIMIT :limit OFFSET :offset`).all(params);
  const from = clampInt(req.query.from, 0, Number.MAX_SAFE_INTEGER, now());
  const to = from + clampInt(req.query.hours, 1, 30, 6) * 3600 * 1000;
  const query = db.prepare(`SELECT title, start, stop FROM programmes
    WHERE source_id = ? AND epg_id = ? AND stop > ? AND start < ? ORDER BY start`);
  const archive = db.prepare('SELECT archive_days FROM items WHERE id = ?');
  res.json({
    from,
    to,
    more: rows.length === params.limit,
    channels: rows.map((r) => ({
      ...dto(r),
      archiveDays: archive.get(r.id)?.archive_days || undefined,
      programmes: r.epg_id ? query.all(r.source_id, r.epg_id, from, to) : [],
    })),
  });
});

app.post('/api/favorites/:id', requireUser, (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM items WHERE id = ?').get(id)) return res.status(404).json({ error: 'Niet gevonden.' });
  db.prepare('INSERT OR IGNORE INTO favorites (user_id, item_id, created_at) VALUES (?, ?, ?)').run(req.user.id, id, now());
  res.json({ fav: true });
});

app.delete('/api/favorites/:id', requireUser, (req, res) => {
  db.prepare('DELETE FROM favorites WHERE user_id = ? AND item_id = ?').run(req.user.id, Number(req.params.id));
  res.json({ fav: false });
});

app.post('/api/progress/:id', requireUser, (req, res) => {
  const id = Number(req.params.id);
  const { position, duration, finished } = req.body ?? {};
  const item = db.prepare('SELECT id, parent_id, season, episode FROM items WHERE id = ?').get(id);
  if (finished || isWatched(Number(position), Number(duration))) {
    db.prepare('DELETE FROM progress WHERE user_id = ? AND item_id = ?').run(req.user.id, id);
    if (item?.parent_id) {
      clearEarlierEpisodes(req.user.id, item);
      queueNextEpisode(req.user.id, item);
    }
    return res.json({ ok: true });
  }
  if (item?.parent_id) clearEarlierEpisodes(req.user.id, item);
  if (!Number.isFinite(position) || position < 0) return res.status(400).json({ error: 'Ongeldige positie.' });
  if (!db.prepare(`SELECT 1 FROM items WHERE id = ? AND type IN ('movie', 'episode')`).get(id)) {
    return res.status(404).json({ error: 'Niet gevonden.' });
  }
  db.prepare(`INSERT INTO progress (user_id, item_id, position, duration, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (user_id, item_id) DO UPDATE SET position = excluded.position, duration = excluded.duration, updated_at = excluded.updated_at`)
    .run(req.user.id, id, position, Number.isFinite(duration) ? duration : 0, now());
  res.json({ ok: true });
});

// Handmatig uit "Verder kijken" halen. Bij een aflevering gaat de hele serie eruit.
app.delete('/api/progress/:id', requireUser, (req, res) => {
  const item = db.prepare('SELECT id, parent_id FROM items WHERE id = ?').get(Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'Niet gevonden.' });
  if (item.parent_id) {
    db.prepare('DELETE FROM progress WHERE user_id = ? AND item_id IN (SELECT id FROM items WHERE parent_id = ?)')
      .run(req.user.id, item.parent_id);
  } else {
    db.prepare('DELETE FROM progress WHERE user_id = ? AND item_id = ?').run(req.user.id, item.id);
  }
  res.json({ ok: true });
});

// ---- Afspelen
const validCid = (cid) => typeof cid === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(cid);

app.post('/api/play/:id', requireUser, async (req, res) => {
  const { mode = 'auto', cid, start = 0, native = false } = req.body ?? {};
  if (!['auto', 'remux', 'transcode'].includes(mode) || !validCid(cid)) {
    return res.status(400).json({ error: 'Ongeldig verzoek.' });
  }
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'Niet gevonden.' });
  try {
    const started = await startPlayback(item, { mode, cid, start: Number(start) || 0, native: native === true });
    plays.set(cid, { user: req.user.username, device: deviceName(req), itemId: item.id, at: Date.now() });
    res.json(started);
  } catch (err) {
    if (err.name === 'AbortError') return res.status(499).end();
    if (!(err instanceof UpstreamError)) console.error(`Afspelen mislukt: ${err.code ?? err.name}`);
    res.status(502).json({ error: err instanceof UpstreamError ? err.message : 'De stream is nu niet bereikbaar.' });
  }
});

/**
 * Terugkijken: een uitzending die al (deels) voorbij is, afspelen als een film. `offset` (seconden)
 * om verder te kijken; dat gaat in hele minuten via de begintijd bij de provider.
 */
app.post('/api/catchup/:id', requireUser, async (req, res) => {
  const { cid, start, stop, offset = 0, mode = 'remux' } = req.body ?? {};
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(Number(req.params.id));
  if (!item || item.type !== 'live') return res.status(404).json({ error: 'Niet gevonden.' });
  if (!validCid(cid) || !Number.isFinite(start) || !Number.isFinite(stop) || stop <= start) return res.status(400).json({ error: 'Ongeldig verzoek.' });
  if (!item.archive_days) return res.status(400).json({ error: 'Bij deze zender kun je niet terugkijken.' });
  const current = now();
  if (start > current) return res.status(400).json({ error: 'Deze uitzending is nog niet begonnen.' });
  // Een paar uur speling: providers ronden het archief per dag af.
  if (start < current - item.archive_days * 86400000 - 3 * 3600000) {
    return res.status(400).json({ error: `Deze uitzending is te oud: je provider bewaart ${item.archive_days} dag${item.archive_days === 1 ? '' : 'en'}.` });
  }
  const skip = Math.floor(clampInt(offset, 0, 24 * 3600, 0) / 60);
  const from = start + skip * 60000;
  const minutes = (Math.min(stop, current) - from) / 60000;
  if (minutes < 1) return res.status(400).json({ error: 'Je hebt deze uitzending al helemaal gezien.' });
  const url = catchupUrl(item, from, minutes);
  if (!url) return res.status(400).json({ error: 'Bij deze bron kun je niet terugkijken.' });
  try {
    const started = await startPlayback({ ...item, type: 'catchup', url, catchupKey: `${from}-${minutes}` },
      { mode: mode === 'transcode' ? 'transcode' : 'remux', cid, start: 0, native: false });
    plays.set(cid, { user: req.user.username, device: deviceName(req), itemId: item.id, at: Date.now() });
    res.json({ ...started, base: skip * 60 });
  } catch (err) {
    if (err.name === 'AbortError') return res.status(499).end();
    res.status(502).json({ error: err instanceof UpstreamError ? err.message : 'De uitzending is nu niet bereikbaar.' });
  }
});

// Fouten in de speler gebeuren op het apparaat zelf. Zo komen ze toch in het logboek terecht.
const logText = (value, max) => String(value ?? '-').replace(/https?:\/\/\S+/g, '[link]').replace(/[^\x20-\x7e]/g, '?').slice(0, max);

app.post('/api/play-error', requireUser, (req, res) => {
  const { itemId, mode, code, message, native } = req.body ?? {};
  const device = /iPhone|iPad|Android|Windows|Macintosh/.exec(req.get('user-agent') ?? '')?.[0] ?? 'onbekend';
  console.error(`Afspeelfout op apparaat: item ${Number(itemId)}, modus ${logText(mode, 12)}, ${device}, ${native ? 'ingebouwde speler' : 'hls.js'}, code ${logText(code, 40)}: ${logText(message, 200)}`);
  res.json({ ok: true });
});

app.post('/api/play-release', requireUser, (req, res) => {
  if (validCid(req.body?.cid)) {
    releaseViewer(req.body.cid);
    plays.delete(req.body.cid);
  }
  res.json({ ok: true });
});

// ---- Status voor de beheerder: wie kijkt wat, hoe druk de server is, wat de provider telt

const plays = new Map(); // browsertab -> { user, device, itemId, at }

function deviceName(req) {
  const ua = req.get('user-agent') ?? '';
  if (/KijkboxTV/.test(ua)) return 'TV-app';
  return /iPhone|iPad|Android|Windows|Macintosh|Linux/.exec(ua)?.[0]?.replace('Macintosh', 'Mac') ?? 'onbekend';
}

/** Wat er nu speelt en wie er kijkt. */
function playingNow() {
  return playbackStatus().map((p) => {
    // Bij doorgegeven streams weet de server niet welk tabblad kijkt, alleen welk item.
    const who = p.cids
      ? p.cids.map((cid) => plays.get(cid)).filter(Boolean)
      : [...plays.values()].filter((play) => play.itemId === p.itemId);
    const seen = new Set();
    const watchers = who.filter((w) => !seen.has(`${w.user}|${w.device}`) && seen.add(`${w.user}|${w.device}`))
      .map(({ user, device }) => ({ user, device }));
    return { name: p.name, type: p.type, mode: p.mode, since: p.since, provider: p.provider, failed: p.failed, watchers };
  });
}

let cpuBefore = null;
/** Hoe druk de processor het had sinds de vorige vraag (in procenten). */
function cpuPercent() {
  const now = os.cpus().reduce((sum, c) => {
    const total = Object.values(c.times).reduce((a, b) => a + b, 0);
    return { idle: sum.idle + c.times.idle, total: sum.total + total };
  }, { idle: 0, total: 0 });
  const before = cpuBefore;
  cpuBefore = now;
  if (!before || now.total <= before.total) return null;
  return Math.round(100 * (1 - (now.idle - before.idle) / (now.total - before.total)));
}

app.get('/api/status', requireAdmin, async (req, res) => {
  const now = Date.now();
  for (const [cid, play] of plays) if (now - play.at > 12 * 3600 * 1000) plays.delete(cid);
  const playing = playingNow();
  let disk = null;
  try {
    const st = fs.statfsSync(config.dataDir);
    disk = { total: st.blocks * st.bsize, free: st.bavail * st.bsize };
  } catch { /* niet overal beschikbaar */ }
  res.set('Cache-Control', 'no-store').json({
    version: config.version,
    uptime: Math.round(process.uptime()),
    system: {
      cpu: cpuPercent(), cores: os.cpus().length, load: os.loadavg(),
      memTotal: os.totalmem(), memFree: os.freemem(), memKijkbox: process.memoryUsage().rss, disk,
    },
    playing,
    providers: await providerStatus(),
  });
});

app.get('/api/img/:id', requireUser, serveLogo);

const media = (handler) => async (req, res) => {
  res.set('Content-Security-Policy', 'sandbox');
  try {
    await handler(req, res);
  } catch (err) {
    if (err.name === 'AbortError' || res.headersSent) return res.destroy();
    res.status(502).json({ error: 'De stream is nu niet bereikbaar.' });
  }
};
app.get('/s/m/:token', requireUser, media(serveManifest));
app.get('/s/g/:token', requireUser, media(servePassthrough));
app.get('/s/t/:sid/:cid/subs', requireUser, serveSubtitleList);
app.get('/s/t/:sid/:cid/subs/:n', requireUser, serveSubtitleCues);
app.get('/s/t/:sid/:cid/:file', requireUser, serveFfmpegFile);

// ---- Website
app.get('/vendor/hls.min.js', (req, res) => {
  res.sendFile(path.join(rootDir, 'node_modules', 'hls.js', 'dist', 'hls.min.js'), { maxAge: '7d' });
});
// De startpagina noemt app.js en styles.css met het versienummer erachter. Zo krijgt elke versie
// eigen adressen en kan geen enkele cache (browser, tv-app, reverse proxy, Cloudflare) na een
// update nog de oude code geven. De startpagina zelf wordt nooit bewaard.
const indexHtml = fs.readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8')
  .replace(/(href|src)="\/(app\.js|styles\.css)"/g, (_, attr, file) => `${attr}="/${file}?v=${config.version}"`)
  .replace('<head>', `<head>\n  <meta name="kijkbox-version" content="${config.version}">`);
const sendIndex = (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'CDN-Cache-Control': 'no-store', 'Surrogate-Control': 'no-store' }).type('html').send(indexHtml);
};
app.get(['/', '/index.html'], sendIndex);
app.use(express.static(path.join(rootDir, 'public'), {
  index: false,
  setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
}));
app.use('/api', (req, res) => res.status(404).json({ error: 'Niet gevonden.' }));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Dit bestand is te groot.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Ongeldig verzoek.' });
  console.error(`Serverfout: ${err.code ?? err.name}`);
  res.status(500).json({ error: 'Er ging iets mis op de server.' });
});

// ---- Nachtelijk onderhoud: elke nacht om config.refreshHour worden playlists en tv-gids bijgewerkt.
// Elke 10 minuten wordt gekeken of het moment voorbij is; een gemiste nacht wordt ingehaald.
// Mislukt het, dan volgt hooguit één nieuwe poging per uur.
const lastAttempt = new Map();
let maintaining = false;
function shouldTry(key, last) {
  if (!isDue(last, now(), config.refreshHour)) return false;
  if (now() - (lastAttempt.get(key) ?? 0) < 3600 * 1000) return false;
  lastAttempt.set(key, now());
  return true;
}
async function maintenance() {
  if (maintaining) return;
  maintaining = true;
  try {
    pruneSessions();
    // Elke nacht om 03:00 een back-up (of meteen, als er nog geen recente is).
    if (hasUsers() && isDue(listBackups()[0]?.at ?? 0, now(), 3)) {
      try {
        createBackup('dagelijks');
      } catch (err) {
        console.error(`Back-up mislukt: ${err.message}`);
      }
    }
    const sources = db.prepare('SELECT id, last_refresh, last_epg_refresh, type FROM sources').all();
    for (const s of sources) {
      if (s.type !== 'm3u_text' && shouldTry(`list${s.id}`, s.last_refresh)) {
        console.log(`Nachtelijke update: playlist van bron ${s.id}`);
        await refreshSource(s.id).catch(() => {});
      }
      if (shouldTry(`epg${s.id}`, s.last_epg_refresh)) await refreshEpg(s.id).catch(() => {});
    }
  } finally {
    maintaining = false;
  }
}
setTimeout(maintenance, 30 * 1000).unref();
setInterval(maintenance, 10 * 60 * 1000).unref();

const server = app.listen(config.port, config.host, () => {
  const lan = Object.values(os.networkInterfaces()).flat()
    .filter((net) => net.family === 'IPv4' && !net.internal).map((net) => net.address);
  console.log(`\n  Kijkbox ${config.version} draait.`);
  console.log(`  Op deze computer:  http://localhost:${config.port}`);
  for (const ip of lan) console.log(`  Op je thuisnetwerk: http://${ip}:${config.port}`);
  if (!hasUsers()) console.log(`\n  Installatiecode voor het eerste account:  ${setupCode}`);
  console.log('');
});

// Eén onverwachte fout mag de streams van iedereen niet stoppen.
process.on('uncaughtException', (err) => console.error(`Onverwachte fout: ${err.code ?? err.name}: ${err.message.replace(/https?:\/\/\S+/g, '[link]')}`));
process.on('unhandledRejection', (err) => console.error(`Onverwachte fout: ${err?.code ?? err?.name ?? err}`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopAllSessions();
    stopDownloads();
    server.close();
    process.exit(0);
  });
}

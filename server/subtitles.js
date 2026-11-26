// Ondertitels via OpenSubtitles (opensubtitles.com). De beheerder vult zelf een API-sleutel in,
// en eventueel een account voor meer downloads per dag. Een gedownloade ondertitel wordt bewaard,
// zodat opnieuw kijken geen download meer kost.
import fs from 'node:fs';
import path from 'node:path';
import { seal, unseal } from './auth.js';
import { config } from './config.js';
import { db } from './db.js';
import { releaseYear } from './years.js';
import { tmdbIds } from './sources.js';

// OPENSUBTITLES_API is er alleen om tegen een nagebootste server te testen.
const API = process.env.OPENSUBTITLES_API || 'https://api.opensubtitles.com/api/v1';
// OpenSubtitles eist een herkenbare naam met versie.
const APP = 'Kijkbox v1.0';
export const LANGS = { nl: 'Nederlands', en: 'Engels' };

const cacheDir = path.join(config.dataDir, 'subtitles');
fs.mkdirSync(cacheDir, { recursive: true });

// ---- Instellingen (wachtwoord versleuteld opgeslagen)

const readSetting = () => {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'opensubtitles'`).get();
  try { return row ? JSON.parse(row.value) : {}; } catch { return {}; }
};

export function subtitleSettings() {
  const s = readSetting();
  return { configured: Boolean(s.apiKey), username: s.username ?? '', hasPassword: Boolean(s.password), remaining: s.remaining ?? null };
}

/** Slaat de gegevens op en controleert ze meteen. Lege velden laten de oude waarde staan. */
export async function saveSubtitleSettings({ apiKey, username, password, clear }) {
  if (clear) {
    db.prepare(`DELETE FROM settings WHERE key = 'opensubtitles'`).run();
    session = null;
    return subtitleSettings();
  }
  const old = readSetting();
  const next = {
    apiKey: typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim().slice(0, 200) : old.apiKey,
    username: typeof username === 'string' ? username.trim().slice(0, 100) : old.username ?? '',
    password: typeof password === 'string' && password ? seal({ p: password.slice(0, 200) }) : old.password,
  };
  if (!next.username) next.password = undefined;
  if (!next.apiKey) throw new SubtitleError('Vul de API-sleutel van OpenSubtitles in.');
  // Eerst proberen, pas daarna opslaan: een tikfout moet je meteen zien.
  const probe = await connect(next, true);
  next.remaining = probe.remaining ?? null;
  db.prepare(`INSERT INTO settings (key, value) VALUES ('opensubtitles', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(next));
  return subtitleSettings();
}

export class SubtitleError extends Error {}

// ---- Verbinding met OpenSubtitles

let session = null; // { token, base, at }

async function call(base, pathname, { method = 'GET', body, apiKey, token } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      'Api-Key': apiKey, 'User-Agent': APP, Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new SubtitleError(data.message || data.errors?.[0] || `OpenSubtitles antwoordde met ${res.status}.`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Logt in (als er een account is) en geeft het adres en token om mee verder te werken. */
async function connect(settings = readSetting(), test = false) {
  if (!settings.apiKey) throw new SubtitleError('Ondertitels zijn nog niet ingesteld. Een beheerder kan dat doen bij Instellingen.');
  if (!test && session && Date.now() - session.at < 20 * 3600 * 1000) return session;
  const password = settings.password && unseal(settings.password)?.p;
  if (settings.username && password) {
    try {
      const data = await call(API, '/login', { method: 'POST', body: { username: settings.username, password }, apiKey: settings.apiKey });
      const base = data.base_url ? `https://${String(data.base_url).replace(/^https?:\/\//, '')}/api/v1` : API;
      session = { token: data.token, base, at: Date.now(), remaining: data.user?.allowed_downloads ?? null };
      return session;
    } catch (err) {
      if (err.status === 401) throw new SubtitleError('OpenSubtitles weigert deze gebruikersnaam of dit wachtwoord.');
      if (err.status === 403) throw new SubtitleError('OpenSubtitles weigert deze API-sleutel.');
      throw err;
    }
  }
  // Zonder account: alleen de sleutel controleren.
  if (test) {
    try {
      await call(API, '/infos/languages', { apiKey: settings.apiKey });
    } catch (err) {
      if (err.status === 401 || err.status === 403) throw new SubtitleError('OpenSubtitles weigert deze API-sleutel.');
      throw err;
    }
  }
  session = { token: null, base: API, at: Date.now(), remaining: null };
  return session;
}

// ---- Zoeken en kiezen

export const cleanTitle = (name) => String(name)
  .replace(/^\s*(?:[┃|[(][^┃|\])]{1,20}[┃|\])]|[A-Z0-9][A-Z0-9 |-]{1,14}┃)\s*/u, '')
  .replace(/\(\s*\d{4}\s*\)|\b(19|20)\d{2}\b|\b(4K|HEVC|x265|FHD|UHD|HD|SD|MULTI|DUBB?|VOST\w*)\b/gi, '')
  .replace(/\s+-\s*$/, '')
  .replace(/\s{2,}/g, ' ')
  .trim();

/** OpenSubtitles wil de zoekvelden op alfabet en in kleine letters, anders volgt een omleiding. */
export const queryString = (params) => Object.keys(params).filter((k) => params[k] !== '' && params[k] != null).sort()
  .map((k) => `${k}=${encodeURIComponent(String(params[k]).toLowerCase())}`).join('&');

async function searchParams(item) {
  let ids = {};
  try { ids = await tmdbIds(item); } catch { /* zonder nummer zoeken we op naam */ }
  if (item.type === 'episode') {
    const series = db.prepare('SELECT name, year FROM items WHERE id = ?').get(item.parent_id);
    const where = { season_number: item.season ?? 1, episode_number: item.episode ?? 1 };
    return ids.parentTmdb
      ? { ...where, parent_tmdb_id: ids.parentTmdb }
      : { ...where, query: cleanTitle(series?.name ?? ''), type: 'episode' };
  }
  if (ids.tmdb) return { tmdb_id: ids.tmdb };
  return { query: cleanTitle(item.name), type: 'movie', year: item.year || releaseYear(item.name) || '' };
}

/** De beste versie: geen machinevertaling, betrouwbare uploader, veel gedownload. */
function best(results, lang) {
  const score = (a) => (a.machine_translated || a.ai_translated ? -1e6 : 0) + (a.from_trusted ? 1e5 : 0)
    + (a.hearing_impaired ? -1e3 : 0) + Math.min(a.download_count ?? 0, 9e4);
  return results.map((r) => r.attributes).filter((a) => a?.language === lang && a.files?.length)
    .sort((a, b) => score(b) - score(a))[0] ?? null;
}

// ---- Omzetten naar losse ondertitelregels

function decode(buffer) {
  const utf8 = new TextDecoder('utf-8').decode(buffer);
  return utf8.includes('�') ? new TextDecoder('windows-1252').decode(buffer) : utf8;
}

const toSeconds = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;

/** Leest SRT of WebVTT en geeft [{ start, end, text }]. */
export function parseCues(text) {
  const cues = [];
  const blocks = text.replace(/^﻿/, '').replace(/\r/g, '').split(/\n{2,}/);
  const time = /(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/;
  for (const block of blocks) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => time.test(l));
    if (at < 0) continue;
    const m = time.exec(lines[at]);
    const body = lines.slice(at + 1).join('\n')
      .replace(/<(?!\/?(i|b|u)>)[^>]*>/g, '') // alleen cursief/vet/onderstreept blijft
      .replace(/\{\\[^}]*\}/g, '')            // ASS-opmaak
      .trim();
    if (!body) continue;
    cues.push({ start: toSeconds(m[1] ?? 0, m[2], m[3], m[4]), end: toSeconds(m[5] ?? 0, m[6], m[7], m[8]), text: body });
  }
  return cues;
}

// ---- Ophalen (met bewaren)

const misses = new Map(); // `${id}-${lang}` -> tijdstip; niet steeds opnieuw zoeken

export async function subtitleCues(item, lang) {
  if (!LANGS[lang]) throw new SubtitleError('Onbekende taal.');
  if (item.type !== 'movie' && item.type !== 'episode') throw new SubtitleError('Ondertitels zijn er alleen bij films en afleveringen.');
  const file = path.join(cacheDir, `${item.id}-${lang}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const key = `${item.id}-${lang}`;
  if (Date.now() - (misses.get(key) ?? 0) < 6 * 3600 * 1000) throw notFound(lang);

  const settings = readSetting();
  let conn = await connect(settings);
  const params = await searchParams(item);
  const found = await call(conn.base, `/subtitles?${queryString({ ...params, languages: 'en,nl' })}`, { apiKey: settings.apiKey, token: conn.token });
  const pick = best(found.data ?? [], lang);
  if (!pick) {
    misses.set(key, Date.now());
    throw notFound(lang);
  }

  let link;
  try {
    link = await call(conn.base, '/download', { method: 'POST', body: { file_id: pick.files[0].file_id }, apiKey: settings.apiKey, token: conn.token });
  } catch (err) {
    if (err.status === 401 && conn.token) { // token verlopen: één keer opnieuw inloggen
      session = null;
      conn = await connect(settings);
      link = await call(conn.base, '/download', { method: 'POST', body: { file_id: pick.files[0].file_id }, apiKey: settings.apiKey, token: conn.token });
    } else if (err.status === 406 || /quota|limit|allowed/i.test(err.message)) {
      throw new SubtitleError('Het maximum aantal ondertiteldownloads voor vandaag is bereikt. Morgen kan het weer.');
    } else throw err;
  }
  if (!link?.link) throw new SubtitleError(link?.message || 'OpenSubtitles gaf geen downloadlink.');
  const res = await fetch(link.link, { headers: { 'User-Agent': APP }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new SubtitleError(`Downloaden mislukte (${res.status}).`);
  const cues = parseCues(decode(Buffer.from(await res.arrayBuffer())));
  if (!cues.length) throw new SubtitleError('De gevonden ondertitel was leeg of onleesbaar.');

  const stored = readSetting();
  stored.remaining = link.remaining ?? stored.remaining ?? null;
  db.prepare(`UPDATE settings SET value = ? WHERE key = 'opensubtitles'`).run(JSON.stringify(stored));
  fs.writeFileSync(file, JSON.stringify(cues));
  return cues;
}

const notFound = (lang) => new SubtitleError(`Geen ${LANGS[lang].toLowerCase()}e ondertitels gevonden voor deze titel.`);

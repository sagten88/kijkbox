import crypto from 'node:crypto';
import readline from 'node:readline';
import { db, normalize, recomputeVariants } from './db.js';
import { langRank, titleKey } from './titles.js';

const rankCache = new Map();
import { releaseYear } from './years.js';
import { open, readText, UpstreamError } from './upstream.js';

const VIDEO_FILE = /\.(mp4|m4v|mkv|avi|mov|webm|wmv|flv|mpg|mpeg)$/i;
const EPISODE_NAME = /^(.*?)[\s._-]*\bS(\d{1,2})[\s._-]*E(\d{1,3})\b/i;
const MAX_XTREAM_JSON = 500 * 1024 * 1024;

const upsertItem = db.prepare(`
  INSERT INTO items (source_id, ext_key, type, name, name_lc, grp, logo, url, epg_id, parent_id, ext_id,
                     season, episode, plot, rating, year, user_agent, referer, sort, generation, title_key, lang_rank)
  VALUES (:source_id, :ext_key, :type, :name, :name_lc, :grp, :logo, :url, :epg_id, :parent_id, :ext_id,
          :season, :episode, :plot, :rating, :year, :user_agent, :referer, :sort, :generation, :title_key, :lang_rank)
  ON CONFLICT (source_id, ext_key) DO UPDATE SET
    title_key = excluded.title_key, lang_rank = excluded.lang_rank,
    type = excluded.type, name = excluded.name, name_lc = excluded.name_lc, grp = excluded.grp,
    logo = excluded.logo, url = excluded.url, epg_id = excluded.epg_id, parent_id = excluded.parent_id,
    ext_id = excluded.ext_id, season = excluded.season, episode = excluded.episode, plot = excluded.plot,
    rating = excluded.rating, year = excluded.year, user_agent = excluded.user_agent,
    referer = excluded.referer, sort = excluded.sort, generation = excluded.generation
  RETURNING id`);

/**
 * Schrijft in kleine stukken, zodat lopende streams niet haperen tijdens een grote import.
 * Elke transactie loopt van begin tot eind zonder await: de site heeft één databaseverbinding,
 * en een transactie die over een await heen open blijft, botst met andere imports.
 */
class ItemWriter {
  constructor(sourceId, generation) {
    this.sourceId = sourceId;
    this.generation = generation;
    this.count = 0;
    this.buffer = [];
  }

  toRow(item) {
    const name = String(item.name || 'Naamloos').trim().slice(0, 300);
    const row = {
      source_id: this.sourceId,
      ext_key: item.ext_key,
      type: item.type,
      name,
      name_lc: normalize(name),
      grp: String(item.grp || 'Overig').trim().slice(0, 200),
      logo: String(item.logo || ''),
      url: item.url || '',
      epg_id: String(item.epg_id || ''),
      parent_id: item.parent_id ?? null,
      ext_id: String(item.ext_id ?? ''),
      season: item.season ?? null,
      episode: item.episode ?? null,
      plot: String(item.plot || ''),
      rating: String(item.rating ?? ''),
      year: String(item.year ?? ''),
      user_agent: item.user_agent || '',
      referer: item.referer || '',
      sort: item.sort ?? this.count,
      generation: item.generation ?? this.generation,
      title_key: '',
      lang_rank: 2,
    };
    if (row.type === 'movie' || row.type === 'series') {
      row.title_key = titleKey(name);
      if (!rankCache.has(row.grp)) rankCache.set(row.grp, langRank(row.grp));
      row.lang_rank = rankCache.get(row.grp);
    }
    this.count += 1;
    return row;
  }

  /** Schrijft meteen en geeft het id terug, voor rijen waar andere rijen naar verwijzen. */
  addNow(item) {
    return upsertItem.get(this.toRow(item)).id;
  }

  async add(item) {
    this.buffer.push(this.toRow(item));
    if (this.buffer.length >= 1000) await this.flush();
  }

  async flush() {
    if (this.buffer.length) {
      db.exec('BEGIN');
      try {
        for (const row of this.buffer) upsertItem.get(row);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      this.buffer = [];
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// ---- M3U

export function parseExtinf(line) {
  const attrs = {};
  const body = line.slice(line.indexOf(':') + 1);
  for (const match of body.matchAll(/([a-zA-Z0-9_-]+)="([^"]*)"/g)) attrs[match[1].toLowerCase()] = match[2];
  const withoutAttrs = body.replace(/([a-zA-Z0-9_-]+)="[^"]*"/g, '');
  const comma = withoutAttrs.indexOf(',');
  return { attrs, title: comma >= 0 ? withoutAttrs.slice(comma + 1).trim() : '' };
}

export function classify(url, group, name) {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    /* onvolledige links worden hieronder geweigerd */
  }
  const episode = EPISODE_NAME.exec(name);
  if (/\/series\//i.test(path)) return episode ? 'episode' : 'movie';
  if (/\/movies?\//i.test(path)) return 'movie';
  if (VIDEO_FILE.test(path)) return episode ? 'episode' : 'movie';
  if (/^(vod|movies?|films?)\b/i.test(group)) return 'movie';
  return 'live';
}

/** Zet M3U-regels om in losse zenders, zonder het hele bestand in het geheugen te laden. */
export async function* parseM3U(lines) {
  let current = null;
  let group = '';
  let options = {};
  for await (const raw of lines) {
    const line = raw.replace(/^﻿/, '').trim();
    if (!line) continue;
    if (line.startsWith('#EXTM3U')) {
      const tvg = /(?:url-tvg|x-tvg-url)="([^"]+)"/i.exec(line);
      if (tvg) yield { header: true, epgUrl: tvg[1].split(',')[0].trim() };
    } else if (line.startsWith('#EXTINF')) {
      current = parseExtinf(line);
    } else if (line.startsWith('#EXTGRP:')) {
      group = line.slice(8).trim();
    } else if (line.startsWith('#EXTVLCOPT:')) {
      const [key, ...value] = line.slice(11).split('=');
      if (/http-user-agent/i.test(key)) options.user_agent = value.join('=');
      if (/http-referr?er/i.test(key)) options.referer = value.join('=');
    } else if (!line.startsWith('#')) {
      if (/^https?:\/\//i.test(line)) {
        const attrs = current?.attrs ?? {};
        const name = current?.title || attrs['tvg-name'] || line.split('/').pop();
        yield {
          name,
          url: line,
          grp: attrs['group-title'] || group,
          logo: attrs['tvg-logo'] || '',
          epg_id: attrs['tvg-id'] || '',
          ...options,
        };
      }
      current = null;
      group = '';
      options = {};
    }
  }
}

async function importM3U(source, writer) {
  let lines;
  let upstreamResponse = null;
  if (source.type === 'm3u_text') {
    lines = source.content.split(/\r?\n/);
  } else {
    const { res } = await open(source.url, { userAgent: source.user_agent, timeout: 60000 });
    if (res.statusCode !== 200) {
      res.resume();
      throw new UpstreamError(`De bron antwoordde met foutcode ${res.statusCode}.`);
    }
    upstreamResponse = res;
    lines = readline.createInterface({ input: res, crlfDelay: Infinity });
  }

  const seen = new Map();
  const parents = new Map();
  let epgUrl = '';
  for await (const entry of parseM3U(lines)) {
    if (entry.header) {
      epgUrl = entry.epgUrl;
      continue;
    }
    const base = `${entry.epg_id}|${entry.name}|${entry.grp}`;
    const copy = (seen.get(base) ?? 0) + 1;
    seen.set(base, copy);
    const ext_key = crypto.createHash('sha1').update(`${base}|${copy}`).digest('base64url');
    const type = classify(entry.url, entry.grp, entry.name);

    if (type === 'episode') {
      const [, title, season, episode] = EPISODE_NAME.exec(entry.name);
      const showName = title.trim() || entry.name;
      const parentKey = `series:${normalize(showName)}`;
      let parent_id = parents.get(parentKey);
      if (!parent_id) {
        parent_id = writer.addNow({ ext_key: parentKey, type: 'series', name: showName, grp: entry.grp, logo: entry.logo });
        parents.set(parentKey, parent_id);
      }
      await writer.add({ ...entry, ext_key, type, parent_id, season: Number(season), episode: Number(episode) });
    } else {
      await writer.add({ ...entry, ext_key, type, year: type === 'live' ? '' : releaseYear(entry.name) });
    }
  }
  upstreamResponse?.destroy();
  db.prepare('UPDATE sources SET detected_epg_url = ? WHERE id = ?').run(epgUrl, source.id);
}

// ---- Xtream Codes

export function xtreamBase(source) {
  return source.url.trim().replace(/\/+$/, '').replace(/\/(player_api|get)\.php.*$/i, '');
}

function xtreamAuth(source) {
  return `username=${encodeURIComponent(source.username)}&password=${encodeURIComponent(source.password)}`;
}

async function xtreamCall(source, action) {
  const suffix = action ? `&action=${action}` : '';
  const url = `${xtreamBase(source)}/player_api.php?${xtreamAuth(source)}${suffix}`;
  const { res } = await open(url, { userAgent: source.user_agent, timeout: 60000 });
  if (res.statusCode !== 200) {
    res.resume();
    throw new UpstreamError(`De provider antwoordde met foutcode ${res.statusCode}.`);
  }
  try {
    return JSON.parse(await readText(res, MAX_XTREAM_JSON));
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    throw new UpstreamError('De provider stuurde een onleesbaar antwoord.');
  }
}

const streamUrl = (source, kind, id, extension) => {
  const user = encodeURIComponent(source.username);
  const pass = encodeURIComponent(source.password);
  return `${xtreamBase(source)}/${kind}/${user}/${pass}/${id}.${extension}`;
};

const asList = (value) => (Array.isArray(value) ? value : []);

const KIND_LABELS = { live: 'zenders', movie: 'films', series: 'series' };

/**
 * Haalt een lijst op die niet leeg hoort te zijn. Sommige providers geven bij drukte een leeg
 * antwoord in plaats van een fout. Zonder deze controle verdwijnen dan stilletjes alle films.
 * Geeft null terug als het echt niet lukt.
 */
async function xtreamList(source, action) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const data = await xtreamCall(source, action);
      if (Array.isArray(data) && data.length) return data;
      console.error(`${action} poging ${attempt}: leeg antwoord (${Array.isArray(data) ? 'lege lijst' : typeof data})`);
    } catch (err) {
      console.error(`${action} poging ${attempt} mislukt: ${err.code ?? err.message}`);
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
  }
  return null;
}

async function importXtream(source, writer, problems) {
  const account = await xtreamCall(source);
  if (Number(account?.user_info?.auth) !== 1) {
    throw new UpstreamError('De provider weigert deze gebruikersnaam of dit wachtwoord.');
  }
  const info = account.user_info;
  db.prepare('UPDATE sources SET account_info = ? WHERE id = ?').run(JSON.stringify({
    status: info.status,
    expires: info.exp_date ? Number(info.exp_date) * 1000 : null,
    maxConnections: Number(info.max_connections) || null,
  }), source.id);

  const categories = async (action) => {
    const names = new Map();
    for (const c of asList(await xtreamCall(source, action))) names.set(String(c.category_id), c.category_name);
    return names;
  };

  // Zonder categorieën heeft de provider dit onderdeel niet; dan is een lege lijst geen fout.
  const fetchKind = async (kind, groups, action) => {
    if (!groups.size) return [];
    const list = await xtreamList(source, action);
    if (!list) problems.push(kind);
    return list ?? [];
  };

  const liveGroups = await categories('get_live_categories');
  const extension = source.stream_format === 'ts' ? 'ts' : 'm3u8';
  for (const s of await fetchKind('live', liveGroups, 'get_live_streams')) {
    await writer.add({
      ext_key: `live:${s.stream_id}`,
      ext_id: s.stream_id,
      type: 'live',
      name: s.name,
      grp: liveGroups.get(String(s.category_id)),
      logo: s.stream_icon,
      epg_id: s.epg_channel_id,
      url: streamUrl(source, 'live', s.stream_id, extension),
    });
  }

  const movieGroups = await categories('get_vod_categories');
  const movies = (await fetchKind('movie', movieGroups, 'get_vod_streams'))
    .sort((a, b) => Number(b.added ?? 0) - Number(a.added ?? 0));
  for (const s of movies) {
    await writer.add({
      ext_key: `movie:${s.stream_id}`,
      ext_id: s.stream_id,
      type: 'movie',
      name: s.name,
      grp: movieGroups.get(String(s.category_id)),
      logo: s.stream_icon,
      rating: s.rating,
      year: releaseYear(s.name),
      url: streamUrl(source, 'movie', s.stream_id, s.container_extension || 'mp4'),
    });
  }

  const seriesGroups = await categories('get_series_categories');
  const series = (await fetchKind('series', seriesGroups, 'get_series'))
    .sort((a, b) => Number(b.last_modified ?? 0) - Number(a.last_modified ?? 0));
  for (const s of series) {
    await writer.add({
      ext_key: `series:${s.series_id}`,
      ext_id: s.series_id,
      type: 'series',
      name: s.name,
      grp: seriesGroups.get(String(s.category_id)),
      logo: s.cover,
      plot: s.plot,
      rating: s.rating,
      year: /^\d{4}/.test(s.releaseDate || s.release_date || '') ? (s.releaseDate || s.release_date).slice(0, 4) : releaseYear(s.name),
    });
  }
}

/** Xtream geeft afleveringen per serie, dus die haalt de site pas op als iemand de serie opent. */
export async function loadEpisodes(series) {
  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(series.source_id);
  if (source?.type !== 'xtream') return;
  const known = db.prepare('SELECT COUNT(*) AS n FROM items WHERE parent_id = ?').get(series.id).n;
  const key = `series-${series.id}`;
  if (known && Date.now() - (episodeFetches.get(key) ?? 0) < 3600 * 1000) return;

  let data;
  try {
    data = await xtreamCall(source, `get_series_info&series_id=${encodeURIComponent(series.ext_id)}`);
  } catch (err) {
    if (known) return;
    throw err;
  }
  episodeFetches.set(key, Date.now());
  if (data?.info?.plot) db.prepare('UPDATE items SET plot = ? WHERE id = ?').run(data.info.plot, series.id);
  saveBackdrop(series.id, data?.info);

  const writer = new ItemWriter(source.id, 0);
  let sort = 0;
  for (const group of Object.values(data?.episodes ?? {})) {
    for (const e of asList(group)) {
      sort += 1;
      await writer.add({
        ext_key: `episode:${e.id}`,
        ext_id: e.id,
        type: 'episode',
        parent_id: series.id,
        name: e.title,
        grp: series.grp,
        logo: e.info?.movie_image,
        plot: e.info?.plot,
        season: Number(e.season) || 1,
        episode: Number(e.episode_num) || sort,
        sort,
        generation: 0,
        url: streamUrl(source, 'series', e.id, e.container_extension || 'mp4'),
      });
    }
  }
  await writer.flush();
}
const episodeFetches = new Map();

/** Bewaart het brede achtergrondbeeld uit de info van de provider; '-' betekent: heeft er geen. */
function saveBackdrop(id, info) {
  const list = Array.isArray(info?.backdrop_path) ? info.backdrop_path : [info?.backdrop_path];
  const link = list.find((v) => typeof v === 'string' && /^https?:\/\//i.test(v)) || '';
  db.prepare('UPDATE items SET backdrop = ? WHERE id = ?').run(link.slice(0, 1000) || '-', id);
  return link;
}

/** Haalt bij een film eenmalig het achtergrondbeeld op. Series krijgen het via loadEpisodes. */
export async function loadBackdrop(item) {
  if (item.backdrop || item.type !== 'movie' || !item.ext_id) return;
  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(item.source_id);
  if (source?.type !== 'xtream') return;
  const data = await xtreamCall(source, `get_vod_info&vod_id=${encodeURIComponent(item.ext_id)}`);
  saveBackdrop(item.id, data?.info);
  if (!item.plot && data?.info?.plot) db.prepare('UPDATE items SET plot = ? WHERE id = ?').run(String(data.info.plot), item.id);
}

const digits = (value) => (/^\d{1,10}$/.test(String(value ?? '').trim()) ? String(value).trim() : '');

/**
 * Zoekt het TMDB-nummer van een film, of van de serie bij een aflevering. Daarmee vinden
 * ondertitelsites de juiste titel. Alleen Xtream-providers geven dit; anders een leeg object.
 */
export async function tmdbIds(item) {
  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(item.source_id);
  if (source?.type !== 'xtream' || !item.ext_id) return {};
  if (item.type === 'movie') {
    const data = await xtreamCall(source, `get_vod_info&vod_id=${encodeURIComponent(item.ext_id)}`);
    return { tmdb: digits(data?.info?.tmdb_id) || digits(data?.info?.tmdb) || digits(data?.movie_data?.tmdb_id) };
  }
  if (item.type === 'episode' && item.parent_id) {
    const series = db.prepare('SELECT ext_id FROM items WHERE id = ?').get(item.parent_id);
    if (!series?.ext_id) return {};
    const data = await xtreamCall(source, `get_series_info&series_id=${encodeURIComponent(series.ext_id)}`);
    return { parentTmdb: digits(data?.info?.tmdb) || digits(data?.info?.tmdb_id) };
  }
  return {};
}

// ---- Verversen

const running = new Set();
export const isRefreshing = (id) => running.has(id);

export async function refreshSource(id) {
  if (running.has(id)) return;
  running.add(id);
  const setStatus = db.prepare('UPDATE sources SET status = ?, last_error = ? WHERE id = ?');
  setStatus.run('bezig', '', id);
  try {
    const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
    if (!source) return;
    const generation = source.generation + 1;
    const writer = new ItemWriter(id, generation);
    const problems = [];
    if (source.type === 'xtream') await importXtream(source, writer, problems);
    else await importM3U(source, writer);
    await writer.flush();
    if (!writer.count) throw new UpstreamError('De bron bevat geen zenders of video\'s.');
    // Wat nu niet opgehaald kon worden, blijft staan uit de vorige keer.
    for (const kind of problems) {
      db.prepare('UPDATE items SET generation = ? WHERE source_id = ? AND type = ? AND generation <> 0').run(generation, id, kind);
    }
    // Oude rijen pas verwijderen als de nieuwe lijst binnen is, zodat favorieten blijven bestaan.
    db.prepare('DELETE FROM items WHERE source_id = ? AND generation NOT IN (?, 0)').run(id, generation);
    recomputeVariants();
    const warning = problems.length
      ? `De provider gaf geen ${problems.map((k) => KIND_LABELS[k]).join(' en ')} terug. Probeer later opnieuw te verversen.`
      : '';
    db.prepare(`UPDATE sources SET generation = ?, last_refresh = ?, status = 'ok', last_error = ? WHERE id = ?`)
      .run(generation, Date.now(), warning, id);
  } catch (err) {
    const message = err instanceof UpstreamError ? err.message : 'De bron kon niet worden opgehaald.';
    console.error(`Bron ${id} verversen mislukt: ${err.code ?? err.name}`);
    setStatus.run('fout', message, id);
  } finally {
    running.delete(id);
  }
}

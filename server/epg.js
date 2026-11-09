import zlib from 'node:zlib';
import { db } from './db.js';
import { xtreamBase } from './sources.js';
import { open, UpstreamError } from './upstream.js';

const KEEP_BEFORE = 12 * 3600 * 1000;
const KEEP_AFTER = 4 * 86400 * 1000;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXml(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ENTITIES[name])
    .trim();
}

/** XMLTV-tijd, bijvoorbeeld "20261106183000 +0100". */
export function parseXmltvDate(value) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{2})?:?(\d{2})?/.exec(value ?? '');
  if (!m) return null;
  const [, y, mo, d, h, mi, s = '0', tzH = '+00', tzM = '00'] = m;
  const offset = (Number(tzH) * 60 + Math.sign(Number(`${tzH}1`)) * Number(tzM)) * 60000;
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) - offset;
}

const attr = (text, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(text)?.[1];
const child = (text, name) => {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`).exec(text);
  return m ? decodeXml(m[1]) : '';
};

export function parseProgramme(attributes, body) {
  const channel = attr(attributes, 'channel');
  const start = parseXmltvDate(attr(attributes, 'start'));
  const stop = parseXmltvDate(attr(attributes, 'stop'));
  if (!channel || !start || !stop) return null;
  return { channel: decodeXml(channel), start, stop, title: child(body, 'title') || 'Onbekend', descr: child(body, 'desc') };
}

/** Doorloopt een XMLTV-stroom zonder het bestand volledig in het geheugen te laden. */
async function* programmes(stream) {
  let buffer = '';
  const pattern = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
  for await (const chunk of stream) {
    buffer += chunk;
    let end = 0;
    pattern.lastIndex = 0;
    for (let m = pattern.exec(buffer); m; m = pattern.exec(buffer)) {
      const parsed = parseProgramme(m[1], m[2]);
      if (parsed) yield parsed;
      end = pattern.lastIndex;
    }
    if (end) buffer = buffer.slice(end);
    else if (buffer.length > 4 * 1024 * 1024) buffer = '';
  }
}

export function epgUrlFor(source) {
  if (source.epg_url) return source.epg_url;
  if (source.detected_epg_url) return source.detected_epg_url;
  if (source.type === 'xtream') {
    const user = encodeURIComponent(source.username);
    const pass = encodeURIComponent(source.password);
    return `${xtreamBase(source)}/xmltv.php?username=${user}&password=${pass}`;
  }
  return '';
}

async function gunzipIfNeeded(res) {
  const iterator = res[Symbol.asyncIterator]();
  const first = await iterator.next();
  const head = first.value ?? Buffer.alloc(0);
  const { Readable } = await import('node:stream');
  const whole = Readable.from((async function* replay() {
    if (head.length) yield head;
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  })());
  const stream = head[0] === 0x1f && head[1] === 0x8b ? whole.pipe(zlib.createGunzip()) : whole;
  stream.setEncoding('utf8');
  return stream;
}

const running = new Set();

export async function refreshEpg(id) {
  if (running.has(id)) return;
  running.add(id);
  const setStatus = db.prepare('UPDATE sources SET epg_status = ?, last_epg_refresh = ? WHERE id = ?');
  try {
    const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
    const url = source && epgUrlFor(source);
    if (!url) {
      if (source) setStatus.run('geen tv-gids ingesteld', Date.now(), id);
      return;
    }
    const known = new Set(db.prepare(`SELECT DISTINCT epg_id FROM items WHERE source_id = ? AND epg_id <> ''`)
      .all(id).map((row) => row.epg_id));
    if (!known.size) {
      setStatus.run('geen zenders met gids-id', Date.now(), id);
      return;
    }
    const { res } = await open(url, { userAgent: source.user_agent, timeout: 120000 });
    if (res.statusCode !== 200) {
      res.resume();
      throw new UpstreamError(`foutcode ${res.statusCode}`);
    }

    const now = Date.now();
    const insert = db.prepare('INSERT INTO programmes (source_id, epg_id, start, stop, title, descr) VALUES (?, ?, ?, ?, ?, ?)');
    // De oude gids blijft staan tot de nieuwe binnen is. Elke transactie loopt zonder await,
    // zodat die niet kan botsen met een andere import op dezelfde databaseverbinding.
    const lastOldId = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM programmes').get().id;
    let buffer = [];
    let count = 0;
    const flush = async () => {
      db.exec('BEGIN');
      try {
        for (const p of buffer) insert.run(id, p.channel, p.start, p.stop, p.title, p.descr);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      count += buffer.length;
      buffer = [];
      await new Promise((resolve) => setImmediate(resolve));
    };
    try {
      for await (const p of programmes(await gunzipIfNeeded(res))) {
        if (!known.has(p.channel) || p.stop < now - KEEP_BEFORE || p.start > now + KEEP_AFTER) continue;
        buffer.push(p);
        if (buffer.length >= 2000) await flush();
      }
      await flush();
    } catch (err) {
      db.prepare('DELETE FROM programmes WHERE source_id = ? AND id > ?').run(id, lastOldId);
      throw err;
    }
    db.prepare('DELETE FROM programmes WHERE source_id = ? AND id <= ?').run(id, lastOldId);
    setStatus.run(`${count} programma's`, Date.now(), id);
  } catch (err) {
    console.error(`Tv-gids van bron ${id} mislukt: ${err.code ?? err.name}`);
    const reason = err instanceof UpstreamError ? err.message : 'kon niet worden opgehaald';
    setStatus.run(`mislukt: ${reason}`, Date.now(), id);
  } finally {
    running.delete(id);
  }
}

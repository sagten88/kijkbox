import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { releaseYear } from './years.js';
import { langRank, titleKey } from './titles.js';

export const db = new DatabaseSync(path.join(config.dataDir, 'kijkbox.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('m3u', 'm3u_text', 'xtream')),
  url TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  password TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  epg_url TEXT NOT NULL DEFAULT '',
  detected_epg_url TEXT NOT NULL DEFAULT '',
  stream_format TEXT NOT NULL DEFAULT 'hls' CHECK (stream_format IN ('hls', 'ts')),
  user_agent TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'nieuw',
  last_error TEXT NOT NULL DEFAULT '',
  epg_status TEXT NOT NULL DEFAULT '',
  last_refresh INTEGER NOT NULL DEFAULT 0,
  last_epg_refresh INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0,
  account_info TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  ext_key TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('live', 'movie', 'series', 'episode')),
  name TEXT NOT NULL,
  name_lc TEXT NOT NULL,
  grp TEXT NOT NULL DEFAULT '',
  logo TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  epg_id TEXT NOT NULL DEFAULT '',
  parent_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
  ext_id TEXT NOT NULL DEFAULT '',
  season INTEGER,
  episode INTEGER,
  plot TEXT NOT NULL DEFAULT '',
  rating TEXT NOT NULL DEFAULT '',
  year TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  referer TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0,
  UNIQUE (source_id, ext_key)
);
DROP INDEX IF EXISTS items_browse;
CREATE INDEX IF NOT EXISTS items_by_group ON items(type, grp, sort, name_lc);
CREATE INDEX IF NOT EXISTS items_by_sort ON items(type, sort, name_lc);
CREATE INDEX IF NOT EXISTS items_parent ON items(parent_id, season, episode);
CREATE INDEX IF NOT EXISTS items_epg ON items(source_id, epg_id);

CREATE TABLE IF NOT EXISTS favorites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS progress (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  position REAL NOT NULL,
  duration REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS programmes (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  epg_id TEXT NOT NULL,
  start INTEGER NOT NULL,
  stop INTEGER NOT NULL,
  title TEXT NOT NULL,
  descr TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS programmes_lookup ON programmes(source_id, epg_id, start);
`);

// Versie 1: Xtream-zenders lopen via MPEG-TS, omdat HLS-tokens bij veel providers maar kort
// geldig zijn. last_refresh = 0 laat de bron bij de eerstvolgende controle opnieuw inladen.
if (db.prepare('PRAGMA user_version').get().user_version < 1) {
  db.exec(`
    UPDATE sources SET stream_format = 'ts', last_refresh = 0 WHERE type = 'xtream';
    PRAGMA user_version = 1;
  `);
}

// Versie 2: releasejaar uit de titel halen voor films en series die al in de database staan.
// Nieuwe imports doen dit zelf; dit is eenmalig voor wat er al was.
if (db.prepare('PRAGMA user_version').get().user_version < 2) {
  const rows = db.prepare(`SELECT id, name FROM items WHERE type IN ('movie', 'series') AND year NOT GLOB '[0-9][0-9][0-9][0-9]'`).all();
  const update = db.prepare('UPDATE items SET year = ? WHERE id = ?');
  db.exec('BEGIN');
  for (const row of rows) {
    const year = releaseYear(row.name);
    if (year) update.run(year, row.id);
  }
  db.exec('PRAGMA user_version = 2; COMMIT');
}
db.exec('CREATE INDEX IF NOT EXISTS items_by_year ON items(type, year)');

// Instellingen van de site zelf, zoals de koppeling met OpenSubtitles.
db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

// Versie 3: elk account kiest een eigen kleurthema. Leeg betekent het standaardgeel.
if (db.prepare('PRAGMA user_version').get().user_version < 3) {
  db.exec(`
    ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT '';
    PRAGMA user_version = 3;
  `);
}

// Versie 4:
// - films en series in meerdere talen worden één kaart (title_key, lang_rank, is_primary, variants)
// - achtergrondbeeld (backdrop), weergave per account (appearance)
// - verborgen landen/categorieën per account, en accounts per tv (device_accounts)
if (db.prepare('PRAGMA user_version').get().user_version < 4) {
  db.exec(`
    ALTER TABLE items ADD COLUMN title_key TEXT NOT NULL DEFAULT '';
    ALTER TABLE items ADD COLUMN lang_rank INTEGER NOT NULL DEFAULT 2;
    ALTER TABLE items ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE items ADD COLUMN variants INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE items ADD COLUMN backdrop TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN appearance TEXT NOT NULL DEFAULT '';
  `);
  const rows = db.prepare(`SELECT id, name, grp FROM items WHERE type IN ('movie', 'series')`).all();
  const update = db.prepare('UPDATE items SET title_key = ?, lang_rank = ? WHERE id = ?');
  const ranks = new Map();
  db.exec('BEGIN');
  for (const row of rows) {
    if (!ranks.has(row.grp)) ranks.set(row.grp, langRank(row.grp));
    update.run(titleKey(row.name), ranks.get(row.grp), row.id);
  }
  db.exec('PRAGMA user_version = 4; COMMIT');
}
// Versie 5: tijdelijk wachtwoord (eerst zelf een nieuw kiezen), profielfoto en eigen thema per account.
if (db.prepare('PRAGMA user_version').get().user_version < 5) {
  db.exec(`
    ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN look TEXT NOT NULL DEFAULT '';
    PRAGMA user_version = 5;
  `);
}
db.exec(`
CREATE INDEX IF NOT EXISTS items_by_title ON items(type, title_key, lang_rank);
CREATE INDEX IF NOT EXISTS items_primary ON items(type, is_primary, sort);
-- Films/series: één kaart per titel, Nederlands eerst. Met deze volgorde hoeft er niets gesorteerd te worden.
CREATE INDEX IF NOT EXISTS items_primary_order ON items(type, is_primary, lang_rank, sort, name_lc);
CREATE TABLE IF NOT EXISTS user_hidden (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('country', 'group')),
  value TEXT NOT NULL,
  PRIMARY KEY (user_id, kind, value)
);
CREATE TABLE IF NOT EXISTS device_accounts (
  device_hash TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (device_hash, user_id)
);
`);

/**
 * Kiest per titel de hoofdversie (Nederlands, dan Engels, dan de rest) en telt de versies.
 * Na elke import opnieuw, want er kunnen versies bij of af zijn gekomen.
 */
export function recomputeVariants() {
  db.exec(`
    BEGIN;
    UPDATE items SET is_primary = 1, variants = 1 WHERE type IN ('movie', 'series') AND (is_primary <> 1 OR variants <> 1);
    WITH ranked AS (
      SELECT id,
        ROW_NUMBER() OVER (PARTITION BY type, title_key
          ORDER BY lang_rank, (year GLOB '[0-9][0-9][0-9][0-9]') DESC, sort, id) AS rn,
        COUNT(*) OVER (PARTITION BY type, title_key) AS n
      FROM items WHERE type IN ('movie', 'series') AND title_key <> ''
    )
    UPDATE items SET is_primary = (ranked.rn = 1), variants = ranked.n
    FROM ranked WHERE ranked.id = items.id AND ranked.n > 1;
    COMMIT;
  `);
}
if (db.prepare(`SELECT COUNT(*) AS n FROM items WHERE variants > 1`).get().n === 0
  && db.prepare(`SELECT COUNT(*) AS n FROM items WHERE type IN ('movie', 'series')`).get().n > 0) {
  recomputeVariants();
}

/** Maakt tekst vergelijkbaar voor zoeken: geen hoofdletters en geen accenten. */
export function normalize(text) {
  return String(text).normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

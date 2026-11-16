import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const bool = (name, fallback = false) => {
  const v = process.env[name];
  return v === undefined ? fallback : /^(1|true|yes|ja)$/i.test(v);
};

function findFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  // Winget zet ffmpeg in een eigen map, en programma's die al draaien kennen het nieuwe PATH nog niet.
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const pattern = 'Microsoft/WinGet/Packages/Gyan.FFmpeg*/*/bin/ffmpeg.exe';
    const [found] = fs.globSync(pattern, { cwd: process.env.LOCALAPPDATA });
    if (found) return path.join(process.env.LOCALAPPDATA, found);
  }
  return 'ffmpeg';
}

const dataDir = path.resolve(process.env.DATA_DIR || path.join(rootDir, 'data'));

export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  dataDir,
  // Omgezette films en afleveringen (en downloads) staan hier tijdelijk. Niet in /tmp: dat is op veel
  // servers een klein stukje werkgeheugen (bijv. 2 GB), en een aflevering van 2,5 GB past daar niet in.
  tempDir: process.env.TEMP_DIR ? path.resolve(process.env.TEMP_DIR) : path.join(dataDir, 'tmp'),
  // Zet TRUST_PROXY=1 als de site achter een reverse proxy zoals Caddy staat.
  trustProxy: process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY : false,
  secureCookies: bool('SECURE_COOKIES'),
  allowLocalMedia: bool('ALLOW_LOCAL_MEDIA'),
  allowPrivateMedia: bool('ALLOW_PRIVATE_MEDIA'),
  maxFfmpeg: Number(process.env.MAX_FFMPEG || 4),
  ffmpeg: findFfmpeg(),
  userAgent: process.env.UPSTREAM_USER_AGENT || 'VLC/3.0.21 LibVLC/3.0.21',
  sessionDays: 30,
  // Zonder deze instelling weigert de site verzoeken van buiten het thuisnetwerk (zie network.js).
  allowPublic: bool('ALLOW_PUBLIC'),
  version: JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version,
  // Uur (lokale tijd) waarop playlists en tv-gids elke nacht worden bijgewerkt.
  refreshHour: Math.min(23, Math.max(0, Number(process.env.REFRESH_HOUR ?? 4) || 0)),
};

fs.mkdirSync(config.dataDir, { recursive: true });

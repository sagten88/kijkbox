// Nep-IPTV-provider voor testen, met eigen testbeeld. Start met: npm run mock
// Biedt: M3U, XMLTV en de Xtream-API, plus HLS (H.264), MPEG-TS (H.264), TS (HEVC), MP4 en MKV.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.MOCK_PORT || 8899);
const dir = path.join(os.tmpdir(), 'kijkbox-mock');
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const base = `http://127.0.0.1:${PORT}`;

fs.mkdirSync(path.join(dir, 'hls'), { recursive: true });

function make(file, ...args) {
  const target = path.join(dir, file);
  if (fs.existsSync(target)) return;
  const input = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=60',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=60'];
  const out = spawnSync(ffmpeg, [...input, ...args, target], { stdio: 'inherit' });
  if (out.status !== 0) throw new Error(`ffmpeg faalde voor ${file}`);
}

const h264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac'];
make('clip.mp4', ...h264);
make('clip.ts', ...h264, '-f', 'mpegts');
make('clip.mkv', ...h264);
make('hevc.ts', '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'mpegts');
make('hls/index.m3u8', ...h264, '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_playlist_type', 'vod',
  '-hls_segment_filename', path.join(dir, 'hls', 'seg%03d.ts'));

// Echte live-streams: de HLS-lijst schuift door en de TS-stream stopt nooit.
const liveDir = path.join(dir, 'livehls');
fs.rmSync(liveDir, { recursive: true, force: true });
fs.mkdirSync(liveDir);
const liveHls = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-re', '-stream_loop', '-1', '-i', path.join(dir, 'clip.ts'),
  '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '5', '-hls_flags', 'delete_segments',
  '-hls_segment_filename', path.join(liveDir, 'seg%05d.ts'), path.join(liveDir, 'index.m3u8')], { stdio: 'inherit' });
process.on('exit', () => liveHls.kill());

function serveEndlessTs(req, res) {
  const proc = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-re', '-stream_loop', '-1', '-i', path.join(dir, 'clip.ts'),
    '-c', 'copy', '-f', 'mpegts', 'pipe:1'], { stdio: ['ignore', 'pipe', 'inherit'] });
  res.writeHead(200, { 'Content-Type': 'video/mp2t' });
  proc.stdout.pipe(res);
  res.on('close', () => proc.kill());
}

// Gedraagt zich als een provider met 1 verbinding: sluit na 15 seconden, en een nieuwe
// verbinding krijgt code 509 zolang de vorige nog open is of net gesloten is.
let limitedOpen = false;
let limitedFreeAt = 0;

function serveLimitedTs(req, res) {
  if (limitedOpen || Date.now() < limitedFreeAt) return res.writeHead(509).end();
  limitedOpen = true;
  const proc = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-re', '-stream_loop', '-1', '-i', path.join(dir, 'clip.ts'),
    '-c', 'copy', '-f', 'mpegts', 'pipe:1'], { stdio: ['ignore', 'pipe', 'inherit'] });
  res.writeHead(200, { 'Content-Type': 'video/mp2t' });
  proc.stdout.pipe(res);
  const stop = setTimeout(() => res.end(), 15000);
  res.on('close', () => {
    clearTimeout(stop);
    proc.kill();
    limitedOpen = false;
    limitedFreeAt = Date.now() + 2500;
  });
  return undefined;
}

const stamp = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';

function xmltv() {
  const start = Math.floor(Date.now() / 1800000) * 1800000 - 3600000;
  let body = '';
  for (const channel of ['hls.test', 'ts.test', 'hevc.test']) {
    for (let i = 0; i < 12; i += 1) {
      const from = start + i * 2700000;
      body += `<programme start="${stamp(from)}" stop="${stamp(from + 2700000)}" channel="${channel}">`
        + `<title lang="nl">Programma ${i + 1} &amp; meer</title><desc>Beschrijving ${i + 1}</desc></programme>\n`;
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?><tv>${body}</tv>`;
}

const m3u = `#EXTM3U url-tvg="${base}/xmltv.xml"
#EXTINF:-1 tvg-id="hls.test" tvg-logo="${base}/logo.png" group-title="Nederland",HLS Kanaal
${base}/stream/hls/index.m3u8
#EXTINF:-1 tvg-id="ts.test" group-title="Nederland",TS Kanaal
${base}/stream/clip.ts
#EXTINF:-1 tvg-id="hevc.test" group-title="Sport",HEVC Kanaal
${base}/stream/hevc.ts
#EXTINF:-1 group-title="Live test",Live HLS
${base}/stream/livehls/index.m3u8
#EXTINF:-1 group-title="Live test",Live TS
${base}/endless.ts
#EXTINF:-1 group-title="Live test",Onderbroken TS
${base}/limited.ts
#EXTINF:-1 tvg-id="" group-title="Films",Testfilm MP4
${base}/stream/clip.mp4
#EXTINF:-1 tvg-id="" group-title="Films",Testfilm MKV
${base}/stream/clip.mkv
#EXTINF:-1 group-title="Series",Testserie S01E01
${base}/series/stream/clip.mp4
#EXTINF:-1 group-title="Series",Testserie S01E02
${base}/series/stream/clip.mkv
`;

const LOGO = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/AAwAFBAH/k3jZ2QAAAABJRU5ErkJggg==', 'base64');

function xtream(url) {
  const action = url.searchParams.get('action');
  if (url.searchParams.get('password') !== 'geheim') return { user_info: { auth: 0 } };
  switch (action) {
    case null: return { user_info: { auth: 1, status: 'Active', exp_date: String(Math.floor(Date.now() / 1000) + 86400 * 90), max_connections: '2' } };
    case 'get_live_categories': return [{ category_id: '1', category_name: 'Xtream Live' }];
    case 'get_live_streams': return [{ stream_id: 11, name: 'Xtream Kanaal', category_id: '1', epg_channel_id: 'hls.test', stream_icon: `${base}/logo.png` }];
    case 'get_vod_categories': return [{ category_id: '2', category_name: 'Xtream Films' }];
    case 'get_vod_streams': return [{ stream_id: 21, name: 'Xtream Film', category_id: '2', container_extension: 'mp4', rating: '7.5', added: '100' }];
    case 'get_series_categories': return [{ category_id: '3', category_name: 'Xtream Series' }];
    case 'get_series': return [{ series_id: 31, name: 'Xtream Serie', category_id: '3', plot: 'Een testserie.' }];
    case 'get_series_info': return { info: { plot: 'Een testserie.' }, episodes: { 1: [{ id: 41, episode_num: 1, title: 'Pilot', season: 1, container_extension: 'mp4' }], 2: [{ id: 42, episode_num: 1, title: 'Terug', season: 2, container_extension: 'mkv' }] } };
    default: return [];
  }
}

function sendFile(req, res, file) {
  if (!file.startsWith(dir) || !fs.existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  const size = fs.statSync(file).size;
  const type = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.mp4': 'video/mp4' }[path.extname(file)] ?? 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
  if (range) {
    const start = Number(range[1] || 0);
    const end = Number(range[2] || size - 1);
    res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(file).pipe(res);
}

http.createServer((req, res) => {
  const url = new URL(req.url, base);
  const p = url.pathname;
  if (p === '/playlist.m3u') return res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' }).end(m3u);
  if (p === '/xmltv.xml' || p === '/xmltv.php') return res.writeHead(200, { 'Content-Type': 'application/xml' }).end(xmltv());
  if (p === '/endless.ts') return serveEndlessTs(req, res);
  if (p === '/limited.ts') return serveLimitedTs(req, res);
  if (p === '/logo.png') return res.writeHead(200, { 'Content-Type': 'image/png' }).end(LOGO);
  if (p === '/player_api.php') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(xtream(url)));
  if (/^\/live\/[^/]+\/[^/]+\/\d+\.m3u8$/.test(p)) return res.writeHead(302, { Location: '/stream/hls/index.m3u8' }).end();
  if (/^\/live\/[^/]+\/[^/]+\/\d+\.ts$/.test(p)) return sendFile(req, res, path.join(dir, 'clip.ts'));
  if (/^\/(movie|series)\/[^/]+\/[^/]+\/\d+\.mp4$/.test(p)) return sendFile(req, res, path.join(dir, 'clip.mp4'));
  if (/^\/(movie|series)\/[^/]+\/[^/]+\/\d+\.mkv$/.test(p)) return sendFile(req, res, path.join(dir, 'clip.mkv'));
  const stream = /^(?:\/series)?\/stream\/(.+)$/.exec(p);
  if (stream) return sendFile(req, res, path.join(dir, path.normalize(stream[1])));
  res.writeHead(404).end();
}).listen(PORT, '127.0.0.1', () => console.log(`Nep-provider op ${base}`));

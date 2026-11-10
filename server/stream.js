import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { seal, unseal } from './auth.js';
import { config } from './config.js';
import { db } from './db.js';
import { TsDedupe } from './tsdedupe.js';
import { parseCues } from './subtitles.js';
import { assertHostAllowed, open, readText, UpstreamError } from './upstream.js';

const VIEWER_TIMEOUT = 20 * 1000;
const VOD_VIEWER_TIMEOUT = 5 * 60 * 1000;
const MAX_MANIFEST = 8 * 1024 * 1024;

fs.rmSync(config.tempDir, { recursive: true, force: true });
fs.mkdirSync(config.tempDir, { recursive: true });

const getItem = db.prepare('SELECT * FROM items WHERE id = ?');
const getSourceUa = db.prepare('SELECT user_agent FROM sources WHERE id = ?');

function requestOptions(item) {
  return {
    userAgent: item.user_agent || getSourceUa.get(item.source_id)?.user_agent || undefined,
    referer: item.referer || undefined,
  };
}

// Een token is alleen bruikbaar met een geldige inlogsessie, dus het hoeft zelf niet te verlopen.
const issue = (url, itemId) => seal({ u: url, i: itemId });

function readToken(req, res) {
  const data = unseal(req.params.token?.replace(/\.[a-z0-9]+$/, ''));
  if (!data) {
    res.status(404).json({ error: 'Deze streamlink bestaat niet.' });
    return null;
  }
  const item = getItem.get(data.i);
  if (!item) {
    res.status(404).json({ error: 'Niet gevonden.' });
    return null;
  }
  return { url: data.u, item };
}

// De streamlink bevat vaak het wachtwoord van de provider. De browser ziet daarom alleen versleutelde links.
export function rewriteManifest(text, baseUrl, sign) {
  const resolve = (uri) => new URL(uri, baseUrl).href;
  const lines = text.split(/\r?\n/);
  let nextIsPlaylist = false;
  return lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith('#')) {
      if (/^#EXT-X-(STREAM-INF)/i.test(trimmed)) nextIsPlaylist = true;
      return line.replace(/URI="([^"]+)"/g, (_, uri) => {
        const isPlaylist = /^#EXT-X-(MEDIA|I-FRAME-STREAM-INF)/i.test(trimmed);
        return `URI="${sign(resolve(uri), isPlaylist)}"`;
      });
    }
    const isPlaylist = nextIsPlaylist || /\.m3u8?(\?|$)/i.test(trimmed);
    nextIsPlaylist = false;
    return sign(resolve(trimmed), isPlaylist);
  }).join('\n');
}

// Onthoudt waar een afspeellijst naartoe omleidde. Veel providers geven per aanvraag een nieuw
// token, soms op een andere server. Elke verversing telt dan als nieuwe verbinding.
const pinnedPlaylists = new Map();
const MAX_PINNED = 200;

function pinPlaylist(token, url) {
  pinnedPlaylists.delete(token);
  pinnedPlaylists.set(token, url);
  if (pinnedPlaylists.size > MAX_PINNED) pinnedPlaylists.delete(pinnedPlaylists.keys().next().value);
}

export async function serveManifest(req, res) {
  const target = readToken(req, res);
  if (!target) return;
  const { item } = target;
  touchDirect(item);
  const { token } = req.params;
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const options = { ...requestOptions(item), signal: controller.signal };

  const pinned = pinnedPlaylists.get(token);
  let { res: upstream, url } = await open(pinned ?? target.url, options);
  if (pinned && upstream.statusCode !== 200) {
    // Het token is verlopen: één keer opnieuw via de oorspronkelijke link.
    upstream.resume();
    pinnedPlaylists.delete(token);
    ({ res: upstream, url } = await open(target.url, options));
  }
  if (upstream.statusCode !== 200) {
    upstream.resume();
    return res.status(502).json({ error: `De bron antwoordde met foutcode ${upstream.statusCode}.` });
  }
  if (url !== target.url) pinPlaylist(token, url);
  const text = await readText(upstream, MAX_MANIFEST);
  if (!text.trimStart().startsWith('#EXTM3U')) return res.status(502).json({ error: 'Geen geldige afspeellijst.' });
  const output = rewriteManifest(text, url, (uri, isPlaylist) => {
    const token = issue(uri, item.id);
    return isPlaylist ? `/s/m/${token}.m3u8` : `/s/g/${token}`;
  });
  res.set({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' }).send(output);
}

/** Geeft segmenten en videobestanden door, inclusief spoelen via Range-verzoeken. */
export async function servePassthrough(req, res) {
  const target = readToken(req, res);
  if (!target) return;
  const controller = new AbortController();
  const activity = touchDirect(target.item);
  activity.open += 1;
  res.on('close', () => {
    controller.abort();
    activity.open -= 1;
    activity.last = Date.now();
  });
  const range = /^bytes=\d*-\d*$/.test(req.headers.range ?? '') ? req.headers.range : undefined;
  const { res: upstream } = await open(target.url, { ...requestOptions(target.item), range, signal: controller.signal });
  const status = upstream.statusCode ?? 502;
  if (status !== 200 && status !== 206) {
    upstream.resume();
    return res.status(502).json({ error: `De bron antwoordde met foutcode ${status}.` });
  }
  const type = upstream.headers['content-type'] ?? '';
  const safeType = /^(video|audio)\/|^application\/(octet-stream|vnd\.apple|x-mpegurl)|^binary\//i.test(type) ? type : 'application/octet-stream';
  res.status(status).set({ 'Content-Type': safeType, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' });
  for (const header of ['content-length', 'content-range']) {
    if (upstream.headers[header]) res.set(header, upstream.headers[header]);
  }
  await pipeline(upstream, res).catch(() => {});
}

// ---- FFmpeg: zet streams om die browsers niet zelf kunnen afspelen

const sessions = new Map(); // sessie-id -> sessie
const byKey = new Map(); // item + modus -> sessie
const viewers = new Map(); // browsertab -> sessie-id
const direct = new Map(); // item-id -> { item, since, last, open }: streams die de server alleen doorgeeft

/** Houdt bij welke streams rechtstreeks (zonder ffmpeg) door de server lopen, voor de statuspagina. */
function touchDirect(item) {
  const now = Date.now();
  let entry = direct.get(item.id);
  if (!entry || (!entry.open && now - entry.last > 60000)) {
    entry = { item, since: now, last: now, open: 0 };
    direct.set(item.id, entry);
  }
  entry.last = now;
  return entry;
}

// De iPhone-speler stopt als de afspeellijst langer dan 1,5 keer de segmentduur niet ververst.
// Langere segmenten geven dus meer speling, ten koste van een paar seconden extra vertraging.
const LIVE_SEGMENT = 4;

// De provider verbreekt de verbinding elke ~28 seconden en levert daardoor met horten en stoten:
// even bijna niets, dan ineens 15–30 seconden tegelijk. Daarom houdt de afspeellijst ruim
// video vast (een golf wist dan geen segmenten die de speler nog nodig heeft) en start de
// speler LIVE_DELAY seconden achter live, zodat hij de stille stukken uit zijn buffer overbrugt.
const LIVE_WINDOW = 40;
export const LIVE_DELAY = 30;

function ffmpegArgs(session) {
  const { item, url, live, transcode, start, dir } = session;
  const opts = requestOptions(item);
  const args = ['-hide_banner', '-loglevel', 'info'];
  if (usesFeed(session)) {
    // De server haalt de stream zelf op en filtert herhaalde stukken eruit (zie feedLive).
    args.push('-fflags', '+genpts+discardcorrupt', '-i', 'pipe:0');
  } else {
    args.push('-nostdin', '-user_agent', opts.userAgent || config.userAgent);
    if (opts.referer) args.push('-headers', `Referer: ${opts.referer}\r\n`);
    args.push('-reconnect', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '5');
    // Komt er 15 seconden niets binnen, dan stopt ffmpeg en start de server hem opnieuw.
    if (live) args.push('-reconnect_streamed', '1', '-rw_timeout', '15000000');
    args.push('-fflags', '+genpts+discardcorrupt', '-protocol_whitelist', 'http,https,tcp,tls,crypto,hls');
    if (start > 0) args.push('-ss', String(start));
    args.push('-i', url);
  }
  args.push('-map', '0:v:0?', '-map', '0:a:0?');
  if (transcode) {
    args.push(
      '-vf', "yadif=mode=0:parity=-1:deint=1,scale=-2:'min(1080,ih)',format=yuv420p",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-maxrate', '6M', '-bufsize', '12M', '-sc_threshold', '0',
    );
    // Live: een keyframe precies op elke segmentgrens, zodat alle segmenten even lang zijn.
    if (live) args.push('-tune', 'zerolatency', '-force_key_frames', `expr:gte(t,n_forced*${LIVE_SEGMENT})`);
    else args.push('-g', '48', '-keyint_min', '48');
  } else {
    args.push('-c:v', 'copy');
  }
  args.push('-c:a', 'aac', '-ac', '2', '-b:a', '160k', '-f', 'hls');
  if (live) {
    // omit_endlist: een live-stream eindigt nooit, ook niet als de bron even wegvalt.
    // append_list alleen na een herstart: dan gaat dezelfde afspeellijst verder. Bij de eerste start
    // moet de lijst schoon zijn, want Apple's speler is daar veel strenger in dan hls.js.
    const flags = ['delete_segments', 'independent_segments', 'omit_endlist', session.relaunch && 'append_list'].filter(Boolean).join('+');
    args.push('-hls_time', String(LIVE_SEGMENT), '-hls_list_size', String(LIVE_WINDOW), '-hls_flags', flags);
  } else {
    args.push('-hls_time', '6', '-hls_list_size', '0', '-hls_playlist_type', 'event');
  }
  args.push('-hls_segment_filename', path.join(dir, 'seg%05d.ts'), path.join(dir, 'index.m3u8'));
  // Ondertitels die in het bestand zitten, via dezelfde verbinding als losse WebVTT-bestanden.
  for (const [n, track] of (session.subtitleTracks ?? []).entries()) {
    // flush_packets: elke regel meteen wegschrijven, zodat de speler ze al tijdens het omzetten kan ophalen.
    args.push('-map', `0:${track.index}`, '-c:s', 'webvtt', '-flush_packets', '1', '-f', 'webvtt', path.join(dir, `sub${n}.vtt`));
  }
  return args;
}

// Tekstondertitels die we naar WebVTT kunnen omzetten (beeldondertitels zoals PGS niet).
const TEXT_SUBTITLES = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);

/** Ondertitelsporen uit de uitvoer van ffmpeg: "Stream #0:2(dut): Subtitle: subrip (default)". */
export function parseSubtitleStreams(stderr) {
  const tracks = [];
  const re = /Stream #0:(\d+)(?:\[0x[0-9a-f]+\])?(?:\((\w+)\))?: Subtitle: (\w+)/g;
  for (let m = re.exec(stderr); m; m = re.exec(stderr)) {
    if (TEXT_SUBTITLES.has(m[3])) tracks.push({ index: Number(m[1]), lang: (m[2] ?? 'und').toLowerCase(), codec: m[3] });
  }
  return tracks;
}

const describe = (tail) => tail.split('\n').filter(Boolean).slice(-2).join(' | ').replace(/https?:\/\/\S+/g, '[link]');

/**
 * Providers sluiten live-verbindingen geregeld, en een vorige verbinding is vaak nog een paar
 * seconden bezet. Daarom probeert de server het opnieuw in plaats van de stream op te geven.
 */
function restartLive(session, tail) {
  const ranFor = Date.now() - session.launchedAt;
  // Wie 10 seconden goed liep, is niet stuk: dan telt het als een nieuwe eerste poging.
  // (Met 30 seconden gaf de server het op bij providers die elke ~28 seconden afkappen.)
  session.retries = ranFor > 10000 ? 1 : (session.retries ?? 0) + 1;
  session.limited = /\b509\b|Too many|max.?conn/i.test(tail);
  if (session.retries > 8) {
    console.error(`Stream gestopt na herhaalde pogingen (item ${session.item.id}): ${describe(tail)}`);
    session.failed = session.limited
      ? 'Je provider weigert een extra verbinding. Stop de stream op je andere apparaat en probeer het opnieuw.'
      : 'De stream kon niet worden omgezet.';
    return;
  }
  const delay = Math.min(500 * 2 ** session.retries, 5000);
  session.relaunch = true;
  setTimeout(() => {
    if (!session.closed) launch(session);
  }, delay);
}

/** Live MPEG-TS (geen HLS) haalt de server zelf op, zodat herhaalde stukken eruit kunnen. */
const usesFeed = (session) => session.live && !/\.m3u8?(\?|$)/i.test(new URL(session.url).pathname);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const FEED_STALL = 30000;

/**
 * Haalt de live-stream op en geeft hem via stdin aan ffmpeg. Bij elke afgebroken verbinding wordt
 * meteen opnieuw verbonden; ffmpeg merkt daar niets van, dus er komen geen naden of herstarts.
 * Wat de provider na een nieuwe verbinding opnieuw stuurt, gooit TsDedupe weg.
 */
async function feedLive(session, proc) {
  const dedupe = (session.dedupe ??= new TsDedupe());
  const alive = () => !session.closed && session.proc === proc && proc.exitCode === null && !proc.killed;
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  proc.stdin.on('error', () => {});
  let failures = 0;
  let lastData = Date.now();
  while (alive()) {
    const controller = new AbortController();
    session.feedAbort = controller;
    dedupe.reconnect();
    const droppedBefore = dedupe.droppedBytes;
    try {
      const { res } = await open(session.url, { ...requestOptions(session.item), signal: controller.signal, timeout: 15000 });
      if (res.statusCode !== 200) {
        res.resume();
        throw new UpstreamError(`foutcode ${res.statusCode}`);
      }
      for await (const chunk of res) {
        if (!alive()) break;
        const out = dedupe.push(chunk);
        lastData = Date.now();
        failures = 0;
        if (out.length && !proc.stdin.write(out)) {
          await Promise.race([new Promise((resolve) => proc.stdin.once('drain', resolve)), exited]);
        }
      }
    } catch (err) {
      failures += 1;
      session.feedError = err.message;
      if (failures <= 3 || failures % 10 === 0) {
        console.log(`Live item ${session.item.id}: verbinden mislukt (${String(err.message).replace(/https?:\/\/\S+/g, '[link]')}), poging ${failures}`);
      }
    } finally {
      controller.abort();
    }
    const skipped = dedupe.droppedBytes - droppedBefore;
    if (skipped > 1024 * 1024) {
      console.log(`Live item ${session.item.id}: ${(skipped / 1048576).toFixed(1)} MB herhaalde video van de provider overgeslagen`);
    }
    if (!alive()) break;
    // Lukt het al een halve minuut niet, dan ffmpeg stoppen; restartLive regelt de rest.
    if (Date.now() - lastData > FEED_STALL) {
      proc.kill('SIGKILL');
      break;
    }
    // Een "bezet" (509) van de provider is meestal binnen een paar seconden over: in kleine stappen
    // opnieuw proberen (0,4 / 0,8 / 1,2 … s, hooguit 3 s) in plaats van 1 / 2 / 4 s.
    await sleep(failures ? Math.min(400 * failures, 3000) : 200);
  }
}

function launch(session) {
  const feed = usesFeed(session);
  const proc = spawn(config.ffmpeg, ffmpegArgs(session), { stdio: [feed ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
  session.proc = proc;
  session.launchedAt = Date.now();
  if (feed) feedLive(session, proc).catch((err) => console.error(`Live-ophalen mislukt (item ${session.item.id}): ${err.message}`));
  let tail = '';
  let checked = false;
  proc.stderr.setEncoding('utf8');
  let head = '';
  proc.stderr.on('data', (chunk) => {
    tail = (tail + chunk).slice(-4000);
    if (checked) return;
    head = (head + chunk).slice(0, 64000);
    // Pas als ffmpeg alle sporen van de invoer heeft genoemd ("Stream mapping") beslissen.
    if (!/Stream mapping:/.test(head)) return;
    checked = true;
    // Lengte van de bron (films, afleveringen). De speler toont zo meteen de echte duur en weet
    // waar hij heen kan spoelen, ook voorbij het stuk dat al is omgezet.
    const length = /Duration: (\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(head);
    if (length && !session.live) session.duration = Number(length[1]) * 3600 + Number(length[2]) * 60 + Number(length[3]);
    const video =/Stream #0:\d+[^\n]*?: Video: (\w+)/.exec(head);
    let restart = false;
    // Alleen H.264 speelt overal af. HEVC en anderen worden dus automatisch omgezet.
    if (video && !session.transcode && video[1] !== 'h264') {
      session.transcode = true;
      restart = true;
    }
    // Films en afleveringen: ingebouwde tekstondertitels meenemen (één keer opnieuw starten).
    if (!session.live && session.subtitleTracks === undefined) {
      session.subtitleTracks = parseSubtitleStreams(head);
      if (session.subtitleTracks.length) restart = true;
    }
    if (restart) {
      session.restarting = true;
      proc.kill('SIGKILL');
    }
  });
  proc.on('error', (err) => {
    session.failed = err.code === 'ENOENT' ? 'FFmpeg is niet geïnstalleerd.' : 'FFmpeg kon niet starten.';
  });
  proc.on('exit', (code) => {
    if (session.proc !== proc || session.closed) return;
    if (session.restarting) {
      session.restarting = false;
      session.restartedAt = Date.now();
      fs.rmSync(path.join(session.dir, 'index.m3u8'), { force: true });
      launch(session);
    } else if (!session.live && code !== 0 && Date.now() - (session.restartedAt ?? 0) < 20000 && (session.retries ?? 0) < 4) {
      // Net opnieuw gestart (voor omzetten of ondertitels): de provider houdt de vorige verbinding
      // soms nog een paar seconden bezet. Even wachten en het nog eens proberen.
      session.retries = (session.retries ?? 0) + 1;
      setTimeout(() => {
        if (session.closed) return;
        fs.rmSync(path.join(session.dir, 'index.m3u8'), { force: true });
        launch(session);
      }, 1500 * session.retries);
    } else if (session.failed) {
      /* ffmpeg kon niet starten; de melding staat al klaar */
    } else if (session.live) {
      restartLive(session, `${tail}\n${session.feedError ?? ''}`);
    } else if (code !== 0) {
      console.error(`FFmpeg stopte (item ${session.item.id}): ${describe(tail)}`);
      session.failed = 'De stream kon niet worden omgezet.';
    } else {
      session.finished = true;
    }
  });
}

function closeSession(session) {
  if (session.closed) return;
  session.closed = true;
  sessions.delete(session.id);
  if (byKey.get(session.key) === session) byKey.delete(session.key);
  session.proc?.kill('SIGKILL');
  session.feedAbort?.abort();
  // Op Windows blijven bestanden kort vergrendeld nadat ffmpeg is gestopt.
  setTimeout(() => fs.rm(session.dir, { recursive: true, force: true, maxRetries: 3 }, () => {}), 1000);
}

export function releaseViewer(cid) {
  const session = sessions.get(viewers.get(cid));
  viewers.delete(cid);
  if (!session) return;
  session.viewers.delete(cid);
  // De verbinding meteen vrijgeven: veel providers staan er maar één tegelijk toe.
  if (!session.viewers.size) closeSession(session);
}

setInterval(() => {
  const now = Date.now();
  for (const session of sessions.values()) {
    const limit = session.live ? VIEWER_TIMEOUT : VOD_VIEWER_TIMEOUT;
    for (const [cid, seen] of session.viewers) {
      if (now - seen > limit) {
        session.viewers.delete(cid);
        viewers.delete(cid);
      }
    }
    if (!session.viewers.size) closeSession(session);
  }
}, 5000).unref();

export const stopAllSessions = () => {
  for (const session of sessions.values()) closeSession(session);
};

async function waitUntilReady(session, cid) {
  const index = path.join(session.dir, 'index.m3u8');
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (session.failed) throw new UpstreamError(session.failed);
    if (session.closed) throw new UpstreamError('De stream is gestopt.');
    if (fs.existsSync(index)) return;
    // Wie wacht, kijkt nog. Anders ruimt de server een trage start op alsof er niemand meer is.
    if (session.viewers.has(cid)) session.viewers.set(cid, Date.now());
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new UpstreamError('De stream start niet. Probeer het opnieuw.');
}

async function startFfmpeg(item, { cid, transcode, live, start, native }) {
  await assertHostAllowed(item.url);
  const key = `${item.id}:${item.catchupKey ?? ''}:${transcode ? 't' : 'c'}:${start}`;
  let session = byKey.get(key);
  if (!session) {
    if (sessions.size >= config.maxFfmpeg) {
      throw new UpstreamError('De server is druk: er worden al te veel streams omgezet.');
    }
    const id = crypto.randomBytes(16).toString('hex');
    const dir = path.join(config.tempDir, id);
    fs.mkdirSync(dir);
    session = { id, key, dir, item, url: item.url, live, transcode, start, viewers: new Map(), startedAt: Date.now() };
    // Bij spoelen naar een nieuw punt start een nieuwe sessie vlak nadat de vorige is gesloten. De provider
    // houdt die verbinding soms nog even bezet: dan net als bij een herstart een paar keer opnieuw proberen.
    if (!live) session.restartedAt = Date.now();
    sessions.set(id, session);
    byKey.set(key, session);
    launch(session);
  }
  session.viewers.set(cid, Date.now());
  viewers.set(cid, session.id);
  try {
    await waitUntilReady(session, cid);
    if (native) await waitForSegments(session, NATIVE_SEGMENTS, cid);
  } catch (err) {
    releaseViewer(cid);
    throw err;
  }
  return {
    kind: 'hls', url: `/s/t/${session.id}/${cid}/index.m3u8`, base: start, mode: session.transcode ? 'transcode' : 'remux',
    duration: session.duration && session.duration > start ? Math.round(session.duration) : undefined,
  };
}

/** Apple's speler start stabieler als de afspeellijst al een paar segmenten bevat. */
const NATIVE_SEGMENTS = 2;

async function waitForSegments(session, count, cid) {
  const index = path.join(session.dir, 'index.m3u8');
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !session.closed && !session.failed) {
    const text = fs.existsSync(index) ? fs.readFileSync(index, 'utf8') : '';
    if ((text.match(/#EXTINF/g) ?? []).length >= count) return;
    if (session.viewers.has(cid)) session.viewers.set(cid, Date.now());
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Bepaalt welk afspeeltype past wanneer de link geen duidelijke bestandsextensie heeft. */
async function sniff(item) {
  const controller = new AbortController();
  const { res, url } = await open(item.url, { ...requestOptions(item), signal: controller.signal });
  const type = String(res.headers['content-type'] ?? '');
  let head = '';
  if (res.statusCode === 200) {
    const first = await res[Symbol.asyncIterator]().next();
    head = first.value?.subarray?.(0, 16).toString('utf8') ?? '';
  }
  controller.abort();
  res.destroy();
  return { isHls: /mpegurl/i.test(type) || head.trimStart().startsWith('#EXTM3U'), url };
}

export async function startPlayback(item, { mode, cid, start, native }) {
  if (!item.url) throw new UpstreamError('Dit item heeft geen stream.');
  releaseViewer(cid);
  const live = item.type === 'live';
  const offset = live ? 0 : Math.max(0, Math.floor(start) || 0);
  let path_ = item.url;
  try {
    path_ = new URL(item.url).pathname;
  } catch {
    throw new UpstreamError('Ongeldige streamlink.');
  }

  if (mode === 'auto') {
    if (/\.m3u8?$/i.test(path_)) {
      return { kind: 'hls', url: `/s/m/${issue(item.url, item.id)}.m3u8`, base: 0, mode: 'direct' };
    }
    if (/\.(mp4|m4v|webm)$/i.test(path_)) {
      return { kind: 'file', url: `/s/g/${issue(item.url, item.id)}`, base: 0, mode: 'direct' };
    }
    if (!/\.(ts|mkv|avi|mov|flv|wmv|mpg|mpeg)$/i.test(path_)) {
      const found = await sniff(item);
      if (found.isHls) return { kind: 'hls', url: `/s/m/${issue(found.url, item.id)}.m3u8`, base: 0, mode: 'direct' };
    }
  }
  return startFfmpeg(item, { cid, live, start: offset, transcode: mode === 'transcode', native: native && live });
}

export function withLiveStart(text) {
  if (/#EXT-X-START:/i.test(text)) return text;
  return text.replace(/^#EXTM3U[^\n]*\n/, (head) => `${head}#EXT-X-START:TIME-OFFSET=-${LIVE_DELAY}\n`);
}

/**
 * Na een herstart zet ffmpeg een naad (#EXT-X-DISCONTINUITY) in de afspeellijst, maar houdt hij
 * #EXT-X-DISCONTINUITY-SEQUENCE niet bij. Schuift de naad bovenaan uit de lijst, dan krijgen de
 * resterende segmenten ineens een ander naadnummer en keurt de speler de lijst af
 * ("discontinuity sequence mismatch"). Daarom onthoudt de server per segment zijn naadnummer en
 * zet hij de juiste DISCONTINUITY-SEQUENCE erin. `known` is een Map van segmentnaam naar nummer.
 */
export function withDiscontinuitySequence(text, known) {
  const lines = text.split('\n').filter((line) => !/^#EXT-X-DISCONTINUITY-SEQUENCE:/i.test(line));
  const segments = [];
  let seams = 0;
  for (const line of lines) {
    if (/^#EXT-X-DISCONTINUITY\s*$/i.test(line)) seams += 1;
    else if (line.trim() && !line.startsWith('#')) segments.push([line.trim(), seams]);
  }
  if (!segments.length) return text;
  const anchor = segments.find(([name]) => known.has(name));
  // Nog niets bekend (eerste keer, of lang niemand gekeken): verder tellen vanaf het hoogste nummer.
  const base = anchor ? known.get(anchor[0]) - anchor[1] : Math.max(0, ...known.values());
  for (const [name, seam] of segments) if (!known.has(name)) known.set(name, base + seam);
  // Alleen de recente segmenten bewaren.
  if (known.size > 400) for (const name of [...known.keys()].slice(0, known.size - 200)) known.delete(name);
  const at = lines.findIndex((line) => /^#EXT-X-MEDIA-SEQUENCE:/i.test(line));
  lines.splice(at >= 0 ? at + 1 : 1, 0, `#EXT-X-DISCONTINUITY-SEQUENCE:${base}`);
  return lines.join('\n');
}

export function serveFfmpegFile(req, res) {
  const { sid, cid, file } = req.params;
  const session = sessions.get(sid);
  if (!session || !/^(index\.m3u8|seg\d{5}\.ts)$/.test(file) || !/^[a-zA-Z0-9-]{8,64}$/.test(cid)) {
    return res.status(404).json({ error: 'Niet gevonden.' });
  }
  session.viewers.set(cid, Date.now());
  viewers.set(cid, sid);
  res.set('Cache-Control', 'no-store');
  res.type(file.endsWith('.ts') ? 'video/mp2t' : 'application/vnd.apple.mpegurl');
  if (session.live && file === 'index.m3u8') {
    // EXT-X-START laat zowel hls.js als de iPhone-speler LIVE_DELAY seconden achter live beginnen.
    return fs.promises.readFile(path.join(session.dir, file), 'utf8')
      .then((text) => res.send(withLiveStart(withDiscontinuitySequence(text, session.seams ??= new Map()))))
      .catch(() => res.status(404).end());
  }
  res.sendFile(path.join(session.dir, file), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
}

/**
 * Wat er nu speelt, voor de statuspagina. `provider` zegt of de server daarvoor op dit moment
 * een verbinding met de provider openhoudt (een film die al helemaal is omgezet doet dat niet meer).
 */
export function playbackStatus() {
  const now = Date.now();
  const list = [];
  for (const s of sessions.values()) {
    if (s.closed) continue;
    list.push({
      itemId: s.item.id, name: s.item.name, type: s.item.type,
      mode: s.live ? 'live' : s.transcode ? 'transcode' : 'remux',
      since: s.startedAt ?? now, cids: [...s.viewers.keys()],
      provider: !s.finished && !s.failed, failed: s.failed ?? null,
    });
  }
  for (const [id, d] of direct) {
    if (!d.open && now - d.last > 30000) {
      direct.delete(id);
      continue;
    }
    list.push({
      itemId: id, name: d.item.name, type: d.item.type, mode: 'direct',
      since: d.since, cids: null, provider: d.open > 0 || now - d.last < 10000, failed: null,
    });
  }
  return list;
}

/** Welke ingebouwde ondertitels deze sessie heeft (taal per spoor). */
export function serveSubtitleList(req, res) {
  const session = sessions.get(req.params.sid);
  if (!session) return res.status(404).json({ error: 'Niet gevonden.' });
  res.set('Cache-Control', 'no-store').json({
    tracks: (session.subtitleTracks ?? []).map((t, n) => ({ n, lang: t.lang, codec: t.codec })),
    done: Boolean(session.finished),
  });
}

/** De regels van één ingebouwd ondertitelspoor. Tijdens het omzetten groeit het bestand nog. */
export async function serveSubtitleCues(req, res) {
  const session = sessions.get(req.params.sid);
  const n = Number(req.params.n);
  if (!session || !Number.isInteger(n) || !session.subtitleTracks?.[n]) return res.status(404).json({ error: 'Niet gevonden.' });
  let text = '';
  try {
    text = await fs.promises.readFile(path.join(session.dir, `sub${n}.vtt`), 'utf8');
  } catch { /* nog niet aangemaakt */ }
  res.set('Cache-Control', 'no-store').json({ cues: parseCues(text), done: Boolean(session.finished) });
}

export function serveLogo(req, res) {
  const item = getItem.get(Number(req.params.id));
  if (!item?.logo) return res.status(404).end();
  return serveImage(res, item, item.logo);
}

/** Grote achtergrondafbeelding van een film of serie (via de server, net als de logo's). */
export function serveBackdrop(req, res) {
  const item = getItem.get(Number(req.params.id));
  if (!item?.backdrop || item.backdrop === '-') return res.status(404).end();
  return serveImage(res, item, item.backdrop);
}

function serveImage(res, item, link) {
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  return open(link, { ...requestOptions(item), signal: controller.signal, timeout: 10000 }).then(async ({ res: upstream }) => {
    const type = String(upstream.headers['content-type'] ?? '');
    const size = Number(upstream.headers['content-length'] ?? 0);
    if (upstream.statusCode !== 200 || !/^image\/(png|jpe?g|webp|gif|avif)/i.test(type) || size > 8e6) {
      upstream.resume();
      return res.status(404).end();
    }
    res.set({ 'Content-Type': type, 'Cache-Control': 'private, max-age=86400' });
    await pipeline(upstream, res).catch(() => {});
  }).catch(() => {
    if (!res.headersSent) res.status(404).end();
  });
}

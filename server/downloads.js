// Downloaden voor offline kijken: de server zet een film of aflevering om naar een gewone mp4
// (beeld gekopieerd, geluid naar stereo AAC), die op telefoons en laptops afspeelt. Daarna kan de
// gebruiker hem opslaan. Eén tegelijk, want de provider staat vaak maar één verbinding toe.
// Klaargezette bestanden blijven een dag staan en worden daarna opgeruimd.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { db } from './db.js';
import { assertHostAllowed, UpstreamError } from './upstream.js';

const DIR = path.join(config.tempDir, 'downloads');
const KEEP_MS = 24 * 60 * 60 * 1000;
const MAX_READY = 3;
const getSourceUa = db.prepare('SELECT user_agent FROM sources WHERE id = ?');

/** Per item: { itemId, name, state: 'working' | 'ready' | 'failed', progress, size, error, finishedAt } */
const jobs = new Map();
let running = null;

fs.rmSync(DIR, { recursive: true, force: true });

export function downloadSettings() {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'downloads'`).get();
  let enabled = true;
  try {
    if (row) enabled = JSON.parse(row.value).enabled !== false;
  } catch { /* standaard aan */ }
  return { enabled };
}

export function saveDownloadSettings({ enabled }) {
  const value = JSON.stringify({ enabled: enabled !== false });
  db.prepare(`INSERT INTO settings (key, value) VALUES ('downloads', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(value);
  return downloadSettings();
}

/** Bestandsnaam voor de gebruiker: de titel zonder providertekens. */
export function downloadName(name) {
  const clean = String(name ?? '')
    .replace(/[┃|]\s*[A-Z]{2,3}\s*[┃|]/g, ' ')
    .replace(/[^\p{L}\p{N} ().,'&-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return `${clean || 'Kijkbox'}.mp4`;
}

const view = (job) => job && {
  itemId: job.itemId, name: job.name, state: job.state,
  progress: Math.round((job.progress ?? 0) * 100) / 100, size: job.size ?? 0, error: job.error ?? null,
};

export function downloadStatus(itemId) {
  return view(jobs.get(itemId)) ?? { itemId, state: 'none' };
}

export async function startDownload(item) {
  if (!downloadSettings().enabled) throw new UpstreamError('Downloaden staat uit. De beheerder kan het aanzetten bij Instellingen.');
  if (item.type !== 'movie' && item.type !== 'episode') throw new UpstreamError('Alleen films en afleveringen kun je downloaden.');
  if (!item.url) throw new UpstreamError('Dit item heeft geen stream.');
  const existing = jobs.get(item.id);
  if (existing && existing.state !== 'failed') return view(existing);
  if (running) {
    throw new UpstreamError(`Er wordt al iets klaargezet: ${running.name} (${Math.round(running.progress * 100)}%). Probeer het daarna nog eens.`);
  }
  await assertHostAllowed(item.url);
  fs.mkdirSync(DIR, { recursive: true });
  const job = {
    itemId: item.id, item, name: downloadName(item.name).replace(/\.mp4$/, ''), state: 'working', progress: 0,
    file: path.join(DIR, `${item.id}.mp4`), tmp: path.join(DIR, `${item.id}.part.mp4`), transcode: false, tag: false,
  };
  jobs.set(item.id, job);
  running = job;
  launch(job);
  return view(job);
}

function launch(job) {
  const { item } = job;
  const userAgent = item.user_agent || getSourceUa.get(item.source_id)?.user_agent || config.userAgent;
  const args = ['-hide_banner', '-nostdin', '-user_agent', userAgent];
  if (item.referer) args.push('-headers', `Referer: ${item.referer}\r\n`);
  args.push('-reconnect', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '10',
    '-fflags', '+genpts+discardcorrupt', '-protocol_whitelist', 'http,https,tcp,tls,crypto,hls', '-i', item.url, '-map', '0:v:0?', '-map', '0:a:0?');
  if (job.transcode) {
    args.push('-vf', "yadif=mode=0:parity=-1:deint=1,scale=-2:'min(1080,ih)',format=yuv420p",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23');
  } else {
    args.push('-c:v', 'copy');
    // HEVC speelt op Apple-toestellen alleen af met dit label.
    if (job.tag) args.push('-tag:v', 'hvc1');
  }
  args.push('-c:a', 'aac', '-ac', '2', '-b:a', '160k', '-movflags', '+faststart', '-f', 'mp4', '-y', job.tmp);
  const proc = spawn(config.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  job.proc = proc;
  let head = '';
  let tail = '';
  let checked = false;
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk) => {
    tail = (tail + chunk).slice(-3000);
    if (!checked) {
      head = (head + chunk).slice(0, 64000);
      if (/Stream mapping:/.test(head)) {
        checked = true;
        const length = /Duration: (\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(head);
        if (length) job.duration = Number(length[1]) * 3600 + Number(length[2]) * 60 + Number(length[3]);
        const codec = /Stream #0:\d+[^\n]*?: Video: (\w+)/.exec(head)?.[1];
        // Alleen H.264 (en HEVC met het juiste label) speelt overal af; anders het beeld omzetten.
        if (!job.transcode && codec && codec !== 'h264') {
          if (codec === 'hevc' && !job.tag) job.tag = true;
          else if (codec !== 'hevc') job.transcode = true;
          if (job.tag || job.transcode) {
            job.restart = true;
            proc.kill('SIGKILL');
            return;
          }
        }
      }
    }
    const times = [...chunk.matchAll(/time=(\d+):(\d\d):(\d\d(?:\.\d+)?)/g)];
    const last = times.at(-1);
    if (last && job.duration) {
      const at = Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
      job.progress = Math.max(0, Math.min(0.99, at / job.duration));
    }
  });
  proc.on('error', () => finish(job, false, 'FFmpeg kon niet starten.'));
  proc.on('exit', (code) => {
    if (job.proc !== proc) return;
    if (job.restart) {
      job.restart = false;
      launch(job);
      return;
    }
    if (code === 0 && fs.existsSync(job.tmp)) {
      fs.renameSync(job.tmp, job.file);
      finish(job, true);
    } else {
      const reason = tail.split('\n').filter(Boolean).slice(-1)[0]?.replace(/https?:\/\/\S+/g, '[link]') ?? '';
      console.error(`Download mislukt (item ${item.id}): ${reason}`);
      finish(job, false, 'Het klaarzetten is mislukt. Kijkt er misschien iemand? Je provider staat vaak maar één verbinding toe.');
    }
  });
}

function finish(job, ok, error) {
  if (job.state !== 'working') return;
  job.proc = null;
  job.finishedAt = Date.now();
  if (running === job) running = null;
  if (ok) {
    job.state = 'ready';
    job.progress = 1;
    job.size = fs.statSync(job.file).size;
    cleanup();
  } else {
    job.state = 'failed';
    job.error = error;
    fs.rmSync(job.tmp, { force: true });
  }
}

/** Oude downloads opruimen: na een dag, en nooit meer dan een paar tegelijk op de schijf. */
function cleanup() {
  const now = Date.now();
  const ready = [...jobs.values()].filter((j) => j.state === 'ready').sort((a, b) => b.finishedAt - a.finishedAt);
  for (const [index, job] of ready.entries()) {
    if (index >= MAX_READY || now - job.finishedAt > KEEP_MS) {
      fs.rmSync(job.file, { force: true });
      jobs.delete(job.itemId);
    }
  }
  for (const job of jobs.values()) {
    if (job.state === 'failed' && now - job.finishedAt > KEEP_MS) jobs.delete(job.itemId);
  }
}
setInterval(cleanup, 10 * 60 * 1000).unref();

/** Het klaargezette bestand naar de gebruiker sturen (met Range, zodat telefoons het goed oppakken). */
export function serveDownload(req, res, itemId) {
  const job = jobs.get(itemId);
  if (!job || job.state !== 'ready' || !fs.existsSync(job.file)) return res.status(404).json({ error: 'Deze download staat niet (meer) klaar.' });
  res.download(job.file, `${job.name}.mp4`);
}

export const stopDownloads = () => {
  for (const job of jobs.values()) job.proc?.kill('SIGKILL');
};

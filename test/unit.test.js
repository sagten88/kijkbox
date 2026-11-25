import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kijkbox-test-'));

const { parseExtinf, parseM3U, classify, xtreamBase } = await import('../server/sources.js');
const { parseXmltvDate, parseProgramme, decodeXml } = await import('../server/epg.js');
const { rewriteManifest, withLiveStart, withDiscontinuitySequence, LIVE_DELAY, firstVideoPts } = await import('../server/stream.js');

test('live-afspeellijst: naadnummer blijft kloppen als de naad uit de lijst schuift', () => {
  // Precies wat ffmpeg schrijft: na een herstart een naad, die later bovenaan wegvalt.
  const head = (seq) => `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:${seq}\n`;
  const seg = (n, seam = false) => `${seam ? '#EXT-X-DISCONTINUITY\n' : ''}#EXTINF:1.000000,\nseg0000${n}.ts\n`;
  const known = new Map();
  const dseq = (text) => Number(/#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)/.exec(withDiscontinuitySequence(text, known))[1]);
  assert.equal(dseq(head(0) + seg(0) + seg(1) + seg(2) + seg(3)), 0);
  assert.equal(dseq(head(2) + seg(2) + seg(3) + seg(4, true) + seg(5)), 0);
  // De naad voor seg4 is weg; seg5 hoort nog steeds bij naad 1.
  assert.equal(dseq(head(5) + seg(5) + seg(6, true) + seg(7) + seg(8)), 1);
  assert.equal(known.get('seg00005.ts'), 1);
  assert.equal(known.get('seg00006.ts'), 2);
  // Het nummer staat direct na MEDIA-SEQUENCE en niet dubbel.
  const out = withDiscontinuitySequence(head(5) + seg(5) + seg(6, true), known);
  assert.equal(out.split('\n')[4], '#EXT-X-DISCONTINUITY-SEQUENCE:1');
  assert.equal(withDiscontinuitySequence(out, known).match(/DISCONTINUITY-SEQUENCE/g).length, 1);
});

test('live-afspeellijst start ruim achter live', () => {
  const list = '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:4\n#EXTINF:3.84,\nseg00001.ts\n';
  const out = withLiveStart(list);
  assert.equal(out.split('\n')[1], `#EXT-X-START:TIME-OFFSET=-${LIVE_DELAY}`);
  assert.equal(withLiveStart(out), out, 'niet dubbel toevoegen');
  assert.equal(withLiveStart(''), '', 'lege of half geschreven lijst blijft ongemoeid');
});
const { TsDedupe, ptsAfter } = await import('../server/tsdedupe.js');

// Bouwt TS-pakketten: PAT (PMT op PID 0x1000), en PES-pakketten met een PTS.
function tsPacket(pid, { pusi = false, payload = Buffer.alloc(0), cc = 0 } = {}) {
  const p = Buffer.alloc(188, 0xff);
  p[0] = 0x47; p[1] = (pusi ? 0x40 : 0) | ((pid >> 8) & 0x1f); p[2] = pid & 0xff; p[3] = 0x10 | (cc & 0x0f);
  payload.copy(p, 4);
  return p;
}
const pat = () => tsPacket(0, { pusi: true, payload: Buffer.from([0, 0x00, 0xb0, 0x0d, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00, 0, 0, 0, 0]) });
function pes(pid, streamId, pts, cc) {
  const h = Buffer.from([0, 0, 1, streamId, 0, 0, 0x80, 0x80, 5,
    0x21 | ((Math.floor(pts / 2 ** 30) & 7) << 1), (pts >> 22) & 0xff, ((pts >> 14) & 0xfe) | 1, (pts >> 7) & 0xff, ((pts << 1) & 0xfe) | 1]);
  return tsPacket(pid, { pusi: true, payload: h, cc });
}
const frames = (from, to, startCc = 0) => {
  const out = [];
  for (let n = from, cc = startCc; n <= to; n += 1) {
    out.push(pes(0x100, 0xe0, n * 1800, cc++), tsPacket(0x100, { cc: cc++ }), pes(0x101, 0xc0, n * 1800 + 10, n));
  }
  return Buffer.concat(out);
};
function ptsOf(buf) {
  const seen = [];
  for (let i = 0; i + 188 <= buf.length; i += 188) {
    const p = buf.subarray(i, i + 188);
    if (((p[1] & 0x1f) << 8 | p[2]) === 0x100 && p[1] & 0x40) seen.push(Math.round((((p[13] >> 1) & 7) * 2 ** 30 + ((p[14] << 22) | ((p[15] >> 1) << 15) | (p[16] << 7) | (p[17] >> 1))) / 1800));
  }
  return seen;
}

test('Live-TS: herhaalde video na een nieuwe verbinding wordt overgeslagen', () => {
  const d = new TsDedupe();
  // De verbinding breekt af midden in beeld 10: alleen het eerste pakket ervan komt binnen.
  const cut = Buffer.concat([pat(), frames(1, 10)]);
  const first = d.push(cut.subarray(0, cut.length - 2 * 188));
  d.reconnect();
  // De provider stuurt na het verbinden frames 6..10 nog een keer, daarna 11..16. Half pakket in het midden.
  const replay = Buffer.concat([pat(), frames(6, 16, 3)]);
  const second = Buffer.concat([d.push(replay.subarray(0, 1000)), d.push(replay.subarray(1000))]);
  // Elk beeld precies één keer, en beeld 10 heel (uit de herhaling). Beeld 16 wacht nog op zijn opvolger.
  assert.deepEqual([...ptsOf(first), ...ptsOf(second)], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  const ten = [];
  for (let i = 0; i < second.length; i += 188) if (((second[i + 1] & 0x1f) << 8 | second[i + 2]) === 0x100) ten.push(second[i + 1] & 0x40 ? 'start' : 'vervolg');
  assert.deepEqual(ten.slice(0, 2), ['start', 'vervolg'], 'beeld 10 compleet');
  // Pakkettellers van de video lopen door, zonder gat.
  const all = Buffer.concat([first, second]);
  const cc = [];
  for (let i = 0; i < all.length; i += 188) if (((all[i + 1] & 0x1f) << 8 | all[i + 2]) === 0x100) cc.push(all[i + 3] & 0x0f);
  assert.ok(cc.every((v, i) => i === 0 || v === ((cc[i - 1] + 1) & 15)), `tellers: ${cc.join(',')}`);
  assert.ok(d.droppedBytes >= 4 * 3 * 188, `overgeslagen: ${d.droppedBytes}`);
});

test('Live-TS: B-frames (PTS niet op volgorde) blijven allemaal behouden', () => {
  const stamp = (v, marker) => [marker | ((Math.floor(v / 2 ** 30) & 7) << 1) | 1, (v >> 22) & 0xff, ((v >> 14) & 0xfe) | 1, (v >> 7) & 0xff, ((v << 1) & 0xfe) | 1];
  // Decodeervolgorde I P B B: DTS 0,1,2,3 en PTS 1,4,2,3 (de P wordt later getoond dan de B's).
  const order = [[0, 1], [1, 4], [2, 2], [3, 3], [4, 7], [5, 5], [6, 6], [7, 8]];
  const packets = order.map(([dts, pts], n) => tsPacket(0x100, {
    pusi: true, cc: n, payload: Buffer.from([0, 0, 1, 0xe0, 0, 0, 0x80, 0xc0, 10, ...stamp(pts * 1800, 0x30), ...stamp(dts * 1800, 0x10)]),
  }));
  const d = new TsDedupe();
  const out = d.push(Buffer.concat([pat(), ...packets]));
  assert.equal(out.length / 188 - 1, order.length - 1, 'alle beelden behalve het laatste (wacht op opvolger)');
  assert.equal(d.droppedBytes, 0);
});

test('Live-TS: echt opnieuw begonnen tijdlijn wordt na een tijd geaccepteerd', () => {
  let t = 0;
  const d = new TsDedupe({ now: () => t });
  // 1 eenheid = 1800 ticks = 1/50 s. 3000 eenheden = 60 s: een (trage) herhaling, niet accepteren...
  d.push(Buffer.concat([pat(), frames(3000, 3005)]));
  d.reconnect();
  assert.deepEqual(ptsOf(d.push(frames(1, 3))), []);
  t = 30000;
  assert.deepEqual(ptsOf(d.push(frames(4, 6))), [], 'na 30 s nog steeds een herhaling');
  t = 91000;
  assert.deepEqual(ptsOf(d.push(frames(7, 10))), [7, 8, 9], '... pas na 90 s accepteren');
  // Meer dan 3 minuten terug is meteen een nieuwe tijdlijn.
  const e = new TsDedupe({ now: () => 0 });
  e.push(Buffer.concat([pat(), frames(20000, 20002)]));
  e.reconnect();
  assert.deepEqual(ptsOf(e.push(frames(1, 4))), [1, 2, 3]);
  assert.ok(ptsAfter(5, 2 ** 33 - 10), 'over de overloop heen');
  assert.ok(!ptsAfter(2 ** 33 - 10, 5));
});

test('Live-TS: geen MPEG-TS wordt ongemoeid doorgegeven', () => {
  const d = new TsDedupe();
  const junk = Buffer.alloc(600 * 1024, 0x11);
  const out = d.push(junk);
  assert.ok(d.passthrough && out.length > 0);
});
const { titleKey, langRank } = await import('../server/titles.js');

test('Back-up: terugzetten, ook als de bron nog niet opnieuw is ingelezen', async () => {
  const { db } = await import('../server/db.js');
  const { createBackup, readBackup, restoreBackup, applyPendingRestore } = await import('../server/backup.js');
  const now = Date.now();
  db.prepare(`INSERT INTO users (id, username, password_hash, role, created_at) VALUES (901, 'bk-admin', 'x', 'admin', ?), (902, 'bk-kijker', 'y', 'viewer', ?)`).run(now, now);
  db.prepare(`INSERT INTO sources (id, name, type, url) VALUES (901, 'Back-uptest', 'm3u', 'http://voorbeeld.test/lijst.m3u')`).run();
  const addItem = db.prepare(`INSERT INTO items (source_id, ext_key, type, name, name_lc, url) VALUES (901, ?, 'movie', ?, ?, 'http://voorbeeld.test/f.mp4') RETURNING id`);
  const a = addItem.get('film:1', 'Film A', 'film a').id;
  const b = addItem.get('film:2', 'Film B', 'film b').id;
  db.prepare('INSERT INTO favorites (user_id, item_id, created_at) VALUES (902, ?, ?)').run(a, now);
  db.prepare('INSERT INTO progress (user_id, item_id, position, duration, updated_at) VALUES (902, ?, 600, 5400, ?)').run(b, now);
  db.prepare(`INSERT INTO user_hidden (user_id, kind, value) VALUES (902, 'country', 'DE')`).run();
  const saved = createBackup('test');
  const data = readBackup(saved.name);
  assert.equal(data.favorites.find((f) => f.user_id === 902).ext_key, 'film:1');

  // Alles weg, alsof het misging; daarna terugzetten.
  db.prepare('DELETE FROM favorites WHERE user_id = 902').run();
  db.prepare(`UPDATE users SET theme = 'rood' WHERE id = 902`).run();
  const result = restoreBackup(data);
  assert.equal(result.favorites, 1);
  assert.equal(result.waiting, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM favorites WHERE user_id = 902').get().n, 1);
  assert.equal(db.prepare('SELECT position FROM progress WHERE user_id = 902').get().position, 600);
  assert.equal(db.prepare('SELECT theme FROM users WHERE id = 902').get().theme, '');

  // Nieuwe server: de films bestaan nog niet. Na het inlezen worden ze alsnog gekoppeld.
  db.prepare('DELETE FROM items WHERE source_id = 901').run();
  const fresh = restoreBackup(data);
  assert.equal(fresh.waiting, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM favorites WHERE user_id = 902').get().n, 0);
  addItem.get('film:1', 'Film A', 'film a');
  addItem.get('film:2', 'Film B', 'film b');
  applyPendingRestore();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM favorites WHERE user_id = 902').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM progress WHERE user_id = 902').get().n, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM settings WHERE key = 'restore_pending'`).get().n, 0);

  assert.throws(() => restoreBackup({ format: 'iets anders' }), /geen Kijkbox-back-up/);
});
const { isLocalAddress, trustProxyValue } = await import('../server/network.js');

test('Alleen thuisnetwerk: lokale adressen herkennen', () => {
  for (const ip of ['127.0.0.1', '::1', '192.168.1.24', '::ffff:192.168.1.5', '10.0.0.9', '172.20.0.2', '100.64.1.20', 'fd00::1', 'fe80::1']) {
    assert.equal(isLocalAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '::ffff:84.10.1.2', '2a02:a46f::1', '172.32.0.1', '', undefined, 'onzin']) {
    assert.equal(isLocalAddress(ip), false, String(ip));
  }
  assert.equal(trustProxyValue('192.168.1.5'), '192.168.1.5');
  assert.equal(trustProxyValue('1'), 1);
  assert.equal(trustProxyValue(''), false);
});

test('Eén kaart per titel: zelfde film in andere talen herkennen', () => {
  const same = ['┃NL┃ Gladiator II (2024)', '┃DE┃Gladiator II', '┃USA┃ Gladiator II 4K', '|FR| Gladiator II - 2024', '┃AR┃ Gladiator II  4K', '┃NL┃ Gladiator II HEVC'];
  assert.deepEqual([...new Set(same.map(titleKey))], ['gladiator ii']);
  assert.notEqual(titleKey('┃NL┃ Gladiator (2000)'), titleKey('┃NL┃ Gladiator II (2024)'));
  assert.equal(titleKey('┃FR┃ Amélie'), titleKey('┃NL┃ Amelie'));
  assert.equal(titleKey('┃EN┃ Fast & Furious'), 'fast and furious');
  assert.deepEqual(['┃NL┃ NETFLIX', '┃EN┃ ACTION', '┃USA┃ X', '┃DE┃ KINO'].map(langRank), [0, 1, 1, 2]);
});
const { parseCues, cleanTitle, queryString } = await import('../server/subtitles.js');

test('Ondertitels: SRT en WebVTT inlezen', () => {
  const srt = '﻿1\r\n00:00:01,500 --> 00:00:03,000\r\n<i>Hallo</i> <font color="red">daar</font>\r\n\r\n2\r\n01:02:03,040 --> 01:02:05,000\r\n{\\an8}Boven\r\n\r\n3\r\n00:00:09,000 --> 00:00:10,000\r\n\r\n';
  assert.deepEqual(parseCues(srt), [
    { start: 1.5, end: 3, text: '<i>Hallo</i> daar' },
    { start: 3723.04, end: 3725, text: 'Boven' },
  ]);
  const vtt = 'WEBVTT\n\n00:05.250 --> 00:07.000 line:90%\nKort formaat\n';
  assert.deepEqual(parseCues(vtt), [{ start: 5.25, end: 7, text: 'Kort formaat' }]);
});

test('Ondertitels: titel opschonen en zoekvolgorde', () => {
  assert.equal(cleanTitle('┃NL┃ Gladiator II (2024)'), 'Gladiator II');
  assert.equal(cleanTitle('┃USA┃ Oppenheimer 4K HEVC'), 'Oppenheimer');
  assert.equal(queryString({ tmdb_id: '558449', languages: 'en,nl', query: '' }), 'languages=en%2Cnl&tmdb_id=558449');
});
const { ipAllowed, parseMediaUrl } = await import('../server/upstream.js');
const { seal, unseal, hashPassword, verifyPassword, validUsername } = await import('../server/auth.js');

test('EXTINF met komma in een attribuut en in de naam', () => {
  const { attrs, title } = parseExtinf('#EXTINF:-1 tvg-id="a.b" group-title="Sport, NL" tvg-logo="http://x/y.png",Ziggo Sport, HD');
  assert.equal(attrs['tvg-id'], 'a.b');
  assert.equal(attrs['group-title'], 'Sport, NL');
  assert.equal(title, 'Ziggo Sport, HD');
});

test('M3U leest kop, opties en slaat onbruikbare links over', async () => {
  const lines = [
    '﻿#EXTM3U url-tvg="http://gids/x.xml"',
    '#EXTINF:-1 group-title="A",Een',
    '#EXTVLCOPT:http-user-agent=Test/1.0',
    '#EXTVLCOPT:http-referrer=http://ref/',
    'http://bron/een.m3u8',
    '#EXTINF:-1,Kapot',
    'rtmp://bron/kapot',
    '#EXTINF:-1,Twee',
    '#EXTGRP:B',
    'http://bron/twee.ts',
  ];
  const out = [];
  for await (const entry of parseM3U(lines)) out.push(entry);
  assert.equal(out[0].epgUrl, 'http://gids/x.xml');
  assert.equal(out.length, 3);
  assert.deepEqual([out[1].name, out[1].grp, out[1].user_agent, out[1].referer], ['Een', 'A', 'Test/1.0', 'http://ref/']);
  assert.equal(out[2].user_agent, undefined);
  assert.deepEqual([out[2].name, out[2].grp], ['Twee', 'B']);
});

test('Soort bepalen aan de hand van link en naam', () => {
  assert.equal(classify('http://x/live/1.m3u8', 'NL', 'NPO 1'), 'live');
  assert.equal(classify('http://x/film.mkv', 'NL', 'Film'), 'movie');
  assert.equal(classify('http://x/movie/u/p/1.mp4', 'NL', 'Film'), 'movie');
  assert.equal(classify('http://x/series/u/p/1.mp4', 'NL', 'Show S02E03'), 'episode');
  assert.equal(classify('http://x/1', 'VOD | Actie', 'Film'), 'movie');
});

test('Xtream-import: lege filmlijst wordt opnieuw geprobeerd en bestaande films blijven staan', { timeout: 30000 }, async (t) => {
  const http = await import('node:http');
  const { config } = await import('../server/config.js');
  const { db } = await import('../server/db.js');
  const { refreshSource } = await import('../server/sources.js');
  config.allowLocalMedia = true;

  let vodCalls = 0;
  let serveMovies = true;
  const server = http.createServer((req, res) => {
    const action = new URL(req.url, 'http://x').searchParams.get('action');
    const replies = {
      get_live_categories: [{ category_id: '1', category_name: 'Live' }],
      get_live_streams: [{ stream_id: 1, name: 'Zender', category_id: '1' }],
      get_vod_categories: [{ category_id: '2', category_name: 'Films' }],
      get_series_categories: [],
    };
    if (action === 'get_vod_streams') {
      vodCalls += 1;
      const movies = serveMovies && vodCalls > 1 ? [{ stream_id: 9, name: 'Film', category_id: '2', container_extension: 'mkv', added: '1' }] : [];
      return res.end(JSON.stringify(movies));
    }
    res.end(JSON.stringify(action ? replies[action] ?? [] : { user_info: { auth: 1 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.close();
    config.allowLocalMedia = false;
  });

  const { lastInsertRowid } = db.prepare(`INSERT INTO sources (name, type, url, username, password, stream_format)
    VALUES ('t', 'xtream', ?, 'u', 'p', 'ts')`).run(`http://127.0.0.1:${server.address().port}`);
  const id = Number(lastInsertRowid);
  const count = () => db.prepare(`SELECT COUNT(*) AS n FROM items WHERE source_id = ? AND type = 'movie'`).get(id).n;
  const source = () => db.prepare('SELECT status, last_error FROM sources WHERE id = ?').get(id);

  await refreshSource(id);
  assert.equal(vodCalls, 2, 'tweede poging haalt de films alsnog op');
  assert.equal(count(), 1);
  assert.equal(source().last_error, '');
  const url = db.prepare(`SELECT url FROM items WHERE source_id = ? AND type = 'live'`).get(id).url;
  assert.ok(url.endsWith('/1.ts'));

  serveMovies = false;
  await refreshSource(id);
  assert.equal(count(), 1, 'bestaande films blijven staan als de provider niets geeft');
  assert.deepEqual([source().status, source().last_error.includes('films')], ['ok', true]);
});

test('Land uit de groepsnaam halen, in de vormen die providers gebruiken', async () => {
  const { countryOf, withoutCountry, OTHER } = await import('../server/countries.js');
  const cases = [
    ['┃NL┃ VIAPLAY F1', 'NL', 'VIAPLAY F1'],
    ['┃ HINDI┃ INDIA', 'HINDI', 'INDIA'],
    ['┃CA EN┃ NEWS', 'CA EN', 'NEWS'],
    ['┃IT┃ ITALIA HD | RIGIOCARE ⏺', 'IT', 'ITALIA HD | RIGIOCARE ⏺'],
    ['[NL] Viaplay', 'NL', 'Viaplay'],
    ['|BE| Sport', 'BE', 'Sport'],
    ['(DE) Kino', 'DE', 'Kino'],
    ['NL | Sport', 'NL', 'Sport'],
    ['UK: News', 'UK', 'News'],
    ['┃US┃ LOCAL', 'USA', 'LOCAL'],
    ['┃NL┃', 'NL', '┃NL┃'],
  ];
  for (const [group, code, rest] of cases) {
    assert.equal(countryOf(group), code, group);
    assert.equal(withoutCountry(group), rest, group);
  }
  for (const group of ['RADIO', 'FOR ADULTS', 'Overig', 'HD - Sport', 'NEWS | World', '┃sport┃ x', '']) {
    assert.equal(countryOf(group), OTHER, group);
    assert.equal(withoutCountry(group), group);
  }
});

test('Landenlijst: Nederland bovenaan, Overig onderaan, zelfde land samengevoegd', async () => {
  const { countryList, firstCountryOnTop, groupsOfCountry } = await import('../server/countries.js');
  const groups = [
    { name: '┃AL┃ ALBANIA', count: 5 }, { name: '┃DE┃ KINO', count: 3 }, { name: 'RADIO', count: 9 },
    { name: '┃NL┃ BASIS', count: 2 }, { name: '┃NL┃ SPORT', count: 4 }, { name: '┃US┃ A', count: 1 }, { name: '┃USA┃ B', count: 1 },
    { name: '┃ZZ┃ ONBEKEND', count: 1 },
  ];
  const list = countryList(groups);
  assert.deepEqual(list.map((c) => c.label), ['Nederland', 'Albanië', 'Duitsland', 'Verenigde Staten', 'ZZ', 'Overig']);
  assert.equal(list[0].count, 6);
  assert.equal(list.find((c) => c.code === 'USA').count, 2);
  assert.deepEqual(groupsOfCountry(groups, 'USA'), ['┃US┃ A', '┃USA┃ B']);
  assert.deepEqual(firstCountryOnTop(groups).slice(0, 3).map((g) => g.name), ['┃NL┃ BASIS', '┃NL┃ SPORT', '┃AL┃ ALBANIA']);
  // Films en series: Engelstalig direct na Nederland.
  const films = countryList([...groups, { name: '┃EN┃ ACTION', count: 7 }], { englishSecond: true });
  assert.deepEqual(films.map((c) => c.code).slice(0, 3), ['NL', 'EN', 'USA']);
  assert.equal(films.at(-1).code, 'OVERIG');
});

test('Live-afspeellijst: geen herstart-instelling bij de eerste start', () => {
  const code = fs.readFileSync(new URL('../server/stream.js', import.meta.url), 'utf8');
  assert.ok(!code.includes('discont_start'), 'discont_start geeft dubbele regels die Apple niet accepteert');
  assert.ok(code.includes("session.relaunch && 'append_list'"));
});

test('Releasejaar uit filmtitels', async () => {
  const { releaseYear } = await import('../server/years.js');
  const now = new Date('2026-11-07');
  const cases = [
    ['┃NL┃ Musk - 2026', '2026'],
    ['┃NL┃ Heart of the Beast - 2026', '2026'],
    ['┃NL┃ Possible Love  [가능한 사랑 (2026)', '2026'],
    ['2012 (2009)', '2009'],
    ['┃NL┃ Tuzlu Kahve [Salted Love] (2026)', '2026'],
    ['Oppenheimer 2023', '2023'],
    ['┃NL┃ WWE NXT 2026-11-04', ''],
    ['AEW Dynamite 2026.11.04', ''],
    ['Blade Runner 2049', ''],
    ['Space Odyssey (2036)', ''],
    ['1917', ''],
    ['De Film Zonder Jaar', ''],
    ['', ''],
  ];
  for (const [name, year] of cases) assert.equal(releaseYear(name, now), year, name);
  assert.equal(releaseYear('Film (2027)', now), '2027', 'volgend jaar mag, voor aangekondigde films');
});

test('Website gebruikt geen functies die alleen op https bestaan', () => {
  const code = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  for (const api of ['randomUUID', 'crypto.subtle', 'navigator.clipboard', 'serviceWorker']) {
    assert.ok(!code.includes(api), api);
  }
});

test('Xtream-adres opschonen', () => {
  assert.equal(xtreamBase({ url: 'http://x:8080/' }), 'http://x:8080');
  assert.equal(xtreamBase({ url: 'http://x:8080/player_api.php?username=a' }), 'http://x:8080');
});

test('XMLTV-tijden en tijdzones', () => {
  assert.equal(parseXmltvDate('20261106120000 +0000'), Date.UTC(2026, 10, 6, 12));
  assert.equal(parseXmltvDate('20261106130000 +0100'), Date.UTC(2026, 10, 6, 12));
  assert.equal(parseXmltvDate('20261106083000 -0330'), Date.UTC(2026, 10, 6, 12));
  assert.equal(parseXmltvDate('onzin'), null);
});

test('XMLTV-programma en tekens', () => {
  const p = parseProgramme(' start="20261106120000 +0000" stop="20261106130000 +0000" channel="a&amp;b"',
    '<title lang="nl">Tom &amp; Jerry</title><desc><![CDATA[Kat <3 muis]]></desc>');
  assert.deepEqual([p.channel, p.title, p.descr], ['a&b', 'Tom & Jerry', 'Kat <3 muis']);
  assert.equal(decodeXml('&#233;&#xE9;'), 'éé');
});

test('Afspeellijst herschrijven verbergt alle links van de provider', () => {
  const input = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio/index.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000',
    'video/chunks?x=1',
    '#EXTINF:4,',
    'http://andere/seg1.ts?token=abc',
  ].join('\n');
  const signed = [];
  const out = rewriteManifest(input, 'http://user:pass@cdn/a/b/master.m3u8', (uri, playlist) => {
    signed.push([uri, playlist]);
    return `/x${signed.length}`;
  });
  assert.ok(!out.includes('cdn') && !out.includes('andere') && !out.includes('token'));
  assert.deepEqual(signed.map((s) => s[1]), [false, true, true, false]);
  assert.equal(signed[0][0], 'http://user:pass@cdn/a/b/key.bin');
  assert.equal(signed[3][0], 'http://andere/seg1.ts?token=abc');
});

test('Onveilige adressen worden geblokkeerd', () => {
  for (const ip of ['169.254.169.254', '127.0.0.1', '10.0.0.1', '192.168.1.1', '::1', 'fe80::1', '0.0.0.0']) {
    assert.equal(ipAllowed(ip), false, ip);
  }
  assert.equal(ipAllowed('8.8.8.8'), true);
  assert.throws(() => parseMediaUrl('file:///etc/passwd'));
  assert.throws(() => parseMediaUrl('http://169.254.169.254/latest'));
  assert.throws(() => parseMediaUrl('http://[::1]/x'));
});

test('Versleutelde streamlinks zijn niet te vervalsen', () => {
  const token = seal({ u: 'http://geheim' });
  assert.deepEqual(unseal(token), { u: 'http://geheim' });
  assert.ok(!Buffer.from(token, 'base64url').toString().includes('geheim'));
  assert.equal(unseal(`${token.slice(0, -2)}xx`), null);
  assert.equal(unseal('onzin'), null);
});

test('Hetzelfde segment houdt dezelfde link, anders keurt de speler live-HLS af', () => {
  assert.equal(seal({ u: 'http://a/1.ts', i: 1 }), seal({ u: 'http://a/1.ts', i: 1 }));
  assert.notEqual(seal({ u: 'http://a/1.ts', i: 1 }), seal({ u: 'http://a/2.ts', i: 1 }));
});

test('Wachtwoorden en gebruikersnamen', async () => {
  const stored = await hashPassword('correct paard');
  assert.ok(!stored.includes('correct'));
  assert.equal(await verifyPassword('correct paard', stored), true);
  assert.equal(await verifyPassword('fout', stored), false);
  assert.equal(validUsername('jan.de-boer'), true);
  assert.equal(validUsername('a'), false);
  assert.equal(validUsername('a b'), false);
});

test('ingebouwde ondertitels herkennen', async () => {
  const { parseSubtitleStreams } = await import('../server/stream.js');
  const stderr = [
    '  Stream #0:0: Video: h264 (High), yuv420p, 1920x1080',
    '  Stream #0:1(dut): Audio: eac3, 48000 Hz, 5.1',
    '  Stream #0:2(dut): Subtitle: subrip (default)',
    '  Stream #0:3[0x1200](eng): Subtitle: ass',
    '  Stream #0:4(eng): Subtitle: hdmv_pgs_subtitle',
    '  Stream #0:5: Subtitle: mov_text',
  ].join('\n');
  assert.deepEqual(parseSubtitleStreams(stderr), [
    { index: 2, lang: 'dut', codec: 'subrip' },
    { index: 3, lang: 'eng', codec: 'ass' },
    { index: 5, lang: 'und', codec: 'mov_text' },
  ]);
});

test('firstVideoPts leest de eerste beeldtijd uit een MPEG-TS-segment', () => {
  // Eén TS-pakket met het begin van een video-PES (stream 0xE0) met PTS = 8,5 s.
  const pts = Math.round(8.5 * 90000);
  const pkt = Buffer.alloc(188, 0xff);
  pkt.set([0x47, 0x41, 0x00, 0x10]);
  pkt.set([0x00, 0x00, 0x01, 0xe0, 0x00, 0x00, 0x80, 0x80, 0x05], 4);
  pkt.set([
    0x21 | ((Math.floor(pts / 2 ** 30) & 0x07) << 1),
    (Math.floor(pts / 2 ** 22)) & 0xff,
    ((Math.floor(pts / 2 ** 15) & 0x7f) << 1) | 1,
    (Math.floor(pts / 2 ** 7)) & 0xff,
    ((pts & 0x7f) << 1) | 1,
  ], 13);
  // Een audiopakket ervoor wordt overgeslagen.
  const audio = Buffer.from(pkt);
  audio[7] = 0xc0;
  assert.equal(firstVideoPts(Buffer.concat([audio, pkt])), 8.5);
  assert.equal(firstVideoPts(Buffer.alloc(376)), null);
});

const together = await import('../server/together.js');

test('samen kijken staat standaard uit en is dan niet te gebruiken', () => {
  assert.equal(together.togetherSettings().enabled, false);
  const user = { id: 1, username: 'sem' };
  assert.throws(() => together.createParty({ user, cid: 'host-tab-0001', device: 'Mac', item: { id: 1, name: 'NPO 1' } }), together.TogetherError);
});

test('samen kijken: gastheer, meekijkers en stoppen', () => {
  assert.equal(together.saveTogetherSettings({ enabled: true }).enabled, true);
  const host = { id: 1, username: 'sem' };
  const guest = { id: 2, username: 'lisa' };
  const party = together.createParty({ user: host, cid: 'host-tab-0001', device: 'TV-app', item: { id: 7, name: 'Film' } });
  assert.match(party.code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(party.ready, false, 'zonder stream op de server is er nog niets om mee te kijken');
  // Nog een keer starten in dezelfde tab: dezelfde sessie, met het nieuwe item.
  assert.equal(together.createParty({ user: host, cid: 'host-tab-0001', device: 'TV-app', item: { id: 8, name: 'Serie' } }).code, party.code);

  const joined = together.joinParty(party.code.toLowerCase(), { user: guest, cid: 'guest-tab-001', device: 'iPhone' });
  assert.equal(joined.sid, null);
  assert.deepEqual(joined.party.members, [{ username: 'lisa', device: 'iPhone' }]);
  assert.equal(joined.party.item.id, 8);
  assert.throws(() => together.joinParty(party.code, { user: host, cid: 'host-tab-0001', device: 'TV-app' }), /zelf de gastheer/);
  assert.throws(() => together.joinParty('ZZZZZZ', { user: guest, cid: 'guest-tab-001', device: 'iPhone' }), /bestaat niet meer/);

  // Alleen de gastheer meldt de stand; vreemde waarden worden genegeerd of begrensd.
  assert.throws(() => together.hostReport(party.code, 'guest-tab-001', { state: { playing: true } }), /Alleen de gastheer/);
  const view = together.hostReport(party.code, 'host-tab-0001', { state: { playing: true, position: 125.5, sn: 12, offset: 1.5, extra: 'x' } });
  assert.equal(view.state.playing, true);
  assert.equal(view.state.position, 125.5);
  assert.equal(view.state.sn, 12);
  assert.equal(view.state.extra, undefined);
  assert.ok(view.state.elapsed >= 0 && view.state.elapsed < 1000);

  const list = together.listParties();
  assert.equal(list.length, 1);
  assert.equal(list[0].count, 2);
  assert.equal(list[0].hostCid, 'host-tab-0001');

  // Meekijker gaat weg: de sessie blijft. Gastheer stopt: de sessie is voorbij.
  together.leaveParty('guest-tab-001');
  assert.equal(together.listParties()[0].count, 1);
  together.leaveParty('host-tab-0001');
  assert.equal(together.listParties().length, 0);
});

test('samen kijken: één sessie per tab, en uitzetten stopt alles', () => {
  const sem = { id: 1, username: 'sem' };
  const a = together.createParty({ user: sem, cid: 'tab-aaaaaaaa', device: 'Mac', item: { id: 1, name: 'A' } });
  const b = together.createParty({ user: sem, cid: 'tab-bbbbbbbb', device: 'Mac', item: { id: 2, name: 'B' } });
  // Tab A sluit aan bij B: dan stopt zijn eigen sessie.
  together.joinParty(b.code, { user: sem, cid: 'tab-aaaaaaaa', device: 'Mac' });
  assert.deepEqual(together.listParties().map((p) => p.code), [b.code]);
  assert.notEqual(a.code, b.code);
  together.saveTogetherSettings({ enabled: false });
  assert.equal(together.listParties().length, 0);
});

test('samen kijken: plek van de gastheer opschonen', () => {
  assert.deepEqual(together.cleanState({ playing: 'ja', position: -5, sn: 1.5, offset: 3, behind: 1e9 }),
    { playing: false, buffering: false, position: 0, sn: null, offset: null, behind: 3600 });
  assert.deepEqual(together.cleanState({ playing: true, buffering: true, position: 61, sn: 40, offset: 2.25 }),
    { playing: true, buffering: true, position: 61, sn: 40, offset: 2.25, behind: null });
});

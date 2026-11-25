// Samen kijken: accounts op dezelfde Kijkbox kijken tegelijk hetzelfde, gelijk met elkaar.
// Eén persoon start het (de gastheer) en bedient de speler; de anderen kijken mee. Iedereen kijkt
// naar dezelfde stream op de server, dus de provider ziet maar één verbinding.
// Het werkt alleen binnen deze Kijkbox (je eigen huishouden) en staat standaard uit: de beheerder
// zet het aan bij Instellingen > Server.
import crypto from 'node:crypto';
import { db } from './db.js';
import { releaseViewer, sessionOfViewer } from './stream.js';

export class TogetherError extends Error {}

export function togetherSettings() {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'together'`).get();
  let enabled = false;
  try {
    if (row) enabled = JSON.parse(row.value).enabled === true;
  } catch { /* standaard uit */ }
  return { enabled };
}

export function saveTogetherSettings({ enabled }) {
  const value = JSON.stringify({ enabled: enabled === true });
  db.prepare(`INSERT INTO settings (key, value) VALUES ('together', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(value);
  if (enabled !== true) endAll('De beheerder heeft Samen kijken uitgezet.');
  return togetherSettings();
}

const parties = new Map(); // code -> sessie
// Verdwijnt een tab (tv uit, wifi weg), dan mag hij zo lang wegblijven voordat hij uit de sessie gaat.
const GRACE_MS = 45 * 1000;
const HEARTBEAT_MS = 15 * 1000;

// Zonder letters en cijfers die op elkaar lijken (0/O, 1/I).
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  for (;;) {
    const code = Array.from({ length: 6 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
    if (!parties.has(code)) return code;
  }
}

const finite = (value, min, max) => (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : null);

/** Wat de gastheer meldt over zijn speler. Alleen getallen en ja/nee; de rest wordt genegeerd. */
export function cleanState(raw = {}) {
  const sn = Number.isSafeInteger(raw.sn) && raw.sn >= 0 ? raw.sn : null;
  return {
    playing: raw.playing === true,
    buffering: raw.buffering === true,
    position: finite(raw.position, 0, 7 * 24 * 3600) ?? 0,
    // Live: het segment en de plek daarin, zodat elke speler (met een eigen tijdlijn) hetzelfde beeld vindt.
    sn,
    offset: sn === null ? null : finite(raw.offset, 0, 600),
    // Live zonder segmentnummer (ingebouwde speler van Apple): hoeveel seconden achter live.
    behind: finite(raw.behind, 0, 3600),
  };
}

const findParty = (code) => parties.get(String(code ?? '').toUpperCase());
const partyOfHost = (cid) => [...parties.values()].find((p) => p.host.cid === cid);
const connected = (party, cid) => [...party.clients].some((c) => c.cid === cid);

function view(party) {
  const now = Date.now();
  return {
    code: party.code,
    host: { username: party.host.username, device: party.host.device },
    item: party.item,
    members: [...party.members.values()].map((m) => ({ username: m.username, device: m.device })),
    // Hoe lang geleden de gastheer dit meldde: de meekijker telt de tijd sindsdien zelf verder.
    state: { ...party.state, elapsed: now - party.state.at },
    streamVersion: party.streamVersion,
    ready: Boolean(party.stream),
  };
}

function send(client, event, data) {
  try {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch { /* verbinding is al weg; de opruimronde haalt hem weg */ }
}

function broadcast(party, event = 'party') {
  const data = event === 'state' ? { state: view(party).state } : view(party);
  for (const client of party.clients) send(client, event, data);
}

/**
 * Kijkt naar welke stream de gastheer nu kijkt. Is dat een andere (ander item, of na spoelen een
 * nieuw stuk), dan laten de meekijkers de oude meteen los: veel providers staan maar één
 * verbinding toe, en zolang er nog iemand op de oude kijkt, blijft die open.
 */
function updateStream(party) {
  const sid = sessionOfViewer(party.host.cid);
  if (sid === (party.stream?.sid ?? null)) return false;
  for (const cid of party.members.keys()) {
    const current = sessionOfViewer(cid);
    if (current && current !== sid) releaseViewer(cid);
  }
  party.stream = sid ? { sid } : null;
  party.streamVersion += 1;
  return true;
}

function endParty(party, reason) {
  parties.delete(party.code);
  for (const client of party.clients) {
    send(client, 'end', { reason });
    client.res.end();
  }
  party.clients.clear();
}

function endAll(reason) {
  for (const party of [...parties.values()]) endParty(party, reason);
}

/** Een tab doet aan één sessie tegelijk mee: als gastheer of als meekijker. */
function leaveEverything(cid, keep) {
  for (const party of [...parties.values()]) {
    if (party === keep) continue;
    if (party.host.cid === cid) endParty(party, `${party.host.username} is gestopt met samen kijken.`);
    else if (party.members.delete(cid)) broadcast(party);
  }
}

function assertEnabled() {
  if (!togetherSettings().enabled) throw new TogetherError('Samen kijken staat uit. De beheerder kan het aanzetten bij Instellingen.');
}

/** Start een sessie met deze tab als gastheer, of werkt het item bij als hij er al een heeft. */
export function createParty({ user, cid, device, item }) {
  assertEnabled();
  let party = partyOfHost(cid);
  leaveEverything(cid, party);
  if (!party) {
    party = {
      code: newCode(),
      host: { userId: user.id, username: user.username, cid, device },
      item,
      stream: null,
      streamVersion: 0,
      state: { ...cleanState(), at: Date.now() },
      members: new Map(),
      clients: new Set(),
      hostSeen: Date.now(),
    };
    parties.set(party.code, party);
  }
  party.item = item;
  party.hostSeen = Date.now();
  updateStream(party);
  broadcast(party);
  return view(party);
}

/** De gastheer meldt wat zijn speler doet (afspelen, pauze, plek) en eventueel een ander item. */
export function hostReport(code, cid, { state, item }) {
  assertEnabled();
  const party = findParty(code);
  if (!party) throw new TogetherError('Deze sessie bestaat niet meer.');
  if (party.host.cid !== cid) throw new TogetherError('Alleen de gastheer bedient de speler.');
  party.hostSeen = Date.now();
  party.state = { ...cleanState(state), at: Date.now() };
  const changed = updateStream(party);
  if (item) party.item = item;
  broadcast(party, changed || item ? 'party' : 'state');
  return view(party);
}

/**
 * De gastheer start iets anders (ander item, of spoelt naar een stuk dat er nog niet is). De meekijkers
 * laten de oude stream dan meteen los: zolang er iemand op kijkt, blijft die verbinding met de provider
 * open, en veel providers staan er maar één toe. Ze sluiten weer aan zodra de nieuwe stream er is.
 * Moet in dezelfde ronde als het starten gebeuren, vóór er iets wordt opgehaald.
 */
export function releaseGuests(hostCid) {
  const party = partyOfHost(hostCid);
  if (!party) return;
  for (const cid of party.members.keys()) releaseViewer(cid);
  if (!party.stream) return;
  party.stream = null;
  party.streamVersion += 1;
  broadcast(party);
}

/** Een tab doet mee als meekijker. Geeft de sessie en de stream van de gastheer (als die er al is). */
export function joinParty(code, { user, cid, device }) {
  assertEnabled();
  const party = findParty(code);
  if (!party) throw new TogetherError('Deze sessie bestaat niet meer. Misschien is de gastheer gestopt.');
  if (party.host.cid === cid) throw new TogetherError('Je bent zelf de gastheer van deze sessie.');
  leaveEverything(cid, party);
  const known = party.members.get(cid);
  party.members.set(cid, { userId: user.id, username: user.username, device, seen: Date.now(), joinedAt: known?.joinedAt ?? Date.now() });
  if (!known) broadcast(party);
  return { party: view(party), sid: party.stream?.sid ?? null };
}

/** Meekijker gaat weg, of de gastheer stopt (dan stopt de sessie voor iedereen). */
export function leaveParty(cid) {
  leaveEverything(cid, null);
}

/** Open verbinding waarover de tab hoort wat er gebeurt (server-sent events). */
export function subscribe(code, cid, req, res) {
  const party = findParty(code);
  if (!party || (party.host.cid !== cid && !party.members.has(cid))) {
    return res.status(404).json({ error: 'Deze sessie bestaat niet meer.' });
  }
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    // Nginx (en Nginx Proxy Manager) houdt berichten anders vast tot er genoeg zijn.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 2000\n\n');
  const client = { cid, res };
  party.clients.add(client);
  send(client, 'party', view(party));
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  req.on('close', () => {
    clearInterval(heartbeat);
    party.clients.delete(client);
    const member = party.members.get(cid);
    if (member) member.seen = Date.now();
    if (party.host.cid === cid) party.hostSeen = Date.now();
  });
}

/** Lopende sessies, voor Home: wie kijkt wat. */
export function listParties() {
  return [...parties.values()].map((p) => ({
    code: p.code,
    host: { username: p.host.username, device: p.host.device },
    hostCid: p.host.cid,
    item: p.item,
    count: p.members.size + 1,
  }));
}

// Tabs die weg zijn (geen verbinding meer en langer dan GRACE_MS niets gehoord) gaan eruit.
// Is de gastheer weg, dan stopt de sessie.
setInterval(() => {
  const now = Date.now();
  for (const party of [...parties.values()]) {
    if (connected(party, party.host.cid)) party.hostSeen = now;
    else if (now - party.hostSeen > GRACE_MS) {
      endParty(party, `${party.host.username} is gestopt met samen kijken.`);
      continue;
    }
    let changed = false;
    for (const [cid, member] of party.members) {
      if (connected(party, cid)) member.seen = now;
      else if (now - member.seen > GRACE_MS) changed = party.members.delete(cid) || changed;
    }
    if (changed) broadcast(party);
  }
}, 10 * 1000).unref();

export const stopTogether = () => endAll('De server start opnieuw op.');

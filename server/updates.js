// Updates: de site installeert niets zelf. Een apart programma (kijkbox-update, draait als root)
// haalt nieuwe versies op, controleert de handtekening en installeert ze als niemand kijkt.
// De site leest alleen de status die dat programma schrijft, en legt een verzoekbestand neer als
// de beheerder op "Controleren" of "Installeren" drukt.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const STATUS = path.join(config.dataDir, 'update-status.json');
const REQUEST = path.join(config.dataDir, 'update-request');
const SETTINGS = path.join(config.dataDir, 'update-config.json');
// Bestaat alleen op installaties die met het installatiescript zijn gemaakt.
const UPDATER = '/usr/local/bin/kijkbox-update';

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

export function updateStatus() {
  const status = readJson(STATUS) ?? {};
  return {
    version: config.version,
    managed: fs.existsSync(UPDATER),
    auto: Boolean(readJson(SETTINGS)?.auto),
    pending: fs.existsSync(REQUEST),
    latest: typeof status.latest === 'string' ? status.latest : null,
    notes: typeof status.notes === 'string' ? status.notes.slice(0, 4000) : '',
    state: typeof status.state === 'string' ? status.state : 'idle',
    message: typeof status.message === 'string' ? status.message.slice(0, 500) : '',
    checkedAt: Number(status.checkedAt) || null,
  };
}

export class UpdateError extends Error {}

/** action: 'check' (alleen kijken) of 'install' (installeren zodra niemand kijkt). */
export function requestUpdate(action) {
  if (!fs.existsSync(UPDATER)) throw new UpdateError('Updates zijn op deze installatie niet ingesteld.');
  if (action !== 'check' && action !== 'install') throw new UpdateError('Onbekende actie.');
  fs.writeFileSync(REQUEST, action);
  return updateStatus();
}

export function setAutoUpdate(auto) {
  fs.writeFileSync(SETTINGS, JSON.stringify({ auto: Boolean(auto) }));
  return updateStatus();
}

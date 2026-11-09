// Wie mag de site bereiken?
//
// Een nieuwe installatie werkt alleen op het thuisnetwerk: verzoeken van een adres op internet
// worden geweigerd, ook als iemand per ongeluk een poort op de router openzet. Van buitenaf kijken
// gaat via een reverse proxy (die staat zelf op het thuisnetwerk). Het adres daarvan stelt de
// beheerder in bij Instellingen; Kijkbox vertrouwt dan alleen die proxy voor het echte adres van
// de bezoeker en voor https.
import net from 'node:net';
import { config } from './config.js';
import { db } from './db.js';

const local = new net.BlockList();
local.addSubnet('127.0.0.0', 8, 'ipv4');
local.addSubnet('10.0.0.0', 8, 'ipv4');
local.addSubnet('172.16.0.0', 12, 'ipv4');
local.addSubnet('192.168.0.0', 16, 'ipv4');
local.addSubnet('169.254.0.0', 16, 'ipv4');
local.addSubnet('100.64.0.0', 10, 'ipv4'); // o.a. Tailscale
local.addAddress('::1', 'ipv6');
local.addSubnet('fc00::', 7, 'ipv6');
local.addSubnet('fe80::', 10, 'ipv6');

/** Komt dit adres van het thuisnetwerk (of een VPN zoals Tailscale)? */
export function isLocalAddress(address) {
  const ip = String(address ?? '').replace(/^::ffff:/i, '');
  const family = net.isIP(ip);
  if (!family) return false;
  return local.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

const readSaved = () => {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'network'`).get();
  try { return row ? JSON.parse(row.value) : {}; } catch { return {}; }
};

/** Het proxy-adres: uit TRUST_PROXY (heeft voorrang) of uit de instellingen. */
export function networkSettings() {
  const fromEnv = Boolean(process.env.TRUST_PROXY);
  return {
    proxy: fromEnv ? String(process.env.TRUST_PROXY) : String(readSaved().proxy ?? ''),
    fromEnv,
    allowPublic: config.allowPublic,
  };
}

/** Waarde voor Express' "trust proxy": een aantal tussenstappen ("1") of een adres. */
export function trustProxyValue(proxy) {
  if (!proxy) return false;
  return /^\d+$/.test(proxy) ? Number(proxy) : proxy;
}

export class NetworkError extends Error {}

export function saveProxy(value) {
  if (process.env.TRUST_PROXY) throw new NetworkError('Het proxy-adres staat vast in de serverinstellingen (TRUST_PROXY).');
  const proxy = String(value ?? '').trim();
  if (proxy && !(net.isIP(proxy) && isLocalAddress(proxy))) {
    throw new NetworkError('Vul het IP-adres van je reverse proxy op het thuisnetwerk in, bijvoorbeeld 192.168.1.5.');
  }
  db.prepare(`INSERT INTO settings (key, value) VALUES ('network', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify({ proxy }));
  return networkSettings();
}

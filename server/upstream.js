import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { config } from './config.js';

// Adressen die de server nooit mag ophalen, ook niet via een omleiding.
const alwaysBlocked = new net.BlockList();
alwaysBlocked.addSubnet('0.0.0.0', 8, 'ipv4');
alwaysBlocked.addSubnet('169.254.0.0', 16, 'ipv4');
alwaysBlocked.addSubnet('224.0.0.0', 3, 'ipv4');
alwaysBlocked.addSubnet('fe80::', 10, 'ipv6');
alwaysBlocked.addSubnet('ff00::', 8, 'ipv6');

const loopback = new net.BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');

const privateNets = new net.BlockList();
privateNets.addSubnet('10.0.0.0', 8, 'ipv4');
privateNets.addSubnet('172.16.0.0', 12, 'ipv4');
privateNets.addSubnet('192.168.0.0', 16, 'ipv4');
privateNets.addSubnet('100.64.0.0', 10, 'ipv4');
privateNets.addSubnet('fc00::', 7, 'ipv6');

export class UpstreamError extends Error {}

export function ipAllowed(ip) {
  const family = net.isIP(ip) === 6 ? 'ipv6' : 'ipv4';
  if (alwaysBlocked.check(ip, family)) return false;
  if (loopback.check(ip, family)) return config.allowLocalMedia;
  if (privateNets.check(ip, family)) return config.allowPrivateMedia;
  return true;
}

export function parseMediaUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new UpstreamError('Dit is geen geldige link.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UpstreamError('Alleen http- en https-links worden ondersteund.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !ipAllowed(host)) throw new UpstreamError('Dit adres is geblokkeerd.');
  return url;
}

// Controleert het adres op het moment van verbinden, dus ook als DNS tussendoor verandert.
function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const allowed = addresses.filter((a) => ipAllowed(a.address));
    if (!allowed.length) return callback(new UpstreamError('Dit adres is geblokkeerd.'));
    if (options.all) return callback(null, allowed);
    callback(null, allowed[0].address, allowed[0].family);
  });
}

/** Lost de naam op en controleert hem, voor programma's zonder guardedLookup, zoals ffmpeg. */
export async function assertHostAllowed(value) {
  const url = parseMediaUrl(value);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return;
  const addresses = await dns.promises.lookup(host, { all: true });
  // Alle adressen moeten mogen: ffmpeg kiest zelf welk adres het gebruikt.
  if (!addresses.length || !addresses.every((a) => ipAllowed(a.address))) throw new UpstreamError('Dit adres is geblokkeerd.');
}

function once(url, { headers, signal, timeout }) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, { method: 'GET', headers, signal, lookup: guardedLookup, timeout }, resolve);
    req.on('timeout', () => req.destroy(new UpstreamError('De bron reageert niet.')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Opent een externe link en volgt omleidingen.
 * Elke stap wordt gecontroleerd. Geeft de response en de uiteindelijke link terug.
 */
export async function open(target, { userAgent, referer, range, signal, timeout = 20000 } = {}) {
  const headers = { 'user-agent': userAgent || config.userAgent, accept: '*/*', 'accept-encoding': 'identity' };
  if (referer) headers.referer = referer;
  if (range) headers.range = range;

  let url = parseMediaUrl(target);
  for (let hop = 0; hop <= 5; hop += 1) {
    const res = await once(url, { headers, signal, timeout });
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      url = parseMediaUrl(new URL(res.headers.location, url).href);
      continue;
    }
    return { res, url: url.href };
  }
  throw new UpstreamError('Te veel omleidingen.');
}

export async function readText(res, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res) {
    size += chunk.length;
    if (size > maxBytes) {
      res.destroy();
      throw new UpstreamError('Het antwoord van de bron is te groot.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

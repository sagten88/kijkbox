// Een tv koppelen met een korte code, zodat je geen wachtwoord hoeft in te tikken met de afstandsbediening.
// De tv vraagt een code aan, je bevestigt die op een apparaat waar je al bent ingelogd, en de tv
// krijgt dan een eigen inlogsessie voor hetzelfde account.
import crypto from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // zonder 0/O en 1/I, die lijken op elkaar
const TTL = 5 * 60 * 1000;
const MAX_OPEN = 500;

const byCode = new Map();
const byToken = new Map();

function prune() {
  const now = Date.now();
  for (const [code, entry] of byCode) {
    if (entry.expires < now) {
      byCode.delete(code);
      byToken.delete(entry.token);
    }
  }
}

const normalizeCode = (input) => String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function createPairing() {
  prune();
  if (byCode.size >= MAX_OPEN) return null;
  let code;
  do {
    // 32 tekens: elke byte valt precies 8 keer in het alfabet, dus elke letter is even waarschijnlijk.
    code = Array.from(crypto.randomBytes(6), (b) => ALPHABET[b % 32]).join('');
  } while (byCode.has(code));
  const token = crypto.randomBytes(24).toString('base64url');
  const entry = { code, token, expires: Date.now() + TTL, userId: null };
  byCode.set(code, entry);
  byToken.set(token, entry);
  return { code: `${code.slice(0, 3)}-${code.slice(3)}`, token, expiresIn: TTL / 1000 };
}

export function approvePairing(input, userId) {
  prune();
  const entry = byCode.get(normalizeCode(input));
  if (!entry || entry.userId) return false;
  entry.userId = userId;
  return true;
}

/** Geeft 'pending', 'expired' of het account waarmee de tv mag inloggen. */
export function pollPairing(token) {
  prune();
  const entry = byToken.get(String(token ?? ''));
  if (!entry) return { status: 'expired' };
  if (!entry.userId) return { status: 'pending' };
  byCode.delete(entry.code);
  byToken.delete(entry.token);
  return { status: 'approved', userId: entry.userId };
}

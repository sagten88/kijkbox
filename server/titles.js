// Herkent dezelfde film of serie in verschillende talen ("┃NL┃ Gladiator II (2024)",
// "┃DE┃Gladiator II", "┃USA┃ Gladiator II 4K"), zodat die op één kaart komen met een taalkeuze.
import { countryOf, ENGLISH, FIRST_COUNTRY } from './countries.js';

// Ook zonder streep vooraan: "FR┃ Titel", "FR-4K┃ Titel", "VO|STFR┃ Titel".
const PREFIX = /^\s*(?:(?:[┃|[(][^┃|\])]{1,20}[┃|\])]|[A-Z0-9][A-Z0-9 |-]{1,14}┃)\s*)+/u;
const NOISE = /\b(4k|uhd|fhd|hd|sd|hevc|x265|h265|x264|multi|dubb?ed|dubb|vostfr|vost|subbed|nl subs?|3d|imax|remastered|extended|director'?s cut)\b/gi;

/** Vergelijkbare titel: zonder landcode, jaar, kwaliteit en leestekens, in kleine letters. */
export function titleKey(name) {
  return String(name)
    .replace(PREFIX, '')
    .normalize('NFD').replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\(\s*(19|20)\d{2}\s*\)|\s-\s*(19|20)\d{2}\s*$|\b(19|20)\d{2}\s*$/g, ' ')
    .replace(NOISE, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Volgorde van versies: Nederlands, dan Engels, dan de rest. */
export function langRank(group) {
  const code = countryOf(group);
  if (code === FIRST_COUNTRY) return 0;
  if (ENGLISH.has(code)) return 1;
  return 2;
}

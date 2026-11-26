// Haalt het land uit de groepsnaam. Providers zetten dat vooraan, bijvoorbeeld "┃NL┃ VIAPLAY F1",
// "NL┃ VIAPLAY F1", "[NL] Sport" of "NL | Sport". Er is geen vaste standaard, dus dit is een herkenning op patroon.

export const OTHER = 'OVERIG';
const FIRST = 'NL';

const LABELS = {
  NL: 'Nederland', BE: 'België', DE: 'Duitsland', UK: 'Verenigd Koninkrijk', IE: 'Ierland',
  FR: 'Frankrijk', ES: 'Spanje', PT: 'Portugal', IT: 'Italië', AT: 'Oostenrijk', CH: 'Zwitserland', LU: 'Luxemburg',
  SE: 'Zweden', NO: 'Noorwegen', DK: 'Denemarken', FI: 'Finland', PL: 'Polen', CZ: 'Tsjechië', HU: 'Hongarije',
  RO: 'Roemenië', BG: 'Bulgarije', GR: 'Griekenland', CY: 'Cyprus', MT: 'Malta', TR: 'Turkije', RU: 'Rusland',
  UKR: 'Oekraïne', LV: 'Letland', LT: 'Litouwen', AL: 'Albanië', RS: 'Servië', HR: 'Kroatië', SI: 'Slovenië',
  BA: 'Bosnië en Herzegovina', MK: 'Noord-Macedonië', ME: 'Montenegro', EXYU: 'Ex-Joegoslavië',
  USA: 'Verenigde Staten', 'CA EN': 'Canada (Engels)', 'CA FR': 'Canada (Frans)', MX: 'Mexico', BR: 'Brazilië',
  ARG: 'Argentinië', CHL: 'Chili', COL: 'Colombia', ECU: 'Ecuador', PER: 'Peru', CU: 'Cuba', HAT: 'Haïti',
  DOMR: 'Dominicaanse Republiek', ANT: 'Antillen', CAR: 'Caraïben', LAT: 'Latijns-Amerika',
  AU: 'Australië', NZ: 'Nieuw-Zeeland', AR: 'Arabisch', IR: 'Iran', IL: 'Israël', PK: 'Pakistan', AFG: 'Afghanistan',
  ARM: 'Armenië', AZE: 'Azerbeidzjan', GE: 'Georgië', HINDI: 'Hindi', KURD: 'Koerdisch', ASIA: 'Azië', AFR: 'Afrika',
  SOM: 'Somalië', SU: 'Suriname', MULTI: 'Meertalig', QC: 'Québec', PPV: 'Pay-per-view', UCL: 'Champions League',
  EN: 'Engelstalig', IN: 'India', ID: 'Indonesië', TELUGU: 'Telugu', TAMIL: 'Tamil',
};

// Engelstalige groepen. Bij films en series komen die direct na Nederland.
export const ENGLISH = new Set(['EN', 'USA', 'UK', 'CA EN', 'AU', 'NZ', 'IE']);

// Dezelfde plek onder twee codes.
const ALIASES = { US: 'USA', GB: 'UK', PAKISTAN: 'PK' };

const BRACKETED = /^\s*[┃|[(]\s*([^┃|\]):]{1,8}?)\s*[┃|\]):]\s*/u;
// Sinds november 2026 zonder streep vooraan: "NL┃ NETFLIX", "CA EN┃ NEWS", "PAKISTAN┃ DRAMA".
const OPEN = /^\s*([A-Z]{2,9}(?: [A-Z]{2})?)\s*┃\s*/u;
const PLAIN = /^\s*([A-Z]{2,5})\s*[|:\-–]\s+/;

function parse(group) {
  const bracketed = BRACKETED.exec(group);
  if (bracketed && /^[A-Z]{2,5}( [A-Z]{2})?$/.test(bracketed[1])) return { code: bracketed[1], length: bracketed[0].length };
  const open = OPEN.exec(group);
  if (open) return { code: open[1], length: open[0].length };
  // Zonder haakjes is de kans op iets anders groter ("HD - Sport"), dus alleen bekende codes.
  const plain = PLAIN.exec(group);
  if (plain && LABELS[plain[1]]) return { code: plain[1], length: plain[0].length };
  return null;
}

/** Geeft de landcode van een groep, of OTHER als die er niet in staat. */
export function countryOf(group) {
  const code = parse(group)?.code;
  return code ? ALIASES[code] ?? code : OTHER;
}

/** De groepsnaam zonder landcode: "┃NL┃ VIAPLAY F1" wordt "VIAPLAY F1". */
export function withoutCountry(group) {
  const found = parse(group);
  return found ? group.slice(found.length) || group : group;
}

const labelOf = (code) => (code === OTHER ? 'Overig' : LABELS[code] ?? code);
export const countryLabel = labelOf;

/**
 * Telt per land. Volgorde: Nederland, dan Engelstalig (eerst "Engelstalig" zelf, dan de Engelstalige landen),
 * dan de rest op alfabet en Overig onderaan. Zo bij Live, Films en Series.
 */
export function countryList(groups) {
  const totals = new Map();
  for (const { name, count } of groups) {
    const code = countryOf(name);
    totals.set(code, (totals.get(code) ?? 0) + count);
  }
  const rank = (code) => (code === FIRST ? 0 : code === 'EN' ? 1 : ENGLISH.has(code) ? 2 : code === OTHER ? 4 : 3);
  return [...totals]
    .map(([code, count]) => ({ code, label: labelOf(code), count }))
    .sort((a, b) => rank(a.code) - rank(b.code) || a.label.localeCompare(b.label, 'nl'));
}

export const groupsOfCountry = (groups, code) => groups.filter((g) => countryOf(g.name) === code).map((g) => g.name);

/** Zet de groepen van Nederland vooraan en laat de volgorde verder staan. */
export function firstCountryOnTop(groups) {
  const top = groups.filter((g) => countryOf(g.name) === FIRST);
  return [...top, ...groups.filter((g) => countryOf(g.name) !== FIRST)];
}

export { FIRST as FIRST_COUNTRY };

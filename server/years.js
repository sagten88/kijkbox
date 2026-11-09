// Het releasejaar uit een titel halen, zoals "Musk - 2026" of "Film (2025)".
// Providers geven bij films geen releasedatum mee, maar zetten het jaar vaak in de naam.

const DATE = /\b(19|20)\d{2}[-./]\d{1,2}[-./]\d{1,2}\b/; // "WWE NXT 2026-11-04": een uitzending, geen film
const IN_PARENTHESES = /\(((?:19|20)\d{2})\)/g;
const AFTER_DASH = /[-–|]\s*((?:19|20)\d{2})\s*\)?\s*$/;
const AT_END = /\b((?:19|20)\d{2})\s*$/;

/** Geeft het jaar als tekst, of '' als het niet betrouwbaar te vinden is. */
export function releaseYear(name, now = new Date()) {
  const text = String(name ?? '');
  if (DATE.test(text)) return '';
  const inParentheses = [...text.matchAll(IN_PARENTHESES)].map((m) => m[1]);
  const year = inParentheses.at(-1) ?? AFTER_DASH.exec(text)?.[1] ?? AT_END.exec(text)?.[1];
  if (!year) return '';
  // Een jaar ver in de toekomst is geen releasejaar, maar deel van de titel ("Blade Runner 2049").
  return Number(year) >= 1920 && Number(year) <= now.getFullYear() + 1 ? year : '';
}

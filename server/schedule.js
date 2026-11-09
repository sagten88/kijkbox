// Vast nachtelijk moment (lokale tijd) waarop playlists en tv-gids worden bijgewerkt.
// Datumrekenen via setDate houdt rekening met zomer- en wintertijd.

export function lastNightly(nowMs, hour) {
  const d = new Date(nowMs);
  d.setHours(hour, 0, 0, 0);
  if (d.getTime() > nowMs) d.setDate(d.getDate() - 1);
  return d.getTime();
}

export function nextNightly(nowMs, hour) {
  const d = new Date(lastNightly(nowMs, hour));
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

// Bijwerken is nodig als de laatste keer van vóór het meest recente nachtelijke moment is.
// Zo wordt een gemiste nacht (server uit) ook ingehaald zodra de server weer draait.
export const isDue = (lastMs, nowMs, hour) => lastMs < lastNightly(nowMs, hour);

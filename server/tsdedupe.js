// Filtert herhaalde video uit een live MPEG-TS-stream.
//
// De provider verbreekt de verbinding geregeld en stuurt na het opnieuw verbinden eerst de laatste
// ~25 seconden nog een keer. ffmpeg zag die als nieuw en zette ze opnieuw in de stream: de kijker
// sprong dan terug. Dit filter onthoudt per spoor (audio, video) de laatste doorgegeven tijdstempel
// (PTS) en laat na een nieuwe verbinding alleen pakketten door die daarna komen. De pakkettellers
// (continuity counters) worden doorlopend gemaakt, zodat ffmpeg geen gaten ziet.

const PACKET = 188;
const WRAP = 2 ** 33; // PTS loopt na ~26,5 uur over
// Zo ver terug in de tijd is geen herhaling meer, maar een bron die echt opnieuw begon.
const NEW_TIMELINE = 180 * 90000;
const NULL_PID = 0x1fff;
const MAX_PENDING = 20000; // ~3,7 MB; een videobeeld is ruim kleiner

/** Ligt PTS a na b, rekening houdend met het overlopen van de teller? */
export function ptsAfter(a, b) {
  const d = (((a - b) % WRAP) + WRAP) % WRAP;
  return d > 0 && d < WRAP / 2;
}

const readStamp = (p, b) => ((p[b] >> 1) & 0x07) * 2 ** 30 + ((p[b + 1] << 22) | ((p[b + 2] >> 1) << 15) | (p[b + 3] << 7) | (p[b + 4] >> 1));

/**
 * De tijdstempel om op te vergelijken: DTS als die er is, anders PTS. Bij video met B-frames
 * komen beelden niet op volgorde van PTS binnen (een eerder te tonen beeld komt later), maar
 * DTS loopt altijd op. Met PTS zou een B-frame ten onrechte als herhaling worden weggegooid.
 */
export function readTimestamp(p, off) {
  if (off + 14 > PACKET || p[off] !== 0 || p[off + 1] !== 0 || p[off + 2] !== 1) return null;
  const streamId = p[off + 3];
  // Alleen audio (0xC0–0xDF), video (0xE0–0xEF) en private stream 1 (AC-3 e.d.) hebben een PTS-kop.
  if (!(streamId >= 0xc0 && streamId <= 0xef) && streamId !== 0xbd) return null;
  const flags = p[off + 7] >> 6;
  if (flags === 3 && off + 19 <= PACKET) return readStamp(p, off + 14);
  if (flags & 2) return readStamp(p, off + 9);
  return null;
}

export class TsDedupe {
  /**
   * resetAfterMs: zo lang alleen oude tijdstempels? Dan is de tijdlijn van de bron echt opnieuw
   * begonnen. Ruim gekozen: de provider stuurt een herhaling soms traag, verspreid over ~25 s.
   */
  constructor({ resetAfterMs = 90000, now = () => Date.now() } = {}) {
    this.now = now;
    this.resetAfterMs = resetAfterMs;
    this.rest = Buffer.alloc(0);
    this.lastPts = new Map(); // pid -> laatste doorgegeven PTS
    this.on = new Map();      // pid -> wordt het huidige PES-pakket doorgegeven?
    this.dropStart = new Map(); // pid -> sinds wanneer alleen oude PTS
    this.cc = new Map();      // pid -> laatste uitgaande continuity counter
    this.psi = new Set([0]);  // PAT en PMT's: altijd doorgeven
    // pid -> { pts, packets }: het beeld/audioblok dat nog binnenkomt. Pas als het volgende begint,
    // is dit compleet en gaat het door. Zo komt er nooit een afgebroken beeld in de stream.
    this.pending = new Map();
    this.passthrough = false;
    this.searched = 0;
    this.droppedBytes = 0;
  }

  /**
   * Aanroepen bij elke nieuwe verbinding. Een half pakket en een half beeld (PES) van de vorige
   * verbinding vervallen; dat beeld komt in de herhaling van de provider nog een keer heel binnen.
   */
  reconnect() {
    this.rest = Buffer.alloc(0);
    this.on.clear();
    for (const block of this.pending.values()) this.droppedBytes += block.packets.length * PACKET;
    this.pending.clear();
  }

  push(chunk) {
    if (this.passthrough) return chunk;
    const buf = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    const out = [];
    let i = 0;
    while (buf.length - i >= PACKET) {
      // Synchronisatie: elk pakket begint met 0x47, en het volgende ook.
      if (buf[i] !== 0x47 || (buf.length - i >= 2 * PACKET && buf[i + PACKET] !== 0x47)) {
        i += 1;
        this.searched += 1;
        // Geen MPEG-TS? Dan ongemoeid doorgeven in plaats van alles weg te gooien.
        if (this.searched > 512 * 1024 && !this.cc.size) {
          this.passthrough = true;
          return buf.subarray(i);
        }
        continue;
      }
      // Kopie: het pakket kan wachten tot zijn beeld compleet is, terwijl buf hergebruikt wordt.
      this.handle(Buffer.from(buf.subarray(i, i + PACKET)), out);
      i += PACKET;
    }
    this.rest = Buffer.from(buf.subarray(i));
    return out.length === 1 ? out[0] : Buffer.concat(out);
  }

  handle(p, out) {
    const pusi = (p[1] & 0x40) !== 0;
    const pid = ((p[1] & 0x1f) << 8) | p[2];
    if (pid === NULL_PID) return;
    const afc = (p[3] >> 4) & 3;
    const hasPayload = (afc & 1) === 1;
    const off = afc & 2 ? 5 + p[4] : 4;

    if (this.psi.has(pid)) {
      if (pid === 0 && pusi && hasPayload) this.readPat(p, off);
      this.renumber(p, pid, hasPayload);
      out.push(p);
      return;
    }
    if (hasPayload && pusi) {
      // Een nieuw blok begint: het vorige van dit spoor is compleet en mag door.
      this.flush(pid, out);
      const pts = readTimestamp(p, off);
      const last = this.lastPts.get(pid);
      let keep = pts === null || last === undefined || ptsAfter(pts, last)
        || (((last - pts) % WRAP) + WRAP) % WRAP > NEW_TIMELINE;
      if (!keep) {
        const since = this.dropStart.get(pid) ?? this.now();
        this.dropStart.set(pid, since);
        if (this.now() - since > this.resetAfterMs) keep = true; // bron is echt opnieuw begonnen
      }
      if (keep) {
        this.dropStart.delete(pid);
        this.pending.set(pid, { pts, packets: [] });
      }
      this.on.set(pid, keep);
    }
    const block = this.on.get(pid) && this.pending.get(pid);
    if (block) {
      block.packets.push(p);
      // Een spoor zonder nieuwe blokken (zeldzame datastroom) mag niet eindeloos geheugen vasthouden.
      if (block.packets.length > MAX_PENDING) this.flush(pid, out);
    } else {
      this.droppedBytes += PACKET;
    }
  }

  flush(pid, out) {
    const block = this.pending.get(pid);
    if (!block) return;
    this.pending.delete(pid);
    if (block.pts !== null) this.lastPts.set(pid, block.pts);
    for (const p of block.packets) {
      this.renumber(p, pid, ((p[3] >> 4) & 1) === 1);
      out.push(p);
    }
  }

  renumber(p, pid, hasPayload) {
    const prev = this.cc.get(pid);
    const cc = prev === undefined ? p[3] & 0x0f : hasPayload ? (prev + 1) & 0x0f : prev;
    p[3] = (p[3] & 0xf0) | cc;
    this.cc.set(pid, cc);
  }

  readPat(p, off) {
    const t = off + 1 + p[off];
    if (t + 8 > PACKET || p[t] !== 0x00) return;
    const end = Math.min(PACKET - 4, t + 3 + (((p[t + 1] & 0x0f) << 8) | p[t + 2]) - 4);
    for (let j = t + 8; j + 4 <= end; j += 4) {
      const program = (p[j] << 8) | p[j + 1];
      if (program !== 0) this.psi.add(((p[j + 2] & 0x1f) << 8) | p[j + 3]);
    }
  }
}

import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.TZ = 'Europe/Amsterdam';
const { isDue, lastNightly, nextNightly } = await import('../server/schedule.js');

const at = (iso) => new Date(iso).getTime();

test('nachtelijk moment ligt om 04:00 Nederlandse tijd', () => {
  assert.equal(lastNightly(at('2026-11-07T15:13:00+01:00'), 4), at('2026-11-07T04:00:00+01:00'));
  assert.equal(lastNightly(at('2026-11-07T03:59:00+01:00'), 4), at('2026-11-06T04:00:00+01:00'));
  assert.equal(nextNightly(at('2026-11-07T15:13:00+01:00'), 4), at('2026-11-08T04:00:00+01:00'));
});

test('zomer- en wintertijd schuiven het tijdstip niet op', () => {
  // Nacht van 24 op 25 oktober 2026: van zomer- naar wintertijd.
  assert.equal(nextNightly(at('2026-10-24T12:00:00+02:00'), 4), at('2026-10-25T04:00:00+01:00'));
  // Nacht van 28 op 29 maart 2026: van winter- naar zomertijd.
  assert.equal(nextNightly(at('2026-03-28T12:00:00+01:00'), 4), at('2026-03-29T04:00:00+02:00'));
});

test('bijwerken alleen als het nachtelijke moment voorbij is', () => {
  const now = at('2026-11-07T15:13:00+01:00');
  assert.equal(isDue(at('2026-11-06T21:08:00+01:00'), now, 4), true, 'gisteravond: nacht gemist');
  assert.equal(isDue(at('2026-11-07T04:01:00+01:00'), now, 4), false, 'vannacht al gedaan');
  assert.equal(isDue(0, now, 4), true, 'nog nooit gedaan');
  assert.equal(isDue(at('2026-11-07T04:01:00+01:00'), at('2026-11-08T03:59:00+01:00'), 4), false);
  assert.equal(isDue(at('2026-11-07T04:01:00+01:00'), at('2026-11-08T04:00:00+01:00'), 4), true);
});

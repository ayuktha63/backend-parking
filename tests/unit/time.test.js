'use strict';

/**
 * Time handling.
 *
 * The single most fragile area of the old system: the customer app sent naive local
 * time, the operator app sent UTC, and the verify handler computed
 * `new Date(dateObject + "Z")` — string concatenation producing Invalid Date, so its
 * window check silently always failed. Every conflict, price and refund decision
 * rested on that.
 *
 * These tests pin the two rules that fix it: nothing ever produces Invalid Date, and
 * a client instant without an explicit offset is recognisable as such.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const time = require('../../src/utils/time');

test('parseInstant never returns an Invalid Date', () => {
  assert.equal(time.parseInstant('nonsense'), null);
  assert.equal(time.parseInstant(''), null);
  assert.equal(time.parseInstant(null), null);
  assert.equal(time.parseInstant(undefined), null);
  assert.equal(time.parseInstant({}), null);
  assert.equal(time.parseInstant(new Date('nope')), null);
});

test('parseInstant accepts the shapes that actually arrive', () => {
  assert.ok(time.parseInstant('2026-04-13T10:00:00.000Z') instanceof Date);
  assert.ok(time.parseInstant('2026-04-13T10:00:00+05:30') instanceof Date);
  assert.ok(time.parseInstant(new Date()) instanceof Date);
  assert.ok(time.parseInstant(1776000000000) instanceof Date);
});

test('the exact defect from the old verify handler cannot recur', () => {
  // server.js:1038 did: new Date(booking.entry_time + "Z") where entry_time was
  // already a Date. Concatenation stringifies it first, giving
  // "Mon Apr 13 2026 15:30:00 GMT+0530 (India Standard Time)Z".
  //
  // What that expression then produces is ENGINE-DEPENDENT, and it got worse:
  //
  //   older V8   Invalid Date        — loud, caught immediately
  //   Node 24    2026-04-13T15:30Z   — parses fine, silently shifted by the local
  //                                    UTC offset, because the offset is applied
  //                                    twice and the trailing "Z" is ignored
  //
  // So on a modern runtime the original bug stops throwing and starts quietly
  // moving bookings by hours. This test therefore asserts the property that is
  // true on every engine — the expression does not yield the right instant — and
  // that parseInstant does.
  const entryTime = new Date('2026-04-13T10:00:00.000Z');
  const brokenExpression = new Date(entryTime + 'Z');

  const brokenIsWrong =
    Number.isNaN(brokenExpression.getTime()) ||
    brokenExpression.getTime() !== entryTime.getTime();
  assert.ok(
    brokenIsWrong,
    'the original expression must not accidentally produce the correct instant'
  );

  // parseInstant handles the same input correctly, on any engine.
  const parsed = time.parseInstant(entryTime);
  assert.ok(parsed && !Number.isNaN(parsed.getTime()));
  assert.equal(parsed.toISOString(), '2026-04-13T10:00:00.000Z');
});

test('hasExplicitOffset distinguishes naive from zoned timestamps', () => {
  // What the customer app sent: DateTime(...).toIso8601String() — no offset.
  assert.equal(time.hasExplicitOffset('2026-04-13T10:00:00.000'), false);
  // What the operator app sent: .toUtc().toIso8601String().
  assert.equal(time.hasExplicitOffset('2026-04-13T04:30:00.000Z'), true);
  assert.equal(time.hasExplicitOffset('2026-04-13T10:00:00+05:30'), true);
  assert.equal(time.hasExplicitOffset('2026-04-13T10:00:00+0530'), true);
});

test('parseClientInstant flags naive input rather than guessing a zone', () => {
  const naive = time.parseClientInstant('2026-04-13T10:00:00.000');
  assert.ok(naive.date instanceof Date);
  assert.equal(naive.naive, true);

  const zoned = time.parseClientInstant('2026-04-13T10:00:00.000Z');
  assert.equal(zoned.naive, false);

  const junk = time.parseClientInstant('not a date');
  assert.equal(junk.date, null);
});

test('intervalsOverlap is half-open, so back-to-back bookings do not conflict', () => {
  const a1 = '2026-04-13T10:00:00Z';
  const a2 = '2026-04-13T11:00:00Z';
  const b1 = '2026-04-13T11:00:00Z';
  const b2 = '2026-04-13T12:00:00Z';

  // Touching at 11:00 must NOT overlap — one car leaves as the next arrives.
  assert.equal(time.intervalsOverlap(a1, a2, b1, b2), false);

  // One minute of genuine overlap must be detected.
  assert.equal(
    time.intervalsOverlap(a1, '2026-04-13T11:01:00Z', b1, b2),
    true
  );
  // Full containment.
  assert.equal(
    time.intervalsOverlap(a1, a2, '2026-04-13T10:15:00Z', '2026-04-13T10:30:00Z'),
    true
  );
});

test('intervalsOverlap refuses to guess when an endpoint is unparseable', () => {
  assert.equal(time.intervalsOverlap('bad', '2026-04-13T11:00:00Z', '2026-04-13T10:00:00Z', '2026-04-13T12:00:00Z'), false);
});

test('bufferedWindow expands a booking on both sides', () => {
  const w = time.bufferedWindow('2026-04-13T10:00:00Z', '2026-04-13T11:00:00Z', 10);
  assert.equal(w.start.toISOString(), '2026-04-13T09:50:00.000Z');
  assert.equal(w.end.toISOString(), '2026-04-13T11:10:00.000Z');
});

test('expectedExit derives the end of a booking from its duration', () => {
  const exit = time.expectedExit('2026-04-13T10:00:00Z', 90);
  assert.equal(exit.toISOString(), '2026-04-13T11:30:00.000Z');
});

test('billableMinutes rounds up and never goes negative', () => {
  assert.equal(time.billableMinutes('2026-04-13T10:00:00Z', '2026-04-13T11:00:00Z'), 60);
  // 60 minutes and one second bills as 61 — a started minute is a used minute.
  assert.equal(time.billableMinutes('2026-04-13T10:00:00Z', '2026-04-13T11:00:01Z'), 61);
  // An exit before entry is nonsense, not a negative charge.
  assert.equal(time.billableMinutes('2026-04-13T11:00:00Z', '2026-04-13T10:00:00Z'), 0);
});

test('startOfLocalDay keeps an operator day whole across the UTC boundary', () => {
  // IST is UTC+5:30. 2026-04-13T20:00Z is 01:30 on the 14th in IST, so the local
  // day it belongs to starts at 2026-04-13T18:30Z.
  const start = time.startOfLocalDay('2026-04-13T20:00:00Z', 330);
  assert.equal(start.toISOString(), '2026-04-13T18:30:00.000Z');
});

test('humanizeRelative produces the strings the active-booking card shows', () => {
  const base = new Date('2026-04-13T10:00:00Z');
  assert.equal(time.humanizeRelative('2026-04-13T10:18:00Z', base), 'in 18 min');
  assert.equal(time.humanizeRelative('2026-04-13T08:00:00Z', base), '2 h ago');
  assert.equal(time.humanizeRelative('2026-04-13T10:00:00Z', base), 'now');
});

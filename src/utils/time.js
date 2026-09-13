'use strict';

/**
 * Time handling.
 *
 * Rule for the whole system: every instant crossing a boundary — API, database,
 * socket — is UTC, ISO-8601, with an explicit offset. Local wall-clock time exists
 * only inside a client's presentation layer.
 *
 * The old system had the customer app sending naive local time, the owner app sending
 * UTC, and the verify handler computing `new Date(dateObject + "Z")`, which yields
 * Invalid Date. Every conflict, price and refund decision rested on that.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Parses a value into a Date, or returns null. Never throws, never produces
 * Invalid Date, never string-concatenates a Date.
 * @returns {Date|null}
 */
function parseInstant(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  // Reject naive datetimes explicitly rather than silently guessing a zone.
  // "2026-04-13T10:00:00" has no offset; "…Z" and "…+05:30" do.
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/** True when an ISO string carries an explicit UTC offset. */
function hasExplicitOffset(value) {
  if (typeof value !== 'string') return false;
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(value.trim());
}

/**
 * Parses a client-supplied instant, requiring an explicit offset.
 * Returns { date, naive } so callers can decide whether to reject or coerce.
 */
function parseClientInstant(value) {
  const date = parseInstant(value);
  if (!date) return { date: null, naive: false };
  return { date, naive: !hasExplicitOffset(value) };
}

/** @returns {string} ISO-8601 UTC, e.g. "2026-04-13T10:00:00.000Z" */
function toIso(date) {
  const d = parseInstant(date);
  return d ? d.toISOString() : null;
}

function nowUtc() {
  return new Date();
}

function addMinutes(date, minutes) {
  const d = parseInstant(date);
  if (!d) return null;
  return new Date(d.getTime() + Number(minutes) * MINUTE_MS);
}

function addSeconds(date, seconds) {
  const d = parseInstant(date);
  if (!d) return null;
  return new Date(d.getTime() + Number(seconds) * 1000);
}

function diffMinutes(a, b) {
  const da = parseInstant(a);
  const db = parseInstant(b);
  if (!da || !db) return null;
  return Math.round((da.getTime() - db.getTime()) / MINUTE_MS);
}

function diffSeconds(a, b) {
  const da = parseInstant(a);
  const db = parseInstant(b);
  if (!da || !db) return null;
  return Math.round((da.getTime() - db.getTime()) / 1000);
}

function isBefore(a, b) {
  const da = parseInstant(a);
  const db = parseInstant(b);
  return Boolean(da && db && da.getTime() < db.getTime());
}

function isAfter(a, b) {
  const da = parseInstant(a);
  const db = parseInstant(b);
  return Boolean(da && db && da.getTime() > db.getTime());
}

/**
 * Half-open interval overlap: [startA, endA) ∩ [startB, endB) ≠ ∅
 * Half-open matters — a booking ending at 10:00 must not conflict with one
 * starting at 10:00.
 */
function intervalsOverlap(startA, endA, startB, endB) {
  const sa = parseInstant(startA);
  const ea = parseInstant(endA);
  const sb = parseInstant(startB);
  const eb = parseInstant(endB);
  if (!sa || !ea || !sb || !eb) return false;
  return sa.getTime() < eb.getTime() && ea.getTime() > sb.getTime();
}

/**
 * Expands a booking window by a buffer on each side. Used to keep two cars from
 * being scheduled into one slot back-to-back with no turnaround time.
 */
function bufferedWindow(start, end, bufferMinutes) {
  const s = parseInstant(start);
  const e = parseInstant(end);
  if (!s || !e) return null;
  const b = Number(bufferMinutes || 0) * MINUTE_MS;
  return { start: new Date(s.getTime() - b), end: new Date(e.getTime() + b) };
}

/** Computes a booking's expected exit from its entry and duration. */
function expectedExit(entry, durationMinutes) {
  return addMinutes(entry, durationMinutes);
}

/**
 * Billable duration, in minutes, rounded up to the next whole minute.
 * Used for check-out pricing; never negative.
 */
function billableMinutes(entry, exit) {
  const s = parseInstant(entry);
  const e = parseInstant(exit);
  if (!s || !e) return 0;
  return Math.max(0, Math.ceil((e.getTime() - s.getTime()) / MINUTE_MS));
}

/** Start of the UTC day containing `date`. */
function startOfUtcDay(date) {
  const d = parseInstant(date) || nowUtc();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Start of the local day for a fixed IANA offset expressed in minutes.
 * Owner dashboards report "today" in the lot's local time, not UTC — a lot in IST
 * closing at 23:00 must not have its takings split across two UTC days.
 */
function startOfLocalDay(date, offsetMinutes) {
  const d = parseInstant(date) || nowUtc();
  const shifted = new Date(d.getTime() + offsetMinutes * MINUTE_MS);
  const dayStartShifted = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate()
  );
  return new Date(dayStartShifted - offsetMinutes * MINUTE_MS);
}

/** Human-readable relative time for API responses: "in 18 min", "2 h ago". */
function humanizeRelative(target, from = nowUtc()) {
  const mins = diffMinutes(target, from);
  if (mins === null) return null;
  const abs = Math.abs(mins);
  const suffix = mins >= 0 ? 'in' : 'ago';
  let value;
  if (abs < 1) value = 'now';
  else if (abs < 60) value = `${abs} min`;
  else if (abs < 60 * 24) value = `${Math.round(abs / 60)} h`;
  else value = `${Math.round(abs / (60 * 24))} d`;
  if (value === 'now') return 'now';
  return mins >= 0 ? `${suffix} ${value}` : `${value} ${suffix}`;
}

module.exports = {
  MINUTE_MS,
  HOUR_MS,
  DAY_MS,
  parseInstant,
  parseClientInstant,
  hasExplicitOffset,
  toIso,
  nowUtc,
  addMinutes,
  addSeconds,
  diffMinutes,
  diffSeconds,
  isBefore,
  isAfter,
  intervalsOverlap,
  bufferedWindow,
  expectedExit,
  billableMinutes,
  startOfUtcDay,
  startOfLocalDay,
  humanizeRelative,
};

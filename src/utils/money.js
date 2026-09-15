'use strict';

/**
 * Money is represented as an integer number of paise, everywhere, always.
 *
 * The old system mixed rupees-as-float in the database, rupees-as-int in the pricing
 * engine, paise in the Razorpay call and a hardcoded `price = 1` in the client. That
 * is how a booking could be stored at ₹24, charged at ₹1 and displayed as "$5.00".
 */

const PAISE_PER_RUPEE = 100;

/** @param {number} rupees @returns {number} paise, rounded half-up */
function rupeesToPaise(rupees) {
  const n = Number(rupees);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * PAISE_PER_RUPEE);
}

/** @param {number} paise @returns {number} rupees as a float — display only, never for arithmetic */
function paiseToRupees(paise) {
  return toPaise(paise) / PAISE_PER_RUPEE;
}

/** Coerces anything to a safe non-negative integer paise value. */
function toPaise(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
}

/** Formats paise for display: 4050 → "₹40.50", 4000 → "₹40" */
function formatPaise(paise, { currency = '₹', alwaysShowDecimals = false } = {}) {
  const p = toPaise(paise);
  const rupees = Math.floor(p / PAISE_PER_RUPEE);
  const remainder = p % PAISE_PER_RUPEE;
  const grouped = groupIndian(rupees);
  if (remainder === 0 && !alwaysShowDecimals) return `${currency}${grouped}`;
  return `${currency}${grouped}.${String(remainder).padStart(2, '0')}`;
}

/** Indian digit grouping: 1234567 → "12,34,567" */
function groupIndian(n) {
  const s = String(Math.abs(Math.trunc(n)));
  if (s.length <= 3) return (n < 0 ? '-' : '') + s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  const grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return (n < 0 ? '-' : '') + grouped + ',' + last3;
}

/**
 * Applies a multiplier to a paise amount and rounds to the nearest whole rupee.
 * Parking prices are quoted in whole rupees; sub-rupee precision would surface as
 * "₹40.37/hr", which no user wants to see.
 */
function applyMultiplierToWholeRupees(basePaise, multiplier) {
  const raw = toPaise(basePaise) * Number(multiplier || 1);
  const rupees = Math.round(raw / PAISE_PER_RUPEE);
  return rupees * PAISE_PER_RUPEE;
}

/** Basis points: 250 bps of ₹40.00 → ₹1.00 */
function applyBasisPoints(paise, bps) {
  if (!bps) return 0;
  return Math.round((toPaise(paise) * Number(bps)) / 10000);
}

/** Sums line items defensively. */
function sum(...amounts) {
  return amounts.reduce((acc, a) => acc + toPaise(a), 0);
}

/** Percentage of an amount, rounded to the nearest paisa. */
function percentOf(paise, percent) {
  return Math.round((toPaise(paise) * Number(percent || 0)) / 100);
}

module.exports = {
  PAISE_PER_RUPEE,
  rupeesToPaise,
  paiseToRupees,
  toPaise,
  formatPaise,
  groupIndian,
  applyMultiplierToWholeRupees,
  applyBasisPoints,
  sum,
  percentOf,
};

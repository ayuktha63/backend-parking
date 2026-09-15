'use strict';

/**
 * Money arithmetic.
 *
 * These exist because the old system simultaneously held ₹24 in the database,
 * charged ₹1 at the gateway and displayed "$5.00" on the confirmation screen. Money
 * is integer paise everywhere now, and these tests pin that down.
 *
 * Run: npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const money = require('../../src/utils/money');

test('rupeesToPaise converts and rounds half-up', () => {
  assert.equal(money.rupeesToPaise(40), 4000);
  assert.equal(money.rupeesToPaise(40.5), 4050);
  assert.equal(money.rupeesToPaise(0.01), 1);
  assert.equal(money.rupeesToPaise(0), 0);
  // 0.1 + 0.2 style float error must not survive the boundary.
  assert.equal(money.rupeesToPaise(0.1 + 0.2), 30);
});

test('rupeesToPaise is defensive about junk input', () => {
  assert.equal(money.rupeesToPaise(undefined), 0);
  assert.equal(money.rupeesToPaise(null), 0);
  assert.equal(money.rupeesToPaise('nonsense'), 0);
  assert.equal(money.rupeesToPaise(NaN), 0);
  assert.equal(money.rupeesToPaise(Infinity), 0);
});

test('toPaise floors at zero and never returns a fraction', () => {
  assert.equal(money.toPaise(-500), 0);
  assert.equal(money.toPaise(12.7), 13);
  assert.equal(money.toPaise('4000'), 4000);
});

test('formatPaise renders Indian currency, hiding empty decimals', () => {
  assert.equal(money.formatPaise(4000), '₹40');
  assert.equal(money.formatPaise(4050), '₹40.50');
  assert.equal(money.formatPaise(4005), '₹40.05');
  assert.equal(money.formatPaise(0), '₹0');
  assert.equal(money.formatPaise(4000, { alwaysShowDecimals: true }), '₹40.00');
});

test('formatPaise groups digits the Indian way', () => {
  assert.equal(money.formatPaise(100000), '₹1,000');
  assert.equal(money.formatPaise(10000000), '₹1,00,000');
  assert.equal(money.formatPaise(123456700), '₹12,34,567');
});

test('groupIndian handles the lakh/crore boundaries', () => {
  assert.equal(money.groupIndian(999), '999');
  assert.equal(money.groupIndian(1000), '1,000');
  assert.equal(money.groupIndian(100000), '1,00,000');
  assert.equal(money.groupIndian(10000000), '1,00,00,000');
  assert.equal(money.groupIndian(-1000), '-1,000');
});

test('applyMultiplierToWholeRupees keeps quoted prices in whole rupees', () => {
  // A user should never be quoted "₹40.37/hr".
  assert.equal(money.applyMultiplierToWholeRupees(4000, 1.0), 4000);
  assert.equal(money.applyMultiplierToWholeRupees(4000, 1.2), 4800);
  assert.equal(money.applyMultiplierToWholeRupees(2000, 1.09), 2200);
  assert.equal(money.applyMultiplierToWholeRupees(2000, 1.0), 2000);
  assert.equal(money.applyMultiplierToWholeRupees(4000, undefined), 4000);
});

test('applyBasisPoints computes platform fees exactly', () => {
  assert.equal(money.applyBasisPoints(10000, 250), 250); // 2.5% of ₹100 = ₹2.50
  assert.equal(money.applyBasisPoints(10000, 0), 0);
  assert.equal(money.applyBasisPoints(4000, 100), 40);
});

test('percentOf drives the refund slabs', () => {
  assert.equal(money.percentOf(10000, 60), 6000);
  assert.equal(money.percentOf(10000, 40), 4000);
  assert.equal(money.percentOf(10000, 0), 0);
  assert.equal(money.percentOf(3333, 60), 2000); // rounds to nearest paisa
});

test('sum coerces every term before adding', () => {
  assert.equal(money.sum(1000, 2000, 500), 3500);
  assert.equal(money.sum(1000, undefined, null, 'x'), 1000);
});

test('a full price breakdown reconciles exactly', () => {
  // The invariant the Review screen depends on: the parts must equal the total.
  const base = money.rupeesToPaise(40);
  const dynamic = money.applyMultiplierToWholeRupees(base, 1.2);
  const fee = money.applyBasisPoints(dynamic, 0);
  const total = money.sum(dynamic, fee);

  assert.equal(dynamic, 4800);
  assert.equal(fee, 0);
  assert.equal(total, 4800);
  assert.equal(money.formatPaise(total), '₹48');
});

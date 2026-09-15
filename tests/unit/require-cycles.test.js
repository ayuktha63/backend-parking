'use strict';

/**
 * No top-level require cycles in src/.
 *
 * REGRESSION: bookingService began requiring parkingPhotoService (for one URL
 * helper), which requires operatorService, which requires bookingService. When
 * bookingService loaded first — as it does in the server, via its controller —
 * operatorService captured bookingService's exports object before
 * `module.exports = {...}` replaced it, and held an empty object for the life of
 * the process. The operator's check-in and check-out then failed with
 * "bookingService.checkIn is not a function", while every unit test that loaded
 * the modules in a different order passed.
 *
 * Requires inside functions (deliberately lazy) are ignored; only module-level
 * `require('./…')` statements can close a cycle at load time.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '../../src');

function listJs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJs(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

function resolveLocal(from, spec) {
  const base = path.resolve(path.dirname(from), spec);
  for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function topLevelRequires(file) {
  const edges = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    // Column-0 statements only: a require indented inside a function is lazy.
    const match = /^(?:const|let|var)\s[^=]+=\s*require\(['"](\.[^'"]+)['"]\)/.exec(line);
    if (!match) continue;
    const target = resolveLocal(file, match[1]);
    if (target) edges.push(target);
  }
  return edges;
}

test('src/ has no module-level require cycles', () => {
  const graph = new Map(listJs(SRC).map((f) => [f, topLevelRequires(f)]));
  const state = new Map(); // undefined = unvisited, 1 = in progress, 2 = done
  const stack = [];
  const cycles = [];

  function visit(node) {
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) || []) {
      if (state.get(next) === 1) {
        const loop = stack.slice(stack.indexOf(next)).concat(next);
        cycles.push(loop.map((f) => path.relative(SRC, f)).join(' → '));
      } else if (!state.has(next)) {
        visit(next);
      }
    }
    stack.pop();
    state.set(node, 2);
  }

  for (const node of graph.keys()) if (!state.has(node)) visit(node);
  assert.deepEqual(cycles, [], `require cycles found:\n  ${cycles.join('\n  ')}`);
});

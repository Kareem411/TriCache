#!/usr/bin/env node
/**
 * Fails CI when the README "tests passing" badge drifts from the actual
 * vitest total. Usage: node scripts/check-test-badge.mjs <test-output-file>
 *
 * Expects the file to contain vitest's summary line, e.g. "Tests  506 passed (506)",
 * and README.md to carry [![Tests](...badge/tests-<N>%20passing...)](...).
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/check-test-badge.mjs <test-output-file>');
  process.exit(2);
}

const out = readFileSync(file, 'utf8');
// Strip ANSI colour/dim codes — vitest emits e.g. "\x1b[2m Tests \x1b[22m \x1b[1m\x1b[32m506 passed".
const clean = out.replace(/\x1B\[[0-9;]*m/g, '');
const match = clean.match(/Tests\s+(\d+)\s+passed/);
if (!match) {
  console.error('check-test-badge: could not find a "Tests <N> passed" summary in the provided output.');
  process.exit(2);
}
const actual = Number(match[1]);

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const badge = readme.match(/badge\/tests-(\d+)%20passing/);
if (!badge) {
  console.error('check-test-badge: README.md has no tests-passing badge to check.');
  process.exit(2);
}
const declared = Number(badge[1]);

if (actual !== declared) {
  console.error(
    `check-test-badge: README badge declares ${declared} passing tests but the suite reports ${actual}. ` +
    `Update the badge in README.md (tests-${actual}%20passing) as part of the same PR.`,
  );
  process.exit(1);
}
console.log(`check-test-badge: OK (${declared} declared == ${actual} reported)`);

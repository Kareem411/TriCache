#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const ref = process.env.GITHUB_REF_NAME ?? process.argv[2];
if (!ref) {
  console.error('usage: node scripts/check-release-version.mjs <vX.Y.Z>');
  process.exit(2);
}
assert.match(ref, /^v\d+\.\d+\.\d+$/, 'Release tag must be a semantic version like v1.2.3');
assert.equal(ref.slice(1), pkg.version, `Release tag ${ref} does not match package version ${pkg.version}`);
console.log(`release version check: ${ref} matches package.json ${pkg.version}`);

'use strict';
const fs = require('fs');
function fixtureDir() {
  const candidates = [process.env.HC_TEST_DATA, '/Users/liups/ai/skill/test/v3/desensitized'].filter(Boolean);
  for (const c of candidates) { try { if (fs.statSync(c).isDirectory()) return c; } catch (_) {} }
  return null;
}
function requireFixtureOrSkip(testName) {
  const dir = fixtureDir();
  if (!dir) { console.log(`SKIP ${testName}: no fixture (set HC_TEST_DATA to a desensitized data dir)`); process.exit(0); }
  return dir;
}
module.exports = { fixtureDir, requireFixtureOrSkip };

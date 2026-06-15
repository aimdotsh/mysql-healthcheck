'use strict';
const assert = require('assert');
const { buildFacts } = require('../tools/preprocess.js');
const { requireFixtureOrSkip } = require('./fixture.js');

const DATA = requireFixtureOrSkip('buildfacts_test');
const facts = buildFacts(DATA, {});

assert.strictEqual(facts.nodes.length, 4, 'expected 4 nodes');
assert.strictEqual(facts.issues.length, 49, `expected 49 issues, got ${facts.issues.length}`);
const byP = p => facts.issues.filter(i => i.priority === p).length;
assert.deepStrictEqual([byP('P0'), byP('P1'), byP('P2'), byP('P3')], [5, 11, 28, 5], 'priority distribution drift');
assert.strictEqual(facts.healthScore.total, 88, 'healthScore drift');
console.log('OK buildfacts_test');

'use strict';
const assert = require('assert');
const charts = require('../tools/charts.js');

for (const fn of ['gauge', 'pie', 'hbar', 'vbar', 'radar', 'topology']) {
  assert.strictEqual(typeof charts[fn], 'function', `missing chart builder: ${fn}`);
}
const svg = charts.gauge(88, '健康度');
assert.ok(svg.trim().startsWith('<svg'), 'gauge must return inline <svg> string');
assert.ok(!/resvg|asPng/.test(svg), 'no resvg in output');
assert.strictEqual(charts.svgToPng, undefined, 'svgToPng must be removed');
console.log('OK charts_test');

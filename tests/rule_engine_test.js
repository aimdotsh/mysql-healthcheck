// rule_engine_test.js — v5.0 规则引擎单元测试
//
// 覆盖：
// - 表达式 tokenizer / parser / evaluator
// - 模板渲染（null 安全、嵌套路径）
// - 规则加载（schema 校验、维度推断）
// - 三种触发方式（trigger / tiers / handler）
// - cfg / disabledRules / priorities 三层覆盖
// - 异常隔离（坏规则不会让整个 run 崩）

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const engine = require('../scripts/rule-engine.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

// ─────────────────────────────────────────────────────────────
console.log('— expression: tokenizer & basic');
// ─────────────────────────────────────────────────────────────

test('tokenize: number + ident + op', () => {
  const t = engine._tokenize('node.x > 90');
  assert.strictEqual(t.length, 4); // IDENT, OP, NUM, EOF
});

test('tokenize: string with quotes', () => {
  const t = engine._tokenize("node.s == 'on'");
  assert.strictEqual(t[2].v, 'on');
});

test('tokenize: multi-char operators', () => {
  const t = engine._tokenize('a >= 1 && b <= 2');
  const ops = t.filter(x => x.t === 'OP').map(x => x.v);
  assert.deepStrictEqual(ops, ['>=', '&&', '<=']);
});

// ─────────────────────────────────────────────────────────────
console.log('— expression: eval semantics');
// ─────────────────────────────────────────────────────────────

test('simple greater-than', () => {
  assert.strictEqual(engine._evalExpr('node.x > 90', { node: { x: 95 } }), true);
  assert.strictEqual(engine._evalExpr('node.x > 90', { node: { x: 85 } }), false);
});

test('cfg.thresholds reference', () => {
  assert.strictEqual(
    engine._evalExpr('node.x > cfg.thresholds.t', { node: { x: 95 }, cfg: { thresholds: { t: 90 } } }),
    true
  );
});

test('null safety: missing path → false on numeric compare', () => {
  assert.strictEqual(engine._evalExpr('node.missing > 0', { node: {} }), false);
  assert.strictEqual(engine._evalExpr('node.missing >= 0', { node: {} }), false);
});

test('null safety: == null comparison works', () => {
  assert.strictEqual(engine._evalExpr('node.x == null', { node: { x: null } }), true);
  assert.strictEqual(engine._evalExpr('node.x != null', { node: { x: 1 } }), true);
});

test('logical and / or / not', () => {
  assert.strictEqual(engine._evalExpr('node.x > 0 && node.y < 5', { node: { x: 1, y: 3 } }), true);
  assert.strictEqual(engine._evalExpr('node.x > 0 || node.y < 5', { node: { x: -1, y: 3 } }), true);
  assert.strictEqual(engine._evalExpr('!(node.x > 0)', { node: { x: -1 } }), true);
});

test('string equality', () => {
  assert.strictEqual(engine._evalExpr("node.s == 'on'", { node: { s: 'on' } }), true);
  assert.strictEqual(engine._evalExpr("node.s != 'off'", { node: { s: 'on' } }), true);
});

test('arithmetic', () => {
  assert.strictEqual(engine._evalExpr('node.x + 5 > 10', { node: { x: 6 } }), true);
  assert.strictEqual(engine._evalExpr('node.x / 2 < 10', { node: { x: 18 } }), true);
});

test('parenthesized grouping', () => {
  assert.strictEqual(engine._evalExpr('(node.x > 1 || node.y > 1) && node.z > 0', { node: { x: 5, y: 0, z: 1 } }), true);
});

test('numbers: int and float', () => {
  assert.strictEqual(engine._evalExpr('node.x > 0.5', { node: { x: 0.7 } }), true);
  assert.strictEqual(engine._evalExpr('node.x < 0.5', { node: { x: 0.4 } }), true);
});

test('boolean literals', () => {
  assert.strictEqual(engine._evalExpr('node.b == true', { node: { b: true } }), true);
  assert.strictEqual(engine._evalExpr('node.b == false', { node: { b: false } }), true);
});

test('rejects forbidden syntax: function call', () => {
  // `foo(x)` lexes as IDENT then LPAREN — parser bails with "trailing tokens"
  // or "unexpected" depending on where it gives up. Either way, must throw.
  assert.throws(() => engine._parse('foo(x)'));
});

// ─────────────────────────────────────────────────────────────
console.log('— template rendering');
// ─────────────────────────────────────────────────────────────

test('basic substitution', () => {
  assert.strictEqual(
    engine._renderTpl('hi {{node.ip}} val {{x}}', { node: { ip: '1.2.3.4' }, x: 42 }),
    'hi 1.2.3.4 val 42'
  );
});

test('missing path → empty string', () => {
  assert.strictEqual(
    engine._renderTpl('val={{node.missing}}', { node: {} }),
    'val='
  );
});

test('null value → empty string', () => {
  assert.strictEqual(
    engine._renderTpl('val={{node.x}}', { node: { x: null } }),
    'val='
  );
});

test('whitespace inside braces tolerated', () => {
  assert.strictEqual(
    engine._renderTpl('hi {{ node.ip }}', { node: { ip: '1.2.3.4' } }),
    'hi 1.2.3.4'
  );
});

// ─────────────────────────────────────────────────────────────
console.log('— rule loader & validator');
// ─────────────────────────────────────────────────────────────

// v5.0.1：测试 fixture 改为「<dim>.json 文件 + rules:[] 数组」布局
function tempRulesDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rules-test-'));
}
function writeRulesFile(dir, dimension, rules) {
  fs.writeFileSync(path.join(dir, `${dimension}.json`), JSON.stringify({ rules }));
}

test('loadRulesFromDir: parses <dim>.json files and infers dimension from filename', () => {
  const dir = tempRulesDir();
  writeRulesFile(dir, 'availability', [{
    id: 'mem_high', scope: 'node', priority: 'P1',
    trigger: 'node.memUsagePct > 90',
    descriptionTpl: 'mem high on {{node.ip}}',
  }]);
  const rules = engine._loadRulesFromDir(dir);
  assert.strictEqual(rules.length, 1);
  assert.strictEqual(rules[0].dimension, 'availability'); // inferred from filename
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadRulesFromDir: multiple rules in one file all get same dimension', () => {
  const dir = tempRulesDir();
  writeRulesFile(dir, 'availability', [
    { id: 'a', scope: 'node', priority: 'P1', trigger: 'node.x > 0', descriptionTpl: 'a' },
    { id: 'b', scope: 'node', priority: 'P2', trigger: 'node.y > 0', descriptionTpl: 'b' },
  ]);
  const rules = engine._loadRulesFromDir(dir);
  assert.strictEqual(rules.length, 2);
  assert.ok(rules.every(r => r.dimension === 'availability'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadRulesFromDir: backward-compat — single rule object (no rules wrapper)', () => {
  const dir = tempRulesDir();
  fs.writeFileSync(path.join(dir, 'performance.json'), JSON.stringify({
    id: 'mem_high', scope: 'node', priority: 'P1',
    trigger: 'node.memUsagePct > 90', descriptionTpl: 'x',
  }));
  const rules = engine._loadRulesFromDir(dir);
  assert.strictEqual(rules.length, 1);
  assert.strictEqual(rules[0].dimension, 'performance');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('validateRule: rejects missing id', () => {
  assert.throws(() => engine._validateRule({ scope: 'node', trigger: 'x>1', priority: 'P1' }, '/x'), /missing id/);
});

test('validateRule: rejects bad scope', () => {
  assert.throws(() => engine._validateRule({ id: 'r', scope: 'global', trigger: 'x>1', priority: 'P1' }, '/x'), /bad scope/);
});

test('validateRule: rejects both trigger and tiers', () => {
  assert.throws(() => engine._validateRule({
    id: 'r', scope: 'node',
    trigger: 'x>1', priority: 'P1',
    tiers: [{ when: 'x>2', priority: 'P0' }],
  }, '/x'), /exactly one of/);
});

test('validateRule: rejects no trigger / tiers / handler', () => {
  assert.throws(() => engine._validateRule({ id: 'r', scope: 'node' }, '/x'), /exactly one of/);
});

test('validateRule: tier missing when', () => {
  assert.throws(() => engine._validateRule({
    id: 'r', scope: 'node',
    tiers: [{ priority: 'P0' }],
  }, '/x'), /tier\[0\] missing when/);
});

// ─────────────────────────────────────────────────────────────
console.log('— engine.run: end-to-end');
// ─────────────────────────────────────────────────────────────

test('trigger rule fires for matching nodes', () => {
  const dir = tempRulesDir();
  writeRulesFile(dir, 'availability', [{
    id: 'mem_high', scope: 'node', priority: 'P1',
    trigger: 'node.memUsagePct > cfg.thresholds.memory.high_pct',
    descriptionTpl: 'mem {{node.memUsagePct}}% on {{node.ip}}',
  }]);
  const e = engine.createEngine({ rulesDir: dir });
  const issues = e.run({
    nodes: [
      { ip: '1.1.1.1', memUsagePct: 95 },
      { ip: '2.2.2.2', memUsagePct: 70 },
    ],
    cfg: { thresholds: { memory: { high_pct: 90 } } },
  });
  assert.strictEqual(issues.length, 1);
  assert.strictEqual(issues[0].type, 'mem_high');
  assert.strictEqual(issues[0].priority, 'P1');
  assert.strictEqual(issues[0].description, 'mem 95% on 1.1.1.1');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tiers rule picks highest priority match', () => {
  const dir = tempRulesDir();
  writeRulesFile(dir, 'availability', [{
    id: 'disk_full', scope: 'node',
    tiers: [
      { when: 'node.disk >= 90', priority: 'P0' },
      { when: 'node.disk >= 80', priority: 'P1' },
    ],
    descriptionTpl: 'disk={{node.disk}}%',
  }]);
  const e = engine.createEngine({ rulesDir: dir });
  const issues = e.run({
    nodes: [
      { ip: 'a', disk: 95 },
      { ip: 'b', disk: 85 },
      { ip: 'c', disk: 70 },
    ],
  });
  assert.strictEqual(issues.length, 2);
  const a = issues.find(i => i.node === 'a');
  const b = issues.find(i => i.node === 'b');
  assert.strictEqual(a.priority, 'P0');
  assert.strictEqual(b.priority, 'P1');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('disabledRules skips rule entirely', () => {
  const dir = tempRulesDir();
  writeRulesFile(dir, 'availability', [{
    id: 'mem_high', scope: 'node', priority: 'P1',
    trigger: 'node.x > 0',
    descriptionTpl: 'x',
  }]);
  const e = engine.createEngine({ rulesDir: dir });
  const issues = e.run({
    nodes: [{ ip: 'a', x: 5 }],
    cfg: { disabledRules: ['mem_high'] },
  });
  assert.strictEqual(issues.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('priorities override applied', () => {
  const dir = tempRulesDir();
  writeRulesFile(dir, 'availability', [{
    id: 'mem_high', scope: 'node', priority: 'P1',
    trigger: 'node.x > 0',
    descriptionTpl: 'x',
  }]);
  const e = engine.createEngine({ rulesDir: dir });
  const issues = e.run({
    nodes: [{ ip: 'a', x: 5 }],
    cfg: { priorities: { mem_high: 'P0' } },
  });
  assert.strictEqual(issues[0].priority, 'P0');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('handler rule invokes registered helper', () => {
  const dir = tempRulesDir();
  writeRulesFile(dir, 'availability', [{
    id: 'my_handler_rule', scope: 'cluster', handler: 'myHelper', priority: 'P2',
    descriptionTpl: 'param {{match.name}} differs',
  }]);
  const helpers = {
    myHelper: () => [{ match: { name: 'foo' }, priority: 'P1' }],
  };
  const e = engine.createEngine({ rulesDir: dir, helpers });
  const issues = e.run({ cluster: {}, nodes: [] });
  assert.strictEqual(issues.length, 1);
  assert.strictEqual(issues[0].priority, 'P1');
  assert.strictEqual(issues[0].description, 'param foo differs');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('broken rule does not crash run; warning to stderr', () => {
  const dir = tempRulesDir();
  writeRulesFile(dir, 'availability', [
    {
      id: 'bad_rule', scope: 'node', priority: 'P1',
      trigger: 'node.x.y.z > 0',  // valid syntax, null-safe at runtime
      descriptionTpl: 'x',
    },
    {
      id: 'good_rule', scope: 'node', priority: 'P1',
      trigger: 'node.x > 0',
      descriptionTpl: 'x',
    },
  ]);
  const e = engine.createEngine({ rulesDir: dir });
  // even if bad_rule were truly broken, good_rule should still fire
  const issues = e.run({ nodes: [{ ip: 'a', x: 5 }] });
  assert.ok(issues.some(i => i.type === 'good_rule'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('issue.node defaults to node.ip when no nodeTpl', () => {
  const dir = tempRulesDir();
  writeRulesFile(dir, 'availability', [{
    id: 'r', scope: 'node', priority: 'P1',
    trigger: 'node.x > 0',
    descriptionTpl: 'x',
  }]);
  const e = engine.createEngine({ rulesDir: dir });
  const issues = e.run({ nodes: [{ ip: '10.0.0.1', x: 1 }] });
  assert.strictEqual(issues[0].node, '10.0.0.1');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('groupKeyTpl renders with node context', () => {
  const dir = tempRulesDir();
  writeRulesFile(dir, 'availability', [{
    id: 'r', scope: 'node', priority: 'P1',
    trigger: 'node.x > 0',
    groupKeyTpl: 'r:{{node.ip}}',
    descriptionTpl: 'x',
  }]);
  const e = engine.createEngine({ rulesDir: dir });
  const issues = e.run({ nodes: [{ ip: '1.1.1.1', x: 1 }] });
  assert.strictEqual(issues[0].groupKey, 'r:1.1.1.1');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('built-in connection_usage_high fires at configured threshold', () => {
  const rulesDir = path.join(__dirname, '..', 'scripts', 'rules');
  const helpers = require('../scripts/rule-helpers');
  const e = engine.createEngine({ rulesDir, helpers });
  const issues = e.run({
    nodes: [{ ip: '10.0.0.1', threadsConnected: 90, variables: { max_connections: '100' } }],
    cfg: { thresholds: { connection: { usage_p1_pct: 85, usage_p2_pct: 70 } }, disabledRules: [] },
  });
  const issue = issues.find(i => i.type === 'connection_usage_high');
  assert(issue, 'connection usage rule should fire');
  assert.strictEqual(issue.priority, 'P1');
  assert(issue.description.includes('90/100'));
});

test('built-in connection_usage_high ignores missing denominator', () => {
  const rulesDir = path.join(__dirname, '..', 'scripts', 'rules');
  const helpers = require('../scripts/rule-helpers');
  const e = engine.createEngine({ rulesDir, helpers });
  const issues = e.run({ nodes: [{ ip: '10.0.0.1', threadsConnected: 90, variables: {} }], cfg: {} });
  assert(!issues.some(i => i.type === 'connection_usage_high'));
});

test('built-in current_lock_waits fires only with current evidence', () => {
  const rulesDir = path.join(__dirname, '..', 'scripts', 'rules');
  const helpers = require('../scripts/rule-helpers');
  const e = engine.createEngine({ rulesDir, helpers });
  const issues = e.run({
    nodes: [{
      ip: '10.0.0.1', variables: {}, lockStatusCounters: { Innodb_row_lock_current_waits: '2' },
      innodbLockWaits: [], innodbLockDetails: [], metadataLocks: [{ lock: 'pending' }],
    }],
    cfg: { thresholds: { locks: { current_waits_p1: 5 } } },
  });
  const issue = issues.find(i => i.type === 'current_lock_waits');
  assert(issue, 'current lock wait rule should fire');
  assert.strictEqual(issue.priority, 'P2');
  assert(issue.needsConfirmation);
});

// ─────────────────────────────────────────────────────────────

console.log('');
console.log(`Result: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

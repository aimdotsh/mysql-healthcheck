#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const llm = require('../scripts/lib/llm-review');

const data = {
  project: '客户 A', inspectionDate: '2026-08-13',
  cluster: { topology: '一主一从', nodeCount: 2 },
  healthScore: { total: 82, dimensions: { availability: 80, performance: 78 } },
  overallAssessment: '运行整体稳定',
  issues: [{
    type: 'mem_high', dimension: 'availability', priority: 'P1', node: '10.0.0.1',
    description: '节点 10.0.0.1 内存使用率 95%', action: '检查配置', sql: 'SECRET SQL',
  }],
  correlations: [],
  nodes: [{
    ip: '10.0.0.1', hostname: 'db-primary.internal', role: 'primary', mysqlVersion: '8.0.36',
    memUsagePct: '95.0', memGB: 64, threadsConnected: 90, questions: 1000, slowQueries: 10,
    variables: { max_connections: '100', innodb_flush_log_at_trx_commit: '1' },
    topSqlByLatency: [{ db: 'orders', query: 'SELECT secret FROM users', execCount: 10 }],
    disks: [{ mount: '/data', usePct: 70 }],
  }],
};

const cfg = llm.loadConfig(null, {
  enabled: true, model: 'test-model', redactHosts: true, includeSqlText: false,
});
const snapshot = llm.buildInspectionSnapshot(data, cfg);
assert.strictEqual(snapshot.project, '已脱敏项目');
assert.strictEqual(snapshot.nodes[0].id, '节点1');
assert(!JSON.stringify(snapshot).includes('10.0.0.1'));
assert(!JSON.stringify(snapshot).includes('db-primary.internal'));
assert(!JSON.stringify(snapshot).includes('SELECT secret'));
assert(!JSON.stringify(snapshot).includes('SECRET SQL'));
assert.strictEqual(snapshot.nodes[0].connections.usagePct, 90);

const parsed = llm.parseModelJson('```json\n{"summary":"ok","findings":[]}\n```');
assert.strictEqual(parsed.summary, 'ok');

const normalized = llm.normalizeReview({
  summary: '发现连接压力',
  findings: [{
    category: 'availability', priority: 'P1', title: '连接余量不足',
    evidence: '90/100', suggestion: '检查连接池', verification: '查看历史峰值',
    relatedRuleIds: ['connection_usage_high'], isRuleGap: false,
  }],
  limitations: ['仅为单点快照'],
}, { provider: 'test', model: 'test-model' }, cfg);
assert.strictEqual(normalized.status, 'success');
assert.strictEqual(normalized.findings[0].id, 'AI-01');
assert.strictEqual(normalized.findings[0].priority, 'P1');
assert(normalized.disclaimer.includes('不改变规则告警'));

(async () => {
  process.env.MYSQL_HC_LLM_TEST_KEY = 'test-key';
  const review = await llm.runReview(data, { ...cfg, apiKeyEnv: 'MYSQL_HC_LLM_TEST_KEY' }, {
    requestJson: async (url, headers, body) => {
      assert(url.toString().endsWith('/v1/chat/completions'));
      assert.strictEqual(headers.Authorization, 'Bearer test-key');
      const payload = JSON.parse(body);
      assert.strictEqual(payload.model, 'test-model');
      return { choices: [{ message: { content: JSON.stringify({
        summary: 'mock', findings: [], limitations: ['mock only'],
      }) } }] };
    },
  });
  delete process.env.MYSQL_HC_LLM_TEST_KEY;
  assert.strictEqual(review.summary, 'mock');

  // CLI 智能体模式：prepare → agent result → apply。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mysql-hc-ai-cli-'));
  const dataPath = path.join(tmp, 'data.json');
  const inputPath = path.join(tmp, 'input.json');
  const resultPath = path.join(tmp, 'result.json');
  fs.writeFileSync(dataPath, JSON.stringify(data));
  const cliPath = path.join(__dirname, '..', 'scripts', 'ai-review.js');
  const prepare = spawnSync(process.execPath, [cliPath, dataPath, '--prepare', '--out', inputPath], { encoding: 'utf8' });
  assert.strictEqual(prepare.status, 0, prepare.stderr);
  assert(JSON.parse(fs.readFileSync(inputPath, 'utf8')).snapshot);
  fs.writeFileSync(resultPath, JSON.stringify({ summary: 'agent review', findings: [], limitations: [] }));
  const apply = spawnSync(process.execPath, [cliPath, dataPath, '--apply', resultPath], { encoding: 'utf8' });
  assert.strictEqual(apply.status, 0, apply.stderr);
  assert.strictEqual(JSON.parse(fs.readFileSync(dataPath, 'utf8')).aiAssessment.summary, 'agent review');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('llm review tests passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});

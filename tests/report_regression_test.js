#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const extractPath = path.join(repoRoot, 'scripts', 'extract.js');
const renderPath = path.join(repoRoot, 'scripts', 'render.js');
const dataDir = process.argv[2] || '/Users/liups/ai/skill/test/v3';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysql-healthcheck-regression-'));
const outPath = path.join(tmpDir, 'data.json');
const docxPath = path.join(tmpDir, 'report.docx');

const run = spawnSync('node', [extractPath, dataDir, '--project', 'v32V4doc', '--out', outPath], {
  encoding: 'utf8',
});

if (run.status !== 0) {
  process.stderr.write(run.stdout || '');
  process.stderr.write(run.stderr || '');
  throw new Error(`extract.js exited with status ${run.status}`);
}

const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));
const byIp = Object.fromEntries(data.nodes.map((node) => [node.ip, node]));

assert.strictEqual(data.nodes[0].ip, '172.16.7.2', 'primary node should be listed first for all report tables and charts');
assert.strictEqual(data.cluster.topology, '一主3从（异步复制）', 'cluster topology should identify one primary and three replicas');
assert.strictEqual(byIp['172.16.7.2'].role, 'primary', '172.16.7.2 should be inferred as the primary node');
assert.strictEqual(byIp['172.16.128.101'].role, 'slave', '172.16.128.101 should be inferred as a replica node');
assert.strictEqual(byIp['172.16.7.3'].role, 'slave', '172.16.7.3 should be inferred as a replica node');
assert.strictEqual(byIp['172.16.7.4'].role, 'slave', '172.16.7.4 should be inferred as a replica node');

assert.strictEqual(byIp['172.16.7.2'].osRelease, 'CentOS release 6.9 (Final)', 'OS release should be parsed from collector output');
assert.strictEqual(byIp['172.16.7.2'].osEolStatus.status, 'eol', 'CentOS 6 should be identified as EOL');
assert(!byIp['172.16.7.2'].binlogDirInfo.includes('[12] 安全与合规'), 'binlog section should strip collector module banners');

const osIssue = data.issues.find((issue) => issue.type === 'os_version_eol');
assert(osIssue, 'OS EOL issue should be promoted into issues');
assert(osIssue.description.includes('CentOS 6'), 'OS EOL issue should name the unsupported OS major version');

const hllIssue = data.issues.find((issue) => issue.type === 'innodb_hll_high');
assert(hllIssue, 'high History List Length should be promoted into issues');
assert.strictEqual(hllIssue.node, '172.16.7.2（主库）', 'HLL issue should point to the primary node');

const readOnlyJudgment = data.paramJudgments.find((item) => item.key === 'read_only');
assert(readOnlyJudgment, 'read_only parameter difference should be reported');
assert(readOnlyJudgment.valueMap.includes('172.16.128.101（从库）=0'), 'parameter difference should map values back to nodes');

const longQueryJudgment = data.paramJudgments.find((item) => item.key === 'long_query_time');
assert(longQueryJudgment.valueMap.includes('172.16.128.101（从库）=10'), 'long_query_time difference should identify the outlier node');

const auditIssue = data.issues.find((issue) => issue.type === 'compliance_fail_audit_log');
assert(auditIssue, 'audit compliance issue should be promoted into issues');
assert.strictEqual(
  auditIssue.description,
  '合规失败：未启用 audit log 插件，无法满足等保合规',
  'audit compliance wording should not contradict itself'
);

const backupIssue = data.issues.find((issue) => issue.type === 'backup_capability');
assert(backupIssue, 'backup assessment issue should be promoted into issues');
assert.strictEqual(
  data.backupAssessment.assessment,
  '检测到备份调度，但在已扫描目录未发现备份产物，需核实施路径或远端存储',
  'backup assessment should distinguish missing scan hits from confirmed absence of backups'
);
assert.strictEqual(data.backupAssessment.severity, 'P2', 'backup assessment should be downgraded when a schedule exists but artifacts were not found locally');
assert.strictEqual(
  backupIssue.description,
  '备份能力评估：检测到备份调度，但在已扫描目录未发现备份产物，需核实施路径或远端存储',
  'promoted backup issue should use the refined wording'
);
assert.deepStrictEqual(
  data.backupAssessment.hintPaths,
  ['/data/mysql/backup', '/opt/backup', '/opt/db_bak/bak_dir'],
  'backup assessment should surface candidate backup paths inferred from scheduling and scans'
);

const writableReplicaIssue = data.issues.find((issue) => issue.type === 'slave_writable' || issue.type === 'dr_writable');
assert(writableReplicaIssue, 'writable replica or DR exception issue should still be reported');
assert.strictEqual(writableReplicaIssue.node, '172.16.128.101（从库）', 'node labels should use inferred replica roles');

const securityItems = Object.fromEntries(data.securityAssessment.items.map((item) => [item.id, item]));
assert.strictEqual(securityItems.strong_password_policy.status, 'FAIL', 'empty password policy section should be treated as collected evidence of missing validate_password enforcement');
assert.strictEqual(securityItems.innodb_encryption.status, 'WARN', 'empty encryption section with no keyring should be treated as collected evidence of missing at-rest encryption');
assert.strictEqual(securityItems.no_empty_password.status, 'PASS', 'empty result set for empty-password users should be treated as a passing check');
assert.strictEqual(securityItems.failed_login_baseline.status, 'PASS', 'empty host_cache failure list should be treated as a passing check');
assert.strictEqual(data.securityAssessment.unknown, 0, 'current V3 samples should no longer be reported as UNKNOWN once empty sections are interpreted correctly');

const render = spawnSync('node', [renderPath, outPath, '--out', docxPath], {
  encoding: 'utf8',
});

if (render.status !== 0) {
  process.stderr.write(render.stdout || '');
  process.stderr.write(render.stderr || '');
  throw new Error(`render.js exited with status ${render.status}`);
}

const unzipDir = path.join(tmpDir, 'docx');
fs.mkdirSync(unzipDir, { recursive: true });
const unzip = spawnSync('unzip', ['-q', docxPath, '-d', unzipDir], { encoding: 'utf8' });
if (unzip.status !== 0) {
  process.stderr.write(unzip.stdout || '');
  process.stderr.write(unzip.stderr || '');
  throw new Error(`unzip exited with status ${unzip.status}`);
}

const parseText = (xmlPath) => {
  const xml = fs.readFileSync(xmlPath, 'utf8');
  return Array.from(xml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g))
    .map((match) => match[1]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&'))
    .join(' ');
};

const headerText = parseText(path.join(unzipDir, 'word', 'header1.xml'));
assert(headerText.includes('云和恩墨(北京)信息技术有限公司 成就所托'), 'header should use the fixed template company line');
assert(headerText.includes('http://www.enmotech.com'), 'header should include the fixed template website');
assert(!headerText.includes('v32V4doc'), 'header should not include the project name');
assert(!headerText.includes('172.16.7.2'), 'header should not include node IPs');

const bodyText = parseText(path.join(unzipDir, 'word', 'document.xml'));
assert(bodyText.includes('文档控制'), 'document should include the control page from the requested cover style');
assert(bodyText.includes('v32V4doc 数据库巡检报告'), 'cover should use the requested formal title style');
assert(bodyText.includes('编制'), 'document control page should include the approval matrix');
assert(bodyText.includes('MySQL 复制拓扑图'), 'server chapter should include a MySQL topology diagram caption/title');
assert(bodyText.includes('CentOS release 6.9 (Final)'), 'server chapter should show OS release, not only kernel');
assert(bodyText.includes('操作系统版本已停止维护'), 'server chapter should explain OS EOL risk');
assert(bodyText.includes('Swap 使用率'), 'memory section should include swap usage ratio');
assert(bodyText.includes('连接使用率'), 'connection chapter should include connection usage visualization or metric');
assert(bodyText.includes('172.16.128.101（从库）=10'), 'parameter difference table should map values to nodes');

console.log('report regression test passed');

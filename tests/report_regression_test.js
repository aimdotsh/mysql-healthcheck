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
// v4.4 评审 #2：dr-mysql 灾备节点应识别为 'dr' 而非 'slave'，避免在第二章 / 12.2 显示错误
assert.strictEqual(byIp['172.16.128.101'].role, 'dr', '172.16.128.101 (dr-mysql) should be inferred as a DR (灾备) node, not a regular slave');
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
// v4.4 评审 #2：dr-mysql 灾备节点角色应反映为 灾备 而非 从库
assert(readOnlyJudgment.valueMap.includes('172.16.128.101（灾备）=0'), 'parameter difference should map values back to nodes (灾备 role)');
assert(readOnlyJudgment.reason.includes('从库未只读：172.16.128.101'), 'read_only judgment should identify writable replica as the actual risk');

const longQueryJudgment = data.paramJudgments.find((item) => item.key === 'long_query_time');
assert(longQueryJudgment.valueMap.includes('172.16.128.101（灾备）=10'), 'long_query_time difference should identify the outlier node (灾备 role)');

// v4.7.2：第十六章「安全合规审计」已移除，compliance_fail_* issues 不再升级到 issues[]。
// 真正的安全风险（root@%、弱口令、复制账号 wildcard 等）依然由 wildcard_critical /
// wildcard_high / wildcard_medium 等规则独立捕获。
assert(
  !data.issues.find((issue) => issue.type && issue.type.startsWith('compliance_fail_')),
  'compliance_fail_* issues should NOT appear in issues after v4.7.2 (compliance chapter removed)'
);

const backupIssue = data.issues.find((issue) => issue.type === 'backup_capability');
assert(backupIssue, 'backup assessment issue should be promoted into issues');
// v4.4 评审 #9：parseBackupDirs flushCurrent 修复后，172.16.7.4 /data/backup 的真实 93GB 备份
// （tbl_order_detail_20240729.sql 等）能被正确识别，因此 v3 测试集现在能正确判定为「备份过旧」P0
// 而非旧版本错误的「未发现备份产物」。"655 天" 是相对当前日期计算的，用 startsWith 兼容。
assert(
  data.backupAssessment.assessment.startsWith('最近备份已 ') && data.backupAssessment.assessment.endsWith('天前，存在数据丢失风险'),
  'backup assessment should detect the 2024-07 stale backup recovered by parseBackupDirs flushCurrent fix (v4.4 #9)'
);
assert.strictEqual(data.backupAssessment.severity, 'P0', 'stale backup (>180 days) should be P0 severity');
assert.strictEqual(data.backupAssessment.hasBackupArtifact, true, 'parseBackupDirs flushCurrent fix should now recover real backup artifacts on 172.16.7.4 (v4.4 #9)');
assert.strictEqual(data.backupAssessment.latestBackup?.ip, '172.16.7.4', 'latest backup should be located on 172.16.7.4');
assert(data.backupAssessment.latestBackup?.path?.includes('tbl_order_detail_20240729.sql'), 'latest backup should be the 48GB tbl_order_detail file');
assert(
  backupIssue.description.startsWith('备份能力评估：最近备份已 '),
  'promoted backup issue should reflect the stale-backup wording after parseBackupDirs fix'
);
// hintPaths 现在合并了所有扫描路径 + crontab 推断路径
const hintSet = new Set(data.backupAssessment.hintPaths);
['/data/mysql/backup', '/opt/backup', '/opt/db_bak/bak_dir', '/data/backup'].forEach(p => {
  assert(hintSet.has(p), `backup hintPaths should include ${p}`);
});

const writableReplicaIssue = data.issues.find((issue) => issue.type === 'slave_writable' || issue.type === 'dr_writable');
assert(writableReplicaIssue, 'writable replica or DR exception issue should still be reported');
assert.strictEqual(writableReplicaIssue.node, '172.16.128.101（灾备）', 'node labels should use inferred 灾备 role for DR exceptions (v4.4 #2)');

assert.strictEqual(byIp['172.16.7.2'].ibtmp1CollectionStatus, 'collected', 'ibtmp1 current usage should be parsed from innodb_tablespaces when collector returns the row');
assert.strictEqual(byIp['172.16.7.2'].ibtmp1.source, 'txt:innodb_tablespaces', 'ibtmp1 data should record the TXT collection source');
assert(Array.isArray(byIp['172.16.7.2'].innodbLockWaits), 'lock wait section should be parsed even when empty');
assert.strictEqual(byIp['172.16.7.2'].lockCollectionStatus, 'collected', 'collector lock sections should be recognized');
assert(byIp['172.16.7.2'].lockStatusCounters.Innodb_row_lock_current_waits === '0', 'lock status counters should be parsed');
assert(byIp['172.16.7.2'].redundantIndexes[0].table, 'redundant index rows should expose table names');
assert(byIp['172.16.7.2'].redundantIndexes[0].redundantIndex, 'redundant index rows should expose redundant index names');

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
assert(bodyText.includes('172.16.128.101（灾备）=10'), 'parameter difference table should map values to nodes with 灾备 role (v4.4 #2)');
assert(bodyText.includes('无主键表分类汇总'), 'no primary key section should summarize business/history/temp table counts');
assert(bodyText.includes('V3 采集脚本已采集 innodb_tablespaces'), 'ibtmp1 section should explain data source and collection coverage');
assert(bodyText.includes('采集脚本已采集 INNODB LOCKS / INNODB LOCK WAITS / INNODB TRX / Metadata locks'), 'lock section should reflect actual collector coverage');
assert(bodyText.includes('未使用索引分类汇总'), 'unused index section should summarize table categories');
assert(bodyText.includes('冗余索引分类汇总'), 'redundant index section should summarize table categories');

console.log('report regression test passed');

// grouper_test.js — SaaS lib/grouper.js 单元测试
//
// 覆盖：
// - 真实 desensitized 1主3从样本（v5.0.2 bug 复现 + 修复验证）
// - parseReplicationLight：脱敏 hostname 不再触发 self-ref 误判
// - Master_Server_Id 解析
// - groupIntoClusters：hostname 冲突感知 + Phase 2 server_id 匹配兜底

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const grouper = require('../saas/lib/grouper.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

// ─────────────────────────────────────────────────────────────
console.log('— parseReplicationLight: 基础解析');
// ─────────────────────────────────────────────────────────────

const PRIMARY_CONTENT = `
----->>>---->>>  [01] hostname
db-primary

----->>>---->>>  [03] my.cnf
server_id = 1
log_bin = ON
`;

const SLAVE_CONTENT = `
----->>>---->>>  [01] hostname
db-slave-01

----->>>---->>>  [04] Slave status
*************************** 1. row ***************************
               Slave_IO_State: Waiting for master to send event
                  Master_Host: db-primary
                  Master_User: repl
                  Master_Port: 3306
             Slave_IO_Running: Yes
            Slave_SQL_Running: Yes
             Master_Server_Id: 1
                  Master_UUID: xxxxxxxx
                Auto_Position: 0

----->>>---->>>  [03] my.cnf
server_id = 2
`;

test('parseReplicationLight: primary 无 Slave 段 → isSlave=false', () => {
  const r = grouper.parseReplicationLight(PRIMARY_CONTENT, '10.0.0.1');
  assert.strictEqual(r.isSlave, false);
  assert.strictEqual(r.hostname, 'db-primary');
  assert.strictEqual(r.serverId, '1');
});

test('parseReplicationLight: slave 有 Slave 段 + masterServerId', () => {
  const r = grouper.parseReplicationLight(SLAVE_CONTENT, '10.0.0.2');
  assert.strictEqual(r.isSlave, true);
  assert.strictEqual(r.masterHost, 'db-primary');
  assert.strictEqual(r.masterServerId, '1');
  assert.strictEqual(r.hostname, 'db-slave-01');
  assert.strictEqual(r.serverId, '2');
});

// ─────────────────────────────────────────────────────────────
console.log('— parseReplicationLight: self-ref 修复（脱敏不再误判）');
// ─────────────────────────────────────────────────────────────

test('IP 维度的 self-ref 仍然识别（合理的 v4.5 残留场景）', () => {
  const r = grouper.parseReplicationLight(`
${SLAVE_CONTENT.replace('Master_Host: db-primary', 'Master_Host: 10.0.0.2')}
`, '10.0.0.2');
  // Master_Host == 本机 IP → 视为残留，不算 slave
  assert.strictEqual(r.isSlave, false);
  assert.strictEqual(r.selfRefResidue, true);
});

test('localhost / 127.0.0.1 仍然被识别为 self-ref', () => {
  const r1 = grouper.parseReplicationLight(
    SLAVE_CONTENT.replace('Master_Host: db-primary', 'Master_Host: localhost'),
    '10.0.0.2'
  );
  assert.strictEqual(r1.isSlave, false);
  assert.strictEqual(r1.selfRefResidue, true);
});

test('hostname 自指在 parseReplicationLight 阶段不再消除 isSlave', () => {
  // 脱敏场景：hostname == masterHost 但实际是不同节点
  // parseReplicationLight 不知道批次内其它节点，保守不消除
  const r = grouper.parseReplicationLight(`
----->>>---->>>  [01] hostname
masked-hostname

----->>>---->>>  [04] Slave status
*************************** 1. row ***************************
               Slave_IO_State: Waiting for master to send event
                  Master_Host: masked-hostname
             Master_Server_Id: 1
`, '10.0.0.2');
  // 关键修复：hostname 自指不再立即消除 isSlave
  assert.strictEqual(r.isSlave, true);
  assert.strictEqual(r.masterHost, 'masked-hostname');
});

// ─────────────────────────────────────────────────────────────
console.log('— groupIntoClusters: 端到端集群识别');
// ─────────────────────────────────────────────────────────────

function tempBatch(specs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grouper-test-'));
  const files = [];
  for (const spec of specs) {
    const filename = `MySQLHealthCheck_${spec.ip}_20260520.txt`;
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, spec.content);
    files.push({ path: filePath, originalName: filename });
  }
  return { dir, files };
}

test('1主3从（IP/hostname 都正常） → 1 集群', () => {
  const { dir, files } = tempBatch([
    { ip: '10.0.0.1', content: PRIMARY_CONTENT.replace('db-primary', 'host-a') },
    { ip: '10.0.0.2', content: SLAVE_CONTENT.replace('db-primary', 'host-a').replace('db-slave-01', 'host-b') },
    { ip: '10.0.0.3', content: SLAVE_CONTENT.replace('db-primary', 'host-a').replace('db-slave-01', 'host-c') },
    { ip: '10.0.0.4', content: SLAVE_CONTENT.replace('db-primary', 'host-a').replace('db-slave-01', 'host-d') },
  ]);
  const groups = grouper.groupIntoClusters(files);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].nodes.length, 4);
  assert.strictEqual(groups[0].primaryIp, '10.0.0.1');
  assert.ok(groups[0].topology.includes('一主3从'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('脱敏：所有 hostname 都是 masked-hostname → server_id 兜底成功', () => {
  // 模拟 desensitized 数据：4 个节点 hostname 全是 'masked-hostname'
  // 1 主（server_id=1）+ 3 从（masterServerId=1）
  const masked = 'masked-hostname';
  const primaryContent = `
----->>>---->>>  [01] hostname
${masked}

----->>>---->>>  [03] my.cnf
server_id = 1
`;
  const slaveTpl = (ownServerId) => `
----->>>---->>>  [01] hostname
${masked}

----->>>---->>>  [04] Slave status
*************************** 1. row ***************************
               Slave_IO_State: Waiting for master to send event
                  Master_Host: ${masked}
             Master_Server_Id: 1
             Slave_IO_Running: Yes

----->>>---->>>  [03] my.cnf
server_id = ${ownServerId}
`;
  const { dir, files } = tempBatch([
    { ip: '10.0.0.1', content: primaryContent },
    { ip: '10.0.0.2', content: slaveTpl(5) },
    { ip: '10.0.0.3', content: slaveTpl(10110075) },
    { ip: '10.0.0.4', content: slaveTpl(10110076) },
  ]);
  const groups = grouper.groupIntoClusters(files);
  assert.strictEqual(groups.length, 1, `expected 1 cluster, got ${groups.length}`);
  assert.strictEqual(groups[0].nodes.length, 4);
  assert.strictEqual(groups[0].primaryIp, '10.0.0.1');
  // 主库 _inferredViaServerIdMatch 标记应当存在
  const primaryNode = groups[0].nodes.find(n => n.ip === '10.0.0.1');
  assert.ok(primaryNode._inferredViaServerIdMatch, 'primary should be inferred via server_id match');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('脱敏 + 多 server_id=1 候选 → slave 同组、主库不强行 union', () => {
  // 罕见但需要防御：两个不同集群都是 server_id=1，hostname 都被脱敏
  // 期望：3 slaves 因 masterHost 字符串相同 union 在一起；2 个候选主库不强行加入
  const masked = 'masked-hostname';
  const primaryContent = (sid) => `
----->>>---->>>  [01] hostname
${masked}

----->>>---->>>  [03] my.cnf
server_id = ${sid}
`;
  const slaveTpl = (ownServerId) => `
----->>>---->>>  [01] hostname
${masked}

----->>>---->>>  [04] Slave status
*************************** 1. row ***************************
               Slave_IO_State: ok
                  Master_Host: ${masked}
             Master_Server_Id: 1

----->>>---->>>  [03] my.cnf
server_id = ${ownServerId}
`;
  const { dir, files } = tempBatch([
    { ip: '10.0.0.1', content: primaryContent(1) },
    { ip: '10.1.0.1', content: primaryContent(1) },  // 第二个 server_id=1 候选
    { ip: '10.0.0.2', content: slaveTpl(5) },
    { ip: '10.0.0.3', content: slaveTpl(6) },
  ]);
  const groups = grouper.groupIntoClusters(files);
  // 期望：slaves 同组（masterHost 字符串相同），2 个 server_id=1 候选不强行 union
  // 所以 ≥ 2 个集群（slaves 一组 + 至少 2 个独立 primary 节点）
  assert.ok(groups.length >= 2, `expected ambiguous grouping (≥2 groups), got ${groups.length}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('IP 自指 self-ref 残留：批次内仅 1 个文件 → 单节点 primary', () => {
  const ipSelfRef = SLAVE_CONTENT.replace('Master_Host: db-primary', 'Master_Host: 10.0.0.5');
  const { dir, files } = tempBatch([
    { ip: '10.0.0.5', content: ipSelfRef },
  ]);
  const groups = grouper.groupIntoClusters(files);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].nodes[0].selfRefResidue, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('hostname 唯一时的 self-ref（v4.5 合理场景）仍能识别', () => {
  // 批次内只有这 1 个节点，hostname 唯一，masterHost == hostname 应当判为 self-ref
  const content = `
----->>>---->>>  [01] hostname
db-old-primary

----->>>---->>>  [04] Slave status
*************************** 1. row ***************************
               Slave_IO_State: ok
                  Master_Host: db-old-primary
             Master_Server_Id: 1
`;
  const { dir, files } = tempBatch([
    { ip: '10.0.0.1', content },
  ]);
  const groups = grouper.groupIntoClusters(files);
  assert.strictEqual(groups.length, 1);
  const n = groups[0].nodes[0];
  assert.strictEqual(n.isSlave, false, 'should NOT be slave (self-ref)');
  assert.strictEqual(n.selfRefResidue, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────
console.log('');
console.log(`Result: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

'use strict';
const assert = require('assert');
const { detectDualMaster } = require('../tools/preprocess.js');

function mkNode(ip, masterHost, role) {
  return { ip, role, replication: { isSlave: !!masterHost, status: { masterHost: masterHost || null } } };
}

// 1) 互为主从 → 两端 primary + isDualMaster + peer 互指
{
  const a = mkNode('10.0.0.1', '10.0.0.2', 'primary');
  const b = mkNode('10.0.0.2', '10.0.0.1', 'slave');
  detectDualMaster([a, b]);
  assert.strictEqual(a.role, 'primary', 'a role');
  assert.strictEqual(b.role, 'primary', 'b reclassified to primary');
  assert.strictEqual(a.isDualMaster, true, 'a isDualMaster');
  assert.strictEqual(b.isDualMaster, true, 'b isDualMaster');
  assert.strictEqual(a.dualMasterPeer, '10.0.0.2', 'a peer');
  assert.strictEqual(b.dualMasterPeer, '10.0.0.1', 'b peer');
}

// 2) 普通一主一从（仅 B 复制 A）→ 都不标 isDualMaster
{
  const a = mkNode('10.0.0.1', null, 'primary');
  const b = mkNode('10.0.0.2', '10.0.0.1', 'slave');
  detectDualMaster([a, b]);
  assert.ok(!a.isDualMaster && !b.isDualMaster, 'one-way replication is NOT dual-master');
  assert.strictEqual(b.role, 'slave', 'slave stays slave');
}

console.log('OK dual_master_test (detection)');

// ── 写冲突 handler ──
const { evalDualMasterWriteConflict } = require('../tools/rule-helpers/index.js');
const CONFLICT_ERR = "Could not execute Write_rows event on table appdb.orders; Duplicate entry '23138' for key 'orders.PRIMARY', Error_code: 1062; handler error HA_ERR_FOUND_DUPP_KEY";

// 3) 双主 + SQL 线程停在 1062 → 1 条 P0，点名冲突表
{
  const node = {
    ip: '10.0.0.2', isDualMaster: true, dualMasterPeer: '10.0.0.1',
    replication: { status: { slaveSqlRunning: 'No', lastSqlError: CONFLICT_ERR } },
  };
  const out = evalDualMasterWriteConflict({ node, cfg: {} });
  assert.strictEqual(out.length, 1, 'should emit 1 issue');
  assert.strictEqual(out[0].type, 'dual_master_write_conflict', 'type');
  assert.strictEqual(out[0].priority, 'P0', 'P0');
  assert.ok(out[0].description.includes('appdb.orders'), 'names conflict table');
  assert.ok(/10\.0\.0\.1/.test(out[0].action), 'action references peer');
}

// 4) 非双主 / SQL 正常 / 非 1062 → []
{
  assert.deepStrictEqual(evalDualMasterWriteConflict({ node: { isDualMaster: false }, cfg: {} }), [], 'not dual master');
  assert.deepStrictEqual(
    evalDualMasterWriteConflict({ node: { isDualMaster: true, replication: { status: { slaveSqlRunning: 'Yes' } } }, cfg: {} }),
    [], 'sql running ok');
  assert.deepStrictEqual(
    evalDualMasterWriteConflict({ node: { isDualMaster: true, replication: { status: { slaveSqlRunning: 'No', lastSqlError: 'some other error' } } }, cfg: {} }),
    [], 'not a 1062 conflict');
}

console.log('OK dual_master_test (write conflict)');

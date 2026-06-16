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

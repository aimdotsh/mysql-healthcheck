# 双主识别 + 写冲突诊断 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让工具正确识别「双主（master-master，互为主从）」拓扑，消除 `slave_writable` 误报，并新增 P0「双主写冲突」诊断（点名冲突表 + 重建复制 / 自增拆分处置）。

**Architecture:** 在 `preprocess.js` 的角色推断之后加 `detectDualMaster()`，把互为主从的两节点都标 `role='primary'` + `isDualMaster`；`deriveTopology`/`nodeLabel` 加双主分支；规则引擎加 handler `evalDualMasterWriteConflict` 出 P0。规则逻辑零回归（脱敏集仍 49 项）。

**Tech Stack:** Node.js（仅 `fs`/`path`），声明式规则引擎 + rule-helpers handler，纯 `assert` 单元测试。

---

## File Structure

| 文件 | 改动 |
|---|---|
| `tools/preprocess.js` | +`detectDualMaster()`；buildFacts 在 `normalizeNodeRoles` 后调用它；`deriveTopology` 双主分支；`nodeLabel` 加 `·双主` 后缀；`module.exports` 加 `detectDualMaster` |
| `tools/rule-helpers/index.js` | +`evalDualMasterWriteConflict()`；`evalRoleReadOnly` slave_writable 分支加 `&& !node.isDualMaster`；导出注册 |
| `tools/rules/durability.json` | + `dual_master_write_conflict` 规则条目（handler 形式） |
| `tests/dual_master_test.js` | 新增单元测试（Task 1 建，Task 2 扩） |
| `package.json` | test 脚本串入 `tests/dual_master_test.js` |
| `SKILL.md` / `CHANGELOG.md` / `VERSION` | 1.1.0 → 1.2.0 |

**测试数据约定**：不提交 yangben（客户数据 + 公开仓）。单元测试用手搓最小 node 对象；冲突错误串用**合成**值（`appdb.orders`，非客户 schema）。

---

## Task 1: 双主识别（detectDualMaster + 拓扑 + 标签）

**Files:**
- Modify: `tools/preprocess.js`（新增函数；buildFacts:1670 后插入调用；`deriveTopology`:1740；`nodeLabel`:2130；`module.exports`:2922）
- Test: `tests/dual_master_test.js`

- [ ] **Step 1: 写失败测试**

Create `tests/dual_master_test.js`:

```js
'use strict';
const assert = require('assert');
const { detectDualMaster } = require('../tools/preprocess.js');

// 构造最小 node：互为主从
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
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/liups/ai/skill/mysql-healthcheck && node tests/dual_master_test.js`
Expected: FAIL — `detectDualMaster is not a function`.

- [ ] **Step 3: 新增 `detectDualMaster` 函数**

在 `tools/preprocess.js` 的 `function deriveTopology(nodes) {`（约 1740 行）**之前**插入：

```js
// 双主识别：两节点互为主从（A 的 masterHost==B.ip 且 B 的 masterHost==A.ip）
// → 两端都是 master（且互为对方的从）。标 role='primary' + isDualMaster + 对端 ip。
function detectDualMaster(nodes) {
  for (const a of nodes) {
    const aMaster = a.replication?.status?.masterHost;
    if (!a.replication?.isSlave || !aMaster) continue;
    const b = nodes.find(n => n !== a && n.ip === aMaster);
    if (!b) continue;
    if (b.replication?.isSlave && b.replication?.status?.masterHost === a.ip) {
      a.role = 'primary';
      b.role = 'primary';
      a.isDualMaster = true;
      b.isDualMaster = true;
      a.dualMasterPeer = b.ip;
      b.dualMasterPeer = a.ip;
    }
  }
}
```

- [ ] **Step 4: 导出 `detectDualMaster`**

把文件末尾 `module.exports = { buildFacts, loadHcConfig };` 改为：
```js
module.exports = { buildFacts, loadHcConfig, detectDualMaster };
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node tests/dual_master_test.js`
Expected: `OK dual_master_test (detection)`

- [ ] **Step 6: 在 buildFacts 里接线（normalizeNodeRoles 之后）**

在 `tools/preprocess.js` 第 1670-1671 行：
```js
  normalizeNodeRoles(nodes);
  sortNodesPrimaryFirst(nodes);
```
改为：
```js
  normalizeNodeRoles(nodes);
  detectDualMaster(nodes);   // 双主：互为主从对 → 两端 primary + isDualMaster
  sortNodesPrimaryFirst(nodes);
```

- [ ] **Step 7: `deriveTopology` 加双主分支**

把 `deriveTopology`（约 1740）函数体开头改为（在现有 `const primary = ...` 之前加一行）：
```js
function deriveTopology(nodes) {
  if (nodes.some(n => n.isDualMaster)) return '双主（master-master，互为主从）';
  const primary = nodes.find(n => n.role === 'primary');
  const slaves = nodes.filter(n => n.role !== 'primary');
  if (primary && slaves.length > 0) {
    return `一主${slaves.length}从（异步复制）`;
  }
  if (nodes.length === 1) return '单节点';
  return '集群';
}
```

- [ ] **Step 8: `nodeLabel` 加 `·双主` 后缀**

把 `tools/preprocess.js:2130` 的：
```js
  const nodeLabel = (n) => `${n.ip}（${roleLabel(n.role)}）`;
```
改为：
```js
  const nodeLabel = (n) => `${n.ip}（${roleLabel(n.role)}${n.isDualMaster ? '·双主' : ''}）`;
```

- [ ] **Step 9: 回归 + 测试全绿**

Run: `node tests/dual_master_test.js && node tests/buildfacts_test.js`
Expected: `OK dual_master_test (detection)` + `OK buildfacts_test`（脱敏集是一主一从，49 项不受影响）。

- [ ] **Step 10: Commit**

```bash
cd /Users/liups/ai/skill/mysql-healthcheck
git add tools/preprocess.js tests/dual_master_test.js
git commit -m "feat(topology): 识别双主（互为主从）→ 两端 primary + isDualMaster + 拓扑/标签

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: 写冲突 P0 规则（evalDualMasterWriteConflict）

**Files:**
- Modify: `tools/rule-helpers/index.js`（新增 handler；`evalRoleReadOnly` 加 `!isDualMaster`；`module.exports`）
- Modify: `tools/rules/durability.json`（加 handler 规则条目）
- Test: `tests/dual_master_test.js`（追加）

- [ ] **Step 1: 追加失败测试**

在 `tests/dual_master_test.js` 末尾（`console.log('OK dual_master_test (detection)')` 之后）追加：

```js
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
```

- [ ] **Step 2: 运行确认失败**

Run: `node tests/dual_master_test.js`
Expected: FAIL — `evalDualMasterWriteConflict is not a function`.

- [ ] **Step 3: 新增 handler**

在 `tools/rule-helpers/index.js` 的 `module.exports = {` **之前**插入：

```js
// 双主写冲突：双主某端 SQL 复制线程因主键冲突（1062）中止 → 数据已分叉
function evalDualMasterWriteConflict(ctx) {
  const { node } = ctx;
  if (!node.isDualMaster) return [];
  const st = node.replication?.status || {};
  if (st.slaveSqlRunning !== 'No') return [];
  const err = String(st.lastSqlError || '');
  if (!/1062|duplicate entry/i.test(err)) return [];

  // 提取冲突表（优先 "on table X.Y"，回退 "for key 'X.Y.PRIMARY'" 去掉索引名）
  const onTable = (err.match(/on table (\S+?)[;\s]/i) || [])[1] || null;
  const keyName = (err.match(/for key '([^']+)'/) || [])[1] || null;
  const tableName = onTable || (keyName ? keyName.replace(/\.[^.]+$/, '') : null);
  const dupVal = (err.match(/Duplicate entry '([^']+)'/i) || [])[1] || null;
  const peer = node.dualMasterPeer || '对端主库';
  const tblText = tableName ? `表 ${tableName}` : '某张表';

  return [{
    type: 'dual_master_write_conflict',
    priority: 'P0',
    groupKey: `dual_master_conflict:${node.ip}`,
    dimension: 'durability',
    description: `双主写冲突：节点 ${node.ip} 的复制 SQL 线程因主键冲突中止（${tblText}${dupVal ? `，重复键 '${dupVal}'` : ''}）。本端与对端 ${peer} 同时写入了同一主键，两库数据已分叉，复制已断；继续双写会持续制造冲突。`,
    currentValue: `SQL 线程 Stopped；${tblText} 主键冲突${dupVal ? `（Duplicate entry '${dupVal}'）` : ''}`,
    recommendedValue: `选定权威端 → 核对修复分叉数据 → 重建复制；并按双主拆分自增（auto_increment_increment=2 + offset 1/2）或收敛为单边写`,
    action: [
      `1) 选定权威端：以业务写入量大 / 数据更全的一端为准（需人工判断 ${node.ip} 还是 ${peer}）；`,
      `2) 核对分叉：用 pt-table-checksum 或人工比对两端 ${tableName || '冲突表'} 的差异行，决定保留/合并策略；`,
      `3) 重建复制：权威端确认位点后，另一端 STOP SLAVE; 修复数据; RESET SLAVE; 重新 CHANGE MASTER 指向权威端；`,
      `4) 防再发：按双主规范拆分自增（${node.ip}: auto_increment_offset=1、${peer}: =2，两端 auto_increment_increment=2），或收敛为「只写单边」的伪双主、应用层禁止双写。`,
    ].join('\n   '),
    sql: [
      '-- 查看断点：',
      'SHOW SLAVE STATUS\\G   -- 关注 Last_SQL_Error / Exec_Master_Log_Pos',
      '-- 防再发：双主自增拆分（两端 increment=2，offset 分别 1 / 2）：',
      'SET GLOBAL auto_increment_increment = 2;',
      'SET GLOBAL auto_increment_offset = 1;   -- 对端设为 2',
    ].join('\n'),
    scope: 'node',
  }];
}
```

- [ ] **Step 4: 注册导出**

把 `tools/rule-helpers/index.js` 的 `module.exports` 末尾：
```js
  evalIbtmp1Oversize,
  evalSwapUsed,
};
```
改为：
```js
  evalIbtmp1Oversize,
  evalSwapUsed,
  evalDualMasterWriteConflict,
};
```

- [ ] **Step 5: `evalRoleReadOnly` slave_writable 兜底**

在 `tools/rule-helpers/index.js` 的 `evalRoleReadOnly` 中，找到（约 199 行）：
```js
  if (node.role !== 'primary' && node.replication?.isSlave && v.read_only === '0') {
```
改为：
```js
  if (node.role !== 'primary' && !node.isDualMaster && node.replication?.isSlave && v.read_only === '0') {
```

- [ ] **Step 6: durability.json 加规则条目**

在 `tools/rules/durability.json` 的 `ibtmp1_oversize` 条目（`"handler": "evalIbtmp1Oversize"` 那条，结尾 `}`）**之后**加一个逗号并插入新条目：

```json
    {
      "id": "dual_master_write_conflict",
      "scope": "node",
      "priority": "P0",
      "title": "双主写冲突",
      "rationale": "双主双写同一主键导致复制 SQL 线程中止、两库数据已分叉。点名冲突表，给出选定权威端 + 重建复制 + 自增拆分的处置。",
      "handler": "evalDualMasterWriteConflict"
    }
```
（确保它仍在 `"rules": [ ... ]` 数组内、与其它条目用逗号分隔，JSON 合法。）

- [ ] **Step 7: 运行测试 + JSON 合法性**

Run: `node tests/dual_master_test.js`
Expected: `OK dual_master_test (detection)` + `OK dual_master_test (write conflict)`

Run: `node -e "JSON.parse(require('fs').readFileSync('tools/rules/durability.json','utf8')); console.log('durability.json valid')"`
Expected: `durability.json valid`

Run（确认规则被引擎加载，不报 handler 缺失）: `node -e "const re=require('./tools/rule-engine.js'); const rs=re._loadRulesFromDir('./tools/rules'); console.log('dual rule loaded:', rs.some(r=>r.id==='dual_master_write_conflict'))"`
Expected: `dual rule loaded: true`

- [ ] **Step 8: 回归全绿**

Run: `node tests/buildfacts_test.js && node tests/charts_test.js && node tests/render_offline_test.js && node tests/report_e2e_test.js && node tests/dual_master_test.js`
Expected: 全部 OK（脱敏集一主一从，不触发双主逻辑，49 项不变）。

- [ ] **Step 9: Commit**

```bash
cd /Users/liups/ai/skill/mysql-healthcheck
git add tools/rule-helpers/index.js tools/rules/durability.json tests/dual_master_test.js
git commit -m "feat(rules): 双主写冲突 P0 诊断（点名冲突表 + 重建复制/自增拆分）；slave_writable 双主兜底

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: yangben 验收 + 文档/版本 + 推送

**Files:**
- Modify: `package.json`（test 脚本）、`VERSION`、`CHANGELOG.md`、`SKILL.md`

- [ ] **Step 1: test 脚本串入新测试**

把 `package.json` 的 test 脚本：
```json
"test": "node tests/buildfacts_test.js && node tests/charts_test.js && node tests/render_offline_test.js && node tests/report_e2e_test.js",
```
改为：
```json
"test": "node tests/buildfacts_test.js && node tests/charts_test.js && node tests/render_offline_test.js && node tests/report_e2e_test.js && node tests/dual_master_test.js",
```

- [ ] **Step 2: yangben 人工验收（本机，不入仓）**

Run:
```bash
cd /Users/liups/ai/skill/mysql-healthcheck
rm -rf /tmp/ym && node tools/report.js yangben --out-dir /tmp/ym --emit-facts --project "双主环境样本" 2>&1 | tail -3
echo "--- topology ---"; node -e "const f=require('/tmp/ym/facts.json'); console.log(f.cluster.topology)"
echo "--- labels + roles ---"; node -e "const f=require('/tmp/ym/facts.json'); f.nodes.forEach(n=>console.log(n.label, n.role, 'dual='+!!n.isDualMaster))"
echo "--- slave_writable 应消失 / dual_master_write_conflict 应出现 / repl_thread_down 应在 ---"
node -e "const f=require('/tmp/ym/facts.json'); const t=f.issues.map(i=>i.type); console.log('slave_writable:', t.includes('slave_writable'), '| dual_master_write_conflict:', t.filter(x=>x==='dual_master_write_conflict').length, '| repl_thread_down:', t.filter(x=>x==='repl_thread_down').length)"
echo "--- 冲突表点名 ---"; node -e "const f=require('/tmp/ym/facts.json'); const c=f.issues.find(i=>i.type==='dual_master_write_conflict'); console.log(c?c.description:'(none)')"
```
Expected（验收标准）:
- topology = `双主（master-master，互为主从）`
- 两节点 label 含 `主库·双主`，role=primary，dual=true
- `slave_writable: false`、`dual_master_write_conflict: 1`、`repl_thread_down: 2`
- 冲突表描述含 `ZDL.sys_logininfor`

若任一不符 → 停下来排查（不要继续提交）。

- [ ] **Step 3: 版本 1.2.0**

`VERSION` 内容改为 `1.2.0`。
`SKILL.md` 两处版本（frontmatter `version:` 行 + `<!-- skill version: ... -->` 注释行）从 `1.1.0` 改为 `1.2.0`。

- [ ] **Step 4: CHANGELOG 1.2.0 条目**

在 `CHANGELOG.md` 顶部（`## [1.1.0]` 之前）插入：
```markdown
## [1.2.0] - 2026-06-15

**双主（master-master）识别 + 写冲突诊断**

- 新增 `detectDualMaster()`：两节点互为主从 → 两端标 `primary` + `isDualMaster`；拓扑显示「双主（master-master，互为主从）」，节点标签「主库·双主」。
- 修复 `slave_writable` 在双主下的误报（双主两端可写是设计如此）。
- 新增 P0 规则 `dual_master_write_conflict`：双主某端 SQL 复制线程因主键冲突（1062）中止时，点名冲突表 + 给出「选定权威端 → 核对修复分叉 → 重建复制 → 自增拆分防再发」的处置。
- 单元测试 `tests/dual_master_test.js`；脱敏集（一主一从）49 项回归不受影响。
```

- [ ] **Step 5: 全量测试 + 版本一致性**

Run:
```bash
npm test 2>&1 | grep -cE "^OK "
echo "VERSION=$(cat VERSION) SKILL=$(grep -m1 'version:' SKILL.md) CHANGELOG=$(grep -m1 '## \[' CHANGELOG.md)"
```
Expected: `7`（6 旧 + 1 新 dual_master）；三处版本都是 1.2.0。

- [ ] **Step 6: Commit + push**

```bash
cd /Users/liups/ai/skill/mysql-healthcheck
git add package.json VERSION CHANGELOG.md SKILL.md
git commit -m "docs: 1.2.0 — 双主识别 + 写冲突诊断；test 串入 dual_master_test

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
git push origin skill
```
Expected: 推送成功。**不要 sync-to-workbuddy（dist 镜像 SaaS）。**

- [ ] **Step 7（可选，需用户确认）: 发二进制 Release**

如用户同意发布更新的二进制：`git tag offline-v1.2.0 && git push origin offline-v1.2.0`（CI 自动构建发布）。**对外动作，先问用户。**

---

## Self-Review

- **Spec 覆盖**：双主识别(Task1)/拓扑+标签(Task1)/slave_writable 兜底(Task2 S5)/写冲突 P0(Task2)/单元测试(Task1+2)/yangben 验收(Task3 S2)/版本文档(Task3) 全有任务对应。✅
- **占位扫描**：无 TODO/TBD；handler 与 detect 函数体均为完整代码。✅
- **类型/命名一致**：`detectDualMaster` / `evalDualMasterWriteConflict` / `isDualMaster` / `dualMasterPeer` / `dual_master_write_conflict` 在 plan 内各处一致；冲突表提取逻辑（`on table` 优先）与测试合成串（`appdb.orders`）+ yangben 实串（`ZDL.sys_logininfor`）均匹配。✅
- **回归**：脱敏集一主一从，detectDualMaster 不触发（无互为主从对），49 项不变 —— Task1 S9 + Task2 S8 双重验证。✅

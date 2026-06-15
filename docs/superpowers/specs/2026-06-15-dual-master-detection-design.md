# 双主识别 + 写冲突诊断 — 设计 spec

**日期**：2026-06-15
**分支**：skill
**版本**：1.1.0 → 1.2.0

---

## 一、背景

样本 `yangben/`（10.120.8.141 / 10.120.8.142）是 **双主（master-master，互为主从）** 环境，但当前工具误判为「一主1从」：

- `141` 复制自 `142`（`masterHost=10.120.8.142`），`142` 复制自 `141`（`masterHost=10.120.8.141`），两端 `read_only=0` 都可写 → 典型双主。
- [normalizeNodeRoles](../../../tools/preprocess.js) 看到 141 有 connected slave 标 `primary`、142 是 isSlave 标 `slave`，**没检查 141 自己也是 142 的从** → 漏掉「互为主从」。

由此产生 3 个问题：
1. 拓扑章节显示「一主1从（异步复制）」，误导客户。
2. `slave_writable`（P1「从库 read_only=0，存在数据漂移风险」）在双主下是**误报**——双主两端可写是设计如此。
3. 缺最有价值的结论：142 的 SQL 线程停在 `1062 Duplicate entry '23138' for key 'ZDL.sys_logininfor.PRIMARY'`，正是**双主双写同一主键的写冲突**，但报告只把两个 `repl_thread_down` 当独立故障列出，没点破根因。

## 二、已确认决策（brainstorming）

| 决策点 | 选择 |
|---|---|
| 双主节点角色标签 | **`IP（主库·双主）`** |
| 识别位置 | preprocess.js（`normalizeNodeRoles` 之后），与现有 topology/role 推断同层 |
| 写冲突诊断形态 | **rule 引擎 handler → P0 issue**（进第十六章行动计划） |
| `slave_writable` 误报 | 双主两端重分类为 `primary` 自动消除 + handler 加 `!isDualMaster` 兜底 |
| 测试数据 | 不提交 yangben（客户数据 + 公开仓）；用**单元测试**喂手搓 node 对象 + 本机 yangben 人工验证 |
| 角色底层值 | 双主两端 `role='primary'` + 布尔标 `node.isDualMaster`（不引入新 role 值，避免动 ~10 处 `role==='primary'` 判断） |

## 三、设计（3 处改动，边界清晰）

### 3.1 preprocess.js — 识别 + 标注

**新增 `detectDualMaster(nodes)`**，在 `normalizeNodeRoles(nodes)` 调用之后执行：

- 对每个 `isSlave` 节点 A，取其 `replication.status.masterHost`，在 nodes 里找 `ip === masterHost` 的节点 B；
- 若 B 也 `isSlave` 且 `B.replication.status.masterHost === A.ip` → A、B 互为主从：
  - `A.role = B.role = 'primary'`
  - `A.isDualMaster = B.isDualMaster = true`
  - `A.dualMasterPeer = B.ip`；`B.dualMasterPeer = A.ip`
- 仅处理**两节点互为主从对**（双主主流形态）；>2 节点环形/级联多源复制不在本期范围（见 §六）。

**`deriveTopology(nodes)`**（preprocess.js:1740）：开头加
```js
if (nodes.some(n => n.isDualMaster)) return '双主（master-master，互为主从）';
```
（置于现有 `一主N从` 判断之前。）

**`nodeLabel(n)`**（preprocess.js:2130）：双主节点标签加后缀：
```js
const nodeLabel = (n) => `${n.ip}（${roleLabel(n.role)}${n.isDualMaster ? '·双主' : ''}）`;
```
→ `10.120.8.141（主库·双主）`。`node.label` 已由该函数赋值，第二/四/十二章渲染自动跟随。

### 3.2 rule-helpers/index.js — 写冲突 P0 规则

**新增 handler `evalDualMasterWriteConflict(ctx)`**：
```
当 node.isDualMaster
 且 node.replication.status.slaveSqlRunning === 'No'
 且 /1062|duplicate entry/i 命中 node.replication.status.lastSqlError
→ 出 P0 issue：
  type: 'dual_master_write_conflict'
  priority: 'P0'
  groupKey: `dual_master_conflict:${node.ip}`
  dimension: 'durability'
  description: 双主写冲突：节点 <ip> 的 SQL 复制线程因主键冲突中止（<冲突表>），
              对端 <peer> 与本节点同时写入同一主键，数据已分叉。
  currentValue: 从 lastSqlError 提取的冲突表 + duplicate key 值
  recommendedValue: 选定权威端、核对并修复分叉数据后重建复制；并按双主拆分自增
  action: ① 确定以哪端为权威（业务量大/数据更全的一端）；
          ② pt-table-checksum / 人工核对两端 <冲突表> 的分叉行；
          ③ 在权威端 RESET，另一端重做复制（或 pt-table-sync 修复）；
          ④ 防再发：auto_increment_increment=2 + 两端 auto_increment_offset=1/2，
            或改为「只写单边」的伪双主，应用层禁止双写。
  sql: 多行：SHOW SLAVE STATUS 定位、auto_increment_increment/offset 设置示例
  scope: 'node'
```
- 冲突表/键从 `lastSqlError` 正则提取（形如 `for key 'ZDL.sys_logininfor.PRIMARY'` → `ZDL.sys_logininfor`；`Duplicate entry 'NNN'` → `NNN`）；提取失败则用通用措辞，不崩。
- 注册进 `module.exports`；在 `tools/rules/durability.json` 加 handler 形式规则条目（`id: dual_master_write_conflict`, `scope: node`, `priority: P0`, `handler: evalDualMasterWriteConflict`, rationale 一句）。

**`evalRoleReadOnly`（rule-helpers/index.js:199）兜底**：slave_writable 分支条件加 `&& !node.isDualMaster`（即便某 case 没被重分类，也不误报）。

### 3.3 不改动

`repl_thread_down`（两端 IO/SQL 中断照常各出一条 P0）、`slave_parallel_workers_zero`、健康度评分、render-offline.js（消费的是 `node.label` / `cluster.topology` / `issues`，字段语义不变，自动正确）。

## 四、数据流

```
txt → 解析 → normalizeNodeRoles（既有：primary/slave/dr）
            → detectDualMaster（新：互为主从对 → 两端 primary + isDualMaster + peer）
            → deriveTopology（双主优先）
            → nodeLabel（·双主 后缀）
规则引擎：evalDualMasterWriteConflict（新 P0）+ evalRoleReadOnly（!isDualMaster 兜底）
→ facts.{cluster.topology, nodes[].label/isDualMaster, issues[]}
→ render-offline 17 章（拓扑/节点标签/行动计划 自动正确）
```

## 五、测试

- **单元测试 `tests/dual_master_test.js`**（零依赖，喂手搓最小 node 对象）：
  1. `detectDualMaster([A,B])`：A.masterHost=B.ip 且 B.masterHost=A.ip → 两端 `role==='primary'` && `isDualMaster===true` && `dualMasterPeer` 互指。
  2. 非双主（普通一主一从：只有 B.masterHost=A.ip）→ 都不打 isDualMaster。
  3. `evalDualMasterWriteConflict`：isDualMaster + slaveSqlRunning='No' + lastSqlError 含 1062/duplicate → 1 条 P0，description/currentValue 含提取出的冲突表名；不满足任一条件 → 返回 `[]`。
  - 需从 preprocess.js 导出 `detectDualMaster`（与 `buildFacts` 一起 export）供测试调用。
- **回归**：现有 `npm test` 6 项保持全绿（buildfacts 仍 49 / [5,11,28,5] / 88——脱敏集是一主一从，不应被双主逻辑误伤）。
- **人工验证**（本机，不入仓）：`node tools/report.js yangben --emit-facts --out-dir /tmp/ym` → 断言 §七 全部成立。

## 六、范围边界（YAGNI）

**做**：两节点互为主从的双主识别 + 标签 + 拓扑 + 写冲突 P0 + slave_writable 兜底 + 单元测试。

**不做**：>2 节点环形/级联多源拓扑；双主自增拆分缺失的独立 P2 规则（已并入写冲突 P0 的 action）；双主延迟/数据分叉的自动量化核对（pt-table-checksum 是给客户的建议，不在工具内跑）；render-offline 增加「双主专章」（现有第十二章主从复制 + 行动计划已足够承载）。

## 七、验收标准（yangben）

1. `cluster.topology` == `双主（master-master，互为主从）`
2. 两节点 `role==='primary'`、`isDualMaster===true`、`label` 含「主库·双主」
3. `slave_writable` 不再出现
4. 新增 1 条 P0 `dual_master_write_conflict`，点名 `ZDL.sys_logininfor`
5. 两条 `repl_thread_down`（141 IO=No、142 SQL=No）仍在
6. `npm test` 6 项全绿（脱敏集不受影响）

## 八、关键文件

| 文件 | 改动 |
|---|---|
| `tools/preprocess.js` | + `detectDualMaster()`；`deriveTopology`/`nodeLabel` 加双主分支；`module.exports` 加 `detectDualMaster` |
| `tools/rule-helpers/index.js` | + `evalDualMasterWriteConflict`；`evalRoleReadOnly` slave_writable 加 `!isDualMaster`；导出注册 |
| `tools/rules/durability.json` | + `dual_master_write_conflict` 规则条目（handler 形式） |
| `tests/dual_master_test.js` | 新增单元测试 |
| `package.json` test 脚本 | 串入 `tests/dual_master_test.js` |
| `CHANGELOG.md` / `VERSION` / `SKILL.md` | 1.1.0 → 1.2.0 条目 |

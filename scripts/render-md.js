#!/usr/bin/env node
/**
 * MySQL 巡检报告 — Markdown 渲染器
 *
 * 用法：
 *   node render-md.js <data.json路径> [--out 报告.md]
 *
 * 输出：Markdown 格式报告（兼容 GitHub/GitLab/Obsidian）
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ─── CLI ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (!args[0]) {
  console.error('用法: node render-md.js <data.json> [--out 报告.md]');
  process.exit(1);
}
const dataFile = path.resolve(args[0]);
if (!fs.existsSync(dataFile)) {
  console.error('错误：文件不存在：' + dataFile);
  process.exit(1);
}

let outIdx = args.indexOf('--out');
const outPath = outIdx !== -1 && args[outIdx + 1]
  ? path.resolve(args[outIdx + 1])
  : path.join(path.dirname(dataFile), path.basename(dataFile).replace(/data\.json$/, '') + 'MySQL健康巡检报告.md').replace(/^_/, '');

const data = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));

// ─── 工具函数 ─────────────────────────────────────────────────
const esc = (s) => String(s == null ? '' : s).replace(/\|/g, '｜');
const pct = (n) => n == null ? '-' : n + '%';

function table(headers, rows) {
  const cols = headers.length;
  const sep = headers.map(() => '---');
  const fmt = (row) => '| ' + row.map(esc).join(' | ') + ' |';
  return [fmt(headers), fmt(sep), ...rows.map(fmt)].join('\n');
}

function scoreBar(score) {
  if (score == null) return '';
  const filled = Math.round(score / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${score}/100`;
}

function priorityLabel(p) {
  return { P0: '🔴 P0 关键', P1: '🟠 P1 重要', P2: '🟡 P2 建议', P3: '⚪ P3 观察' }[p] || p;
}

function dimLabel(d) {
  return {
    availability: '可用性', security: '安全', performance: '性能',
    dataDesign: '数据设计', durability: '持久性', operations: '运维',
  }[d] || d;
}

// ─── 构建 Markdown ─────────────────────────────────────────────
const lines = [];
const h = (level, text) => lines.push('\n' + '#'.repeat(level) + ' ' + text);
const p = (...parts) => lines.push(parts.join(''));
const hr = () => lines.push('\n---');
const blank = () => lines.push('');

const { project, inspectionDate, reportDate, healthScore, overallAssessment,
        issues, nodes, backupAssessment, securityAssessment,
        paramJudgments, recommendations, cluster } = data;

const p0 = issues.filter(i => i.priority === 'P0');
const p1 = issues.filter(i => i.priority === 'P1');
const p2 = issues.filter(i => i.priority === 'P2');
const p3 = issues.filter(i => i.priority === 'P3');

// ══════════════════════════════════════════
// 标题
// ══════════════════════════════════════════
lines.push(`# MySQL 健康巡检报告 — ${project || '未命名项目'}`);
blank();
p(`**巡检日期**：${inspectionDate || '-'}　　**生成日期**：${reportDate || new Date().toISOString().slice(0,10)}`);
hr();

// ══════════════════════════════════════════
// 一、执行摘要
// ══════════════════════════════════════════
h(2, '一、执行摘要');
blank();

// 健康度总览
if (healthScore) {
  p('**综合健康度**：' + scoreBar(healthScore.total));
  blank();
  const dims = healthScore.dimensions || {};
  lines.push(table(
    ['维度', '得分', '状态'],
    [
      ['可用性',   dims.availability,  dims.availability  >= 80 ? '✅ 良好' : '⚠️ 需关注'],
      ['安全',     dims.security,      dims.security      >= 80 ? '✅ 良好' : '⚠️ 需关注'],
      ['性能',     dims.performance,   dims.performance   >= 80 ? '✅ 良好' : '⚠️ 需关注'],
      ['数据设计', dims.dataDesign,    dims.dataDesign    >= 80 ? '✅ 良好' : '⚠️ 需关注'],
      ['持久性',   dims.durability,    dims.durability    >= 80 ? '✅ 良好' : '⚠️ 需关注'],
      ['运维',     dims.operations,    dims.operations    >= 80 ? '✅ 良好' : '⚠️ 需关注'],
    ]
  ));
  blank();
}

p(`**综合评价**：${overallAssessment || ''}`);
blank();
p(`**检出问题**：`, `🔴 P0 × ${p0.length}　🟠 P1 × ${p1.length}　🟡 P2 × ${p2.length}　⚪ P3 × ${p3.length}`);
blank();

if (recommendations) {
  if (recommendations.immediate?.length) {
    blank();
    p('**立即处理（P0）**：');
    recommendations.immediate.forEach(r => lines.push(`- ${r}`));
  }
  if (recommendations.shortTerm?.length) {
    blank();
    p('**近期处理（P1）**：');
    recommendations.shortTerm.forEach(r => lines.push(`- ${r}`));
  }
}

// ══════════════════════════════════════════
// 二、集群概况
// ══════════════════════════════════════════
h(2, '二、集群概况');
blank();

lines.push(table(
  ['节点 IP', '角色', 'MySQL 版本', '操作系统', '内存', 'CPU 核数', '运行时长'],
  nodes.map(n => [
    n.ip,
    n.role === 'primary' ? '主库' : n.role === 'slave' ? '从库' : n.role === 'dr' ? '灾备' : n.role || '未知',
    n.mysqlVersion || '-',
    (n.osRelease || '').split('\n')[0].slice(0, 30) || (n.osKernel || '-').slice(0, 30),
    n.memTotal || '-',
    n.cpuCores || '-',
    n.uptimeText || '-',
  ])
));
blank();

// 复制拓扑
const hasSlave = nodes.some(n => n.replication?.isSlave);
const hasDualMaster = nodes.some(n => n.isDualMaster);
if (hasDualMaster) {
  p('> ⚠️ **检测到双主配置** — 两节点互为主从，存在写冲突风险。');
} else if (hasSlave) {
  const primary = nodes.find(n => n.role === 'primary');
  const slaves = nodes.filter(n => n.replication?.isSlave);
  p(`> 复制拓扑：一主 ${slaves.length} 从${nodes.some(n=>n.role==='dr') ? ' + 灾备' : ''}`);
  if (primary) {
    for (const s of slaves) {
      const st = s.replication?.status || {};
      const delay = st.secondsBehindMaster;
      p(`> - ${s.ip}（从库）← ${primary.ip}，延迟：${delay != null ? delay + 's' : '-'}`);
    }
  }
} else {
  p('> 单节点或集群拓扑。');
}
blank();

// ══════════════════════════════════════════
// 三、关键参数对比
// ══════════════════════════════════════════
if (paramJudgments && paramJudgments.length > 0) {
  h(2, '三、关键参数对比');
  blank();
  const abnormal = paramJudgments.filter(j => !j.ok);
  const normal = paramJudgments.filter(j => j.ok);
  if (abnormal.length > 0) {
    p('**参数不一致（需关注）**：');
    blank();
    lines.push(table(
      ['参数', '各节点值', '说明'],
      abnormal.map(j => [j.key, j.valueMap || j.unique?.join(' / ') || '-', j.reason || '-'])
    ));
    blank();
  }
  if (normal.length > 0) {
    p(`<details><summary>参数一致项（${normal.length} 条，展开查看）</summary>`);
    blank();
    lines.push(table(
      ['参数', '值', '说明'],
      normal.map(j => [j.key, j.valueMap || j.unique?.join(' / ') || '-', j.reason || '正常'])
    ));
    blank();
    p('</details>');
    blank();
  }
}

// ══════════════════════════════════════════
// 四、磁盘与内存
// ══════════════════════════════════════════
h(2, '四、资源使用');
blank();

const diskRows = [];
for (const n of nodes) {
  for (const d of (n.disks || [])) {
    if (parseInt(d.usePct) >= 70) {
      diskRows.push([n.ip, d.mount, d.total || '-', d.used || '-', d.usePct]);
    }
  }
}
if (diskRows.length > 0) {
  p('**磁盘（使用率 ≥ 70%）**：');
  blank();
  lines.push(table(['节点', '挂载点', '总量', '已用', '使用率'], diskRows));
  blank();
}

const memRows = nodes.map(n => [
  n.ip,
  n.memTotal || '-',
  n.memUsed || '-',
  pct(n.memUsagePct),
  n.swapUsed && n.swapUsedKB > 0 ? n.swapUsed : '未使用',
]);
p('**内存使用**：');
blank();
lines.push(table(['节点', '总内存', '已用', '使用率', '交换区已用'], memRows));
blank();

// ══════════════════════════════════════════
// 五、InnoDB 状态
// ══════════════════════════════════════════
h(2, '五、InnoDB 状态');
blank();

const innoRows = nodes.map(n => {
  const v = n.variables || {};
  const bpMB = n.bpMB;
  const bpStr = bpMB ? (bpMB >= 1024 ? (bpMB/1024).toFixed(1)+'GB' : Math.round(bpMB)+'MB') : '-';
  return [
    n.ip,
    bpStr,
    n.bpHitPct != null ? n.bpHitPct + '%' : '-',
    v.innodb_file_per_table || '-',
    v.innodb_flush_log_at_trx_commit || '-',
    v.sync_binlog || '-',
  ];
});
lines.push(table(
  ['节点', 'Buffer Pool', '命中率', 'file_per_table', 'flush_log', 'sync_binlog'],
  innoRows
));
blank();

// ibtmp1
const ibtmpRows = nodes.filter(n => n.ibtmp1?.currentSizeGB > 0).map(n => [
  n.ip, n.ibtmp1.path || '-', (n.ibtmp1.currentSizeGB||0).toFixed(2)+'GB',
  n.ibtmp1NoMax ? '⚠️ 无上限' : '有上限',
]);
if (ibtmpRows.length > 0) {
  p('**临时表空间（ibtmp1）**：');
  blank();
  lines.push(table(['节点', '路径', '当前大小', '上限'], ibtmpRows));
  blank();
}

// ══════════════════════════════════════════
// 六、复制状态
// ══════════════════════════════════════════
const slaves = nodes.filter(n => n.replication?.isSlave);
if (slaves.length > 0) {
  h(2, '六、复制状态');
  blank();
  lines.push(table(
    ['节点', '主库', 'IO线程', 'SQL线程', '延迟(s)', 'GTID'],
    slaves.map(n => {
      const st = n.replication.status || {};
      return [
        n.ip,
        st.masterHost || '-',
        st.slaveIoRunning || '-',
        st.slaveSqlRunning || '-',
        st.secondsBehindMaster != null ? st.secondsBehindMaster : '-',
        n.variables?.gtid_mode || '-',
      ];
    })
  ));
  blank();
}

// ══════════════════════════════════════════
// 七、慢查询 & 活跃会话
// ══════════════════════════════════════════
const hasSlow = nodes.some(n => n.topSqlByAvg?.length > 0);
if (hasSlow) {
  h(2, '七、TOP 慢 SQL（按平均延迟）');
  blank();
  for (const n of nodes) {
    const sqls = (n.topSqlByAvg || []).slice(0, 5);
    if (!sqls.length) continue;
    p(`**${n.ip}（${n.role}）**`);
    blank();
    lines.push(table(
      ['平均延迟', '执行次数', 'SQL 摘要'],
      sqls.map(s => [s.avgLatency || '-', s.execCount || '-', (s.digest || '').slice(0, 80)])
    ));
    blank();
  }
}

// ══════════════════════════════════════════
// 八、数据库容量
// ══════════════════════════════════════════
h(2, '八、数据库容量');
blank();

const capRows = nodes.map(n => [
  n.ip,
  n.dbTotalSizeGB != null ? Number(n.dbTotalSizeGB).toFixed(2) + ' GB' : '-',
  (n.databases || []).length || '-',
  (n.tables || []).length || '-',
]);
lines.push(table(['节点', '数据总量', '库数', '表数'], capRows));
blank();

// TOP 10 大表（只取主库）
const primary = nodes.find(n => n.role === 'primary') || nodes[0];
if (primary?.topTables?.length) {
  p(`**TOP ${Math.min(10, primary.topTables.length)} 大表（主库 ${primary.ip}）**：`);
  blank();
  lines.push(table(
    ['库.表', '行数', '数据', '索引', '总大小'],
    primary.topTables.slice(0, 10).map(t => [
      `${t.db}.${t.table}`, t.rows || '-', t.dataSize || '-', t.indexSize || '-', t.totalSize || '-'
    ])
  ));
  blank();
}

// ══════════════════════════════════════════
// 九、安全评估
// ══════════════════════════════════════════
h(2, '九、安全评估');
blank();

if (securityAssessment) {
  const { items, pass, fail, warn, complianceLevel } = securityAssessment;
  p(`合规等级：**${complianceLevel || '-'}**　通过：${pass || 0}　警告：${warn || 0}　未通过：${fail || 0}`);
  blank();
  const failItems = (items || []).filter(i => i.status === 'fail' || i.status === 'warn');
  if (failItems.length) {
    lines.push(table(
      ['项目', '状态', '说明'],
      failItems.map(i => [i.name || '-', i.status === 'fail' ? '❌' : '⚠️', i.detail || '-'])
    ));
    blank();
  }
}

// 用户安全
const emptyPwdUsers = nodes.flatMap(n => (n.emptyPasswordUsers || []).map(u => ({ ...u, node: n.ip })));
if (emptyPwdUsers.length) {
  p('**空密码账号**（高危）：');
  emptyPwdUsers.forEach(u => lines.push(`- \`${u.user}@${u.host}\` 节点：${u.node}`));
  blank();
}
const weakPwdUsers = nodes.flatMap(n => (n.weakPasswordUsers || []).map(u => ({ ...u, node: n.ip })));
if (weakPwdUsers.length) {
  p('**弱密码账号**：');
  weakPwdUsers.forEach(u => lines.push(`- \`${u.user}@${u.host}\` 节点：${u.node}`));
  blank();
}

// ══════════════════════════════════════════
// 十、备份评估
// ══════════════════════════════════════════
h(2, '十、备份评估');
blank();

if (backupAssessment) {
  const { assessment, severity, hasTool, hasBackupArtifact, hasScheduledBackup, latestBackup, tools } = backupAssessment;
  const statusIcon = { critical: '🔴', high: '🟠', medium: '🟡', low: '✅' }[severity] || '❓';
  p(`${statusIcon} **${assessment || '无评估'}**`);
  blank();
  p(`- 备份工具：${tools?.join('、') || '未检测到'}`);
  p(`- 最近备份：${latestBackup || '未知'}`);
  p(`- 定时任务：${hasScheduledBackup ? '有' : '无'}`);
  p(`- 备份产物：${hasBackupArtifact ? '检测到' : '未检测到'}`);
  blank();
}

// ══════════════════════════════════════════
// 十一、行动计划（P0 → P3）
// ══════════════════════════════════════════
h(2, '十一、行动计划');
blank();
p('> 按优先级排序。P0 须立即处理；P1 建议本周内；P2 建议本月内；P3 长期优化。');
blank();

for (const [priority, label] of [['P0','🔴 P0 关键'], ['P1','🟠 P1 重要'], ['P2','🟡 P2 建议'], ['P3','⚪ P3 观察']]) {
  const grp = issues.filter(i => i.priority === priority);
  if (!grp.length) continue;

  h(3, `${label}（${grp.length} 项）`);
  blank();

  for (const issue of grp) {
    const dimStr = issue.dimension ? ` \`${dimLabel(issue.dimension)}\`` : '';
    const nodeStr = issue.node ? ` — ${issue.node}` : '';
    h(4, `${issue.type || issue.groupKey || '问题'}${dimStr}${nodeStr}`);
    p(issue.description || '');
    blank();
    if (issue.currentValue || issue.recommendedValue) {
      p(`- **当前值**：${issue.currentValue || '-'}`);
      p(`- **推荐值**：${issue.recommendedValue || '-'}`);
    }
    if (issue.action) {
      p(`- **处理建议**：${issue.action}`);
    }
    if (issue.sql) {
      blank();
      lines.push('```sql');
      lines.push(issue.sql);
      lines.push('```');
    }
    blank();
  }
}

// ══════════════════════════════════════════
// 十二、附录：错误日志摘要
// ══════════════════════════════════════════
const hasErrLog = nodes.some(n => n.errorLogAnalysis?.entries?.length > 0);
if (hasErrLog) {
  h(2, '十二、附录：错误日志摘要');
  blank();
  for (const n of nodes) {
    const entries = n.errorLogAnalysis?.entries;
    if (!entries?.length) continue;
    p(`**${n.ip}（近期异常）**：`);
    entries.slice(0, 10).forEach(e => lines.push(`- \`${e.time || ''}\` ${e.level || ''}: ${(e.message || '').slice(0, 100)}`));
    blank();
  }
}

// ══════════════════════════════════════════
// 页脚
// ══════════════════════════════════════════
hr();
p(`> 本报告由 mysql-healthcheck 自动生成 · ${reportDate || new Date().toISOString().slice(0,10)}`);

// ─── 写文件 ───────────────────────────────────────────────────
const md = lines.join('\n');
fs.writeFileSync(outPath, md);
console.error(`Markdown 报告已生成：${outPath}`);
console.error(`  文件大小：${(Buffer.byteLength(md) / 1024).toFixed(1)} KB`);

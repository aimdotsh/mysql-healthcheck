#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
if (!args[0]) {
  console.error('用法: node render-html.js <data.json> [--out 报告.html]');
  process.exit(1);
}
const dataFile = path.resolve(args[0]);
if (!fs.existsSync(dataFile)) {
  console.error('错误：文件不存在：' + dataFile);
  process.exit(1);
}

const outIdx = args.indexOf('--out');
const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const outPath = outIdx !== -1 && args[outIdx + 1]
  ? path.resolve(args[outIdx + 1])
  : path.join(path.dirname(dataFile), `MySQL巡检报告_${today}.html`);

const data = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));

// ── Utilities ─────────────────────────────────────────────────────────────────

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const parts = [];
const h = (...xs) => parts.push(...xs);

function tbl(headers, rows) {
  if (!rows || !rows.length) { h('<p><em>（无数据）</em></p>'); return; }
  h('<table><thead><tr>' + headers.map(x => `<th>${esc(x)}</th>`).join('') + '</tr></thead><tbody>');
  rows.forEach(r => h('<tr>' + r.map(c => `<td>${esc(c)}</td>`).join('') + '</tr>'));
  h('</tbody></table>');
}

function callout(kind, text) {
  h(`<div class="callout ${kind}">${text}</div>`);
}

function fig(svg, caption) {
  h(`<figure class="chart">${svg}<figcaption>${esc(caption)}</figcaption></figure>`);
}

function nodeLabel(n) {
  const rm = { primary: '主库', slave: '从库', dr: '灾备' };
  return n.ip + (n.role ? `（${rm[n.role] || n.role}）` : '');
}

// ── SVG Charts ────────────────────────────────────────────────────────────────

function svgGauge(score) {
  const score100 = Math.max(0, Math.min(100, Number(score) || 0));
  const color = score100 >= 90 ? '#5CB85C' : score100 >= 75 ? '#1565c0' : score100 >= 60 ? '#F0AD4E' : '#D9534F';
  const label = score100 >= 90 ? '优秀' : score100 >= 75 ? '良好' : score100 >= 60 ? '警告' : '危险';

  // Gauge geometry: center (240, 173.59), radius 89.6, 234° arc starting at 153°
  const cx = 240, cy = 173.59, r = 89.6;
  const startDeg = 153, spanDeg = 234;

  const pt = (deg) => {
    const rad = deg * Math.PI / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  };

  const [sx, sy] = pt(startDeg);
  const [bx, by] = pt((startDeg + spanDeg) % 360);
  const filledDeg = (score100 / 100) * spanDeg;
  const [vx, vy] = pt((startDeg + filledDeg) % 360);
  const vLarge = filledDeg > 180 ? 1 : 0;

  const fmt = (n) => n.toFixed(2);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="280" viewBox="0 0 480 280">
<style>text { font-family: "Microsoft YaHei", Arial, sans-serif; }</style>
<rect width="480" height="280" fill="#FFFFFF"/>
<text x="240" y="42" text-anchor="middle" font-size="20" font-weight="bold" fill="#1F4E79">综合健康度</text>
<path d="M ${fmt(sx)} ${fmt(sy)} A ${r} ${r} 0 1 1 ${fmt(bx)} ${fmt(by)}" stroke="#DDDDDD" stroke-width="28" fill="none" stroke-linecap="round"/>
<path d="M ${fmt(sx)} ${fmt(sy)} A ${r} ${r} 0 ${vLarge} 1 ${fmt(vx)} ${fmt(vy)}" stroke="${color}" stroke-width="28" fill="none" stroke-linecap="round"/>
<text x="240" y="185.6" text-anchor="middle" font-size="56" font-weight="bold" fill="${color}">${score100}</text>
<text x="240" y="215.6" text-anchor="middle" font-size="14" fill="#888888">/ 100</text>
<text x="240" y="243.6" text-anchor="middle" font-size="20" font-weight="bold" fill="${color}">${label}</text>
</svg>`;
}

function svgTopology(nodes) {
  const primary = nodes.find(n => n.role === 'primary');
  const slaves = nodes.filter(n => n.replication && n.replication.isSlave);
  if (!primary && !slaves.length) return null;

  const nodeW = 190, nodeH = 52, nodeY = 84;
  const primaryX = 55;
  const width = 620;
  const roleLabel = n => ({ primary: '主库', slave: '从库', dr: '灾备' }[n.role] || n.role || '节点');
  const lines = [];

  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="220" viewBox="0 0 ${width} 220">`,
    '<style>text { font-family: "Microsoft YaHei", Arial, sans-serif; }</style>',
    `<rect width="${width}" height="220" fill="#FFFFFF"/>`,
    '<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="#2E75B6"/></marker></defs>');

  if (primary) {
    const sid = primary.variables?.server_id || '-';
    const mx = primaryX + nodeW / 2;
    lines.push(`<rect x="${primaryX}" y="${nodeY}" width="${nodeW}" height="${nodeH}" rx="8" fill="#1F4E79" stroke="#1F4E79" stroke-width="1.5"/>`,
      `<text x="${mx}" y="${nodeY + 22}" text-anchor="middle" font-size="13" font-weight="bold" fill="#FFFFFF">${esc(primary.ip)}</text>`,
      `<text x="${mx}" y="${nodeY + 42}" text-anchor="middle" font-size="11" fill="#FFFFFF">${roleLabel(primary)} · server_id=${esc(sid)}</text>`);
  }

  let slaveX = primaryX + nodeW + 95;
  for (const slave of slaves) {
    const x1 = primaryX + nodeW, midY = nodeY + nodeH / 2;
    lines.push(
      `<line x1="${x1}" y1="${midY}" x2="${slaveX}" y2="${midY}" stroke="#2E75B6" stroke-width="2" marker-end="url(#arrow)"/>`,
      `<text x="${((x1 + slaveX) / 2).toFixed(0)}" y="${midY - 6}" text-anchor="middle" font-size="10" fill="#888888">async replication</text>`);
    const sid = slave.variables?.server_id || '-';
    const mx = slaveX + nodeW / 2;
    lines.push(
      `<rect x="${slaveX}" y="${nodeY}" width="${nodeW}" height="${nodeH}" rx="8" fill="#2E75B6" stroke="#1F4E79" stroke-width="1.5"/>`,
      `<text x="${mx}" y="${nodeY + 22}" text-anchor="middle" font-size="13" font-weight="bold" fill="#FFFFFF">${esc(slave.ip)}</text>`,
      `<text x="${mx}" y="${nodeY + 42}" text-anchor="middle" font-size="11" fill="#FFFFFF">${roleLabel(slave)} · server_id=${esc(sid)}</text>`);
    slaveX += nodeW + 20;
  }

  lines.push('</svg>');
  return lines.join('\n');
}

function svgBpBar(nodes) {
  const svgH = 40 + nodes.length * 32;
  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="${svgH}" viewBox="0 0 600 ${svgH}">`,
    '<style>text { font-family: "Microsoft YaHei", Arial, sans-serif; }</style>',
    `<rect width="600" height="${svgH}" fill="#FFFFFF"/>`,
    `<text x="300" y="22" text-anchor="middle" font-size="16" font-weight="bold" fill="#1F4E79">InnoDB Buffer Pool 命中率 (%)</text>`,
  ];
  nodes.forEach((n, i) => {
    const y = 40 + i * 32;
    const pct = n.bpHitPct != null ? Math.min(100, Number(n.bpHitPct)) : 0;
    const bw = (pct / 100 * 320).toFixed(1);
    const color = i === 0 ? '#1F4E79' : '#2E75B6';
    const disp = n.bpHitPct != null ? Number(n.bpHitPct).toFixed(0) + '%' : '-';
    lines.push(
      `<text x="172" y="${(y + 15.4).toFixed(1)}" text-anchor="end" font-size="12" fill="#404040">${esc(nodeLabel(n))}</text>`,
      `<rect x="180" y="${y}" width="${bw}" height="22" fill="${color}" rx="3"/>`,
      `<text x="506" y="${(y + 15.4).toFixed(1)}" font-size="11" fill="#404040">${disp}</text>`);
  });
  lines.push('</svg>');
  return lines.join('\n');
}

// ── Data ──────────────────────────────────────────────────────────────────────

const { project, inspectionDate, healthScore, overallAssessment,
        issues, nodes, backupAssessment, securityAssessment, paramJudgments } = data;

const total = healthScore?.total ?? 0;
const dims = healthScore?.dimensions || {};
const p0 = (issues || []).filter(i => i.priority === 'P0');
const p1 = (issues || []).filter(i => i.priority === 'P1');
const p2 = (issues || []).filter(i => i.priority === 'P2');
const p3 = (issues || []).filter(i => i.priority === 'P3');

// ── Derived helpers ───────────────────────────────────────────────────────────

function memGB(n) {
  if (n.memTotalKB) return (n.memTotalKB / 1024 / 1024).toFixed(1);
  return '-';
}

function wildcardUsers(n) {
  return (n.users || []).filter(u => u.host === '%');
}

function spCount(n) {
  return (n.routines || []).filter(r => r.type === 'PROCEDURE').length;
}
function fnCount(n) {
  return (n.routines || []).filter(r => r.type === 'FUNCTION').length;
}
function triggerCount(n) {
  if (!n.dbObjects) return '-';
  const sum = n.dbObjects.filter(o => /trigger/i.test(o.type)).reduce((s, o) => s + (Number(o.count) || 0), 0);
  return sum;
}

function longSessions(n) {
  return (n.processlist || []).filter(p => Number(p.time) > 60);
}

function bpHitDisplay(n) {
  if (n.bpHitDisplay) return n.bpHitDisplay;
  if (n.innodb?.bufferPoolHitRate) return n.innodb.bufferPoolHitRate;
  if (n.bpHitPct != null) return Number(n.bpHitPct).toFixed(0) + '%';
  return '-';
}

function innodbLogSizeMB(n) {
  const v = n.variables?.innodb_log_file_size;
  if (v == null) return '-';
  const num = Number(v);
  if (isNaN(num)) return '-';
  if (num >= 1073741824) return (num / 1073741824).toFixed(0) + ' GB';
  return Math.round(num / 1048576) + ' MB';
}

function bpSizeMB(n) {
  if (n.bpMB != null) return n.bpMB;
  const v = n.variables?.innodb_buffer_pool_size_in_mb;
  if (v != null) return Number(v);
  const v2 = n.variables?.innodb_buffer_pool_size;
  if (v2 == null) return null;
  const num = Number(v2);
  return isNaN(num) ? null : Math.round(num / 1048576);
}

// ── HTML ──────────────────────────────────────────────────────────────────────

const CSS = `body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;line-height:1.6;color:#222;max-width:1000px;margin:0 auto;padding:24px}
h1,h2,h3{color:#1a3a5c;border-bottom:1px solid #e0e6ed;padding-bottom:4px}
table{border-collapse:collapse;width:100%;margin:12px 0;font-size:14px}
th,td{border:1px solid #d0d7de;padding:6px 10px;text-align:left}
th{background:#f1f5f9}
tr:nth-child(even){background:#fafbfc}
pre{background:#f6f8fa;padding:12px;border-radius:6px;overflow:auto}
code{font-family:"SF Mono",Consolas,monospace}
.callout{padding:10px 14px;border-radius:6px;margin:12px 0}
.callout.info{background:#eef6ff;border-left:4px solid #3b82f6}
.callout.warn{background:#fff7ed;border-left:4px solid #f59e0b}
.callout.crit{background:#fef2f2;border-left:4px solid #ef4444}
.callout.ok{background:#f0fdf4;border-left:4px solid #22c55e}
.chart{margin:16px 0;text-align:center}
.chart figcaption{font-size:13px;color:#555;margin-top:4px}
p{margin:8px 0}
ul{padding-left:20px;margin:8px 0}
li{margin:3px 0}`;

h(`<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(project || '未命名项目')} 巡检报告</title>
<style>
${CSS}
</style></head>
<body>`);
h(`<h1>${esc(project || '未命名项目')} 巡检报告</h1>`);
h(`<p>巡检日期：${esc(inspectionDate || '-')}　节点数：${nodes.length}　健康度：${total}/100</p>`);

// ── Ch1 执行摘要 ──────────────────────────────────────────────────────────────
h('<h2>第一章 执行摘要</h2>');
fig(svgGauge(total), `综合健康度 ${total}/100`);
h(`<p>本次巡检覆盖 ${nodes.length} 个节点，共检出 ${(issues || []).length} 项问题：P0 ${p0.length} 项、P1 ${p1.length} 项、P2 ${p2.length} 项、P3 ${p3.length} 项。</p>`);
if (p0.length > 0) callout('crit', `存在 ${p0.length} 项 P0 高危问题，需优先处置（详见第十六章行动计划）。`);
if (overallAssessment) h(`<p>${esc(overallAssessment)}</p>`);
tbl(['维度', '得分'], [
  ['availability', dims.availability != null ? dims.availability + '/100' : '-'],
  ['security',     dims.security     != null ? dims.security     + '/100' : '-'],
  ['performance',  dims.performance  != null ? dims.performance  + '/100' : '-'],
  ['dataDesign',   dims.dataDesign   != null ? dims.dataDesign   + '/100' : '-'],
  ['durability',   dims.durability   != null ? dims.durability   + '/100' : '-'],
  ['operations',   dims.operations   != null ? dims.operations   + '/100' : '-'],
]);

// ── Ch2 操作系统与硬件 ────────────────────────────────────────────────────────
h('<h2>第二章 操作系统与硬件</h2>');
tbl(['节点', 'hostname', 'OS 发行版', '内核', 'CPU 核', '内存 GB', '内存使用率'],
  nodes.map(n => [
    nodeLabel(n), n.hostname || '-',
    n.osRelease ? String(n.osRelease).split('\n')[0] : '',
    n.osKernel || '-',
    n.cpuCores != null ? n.cpuCores : '-',
    memGB(n),
    n.memUsagePct != null ? n.memUsagePct + '%' : '-',
  ]));
for (const n of nodes) {
  const disks = n.disks || [];
  if (!disks.length) continue;
  h(`<h3>${esc(nodeLabel(n))} · 磁盘</h3>`);
  tbl(['挂载点', '文件系统', '总量', '已用', '可用', '使用率'],
    disks.map(d => [d.mount || '-', d.filesystem || d.fs || '-', d.total || '-', d.used || '-', d.avail || d.available || '-', d.usePct || '-']));
}
callout('info', '本章小结：展示操作系统、CPU、内存、磁盘概况；如有磁盘使用率过高或 OS 已 EOL，详见第十六章行动计划。');

// ── Ch3 MySQL 版本与启动配置 ──────────────────────────────────────────────────
h('<h2>第三章 MySQL 版本与启动配置</h2>');
tbl(['节点', 'MySQL 版本', '运行时长'],
  nodes.map(n => [nodeLabel(n), n.mysqlVersion || '-', n.uptimeText || '-']));
h('<h3>关键启动参数</h3>');
const startupKeys = ['datadir', 'socket', 'log_error', 'pid_file', 'server_id'];
tbl(['参数', ...nodes.map(n => nodeLabel(n))],
  startupKeys.map(k => [k, ...nodes.map(n => n.variables?.[k] ?? '-')]));
const eolIssues = (issues || []).filter(i => i.type === 'mysql_version_eol');
if (eolIssues.length) {
  h('<ul>');
  eolIssues.forEach(i => h(`<li>${esc(i.node || '全部节点')}：${esc(i.description || '')}</li>`));
  h('</ul>');
}
callout('info', '本章小结：展示 MySQL 版本、运行时长及关键启动参数；版本 EOL 风险详见第十六章行动计划。');

// ── Ch4 集群拓扑 ──────────────────────────────────────────────────────────────
h('<h2>第四章 集群拓扑</h2>');
const topoSvg = svgTopology(nodes);
if (topoSvg) {
  const slaveCount = nodes.filter(n => n.replication?.isSlave).length;
  const isDM = nodes.some(n => n.isDualMaster);
  const topoDesc = isDM ? '双主配置（高危）' : `一主${slaveCount}从（${slaveCount > 0 ? '异步复制' : '单节点'}）`;
  fig(topoSvg, `集群拓扑：${topoDesc}`);
}
tbl(['节点', '角色', '主机'],
  nodes.map(n => [nodeLabel(n), n.role || '-', n.hostname || '-']));
h('<h3>复制基础信息</h3>');
tbl(['节点', 'server_id', 'server_uuid', 'binlog 格式', 'log_bin'],
  nodes.map(n => [
    nodeLabel(n),
    n.variables?.server_id ?? '-',
    n.variables?.server_uuid ?? '-',
    n.variables?.binlog_format ?? '-',
    n.variables?.log_bin ?? '-',
  ]));
{
  const sc = nodes.filter(n => n.replication?.isSlave).length;
  const isDM = nodes.some(n => n.isDualMaster);
  const desc = isDM ? '双主' : `一主${sc}从`;
  const repDesc = sc > 0 ? '异步复制' : '单节点';
  callout('info', `本章小结：拓扑结构为「${desc}（${repDesc}）」，共 ${nodes.length} 个节点；详细复制状态见第十二章。`);
}

// ── Ch5 关键参数与一致性 ──────────────────────────────────────────────────────
h('<h2>第五章 关键参数与一致性</h2>');
const paramSection = (title, keys) => {
  h(`<h3>${esc(title)}</h3>`);
  tbl(['参数', ...nodes.map(n => nodeLabel(n))],
    keys.map(k => {
      const vals = nodes.map(n => {
        if (k === 'innodb_buffer_pool_size_in_mb') {
          const mb = n.variables?.[k] != null ? Number(n.variables[k]) : bpSizeMB(n);
          if (mb == null) return '-';
          return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB';
        }
        if (k === 'innodb_log_file_size') return innodbLogSizeMB(n);
        const v = n.variables?.[k];
        return v != null ? String(v) : '-';
      });
      return [k, ...vals];
    }));
};
paramSection('持久化', ['innodb_flush_log_at_trx_commit', 'sync_binlog', 'gtid_mode', 'innodb_doublewrite', 'expire_logs_days']);
paramSection('性能', ['innodb_buffer_pool_size_in_mb', 'innodb_log_file_size', 'innodb_flush_method', 'max_connections']);
paramSection('安全', ['default_authentication_plugin', 'sql_mode', 'character_set_server']);
const abnParams = (paramJudgments || []).filter(j => !j.ok);
if (abnParams.length) {
  h('<h3>跨节点参数差异</h3>');
  tbl(['参数名', '各节点取值', '说明'],
    abnParams.map(j => {
      const mapStr = j.valueMap
        ? (typeof j.valueMap === 'object' && !Array.isArray(j.valueMap)
          ? Object.entries(j.valueMap).map(([k, v]) => `${k}=${v}`).join('；')
          : String(j.valueMap))
        : '-';
      return [j.key || '-', mapStr, j.reason || '建议统一'];
    }));
  callout('warn', `本章小结：展示持久化/性能/安全关键参数及跨节点一致性；发现 ${abnParams.length} 项参数不一致，详见上表与第十六章行动计划。`);
} else {
  callout('info', '本章小结：展示持久化/性能/安全关键参数及跨节点一致性；参数一致性良好。');
}

// ── Ch6 性能指标分析 ──────────────────────────────────────────────────────────
h('<h2>第六章 性能指标分析</h2>');
tbl(['节点', 'QPS', '当前连接数', 'BP 命中率', 'Slow_queries'],
  nodes.map(n => [
    nodeLabel(n),
    n.qps != null ? Number(n.qps).toFixed(3) : '-',
    n.threadsConnected ?? '-',
    bpHitDisplay(n),
    n.slowQueries ?? '-',
  ]));
fig(svgBpBar(nodes), 'Buffer Pool 命中率对比');
callout('info', '本章小结：展示 QPS / 连接数 / Buffer Pool 命中率 / 慢查询统计；Buffer Pool 命中率均处于正常区间。');

// ── Ch7 数据库容量与对象 ──────────────────────────────────────────────────────
h('<h2>第七章 数据库容量与对象</h2>');
tbl(['节点', '数据总量(GB)', '表数', 'TOP表'],
  nodes.map(n => {
    const topT = n.topTables?.[0];
    return [
      nodeLabel(n),
      n.dbTotalSizeGB != null ? Number(n.dbTotalSizeGB).toFixed(3) : '-',
      n.topTables?.length ?? '-',
      topT ? `${topT.schema || topT.db || '-'}.${topT.table || '-'}` : '-',
    ];
  }));
for (const n of nodes) {
  if (!n.topTables?.length) continue;
  h(`<h3>${esc(nodeLabel(n))} · TOP 10 大表</h3>`);
  tbl(['库', '表', '行数', '大小(GB)', '引擎'],
    n.topTables.slice(0, 10).map(t => [
      t.schema || t.db || '-', t.table || '-',
      t.rows || '-',
      t.sizeGB != null ? Number(t.sizeGB).toFixed(3) : (t.totalSize || '-'),
      t.engine || 'InnoDB',
    ]));
}
for (const n of nodes) {
  const dbs = n.dbSizes || [];
  if (!dbs.length) continue;
  h(`<h3>${esc(nodeLabel(n))} · 数据库大小分布</h3>`);
  tbl(['库名', '大小(GB)'],
    dbs.map(d => [d.name || '-', d.sizeGB != null ? Number(d.sizeGB).toFixed(3) : '-']));
}
callout('info', '本章小结：展示各节点数据库总量、TOP 大表及数据库大小分布；容量增长趋势需结合历史巡检对比。');

// ── Ch8 InnoDB 状态与 ibtmp1 ──────────────────────────────────────────────────
h('<h2>第八章 InnoDB 状态与 ibtmp1</h2>');
tbl(['节点', 'History List Length', '脏页数', 'Buffer Pool 总页数', 'BP 命中率'],
  nodes.map(n => [
    nodeLabel(n),
    n.innodb?.historyListLength ?? '-',
    n.innodb?.modifiedDbPages ?? '-',
    n.innodb?.bufferPoolSize ?? '-',
    bpHitDisplay(n),
  ]));
h('<h3>ibtmp1 临时表空间</h3>');
tbl(['节点', '当前大小', '初始大小', 'autoextend', '是否设上限'],
  nodes.map(n => {
    const ibt = n.ibtmp1 || {};
    return [
      nodeLabel(n),
      ibt.currentSizeGB != null ? Number(ibt.currentSizeGB).toFixed(2) + ' GB' : '-',
      ibt.initialSizeGB != null ? Number(ibt.initialSizeGB).toFixed(2) + ' GB' : '-',
      ibt.autoextend || '-',
      n.ibtmp1NoMax ? '否' : (ibt.currentSizeGB != null ? '是' : '-'),
    ];
  }));
callout('info', '本章小结：展示 InnoDB History List Length、脏页及 ibtmp1 临时表空间情况；关键指标处于正常范围。');

// ── Ch9 引擎深度 ──────────────────────────────────────────────────────────────
h('<h2>第九章 引擎深度（Buffer Pool / Redo / 锁等待）</h2>');
tbl(['节点', 'BP 大小(MB)', '占 RAM 比例', 'BP 命中率', 'innodb_log_file_size'],
  nodes.map(n => {
    const bpMB2 = bpSizeMB(n);
    const memKB = n.memTotalKB;
    const ratio = bpMB2 != null && memKB
      ? ((bpMB2 / 1024) / (memKB / 1024 / 1024) * 100).toFixed(1) + '%'
      : '-';
    return [nodeLabel(n), bpMB2 != null ? bpMB2 : '-', ratio, bpHitDisplay(n), innodbLogSizeMB(n)];
  }));
h('<h3>锁等待与事务（当前快照）</h3>');
tbl(['节点', 'INNODB LOCKS', 'INNODB LOCK WAITS', 'Metadata Locks'],
  nodes.map(n => [
    nodeLabel(n),
    Array.isArray(n.innodbLocks) ? n.innodbLocks.length : 0,
    Array.isArray(n.innodbLockWaits) ? n.innodbLockWaits.length : 0,
    Array.isArray(n.metadataLocks) ? n.metadataLocks.length : 0,
  ]));
callout('info', '本章小结：展示 Buffer Pool 容量与 RAM 占比、Redo Log 配置及当前锁等待快照；容量评估详见第十六章行动计划。');

// ── Ch10 会话 + 锁 + 错误日志 ────────────────────────────────────────────────
h('<h2>第十章 会话 + 锁 + 错误日志</h2>');
tbl(['节点', '总会话数', '当前连接数'],
  nodes.map(n => [
    nodeLabel(n),
    Array.isArray(n.processlist) ? n.processlist.length : '-',
    n.threadsConnected ?? '-',
  ]));
h('<h3>长时间运行会话</h3>');
const allLongSessions = nodes.flatMap(n =>
  longSessions(n).map(p => [nodeLabel(n), p.user || '-', p.time || '-', String(p.info || p.state || '').slice(0, 80)]));
tbl(['节点', '用户', '时长(s)', 'SQL'], allLongSessions);
h('<h3>错误日志摘要</h3>');
tbl(['节点', '日志范围', 'ERROR 数', 'WARNING 数', 'Deprecated 数'],
  nodes.map(n => {
    const el = n.errorLogAnalysis || {};
    return [
      nodeLabel(n),
      el.timeRange || '不可用',
      el.errorCount ?? '-',
      el.warningCount ?? '-',
      el.deprecatedCount ?? '-',
    ];
  }));
callout('info', '本章小结：展示当前会话、长时间运行会话及错误日志统计；错误日志未发现 ERROR 级别记录。');

// ── Ch11 用户与权限 ──────────────────────────────────────────────────────────
h('<h2>第十一章 用户与权限</h2>');
tbl(['节点', '用户总数', 'host=% 数', 'root@%'],
  nodes.map(n => {
    const wu = wildcardUsers(n);
    const hasRoot = wu.some(u => u.user === 'root');
    return [
      nodeLabel(n),
      (n.users || []).length || '-',
      wu.length,
      hasRoot ? '存在' : '未发现',
    ];
  }));
h('<h3>host=% 用户清单</h3>');
const allWildcard = nodes.flatMap(n => wildcardUsers(n).map(u => [nodeLabel(n), u.user || '-', u.host || '%']));
tbl(['节点', '用户', 'host'], allWildcard);
h('<h3>安全评估汇总</h3>');
if (securityAssessment?.items?.length) {
  tbl(['检查项', '状态', '说明'],
    (securityAssessment.items || []).map(i => [
      i.name || i.check || '-',
      (i.status || '-').toUpperCase(),
      i.detail || i.message || '-',
    ]));
  h(`<p>通过 ${securityAssessment.pass || 0} / 失败 ${securityAssessment.fail || 0} / 告警 ${securityAssessment.warn || 0} / 未知 ${securityAssessment.unknown || 0}，合规等级：${securityAssessment.complianceLevel || '-'}</p>`);
}
{
  const failCount = securityAssessment?.fail || 0;
  const ck = (issues || []).some(i => ['wildcard_critical', 'empty_password'].includes(i.type) && ['P0', 'P1'].includes(i.priority)) || failCount > 0 ? 'crit' : 'warn';
  callout(ck, failCount > 0
    ? `本章小结：展示用户清单、host=% 危险用户及安全合规评估；存在 ${failCount} 项安全检查未通过，详见第十六章行动计划。`
    : '本章小结：展示用户清单、host=% 危险用户及安全合规评估；高危用户详见第十六章行动计划。');
}

// ── Ch12 主从复制 ─────────────────────────────────────────────────────────────
h('<h2>第十二章 主从复制</h2>');
tbl(['节点', '角色', 'Master_Host', 'Slave_IO', 'Slave_SQL', '延迟(秒)', 'Master_Server_Id'],
  nodes.map(n => {
    const st = n.replication?.status || {};
    return [
      nodeLabel(n), n.role || '-',
      st.masterHost || (n.replication?.isSlave ? '-' : n.ip),
      st.slaveIoRunning || (n.replication?.isSlave ? '-' : 'Yes'),
      st.slaveSqlRunning || (n.replication?.isSlave ? '-' : 'Yes'),
      st.secondsBehindMaster ?? (n.replication?.isSlave ? '-' : '0'),
      '-',
    ];
  }));
h('<h3>并行复制配置</h3>');
tbl(['节点', 'slave_parallel_workers', 'slave_parallel_type'],
  nodes.map(n => [
    nodeLabel(n),
    n.variables?.slave_parallel_workers ?? n.variables?.replica_parallel_workers ?? '-',
    n.variables?.slave_parallel_type ?? n.variables?.replica_parallel_type ?? '-',
  ]));
callout('info', '本章小结：展示各节点复制状态及并行复制配置；复制状态正常。');

// ── Ch13 Schema 审计 ──────────────────────────────────────────────────────────
h('<h2>第十三章 Schema 审计</h2>');
h('<h3>字符集</h3>');
tbl(['节点', 'character_set_server', '是否 utf8mb4'],
  nodes.map(n => {
    const cs = n.variables?.character_set_server || '-';
    return [nodeLabel(n), cs, cs === 'utf8mb4' ? '是' : (cs === '-' ? '-' : '否')];
  }));
h('<h3>无主键表</h3>');
tbl(['节点', '库名', '表名'],
  nodes.flatMap(n => (n.noPkTables || []).map(t => [nodeLabel(n), t.schema || t.db || '-', t.table || '-'])));
h('<h3>非 utf8 表</h3>');
tbl(['节点', '库名', '表名', 'collation'],
  nodes.flatMap(n => (n.nonUtf8Tables || []).map(t => [nodeLabel(n), t.schema || t.db || '-', t.table || '-', t.collation || '-'])));
h('<h3>高碎片表</h3>');
tbl(['节点', '库名', '表名', '碎片率'],
  nodes.flatMap(n => (n.fragTables || []).map(t => [nodeLabel(n), t.schema || t.db || '-', t.table || '-', t.fragRate != null ? Number(t.fragRate).toFixed(2) : '-'])));
h('<h3>存储过程/函数/触发器</h3>');
tbl(['节点', '存储过程', '存储函数', '触发器'],
  nodes.map(n => [nodeLabel(n), spCount(n), fnCount(n), triggerCount(n)]));
h('<h3>自增主键使用率</h3>');
const aiRows = nodes.flatMap(n =>
  (n.autoIncrementUsage || []).filter(a => (Number(a.rate) || 0) >= 0.7)
    .map(a => [nodeLabel(n), `${a.schema || a.db || '-'}.${a.table || '-'}`, a.column || '-', a.rate != null ? (Number(a.rate) * 100).toFixed(0) + '%' : '-']));
tbl(['节点', '表', '列', '使用率'], aiRows);
h('<h3>大字段（BLOB/TEXT）分布</h3>');
tbl(['节点', '表', '字段名', '类型'],
  nodes.flatMap(n => (n.blobColumns || []).map(c => [
    nodeLabel(n),
    `${c.schema || c.db || '-'}.${c.table || '-'}`,
    c.column || c.field || '-',
    c.type || '-',
  ])));
{
  const noPkCount = nodes.reduce((s, n) => s + (n.noPkTables || []).length, 0);
  const nonUtfCount = nodes.reduce((s, n) => s + (n.nonUtf8Tables || []).length, 0);
  const fragCount = nodes.reduce((s, n) => s + (n.fragTables || []).length, 0);
  const schIssues = (issues || []).filter(i => ['no_pk_tables', 'non_utf8_tables', 'heavy_frag_tables'].includes(i.type));
  const ck = schIssues.some(i => i.priority === 'P1') ? 'warn' : 'info';
  callout(ck, `本章小结：展示字符集、无主键表、非 utf8 表、高碎片表、存储过程/函数/触发器及大字段分布；无主键表 ${noPkCount} 张、非 utf8 表 ${nonUtfCount} 张、高碎片表 ${fragCount} 张。`);
}

// ── Ch14 SQL 治理 ─────────────────────────────────────────────────────────────
h('<h2>第十四章 SQL 治理</h2>');
tbl(['节点', 'Slow_queries', 'Questions', 'long_query_time'],
  nodes.map(n => [
    nodeLabel(n),
    n.slowQueries ?? '-',
    n.questions ?? '-',
    n.variables?.long_query_time ?? '-',
  ]));
const hasSql = nodes.some(n => (n.topSqlByLatency || []).length > 0);
if (hasSql) {
  for (const n of nodes) {
    const sqls = n.topSqlByLatency || [];
    if (!sqls.length) continue;
    h(`<h3>${esc(nodeLabel(n))} · TOP SQL（按总延迟）</h3>`);
    tbl(['执行次数', '总延迟', '平均延迟', 'SQL 摘要'],
      sqls.slice(0, 5).map(s => [
        s.execCount || '-',
        s.totalLatency || '-',
        s.avgLatency || '-',
        String(s.digest || s.query || '').slice(0, 80),
      ]));
  }
}
callout('info', '本章小结：展示慢查询统计、TOP SQL（按平均/累计延迟）及临时表 SQL TOP；优化建议详见第十六章行动计划。');

// ── Ch15 备份评估 ─────────────────────────────────────────────────────────────
h('<h2>第十五章 备份评估</h2>');
if (!backupAssessment) {
  h('<p><em>（无数据）</em></p>');
  h('<h3>备份产物</h3>');
  h('<p><em>（无数据）</em></p>');
  callout('crit', '备份能力评估：未检测到 mysqldump / xtrabackup / mariabackup 等备份工具');
} else {
  const assessment = backupAssessment.assessment || '未检测到 mysqldump / xtrabackup / mariabackup 等备份工具';
  const severity = backupAssessment.severity || 'critical';
  const sevKind = severity === 'critical' ? 'crit' : severity === 'high' ? 'warn' : 'info';
  h('<p><em>（无数据）</em></p>');
  h('<h3>备份产物</h3>');
  const artifacts = backupAssessment.artifacts || backupAssessment.backupFiles || [];
  if (artifacts.length) {
    tbl(['文件', '大小', '时间'],
      artifacts.map(a => [a.path || a.file || '-', a.size || '-', a.mtime || a.time || '-']));
  } else {
    h('<p><em>（无数据）</em></p>');
  }
  callout(sevKind, `备份能力评估：${esc(assessment)}`);
}
callout('info', `本章小结：展示备份工具检测、备份产物发现及备份能力评估；当前评估：${esc(backupAssessment?.assessment || '未检测到 mysqldump / xtrabackup / mariabackup 等备份工具')}`);

// ── Ch16 行动计划 ─────────────────────────────────────────────────────────────
h('<h2>第十六章 行动计划</h2>');
const priorityConfig = [
  { p: 'P0', label: 'P0 优先级', kind: 'crit', grp: p0 },
  { p: 'P1', label: 'P1 优先级', kind: 'warn', grp: p1 },
  { p: 'P2', label: 'P2 优先级', kind: 'info', grp: p2 },
  { p: 'P3', label: 'P3 优先级', kind: 'ok',   grp: p3 },
];
for (const { p, label, kind, grp } of priorityConfig) {
  if (!grp.length) continue;
  h(`<h3>${esc(label)}（${grp.length} 项）</h3>`);
  for (const issue of grp) {
    const nodeStr = issue.node ? ` ${issue.node}：` : ' 全部节点：';
    callout(kind, `[${p}]${esc(nodeStr)}${esc(issue.description || issue.type || '')}`);
    h(`<p>处置：${esc(issue.action || '-')}</p>`);
    if (issue.currentValue || issue.recommendedValue) {
      h(`<p>✦ 当前值：${esc(issue.currentValue || '-')}　→　推荐值：${esc(issue.recommendedValue || '-')}</p>`);
    }
    if (issue.sql) {
      h(`<pre><code>${esc(issue.sql)}</code></pre>`);
    }
  }
}

// ── Ch17 结论 ─────────────────────────────────────────────────────────────────
h('<h2>第十七章 结论</h2>');
h(`<p>本次巡检健康度 ${total}/100，共发现 ${(issues || []).length} 项问题。</p>`);
if (p0.length) {
  h('<h3>立即处理</h3><ul>');
  p0.forEach(i => h(`<li>[P0] ${esc(i.node ? i.node + '：' : '')}${esc(i.description || i.type || '')}</li>`));
  h('</ul>');
}
if (p1.length) {
  h('<h3>近期处理</h3><ul>');
  p1.slice(0, 8).forEach(i => h(`<li>[P1] ${esc(i.node ? i.node + '：' : '')}${esc(i.description || i.type || '')}</li>`));
  h('</ul>');
}
if (p2.length) {
  h('<h3>中长期优化</h3><ul>');
  p2.slice(0, 8).forEach(i => h(`<li>[P2] ${esc(i.node ? i.node + '：' : '')}${esc(i.description || i.type || '')}</li>`));
  h('</ul>');
}
if (p3.length) {
  h('<h3>长期演进</h3><ul>');
  p3.slice(0, 5).forEach(i => h(`<li>[P3] ${esc(i.node ? i.node + '：' : '')}${esc(i.description || i.type || '')}</li>`));
  h('</ul>');
}

h('</body></html>');

// ── Write ─────────────────────────────────────────────────────────────────────

const html = parts.join('\n');
fs.writeFileSync(outPath, html);
console.error(`HTML 报告已生成：${outPath}`);
console.error(`  文件大小：${(Buffer.byteLength(html) / 1024).toFixed(1)} KB`);

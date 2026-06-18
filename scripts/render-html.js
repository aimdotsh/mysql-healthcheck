#!/usr/bin/env node
/**
 * MySQL 巡检报告 — HTML 渲染器
 *
 * 用法：
 *   node render-html.js <data.json路径> [--out 报告.html]
 *
 * 输出：单文件自包含 HTML（内联 CSS，无外部依赖）
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ─── CLI ──────────────────────────────────────────────────────
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
const outPath = outIdx !== -1 && args[outIdx + 1]
  ? path.resolve(args[outIdx + 1])
  : path.join(path.dirname(dataFile), 'MySQL健康巡检报告.html');

const data = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));

// ─── 工具函数 ─────────────────────────────────────────────────
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function scoreColor(score) {
  if (score == null) return '#888';
  if (score >= 90) return '#2e7d32';
  if (score >= 75) return '#1565c0';
  if (score >= 60) return '#e65100';
  return '#c62828';
}

function priorityBadge(p) {
  const map = {
    P0: { label: 'P0 关键', bg: '#c62828', color: '#fff' },
    P1: { label: 'P1 重要', bg: '#e65100', color: '#fff' },
    P2: { label: 'P2 建议', bg: '#f9a825', color: '#000' },
    P3: { label: 'P3 观察', bg: '#616161', color: '#fff' },
  };
  const m = map[p] || { label: p, bg: '#888', color: '#fff' };
  return `<span class="badge" style="background:${m.bg};color:${m.color}">${m.label}</span>`;
}

function dimLabel(d) {
  return { availability: '可用性', security: '安全', performance: '性能',
           dataDesign: '数据设计', durability: '持久性', operations: '运维' }[d] || d || '';
}

function scoreBar(score) {
  const color = scoreColor(score);
  const pct = score == null ? 0 : Math.round(score);
  return `<div class="score-bar-wrap">
    <div class="score-bar-track"><div class="score-bar-fill" style="width:${pct}%;background:${color}"></div></div>
    <span class="score-num" style="color:${color}">${score != null ? score : '-'}</span>
  </div>`;
}

function th(...cols) { return '<tr>' + cols.map(c => `<th>${c}</th>`).join('') + '</tr>'; }
function td(...cols) { return '<tr>' + cols.map(c => `<td>${esc(c)}</td>`).join('') + '</tr>'; }

// ─── 数据提取 ─────────────────────────────────────────────────
const { project, inspectionDate, reportDate, healthScore, overallAssessment,
        issues, nodes, backupAssessment, securityAssessment,
        paramJudgments, recommendations, cluster } = data;

const p0 = (issues||[]).filter(i => i.priority === 'P0');
const p1 = (issues||[]).filter(i => i.priority === 'P1');
const p2 = (issues||[]).filter(i => i.priority === 'P2');
const p3 = (issues||[]).filter(i => i.priority === 'P3');
const dims = (healthScore||{}).dimensions || {};

// ─── CSS ─────────────────────────────────────────────────────
const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'PingFang SC','Microsoft YaHei','Segoe UI',system-ui,sans-serif;font-size:14px;
  color:#212121;background:#f5f5f5;line-height:1.6}
.page{max-width:1100px;margin:0 auto;padding:24px 16px 60px}

/* Header */
.report-header{background:linear-gradient(135deg,#1a237e 0%,#1565c0 60%,#0288d1 100%);
  color:#fff;padding:36px 40px;border-radius:12px;margin-bottom:28px;
  box-shadow:0 4px 20px rgba(0,0,0,0.18)}
.report-header h1{font-size:26px;font-weight:700;margin-bottom:8px}
.report-header .meta{font-size:13px;opacity:0.85;display:flex;gap:28px;flex-wrap:wrap}
.report-header .meta span{display:flex;align-items:center;gap:6px}

/* Section card */
.section{background:#fff;border-radius:10px;padding:28px 32px;margin-bottom:20px;
  box-shadow:0 1px 4px rgba(0,0,0,0.09)}
.section h2{font-size:18px;font-weight:700;color:#1a237e;border-bottom:2px solid #e3f2fd;
  padding-bottom:10px;margin-bottom:20px;display:flex;align-items:center;gap:8px}
.section h2::before{content:'';width:4px;height:20px;background:#1565c0;border-radius:2px;
  display:inline-block}
.section h3{font-size:15px;font-weight:600;color:#1565c0;margin:16px 0 10px;padding-left:10px;
  border-left:3px solid #90caf9}
.section h4{font-size:14px;font-weight:600;color:#424242;margin:14px 0 6px;padding-left:8px;
  border-left:2px solid #e0e0e0}

/* Summary grid */
.summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:20px;
  margin-bottom:16px}
.summary-card{background:#f8f9fa;border-radius:8px;padding:20px;border:1px solid #e0e0e0}
.summary-card h3{margin:0 0 12px;border:none;padding:0;color:#37474f;font-size:14px;
  text-transform:uppercase;letter-spacing:.5px}

/* Score */
.score-total{font-size:52px;font-weight:800;line-height:1;margin-bottom:4px}
.score-bar-wrap{display:flex;align-items:center;gap:10px;margin:4px 0}
.score-bar-track{flex:1;height:10px;background:#e0e0e0;border-radius:5px;overflow:hidden}
.score-bar-fill{height:100%;border-radius:5px;transition:width .3s}
.score-num{font-size:14px;font-weight:600;min-width:28px;text-align:right}
.dim-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 16px;margin-top:8px}
.dim-row{display:flex;align-items:center;gap:8px;font-size:13px}
.dim-label{min-width:60px;color:#616161}
.dim-bar-wrap{flex:1;display:flex;align-items:center;gap:6px}

/* Issue counts */
.issue-counts{display:flex;flex-wrap:wrap;gap:10px;margin-top:6px}
.issue-count{display:flex;align-items:center;gap:6px;padding:6px 14px;border-radius:20px;
  font-weight:600;font-size:14px}
.ic-p0{background:#ffebee;color:#c62828}
.ic-p1{background:#fff3e0;color:#e65100}
.ic-p2{background:#fffde7;color:#f57f17}
.ic-p3{background:#f5f5f5;color:#616161}

/* Badge */
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;
  vertical-align:middle}

/* Table */
table{width:100%;border-collapse:collapse;font-size:13px;margin:12px 0 4px}
th{background:#e8eaf6;color:#3949ab;font-weight:600;text-align:left;padding:9px 12px;
  white-space:nowrap;border-bottom:2px solid #c5cae9}
td{padding:8px 12px;border-bottom:1px solid #f0f0f0;vertical-align:top;word-break:break-word}
tr:hover td{background:#fafafa}
table code{font-family:monospace;background:#f5f5f5;padding:1px 4px;border-radius:3px;font-size:12px}

/* Action block */
.action-block{border-radius:8px;padding:16px 20px;margin-bottom:12px;border:1px solid transparent}
.ab-p0{background:#fff8f8;border-color:#ffcdd2}
.ab-p1{background:#fffaf5;border-color:#ffe0b2}
.ab-p2{background:#fffef5;border-color:#fff9c4}
.ab-p3{background:#fafafa;border-color:#e0e0e0}
.action-block h4{margin:0 0 6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.action-block p{color:#424242;margin:6px 0}
.action-meta{font-size:12px;color:#757575;display:flex;flex-wrap:wrap;gap:12px;margin:6px 0}
.action-meta strong{color:#37474f}
.current-val{font-size:13px;color:#c62828;background:#fff5f5;border:1px solid #ffcdd2;
  border-radius:4px;padding:3px 8px;display:inline-block;margin:3px 0}
.rec-val{font-size:13px;color:#2e7d32;background:#f1f8e9;border:1px solid #c8e6c9;
  border-radius:4px;padding:3px 8px;display:inline-block;margin:3px 0}
pre{background:#1e1e2e;color:#cdd6f4;padding:14px 18px;border-radius:6px;
  font-size:12px;overflow-x:auto;margin:8px 0;line-height:1.7}
pre code{font-family:'JetBrains Mono','Fira Code','Cascadia Code',monospace;
  background:none;padding:0;color:inherit}

/* Tag */
.tag{display:inline-block;padding:1px 7px;border-radius:4px;font-size:11px;
  background:#e8eaf6;color:#3949ab;margin:0 2px}
.tag-ok{background:#e8f5e9;color:#2e7d32}
.tag-warn{background:#fff3e0;color:#e65100}
.tag-err{background:#ffebee;color:#c62828}

/* Assessment bar */
.assess-bar{display:flex;gap:8px;align-items:center;margin:8px 0}
.assess-label{min-width:80px;font-size:13px;color:#616161}

/* TOC */
.toc{background:#fff;border-radius:10px;padding:20px 28px;margin-bottom:20px;
  box-shadow:0 1px 4px rgba(0,0,0,0.09)}
.toc h2{font-size:16px;color:#1a237e;margin-bottom:12px}
.toc ol{columns:2;column-gap:32px;list-style:decimal inside}
.toc li{padding:3px 0;font-size:13px}
.toc a{color:#1565c0;text-decoration:none}
.toc a:hover{text-decoration:underline}

/* Recommendation */
.rec-block{background:#e3f2fd;border-radius:6px;padding:12px 16px;margin:8px 0;
  border-left:4px solid #1565c0;font-size:13px}

/* Footer */
footer{text-align:center;font-size:12px;color:#9e9e9e;margin-top:40px;padding-top:20px;
  border-top:1px solid #e0e0e0}

/* Details */
details summary{cursor:pointer;color:#1565c0;font-size:13px;user-select:none;margin:8px 0}
details[open] summary{margin-bottom:8px}

/* Responsive */
@media(max-width:700px){
  .report-header{padding:24px 20px}.report-header h1{font-size:20px}
  .summary-grid{grid-template-columns:1fr}
  .toc ol{columns:1}
  .dim-grid{grid-template-columns:1fr}
}
@media print{
  body{background:#fff}.page{padding:0}
  .section{box-shadow:none;border:1px solid #ddd;page-break-inside:avoid}
  .report-header{border-radius:0}
}
`;

// ─── HTML 构建器 ──────────────────────────────────────────────
const blocks = [];
const s = (html) => blocks.push(html);

// ─── HEADER ───────────────────────────────────────────────────
s(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MySQL 健康巡检报告 — ${esc(project || '未命名项目')}</title>
<style>${CSS}</style>
</head>
<body>
<div class="page">
`);

// Report header
s(`<div class="report-header">
  <h1>MySQL 健康巡检报告</h1>
  <div style="font-size:18px;font-weight:500;margin-bottom:12px;opacity:0.9">${esc(project || '未命名项目')}</div>
  <div class="meta">
    <span>📅 巡检日期：${esc(inspectionDate||'-')}</span>
    <span>📄 生成日期：${esc(reportDate || new Date().toISOString().slice(0,10))}</span>
    <span>🖥️ 节点数：${nodes.length}</span>
    <span>📊 综合健康度：<strong style="font-size:20px;margin-left:4px">${healthScore?.total ?? '-'}</strong>/100</span>
  </div>
</div>`);

// TOC
s(`<div class="toc">
  <h2>目录</h2>
  <ol>
    <li><a href="#s1">执行摘要</a></li>
    <li><a href="#s2">集群概况</a></li>
    <li><a href="#s3">关键参数对比</a></li>
    <li><a href="#s4">资源使用</a></li>
    <li><a href="#s5">InnoDB 状态</a></li>
    <li><a href="#s6">复制状态</a></li>
    <li><a href="#s7">数据库容量</a></li>
    <li><a href="#s8">安全评估</a></li>
    <li><a href="#s9">备份评估</a></li>
    <li><a href="#s10">行动计划</a></li>
  </ol>
</div>`);

// ══════════════════════════════════════════
// 一、执行摘要
// ══════════════════════════════════════════
s(`<div class="section" id="s1"><h2>一、执行摘要</h2>`);
s(`<div class="summary-grid">`);

// 健康度卡
s(`<div class="summary-card">`);
s(`<h3>综合健康度</h3>`);
const total = healthScore?.total;
const totalColor = scoreColor(total);
s(`<div class="score-total" style="color:${totalColor}">${total ?? '-'}</div>`);
s(`<div style="font-size:13px;color:#757575;margin-bottom:12px">/ 100</div>`);
s(`<div class="dim-grid">`);
for (const [key, label] of [['availability','可用性'],['security','安全'],['performance','性能'],
                              ['dataDesign','数据设计'],['durability','持久性'],['operations','运维']]) {
  const v = dims[key];
  s(`<div class="dim-row"><span class="dim-label">${label}</span>
     <div class="dim-bar-wrap">${scoreBar(v)}</div></div>`);
}
s(`</div></div>`);

// 问题统计卡
s(`<div class="summary-card"><h3>检出问题</h3>
<div class="issue-counts">
  <div class="issue-count ic-p0">🔴 P0 × ${p0.length}</div>
  <div class="issue-count ic-p1">🟠 P1 × ${p1.length}</div>
  <div class="issue-count ic-p2">🟡 P2 × ${p2.length}</div>
  <div class="issue-count ic-p3">⚪ P3 × ${p3.length}</div>
</div>`);

if (overallAssessment) s(`<p style="margin-top:14px;font-size:13px;color:#424242">${esc(overallAssessment)}</p>`);

if (recommendations) {
  if (recommendations.immediate?.length) {
    s(`<div style="margin-top:14px"><strong style="color:#c62828">立即处理（P0）：</strong><ul style="margin-top:6px;padding-left:20px">`);
    recommendations.immediate.forEach(r => s(`<li style="font-size:13px;color:#424242;margin:3px 0">${esc(r)}</li>`));
    s(`</ul></div>`);
  }
  if (recommendations.shortTerm?.length) {
    s(`<div style="margin-top:10px"><strong style="color:#e65100">近期处理（P1）：</strong><ul style="margin-top:6px;padding-left:20px">`);
    recommendations.shortTerm.forEach(r => s(`<li style="font-size:13px;color:#424242;margin:3px 0">${esc(r)}</li>`));
    s(`</ul></div>`);
  }
}
s(`</div>`); // summary-card
s(`</div></div>`); // summary-grid + section

// ══════════════════════════════════════════
// 二、集群概况
// ══════════════════════════════════════════
s(`<div class="section" id="s2"><h2>二、集群概况</h2>`);

s(`<table><thead>${th('节点 IP','角色','MySQL 版本','操作系统','内存','CPU','运行时长')}</thead><tbody>`);
for (const n of nodes) {
  const roleMap = { primary:'主库', slave:'从库', dr:'灾备' };
  s(td(n.ip, roleMap[n.role]||n.role||'未知', n.mysqlVersion||'-',
    ((n.osRelease||'').split('\n')[0].slice(0,30)) || (n.osKernel||'-').slice(0,30),
    n.memTotal||'-', n.cpuCores||'-', n.uptimeText||'-'));
}
s(`</tbody></table>`);

const hasDM = nodes.some(n => n.isDualMaster);
const slaveNodes = nodes.filter(n => n.replication?.isSlave);
if (hasDM) {
  s(`<div class="rec-block" style="background:#fff5f5;border-color:#c62828;margin-top:12px">
    ⚠️ <strong>检测到双主配置</strong> — 两节点互为主从，存在写冲突风险，建议明确主写节点。</div>`);
} else if (slaveNodes.length) {
  s(`<div class="rec-block" style="margin-top:12px">`);
  s(`一主 ${slaveNodes.length} 从${nodes.some(n=>n.role==='dr')?' + 灾备':''} 复制拓扑`);
  for (const sv of slaveNodes) {
    const st = sv.replication?.status || {};
    const delay = st.secondsBehindMaster;
    s(`<br>• 从库 ${esc(sv.ip)} ← 主库 ${esc(st.masterHost||'-')}，IO：${esc(st.slaveIoRunning||'-')}，SQL：${esc(st.slaveSqlRunning||'-')}，延迟：${delay!=null?delay+'s':'-'}`);
  }
  s(`</div>`);
}
s(`</div>`);

// ══════════════════════════════════════════
// 三、关键参数对比
// ══════════════════════════════════════════
if (paramJudgments?.length) {
  s(`<div class="section" id="s3"><h2>三、关键参数对比</h2>`);
  const abnormal = paramJudgments.filter(j => !j.ok);
  const normal = paramJudgments.filter(j => j.ok);
  if (abnormal.length) {
    s(`<h3>参数不一致（需关注）</h3>`);
    s(`<table><thead>${th('参数','各节点值','说明')}</thead><tbody>`);
    abnormal.forEach(j => s(`<tr>
      <td><code>${esc(j.key)}</code></td>
      <td>${esc(j.valueMap||j.unique?.join(' / ')||'-')}</td>
      <td>${esc(j.reason||'-')}</td></tr>`));
    s(`</tbody></table>`);
  }
  if (normal.length) {
    s(`<details style="margin-top:14px">
      <summary>参数一致项（${normal.length} 条）展开查看</summary>
      <table style="margin-top:8px"><thead>${th('参数','值','说明')}</thead><tbody>`);
    normal.forEach(j => s(`<tr>
      <td><code>${esc(j.key)}</code></td>
      <td>${esc(j.valueMap||j.unique?.join(' / ')||'-')}</td>
      <td>${esc(j.reason||'正常')}</td></tr>`));
    s(`</tbody></table></details>`);
  }
  s(`</div>`);
}

// ══════════════════════════════════════════
// 四、资源使用
// ══════════════════════════════════════════
s(`<div class="section" id="s4"><h2>四、资源使用</h2>`);

// 磁盘
const diskRows = [];
for (const n of nodes) {
  for (const d of (n.disks||[])) {
    if (parseInt(d.usePct) >= 70) diskRows.push({...d, nodeIp: n.ip});
  }
}
if (diskRows.length) {
  s(`<h3>磁盘使用率 ≥ 70%</h3>`);
  s(`<table><thead>${th('节点','挂载点','总量','已用','使用率')}</thead><tbody>`);
  diskRows.forEach(d => {
    const pct = parseInt(d.usePct);
    const color = pct >= 90 ? '#c62828' : pct >= 80 ? '#e65100' : '#f57f17';
    s(`<tr><td>${esc(d.nodeIp)}</td><td>${esc(d.mount)}</td><td>${esc(d.total||'-')}</td>
        <td>${esc(d.used||'-')}</td><td style="color:${color};font-weight:600">${esc(d.usePct)}</td></tr>`);
  });
  s(`</tbody></table>`);
}

// 内存
s(`<h3>内存使用</h3>`);
s(`<table><thead>${th('节点','总内存','已用','使用率','交换区已用')}</thead><tbody>`);
nodes.forEach(n => {
  const pct = n.memUsagePct;
  const color = pct >= 90 ? '#c62828' : pct >= 75 ? '#e65100' : '#2e7d32';
  s(`<tr><td>${esc(n.ip)}</td><td>${esc(n.memTotal||'-')}</td><td>${esc(n.memUsed||'-')}</td>
    <td style="color:${color};font-weight:600">${pct!=null?pct+'%':'-'}</td>
    <td>${n.swapUsedKB>0?esc(n.swapUsed):'<span style="color:#2e7d32">未使用</span>'}</td></tr>`);
});
s(`</tbody></table></div>`);

// ══════════════════════════════════════════
// 五、InnoDB 状态
// ══════════════════════════════════════════
s(`<div class="section" id="s5"><h2>五、InnoDB 状态</h2>`);
s(`<table><thead>${th('节点','Buffer Pool','命中率','file_per_table','flush_log_at_trx','sync_binlog')}</thead><tbody>`);
nodes.forEach(n => {
  const v = n.variables||{};
  const bpMB = n.bpMB;
  const bpStr = bpMB ? (bpMB>=1024?(bpMB/1024).toFixed(1)+'GB':Math.round(bpMB)+'MB') : '-';
  const hitPct = n.bpHitPct;
  const hitColor = hitPct < 95 ? '#c62828' : hitPct < 99 ? '#e65100' : '#2e7d32';
  s(`<tr><td>${esc(n.ip)}</td><td>${esc(bpStr)}</td>
    <td style="color:${hitPct?hitColor:'#888'};font-weight:600">${hitPct!=null?hitPct+'%':'-'}</td>
    <td>${esc(v.innodb_file_per_table||'-')}</td>
    <td>${esc(v.innodb_flush_log_at_trx_commit||'-')}</td>
    <td>${esc(v.sync_binlog||'-')}</td></tr>`);
});
s(`</tbody></table>`);

// ibtmp1
const ibtmpRows = nodes.filter(n => n.ibtmp1?.currentSizeGB > 0);
if (ibtmpRows.length) {
  s(`<h3>临时表空间（ibtmp1）</h3>`);
  s(`<table><thead>${th('节点','路径','当前大小','限制')}</thead><tbody>`);
  ibtmpRows.forEach(n => s(`<tr>
    <td>${esc(n.ip)}</td><td>${esc(n.ibtmp1.path||'-')}</td>
    <td>${esc((n.ibtmp1.currentSizeGB||0).toFixed(2))+'GB'}</td>
    <td>${n.ibtmp1NoMax?'<span class="tag tag-warn">无上限</span>':'有上限'}</td></tr>`));
  s(`</tbody></table>`);
}
s(`</div>`);

// ══════════════════════════════════════════
// 六、复制状态
// ══════════════════════════════════════════
if (slaveNodes.length) {
  s(`<div class="section" id="s6"><h2>六、复制状态</h2>`);
  s(`<table><thead>${th('节点','主库','IO线程','SQL线程','延迟(s)','GTID模式')}</thead><tbody>`);
  slaveNodes.forEach(n => {
    const st = n.replication.status||{};
    const delay = st.secondsBehindMaster;
    const delayColor = delay >= 300 ? '#c62828' : delay >= 60 ? '#e65100' : '#2e7d32';
    const ioOk = st.slaveIoRunning === 'Yes';
    const sqlOk = st.slaveSqlRunning === 'Yes';
    s(`<tr><td>${esc(n.ip)}</td><td>${esc(st.masterHost||'-')}</td>
      <td>${ioOk?'<span class="tag tag-ok">Yes</span>':'<span class="tag tag-err">'+esc(st.slaveIoRunning||'-')+'</span>'}</td>
      <td>${sqlOk?'<span class="tag tag-ok">Yes</span>':'<span class="tag tag-err">'+esc(st.slaveSqlRunning||'-')+'</span>'}</td>
      <td style="color:${delay!=null?delayColor:'#888'};font-weight:600">${delay!=null?delay:'-'}</td>
      <td>${esc(n.variables?.gtid_mode||'-')}</td></tr>`);
  });
  s(`</tbody></table></div>`);
}

// ══════════════════════════════════════════
// 七、数据库容量
// ══════════════════════════════════════════
s(`<div class="section" id="s7"><h2>七、数据库容量</h2>`);
s(`<table><thead>${th('节点','数据总量','库数','表数')}</thead><tbody>`);
nodes.forEach(n => s(td(n.ip,
  n.dbTotalSizeGB!=null?Number(n.dbTotalSizeGB).toFixed(2)+' GB':'-',
  (n.databases||[]).length||(n.databases?n.databases.length:'-'),
  (n.tables||[]).length||(n.tables?n.tables.length:'-'))));
s(`</tbody></table>`);

const primary = nodes.find(n => n.role==='primary') || nodes[0];
if (primary?.topTables?.length) {
  s(`<h3>TOP ${Math.min(10, primary.topTables.length)} 大表（主库 ${esc(primary.ip)}）</h3>`);
  s(`<table><thead>${th('库.表','行数','数据','索引','总大小')}</thead><tbody>`);
  primary.topTables.slice(0,10).forEach(t => s(td(`${t.db}.${t.table}`,t.rows||'-',t.dataSize||'-',t.indexSize||'-',t.totalSize||'-')));
  s(`</tbody></table>`);
}
s(`</div>`);

// ══════════════════════════════════════════
// 八、安全评估
// ══════════════════════════════════════════
s(`<div class="section" id="s8"><h2>八、安全评估</h2>`);
if (securityAssessment) {
  const { items, pass, fail, warn, complianceLevel } = securityAssessment;
  const levelColor = { 优 : '#2e7d32', 良: '#1565c0', 中: '#e65100', 差: '#c62828' }[complianceLevel] || '#888';
  s(`<div style="display:flex;gap:24px;flex-wrap:wrap;margin-bottom:16px;align-items:center">`);
  s(`<div style="text-align:center"><div style="font-size:36px;font-weight:800;color:${levelColor}">${esc(complianceLevel||'-')}</div><div style="font-size:12px;color:#757575">合规等级</div></div>`);
  s(`<div style="display:grid;grid-template-columns:repeat(3,auto);gap:8px 20px;align-items:center">`);
  s(`<span class="tag tag-ok">✅ 通过 ${pass||0}</span>`);
  s(`<span class="tag tag-warn">⚠️ 警告 ${warn||0}</span>`);
  s(`<span class="tag tag-err">❌ 失败 ${fail||0}</span>`);
  s(`</div></div>`);

  const badItems = (items||[]).filter(i => i.status==='fail'||i.status==='warn');
  if (badItems.length) {
    s(`<table><thead>${th('检查项','状态','说明')}</thead><tbody>`);
    badItems.forEach(i => s(`<tr>
      <td>${esc(i.name||'-')}</td>
      <td>${i.status==='fail'?'<span class="tag tag-err">❌ 失败</span>':'<span class="tag tag-warn">⚠️ 警告</span>'}</td>
      <td>${esc(i.detail||'-')}</td></tr>`));
    s(`</tbody></table>`);
  }
}

const emptyPwd = nodes.flatMap(n => (n.emptyPasswordUsers||[]).map(u => ({...u, node: n.ip})));
if (emptyPwd.length) {
  s(`<h3 style="color:#c62828">空密码账号（高危）</h3><ul style="padding-left:20px">`);
  emptyPwd.forEach(u => s(`<li style="font-size:13px;margin:3px 0"><code>${esc(u.user)}@${esc(u.host)}</code> 节点：${esc(u.node)}</li>`));
  s(`</ul>`);
}
const weakPwd = nodes.flatMap(n => (n.weakPasswordUsers||[]).map(u => ({...u, node: n.ip})));
if (weakPwd.length) {
  s(`<h3 style="color:#e65100">弱密码账号</h3><ul style="padding-left:20px">`);
  weakPwd.forEach(u => s(`<li style="font-size:13px;margin:3px 0"><code>${esc(u.user)}@${esc(u.host)}</code> 节点：${esc(u.node)}</li>`));
  s(`</ul>`);
}
s(`</div>`);

// ══════════════════════════════════════════
// 九、备份评估
// ══════════════════════════════════════════
s(`<div class="section" id="s9"><h2>九、备份评估</h2>`);
if (backupAssessment) {
  const { assessment, severity, hasTool, hasBackupArtifact, hasScheduledBackup, latestBackup, tools } = backupAssessment;
  const sevColor = { critical:'#c62828', high:'#e65100', medium:'#f57f17', low:'#2e7d32' }[severity] || '#888';
  const sevIcon = { critical:'🔴', high:'🟠', medium:'🟡', low:'✅' }[severity] || '❓';
  s(`<div class="action-block ${severity==='critical'?'ab-p0':severity==='high'?'ab-p1':severity==='medium'?'ab-p2':'ab-p3'}">
    <strong style="font-size:15px;color:${sevColor}">${sevIcon} ${esc(assessment||'无评估')}</strong>
    <div class="action-meta" style="margin-top:10px">
      <span><strong>备份工具：</strong>${esc(tools?.join('、')||'未检测到')}</span>
      <span><strong>最近备份：</strong>${esc(latestBackup||'未知')}</span>
      <span><strong>定时任务：</strong>${hasScheduledBackup?'<span class="tag tag-ok">有</span>':'<span class="tag tag-err">无</span>'}</span>
      <span><strong>备份产物：</strong>${hasBackupArtifact?'<span class="tag tag-ok">检测到</span>':'<span class="tag tag-err">未检测到</span>'}</span>
    </div>
  </div>`);
}
s(`</div>`);

// ══════════════════════════════════════════
// 十、行动计划（P0 → P3）
// ══════════════════════════════════════════
s(`<div class="section" id="s10"><h2>十、行动计划</h2>`);
s(`<p style="font-size:13px;color:#616161;margin-bottom:16px">按优先级排序。P0 须立即处理；P1 建议本周内；P2 建议本月内；P3 长期优化。</p>`);

const pGroups = [
  { p: 'P0', label: '🔴 P0 关键', issues: p0, cls: 'ab-p0' },
  { p: 'P1', label: '🟠 P1 重要', issues: p1, cls: 'ab-p1' },
  { p: 'P2', label: '🟡 P2 建议', issues: p2, cls: 'ab-p2' },
  { p: 'P3', label: '⚪ P3 观察', issues: p3, cls: 'ab-p3' },
];

for (const { p, label, issues: grp, cls } of pGroups) {
  if (!grp.length) continue;
  s(`<h3>${label}（${grp.length} 项）</h3>`);
  for (const issue of grp) {
    s(`<div class="action-block ${cls}">`);
    s(`<h4>${priorityBadge(issue.priority)} ${esc(issue.type || issue.groupKey || '问题')}`);
    if (issue.dimension) s(`<span class="tag">${esc(dimLabel(issue.dimension))}</span>`);
    if (issue.node) s(`<span style="font-size:12px;color:#757575"> — ${esc(issue.node)}</span>`);
    s(`</h4>`);
    if (issue.description) s(`<p style="margin-top:6px">${esc(issue.description)}</p>`);
    if (issue.currentValue || issue.recommendedValue) {
      s(`<div class="action-meta" style="margin-top:8px">`);
      if (issue.currentValue) s(`<span>当前值：<span class="current-val">${esc(issue.currentValue)}</span></span>`);
      if (issue.recommendedValue) s(`→ <span>推荐值：<span class="rec-val">${esc(issue.recommendedValue)}</span></span>`);
      s(`</div>`);
    }
    if (issue.action) s(`<p style="margin-top:8px;color:#37474f"><strong>处理建议：</strong>${esc(issue.action)}</p>`);
    if (issue.sql) s(`<pre><code>${esc(issue.sql)}</code></pre>`);
    s(`</div>`);
  }
}
s(`</div>`);

// ─── FOOTER ───────────────────────────────────────────────────
s(`<footer>本报告由 mysql-healthcheck 自动生成 · ${esc(reportDate || new Date().toISOString().slice(0,10))}</footer>`);
s(`</div></body></html>`);

// ─── 写文件 ───────────────────────────────────────────────────
const html = blocks.join('\n');
fs.writeFileSync(outPath, html);
console.error(`HTML 报告已生成：${outPath}`);
console.error(`  文件大小：${(Buffer.byteLength(html) / 1024).toFixed(1)} KB`);

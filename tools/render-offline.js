'use strict';
// 离线渲染器：facts → { markdown, html }。零外部依赖（不 require 任何 npm 包）。
const charts = require('./charts.js');

// ── block 工厂 ───────────────────────────────────────────────
const B = {
  heading: (level, text) => ({ t: 'heading', level, text }),
  paragraph: (text) => ({ t: 'paragraph', text }),
  table: (headers, rows) => ({ t: 'table', headers, rows }),
  list: (items, ordered = false) => ({ t: 'list', items, ordered }),
  callout: (kind, text) => ({ t: 'callout', kind, text }), // kind: info|warn|crit|ok
  codeblock: (lang, code) => ({ t: 'codeblock', lang, code }),
  chart: (svg, caption, tableFallback) => ({ t: 'chart', svg, caption, tableFallback }),
};

// ── 转义 ─────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function mdCell(s) { return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, '<br/>'); }

// ── Markdown 序列化 ──────────────────────────────────────────
function toMarkdown(blocks) {
  const out = [];
  for (const b of blocks) {
    switch (b.t) {
      case 'heading': out.push('#'.repeat(b.level) + ' ' + b.text, ''); break;
      case 'paragraph': out.push(b.text, ''); break;
      case 'table': {
        if (!b.rows.length) { out.push('_（无数据）_', ''); break; }
        out.push('| ' + b.headers.map(mdCell).join(' | ') + ' |');
        out.push('| ' + b.headers.map(() => '---').join(' | ') + ' |');
        for (const r of b.rows) out.push('| ' + r.map(mdCell).join(' | ') + ' |');
        out.push('');
        break;
      }
      case 'list':
        b.items.forEach((it, i) => out.push((b.ordered ? `${i + 1}. ` : '- ') + it));
        out.push('');
        break;
      case 'callout': {
        const tag = { info: 'ℹ️', warn: '⚠️', crit: '🔴', ok: '✅' }[b.kind] || 'ℹ️';
        out.push(`> ${tag} ${b.text}`, '');
        break;
      }
      case 'codeblock': out.push('```' + (b.lang || ''), b.code, '```', ''); break;
      case 'chart':
        if (b.caption) out.push(`**${b.caption}**`, '');
        if (b.tableFallback) out.push(...toMarkdown([b.tableFallback]).split('\n'));
        break;
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// ── HTML 序列化 ──────────────────────────────────────────────
const CSS = `
body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;line-height:1.6;color:#222;max-width:1000px;margin:0 auto;padding:24px}
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
`;

function htmlBlocks(blocks) {
  const out = [];
  for (const b of blocks) {
    switch (b.t) {
      case 'heading': out.push(`<h${b.level}>${esc(b.text)}</h${b.level}>`); break;
      case 'paragraph': out.push(`<p>${esc(b.text)}</p>`); break;
      case 'table': {
        if (!b.rows.length) { out.push('<p><em>（无数据）</em></p>'); break; }
        const head = b.headers.map(h => `<th>${esc(h)}</th>`).join('');
        const body = b.rows.map(r => '<tr>' + r.map(c => `<td>${esc(c)}</td>`).join('') + '</tr>').join('');
        out.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
        break;
      }
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        out.push(`<${tag}>` + b.items.map(i => `<li>${esc(i)}</li>`).join('') + `</${tag}>`);
        break;
      }
      case 'callout': out.push(`<div class="callout ${esc(b.kind)}">${esc(b.text)}</div>`); break;
      case 'codeblock': out.push(`<pre><code>${esc(b.code)}</code></pre>`); break;
      case 'chart':
        // SVG 由我们自己的 charts.js 生成，可信，直接内联
        out.push(`<figure class="chart">${b.svg || ''}${b.caption ? `<figcaption>${esc(b.caption)}</figcaption>` : ''}</figure>`);
        break;
    }
  }
  return out.join('\n');
}

function toHtml(blocks, opts = {}) {
  const title = esc(opts.title || 'MySQL 巡检报告');
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${CSS}</style></head>
<body>
${htmlBlocks(blocks)}
</body></html>
`;
}

// 顶层：把 facts 渲染成 block 数组（17 章完整结构 → toMarkdown/toHtml 序列化）
function buildReportBlocks(facts) {
  const blocks = [];
  const title = `${facts.project || 'MySQL'} 巡检报告`;
  blocks.push(B.heading(1, title));
  blocks.push(B.paragraph(`巡检日期：${facts.inspectionDate || facts.reportDate || '-'}　节点数：${facts.nodes.length}　健康度：${facts.healthScore?.total ?? '-'}/100`));

  // ── 第一章 执行摘要 ──────────────────────────────────────────
  const hs = facts.healthScore || { total: 0, dimensions: {} };
  const cnt = p => facts.issues.filter(i => i.priority === p).length;
  blocks.push(B.heading(2, '第一章 执行摘要'));
  blocks.push(B.chart(charts.gauge(hs.total, '综合健康度'), `综合健康度 ${hs.total}/100`));
  blocks.push(B.paragraph(`本次巡检覆盖 ${facts.nodes.length} 个节点，共检出 ${facts.issues.length} 项问题：` +
    `P0 ${cnt('P0')} 项、P1 ${cnt('P1')} 项、P2 ${cnt('P2')} 项、P3 ${cnt('P3')} 项。`));
  if (cnt('P0') > 0) blocks.push(B.callout('crit', `存在 ${cnt('P0')} 项 P0 高危问题，需优先处置（详见第十六章行动计划）。`));
  if (facts.overallAssessment) blocks.push(B.paragraph(String(facts.overallAssessment).slice(0, 600)));
  blocks.push(B.table(['维度', '得分'],
    Object.entries(hs.dimensions || {}).map(([k, v]) => [k, `${v}/100`])));

  // ── 第二章 操作系统与硬件 ────────────────────────────────────
  blocks.push(B.heading(2, '第二章 操作系统与硬件'));
  blocks.push(B.table(['节点', 'hostname', 'OS 发行版', '内核', 'CPU 核', '内存 GB', '内存使用率'],
    facts.nodes.map(n => [
      n.label || n.ip, n.hostname ?? '-', n.osRelease ?? '-',
      n.osKernel ?? '-', n.cpuCores ?? '-',
      n.memGB != null ? Number(n.memGB).toFixed(1) : (n.memTotal ?? '-'),
      n.memUsagePct != null ? `${n.memUsagePct}%` : '-',
    ])));
  for (const n of facts.nodes) {
    if (!(n.disks || []).length) continue;
    blocks.push(B.heading(3, `${n.label || n.ip} · 磁盘`));
    blocks.push(B.table(['挂载点', '文件系统', '总量', '已用', '可用', '使用率'],
      n.disks.map(d => [d.mount ?? '-', d.filesystem ?? '-', d.total ?? '-', d.used ?? '-', d.avail ?? '-', d.usePct ?? '-'])));
  }
  const eolNodes = facts.nodes.filter(n => n.osEolStatus && n.osEolStatus.status === 'eol');
  if (eolNodes.length) {
    blocks.push(B.list(eolNodes.map(n => `${n.label || n.ip}：${n.osRelease ?? '-'} ${n.osEolStatus.statusLabel || '已 EOL'}（${n.osEolStatus.eolDate ?? '-'}），存在合规风险`)));
  }
  blocks.push(B.callout('info', '本章小结：展示操作系统、CPU、内存、磁盘概况；如有磁盘使用率过高或 OS 已 EOL，详见第十六章行动计划。'));

  // ── 第三章 MySQL 版本与启动配置 ──────────────────────────────
  blocks.push(B.heading(2, '第三章 MySQL 版本与启动配置'));
  blocks.push(B.table(['节点', 'MySQL 版本', '运行时长'],
    facts.nodes.map(n => [n.label || n.ip, n.mysqlVersion ?? '-', n.uptimeText ?? '-'])));
  blocks.push(B.heading(3, '关键启动参数'));
  blocks.push(B.table(['参数', ...facts.nodes.map(n => n.label || n.ip)],
    ['datadir', 'socket', 'log_error', 'pid_file', 'server_id'].map(key =>
      [key, ...facts.nodes.map(n => n.variables?.[key] ?? '-')])));
  const mysqlEol = facts.nodes.filter(n => n.mysqlEolStatus && n.mysqlEolStatus.status === 'eol');
  if (mysqlEol.length) {
    blocks.push(B.list(mysqlEol.map(n => `${n.label || n.ip}：${n.mysqlVersion ?? '-'} 已${n.mysqlEolStatus.statusLabel || 'EOL'}（${n.mysqlEolStatus.eolDate ?? '-'}）`)));
  }
  blocks.push(B.callout('info', '本章小结：展示 MySQL 版本、运行时长及关键启动参数；版本 EOL 风险详见第十六章行动计划。'));

  // ── 第四章 集群拓扑 ──────────────────────────────────────────
  blocks.push(B.heading(2, '第四章 集群拓扑'));
  try {
    blocks.push(B.chart(charts.topology(facts.nodes), `集群拓扑：${facts.cluster?.topology ?? '-'}`));
  } catch (_) { /* 拓扑图生成失败时退化为纯表格 */ }
  blocks.push(B.table(['节点', '角色', '主机'],
    facts.nodes.map(n => [n.label || n.ip, n.role ?? '-', n.hostname ?? '-'])));
  blocks.push(B.heading(3, '复制基础信息'));
  blocks.push(B.table(['节点', 'server_id', 'server_uuid', 'binlog 格式', 'log_bin'],
    facts.nodes.map(n => [
      n.label || n.ip, n.variables?.server_id ?? '-', n.variables?.server_uuid ?? '-',
      n.variables?.binlog_format ?? '-', n.variables?.log_bin ?? '-',
    ])));
  blocks.push(B.callout('info', `本章小结：拓扑结构为「${facts.cluster?.topology ?? '-'}」，共 ${facts.cluster?.nodeCount ?? facts.nodes.length} 个节点；详细复制状态见第十二章。`));

  // ── 第五章 关键参数与一致性 ──────────────────────────────────
  blocks.push(B.heading(2, '第五章 关键参数与一致性'));
  const PARAM_GROUPS = {
    '持久化': ['innodb_flush_log_at_trx_commit', 'sync_binlog', 'gtid_mode', 'innodb_doublewrite', 'expire_logs_days'],
    '性能': ['innodb_buffer_pool_size', 'innodb_log_file_size', 'innodb_flush_method', 'max_connections'],
    '安全': ['default_authentication_plugin', 'sql_mode', 'character_set_server'],
  };
  const formatBpSize = (n) => {
    if (n.bpMB != null) return n.bpMB >= 1024 ? `${(n.bpMB / 1024).toFixed(1)} GB` : `${n.bpMB} MB`;
    return n.variables?.innodb_buffer_pool_size_in_mb != null ? `${n.variables.innodb_buffer_pool_size_in_mb} MB` : '-';
  };
  const formatLogFileSize = (n) => n.variables?.innodb_log_file_size_in_mb != null ? `${n.variables.innodb_log_file_size_in_mb} MB` : '-';
  const formatFlushMethod = (n) => {
    if (n.variables?.innodb_flush_method != null) return n.variables.innodb_flush_method;
    if (n.flushMethodNotODirect != null) return n.flushMethodNotODirect ? 'non-O_DIRECT' : 'O_DIRECT';
    return '-';
  };
  const formatCharsetServer = (n) => {
    if (n.variables?.character_set_server != null) return n.variables.character_set_server;
    if (n.charsetNotUtf8mb4 != null) return n.charsetNotUtf8mb4 ? '非 utf8mb4' : 'utf8mb4';
    return '-';
  };
  const PARAM_VALUE_RESOLVERS = {
    innodb_buffer_pool_size: formatBpSize,
    innodb_log_file_size: formatLogFileSize,
    innodb_flush_method: formatFlushMethod,
    max_connections: (n) => n.variables?.max_connections ?? '-',
    default_authentication_plugin: (n) => n.variables?.default_authentication_plugin ?? '-',
    sql_mode: (n) => n.sqlModeStr ?? '-',
    character_set_server: formatCharsetServer,
  };
  for (const [groupName, keys] of Object.entries(PARAM_GROUPS)) {
    blocks.push(B.heading(3, groupName));
    blocks.push(B.table(['参数', ...facts.nodes.map(n => n.label || n.ip)],
      keys.map(key => [key, ...facts.nodes.map(n => (PARAM_VALUE_RESOLVERS[key] ?? (n2 => n2.variables?.[key] ?? '-'))(n))])));
  }
  const inconsistent = (facts.paramJudgments || []).filter(p => p.ok === false);
  if (inconsistent.length) {
    blocks.push(B.heading(3, '跨节点参数差异'));
    blocks.push(B.table(['参数名', '各节点取值', '说明'],
      inconsistent.map(p => [p.key ?? '-', p.valueMap ?? (p.values || []).join(' / '), p.reason ?? '-'])));
  }
  blocks.push(B.callout(inconsistent.length ? 'warn' : 'info',
    `本章小结：展示持久化/性能/安全关键参数及跨节点一致性；${inconsistent.length ? `发现 ${inconsistent.length} 项参数不一致，详见上表与第十六章行动计划。` : '关键参数跨节点一致。'}`));

  // ── 第六章 性能指标分析 ──────────────────────────────────────
  blocks.push(B.heading(2, '第六章 性能指标分析'));
  blocks.push(B.table(['节点', 'QPS', '当前连接数', 'BP 命中率', 'Slow_queries'],
    facts.nodes.map(n => [
      n.label || n.ip, n.qps ?? '-', n.threadsConnected ?? '-', n.bpHitDisplay ?? '-', n.slowQueries ?? '-',
    ])));
  const hitRateData = facts.nodes.filter(n => n.bpHitPct != null).map(n => ({ label: n.label || n.ip, value: n.bpHitPct }));
  if (hitRateData.length) {
    blocks.push(B.chart(charts.hbar(hitRateData, { title: 'InnoDB Buffer Pool 命中率 (%)', max: 100, format: v => `${v}%` }), 'Buffer Pool 命中率对比'));
  }
  const lowHit = facts.nodes.filter(n => n.bpHitPct != null && n.bpHitPct < 95);
  blocks.push(B.callout(lowHit.length ? 'warn' : 'info',
    `本章小结：展示 QPS / 连接数 / Buffer Pool 命中率 / 慢查询统计；${lowHit.length ? `${lowHit.map(n => n.label || n.ip).join('、')} 命中率低于 95%，需关注。` : 'Buffer Pool 命中率均处于正常区间。'}`));

  // ── 第七章 数据库容量与对象 ───────────────────────────────────
  blocks.push(B.heading(2, '第七章 数据库容量与对象'));
  blocks.push(B.table(['节点', '数据总量(GB)', '表数', 'TOP表'],
    facts.nodes.map(n => [
      n.label || n.ip,
      n.dbTotalSizeGB ?? '-',
      (n.topTables || []).length || '-',
      (n.topTables || []).slice(0, 1).map(t => `${t.db || t.schema || ''}.${t.table || t.name || ''}`).join('') || '-',
    ])));
  for (const n of facts.nodes) {
    if (!(n.topTables || []).length) continue;
    blocks.push(B.heading(3, `${n.label || n.ip} · TOP 10 大表`));
    blocks.push(B.table(['库', '表', '行数', '大小(GB)', '引擎'],
      n.topTables.slice(0, 10).map(t => [
        t.db || t.schema || '-', t.table || t.name || '-', t.rows ?? '-',
        t.sizeGB ?? t.dataSize ?? t.data ?? '-', t.engine ?? '-',
      ])));
  }
  for (const n of facts.nodes) {
    if (!(n.dbSizes || []).length) continue;
    blocks.push(B.heading(3, `${n.label || n.ip} · 数据库大小分布`));
    blocks.push(B.table(['库名', '大小(GB)'], n.dbSizes.map(d => [d.name ?? '-', d.sizeGB ?? '-'])));
  }
  blocks.push(B.callout('info', '本章小结：展示各节点数据库总量、TOP 大表及数据库大小分布；容量增长趋势需结合历史巡检对比。'));

  // ── 第八章 InnoDB 状态与 ibtmp1 ──────────────────────────────
  blocks.push(B.heading(2, '第八章 InnoDB 状态与 ibtmp1'));
  blocks.push(B.table(['节点', 'History List Length', '脏页数', 'Buffer Pool 总页数', 'BP 命中率'],
    facts.nodes.map(n => [
      n.label || n.ip, n.innodb?.historyListLength ?? '-', n.innodb?.modifiedDbPages ?? '-',
      n.innodb?.databasePages ?? '-', n.bpHitDisplay ?? '-',
    ])));
  blocks.push(B.heading(3, 'ibtmp1 临时表空间'));
  blocks.push(B.table(['节点', '当前大小', '初始大小', 'autoextend', '是否设上限'],
    facts.nodes.map(n => [
      n.label || n.ip, n.ibtmp1?.sizeFormatted ?? '-', n.ibtmp1?.initialSize ?? '-',
      n.ibtmp1?.autoExtendSize ?? '-', n.ibtmp1NoMax ? '否' : '是',
    ])));
  const hllHigh = facts.nodes.filter(n => Number(n.innodb?.historyListLength) > 10000);
  blocks.push(B.callout(hllHigh.length ? 'warn' : 'info',
    `本章小结：展示 InnoDB History List Length、脏页及 ibtmp1 临时表空间情况；${hllHigh.length ? `${hllHigh.map(n => n.label || n.ip).join('、')} History List Length 超过 10000，需排查长事务/未提交事务。` : '关键指标处于正常范围。'}`));

  // ── 第九章 引擎深度（Buffer Pool / Redo / 锁等待） ────────────────
  blocks.push(B.heading(2, '第九章 引擎深度（Buffer Pool / Redo / 锁等待）'));
  blocks.push(B.table(['节点', 'BP 大小(MB)', '占 RAM 比例', 'BP 命中率', 'innodb_log_file_size'],
    facts.nodes.map(n => [
      n.label || n.ip, n.bpMB ?? '-',
      (n.bpMB != null && n.memGB) ? `${((n.bpMB / 1024 / n.memGB) * 100).toFixed(1)}%` : '-',
      n.bpHitDisplay ?? '-', formatLogFileSize(n),
    ])));
  blocks.push(B.heading(3, '锁等待与事务（当前快照）'));
  blocks.push(B.table(['节点', 'INNODB LOCKS', 'INNODB LOCK WAITS', 'Metadata Locks'],
    facts.nodes.map(n => [
      n.label || n.ip, (n.innodbLocks || []).length || 0,
      (n.innodbLockWaits || []).length || 0, (n.metadataLocks || []).length || 0,
    ])));
  blocks.push(B.callout('info', '本章小结：展示 Buffer Pool 容量与 RAM 占比、Redo Log 配置及当前锁等待快照；容量评估详见第十六章行动计划。'));

  // ── 第十章 会话 + 锁 + 错误日志 ──────────────────────────────────
  blocks.push(B.heading(2, '第十章 会话 + 锁 + 错误日志'));
  blocks.push(B.table(['节点', '总会话数', '当前连接数'],
    facts.nodes.map(n => [n.label || n.ip, (n.processlist || []).length || 0, n.threadsConnected ?? '-'])));
  blocks.push(B.heading(3, '长时间运行会话'));
  blocks.push(B.table(['节点', 'id', 'user', 'host', 'time(秒)', 'state', 'db'],
    facts.nodes.filter(n => n.longSessTop).map(n => {
      const s = n.longSessTop;
      return [n.label || n.ip, s.id ?? '-', s.user ?? '-', s.host ?? '-', s.time ?? '-', s.state ?? '-', s.db ?? '-'];
    })));
  blocks.push(B.heading(3, '错误日志摘要'));
  blocks.push(B.table(['节点', '日志范围', 'ERROR 数', 'WARNING 数', 'Deprecated 数'],
    facts.nodes.map(n => {
      const e = n.errorLogAnalysis;
      return [n.label || n.ip, e?.available ? `${e.firstTs ?? '-'} ~ ${e.lastTs ?? '-'}` : '不可用',
        e?.errorCount ?? '-', e?.warningCount ?? '-', e?.deprecatedCount ?? '-'];
    })));
  const errNodes = facts.nodes.filter(n => Number(n.errorLogAnalysis?.errorCount) > 0);
  blocks.push(B.callout(errNodes.length ? 'warn' : 'info',
    `本章小结：展示当前会话、长时间运行会话及错误日志统计；${errNodes.length ? `${errNodes.map(n => n.label || n.ip).join('、')} 错误日志中存在 ERROR 记录，需排查。` : '错误日志未发现 ERROR 级别记录。'}`));

  // ── 第十一章 用户与权限 ──────────────────────────────────────
  blocks.push(B.heading(2, '第十一章 用户与权限'));
  blocks.push(B.table(['节点', '用户总数', 'host=% 数', 'root@%'],
    facts.nodes.map(n => {
      const users = n.users || [];
      const wildcard = users.filter(u => u.host === '%');
      const rootWildcard = users.some(u => u.user === 'root' && u.host === '%');
      return [n.label || n.ip, users.length, wildcard.length, rootWildcard ? '存在' : '无'];
    })));
  blocks.push(B.heading(3, 'host=% 用户清单'));
  const wildcardRows = [];
  for (const n of facts.nodes) {
    for (const u of (n.users || [])) {
      if (u.host === '%') wildcardRows.push([n.label || n.ip, u.user ?? '-', u.host ?? '-']);
    }
  }
  blocks.push(B.table(['节点', '用户', 'host'], wildcardRows));
  blocks.push(B.heading(3, '安全评估汇总'));
  const sec = facts.securityAssessment;
  if (sec) {
    blocks.push(B.table(['检查项', '状态', '说明'],
      (sec.items || []).map(it => [it.label ?? it.id ?? '-', it.status ?? '-', it.detail ?? '-'])));
    blocks.push(B.paragraph(`通过 ${sec.pass ?? '-'} / 失败 ${sec.fail ?? '-'} / 告警 ${sec.warn ?? '-'} / 未知 ${sec.unknown ?? '-'}，合规等级：${sec.complianceLevel ?? '-'}`));
  }
  blocks.push(B.callout((sec?.fail || 0) > 0 ? 'crit' : 'info',
    `本章小结：展示用户清单、host=% 危险用户及安全合规评估；${(sec?.fail || 0) > 0 ? `存在 ${sec.fail} 项安全检查未通过，详见第十六章行动计划。` : '安全检查未发现严重问题。'}`));

  // ── 第十二章 主从复制 ────────────────────────────────────────
  blocks.push(B.heading(2, '第十二章 主从复制'));
  blocks.push(B.table(['节点', '角色', 'Master_Host', 'Slave_IO', 'Slave_SQL', '延迟(秒)', 'Master_Server_Id'],
    facts.nodes.map(n => {
      const r = n.replication || {};
      const s = r.status || {};
      return [
        n.label || n.ip, n.role ?? '-', s.masterHost ?? '-', s.slaveIoRunning ?? '-',
        s.slaveSqlRunning ?? '-', s.secondsBehindMaster ?? '-', s.masterServerId ?? '-',
      ];
    })));
  blocks.push(B.heading(3, '并行复制配置'));
  blocks.push(B.table(['节点', 'slave_parallel_workers', 'slave_parallel_type'],
    facts.nodes.map(n => [n.label || n.ip, n.variables?.slave_parallel_workers ?? '-', n.variables?.slave_parallel_type ?? '-'])));
  const replIssues = facts.nodes.filter(n => {
    const s = n.replication?.status || {};
    return n.replication?.isSlave && (s.slaveIoRunning !== 'Yes' || s.slaveSqlRunning !== 'Yes');
  });
  const replDelayHigh = facts.nodes.filter(n => Number(n.replication?.status?.secondsBehindMaster) > 300);
  blocks.push(B.callout(replIssues.length || replDelayHigh.length ? 'crit' : 'info',
    `本章小结：展示各节点复制状态及并行复制配置；${replIssues.length ? `${replIssues.map(n => n.label || n.ip).join('、')} 复制线程未正常运行（P0）。` : ''}${replDelayHigh.length ? `${replDelayHigh.map(n => n.label || n.ip).join('、')} 延迟超过 300 秒。` : ''}${(!replIssues.length && !replDelayHigh.length) ? '复制状态正常。' : ''}`));

  // ── 第十三章 Schema 审计 ─────────────────────────────────────
  blocks.push(B.heading(2, '第十三章 Schema 审计'));
  blocks.push(B.heading(3, '字符集'));
  blocks.push(B.table(['节点', 'character_set_server', '是否 utf8mb4'],
    facts.nodes.map(n => [n.label || n.ip, formatCharsetServer(n), n.charsetNotUtf8mb4 ? '否' : '是'])));
  blocks.push(B.heading(3, '无主键表'));
  const noPkRows = [];
  for (const n of facts.nodes) for (const t of (n.noPkTables || [])) noPkRows.push([n.label || n.ip, t.schema ?? '-', t.table ?? '-']);
  blocks.push(B.table(['节点', '库名', '表名'], noPkRows));
  blocks.push(B.heading(3, '非 utf8 表'));
  const nonUtf8Rows = [];
  for (const n of facts.nodes) for (const t of (n.nonUtf8Tables || [])) nonUtf8Rows.push([n.label || n.ip, t.schema ?? '-', t.table ?? '-', t.collation ?? '-']);
  blocks.push(B.table(['节点', '库名', '表名', 'collation'], nonUtf8Rows));
  blocks.push(B.heading(3, '高碎片表'));
  const fragRows = [];
  for (const n of facts.nodes) for (const t of (n.fragTables || [])) fragRows.push([n.label || n.ip, t.schema ?? '-', t.table ?? '-', t.fragRate ?? '-']);
  blocks.push(B.table(['节点', '库名', '表名', '碎片率'], fragRows));
  blocks.push(B.heading(3, '存储过程/函数/触发器'));
  blocks.push(B.table(['节点', '存储过程', '存储函数', '触发器'],
    facts.nodes.map(n => {
      const r = n.routines || [];
      return [n.label || n.ip, r.filter(x => x.type === 'PROCEDURE').length, r.filter(x => x.type === 'FUNCTION').length, r.filter(x => x.type === 'TRIGGER').length];
    })));
  blocks.push(B.heading(3, '自增主键使用率'));
  const aiRows = [];
  for (const n of facts.nodes) for (const t of (n.autoIncrementUsage || [])) aiRows.push([n.label || n.ip, t.schema ?? '-', t.table ?? '-', t.column ?? '-', t.currentValue ?? '-', t.usagePct ?? '-']);
  blocks.push(B.table(['节点', '库名', '表名', '列名', '当前值', '使用率'], aiRows));
  blocks.push(B.heading(3, '大字段（BLOB/TEXT）分布'));
  const blobRows = [];
  for (const n of facts.nodes) for (const c of (n.blobColumns || [])) blobRows.push([n.label || n.ip, `${c.schema ?? '-'}.${c.table ?? '-'}`, c.column ?? '-', c.type ?? '-']);
  blocks.push(B.table(['节点', '表', '字段名', '类型'], blobRows));
  blocks.push(B.callout((noPkRows.length || nonUtf8Rows.length || fragRows.length) ? 'warn' : 'info',
    `本章小结：展示字符集、无主键表、非 utf8 表、高碎片表、存储过程/函数/触发器及大字段分布；` +
    `无主键表 ${noPkRows.length} 张、非 utf8 表 ${nonUtf8Rows.length} 张、高碎片表 ${fragRows.length} 张。`));

  // ── 第十四章 SQL 治理 ────────────────────────────────────────
  blocks.push(B.heading(2, '第十四章 SQL 治理'));
  blocks.push(B.table(['节点', 'Slow_queries', 'Questions', 'long_query_time'],
    facts.nodes.map(n => [n.label || n.ip, n.slowQueries ?? '-', n.questions ?? '-', n.variables?.long_query_time ?? '-'])));
  for (const n of facts.nodes) {
    if (!(n.topSqlByAvg || []).length) continue;
    blocks.push(B.heading(3, `${n.label || n.ip} · TOP SQL（按 avg_latency）`));
    blocks.push(B.table(['DB', '摘要', '调用次数', 'avg_latency', 'total_latency'],
      n.topSqlByAvg.slice(0, 10).map(s => [s.db ?? '-', s.query ?? '-', s.execCount ?? '-', s.avgLatency ?? '-', s.totalLatency ?? '-'])));
  }
  for (const n of facts.nodes) {
    if (!(n.topSqlByLatency || []).length) continue;
    blocks.push(B.heading(3, `${n.label || n.ip} · TOP SQL（按 total_latency）`));
    blocks.push(B.table(['DB', '摘要', '调用次数', 'total_latency', 'rows_examined'],
      n.topSqlByLatency.slice(0, 10).map(s => [s.db ?? '-', s.query ?? '-', s.execCount ?? '-', s.totalLatency ?? '-', s.rowsExamined ?? '-'])));
  }
  for (const n of facts.nodes) {
    if (!(n.sqlWithTmp || []).length) continue;
    blocks.push(B.heading(3, `${n.label || n.ip} · 临时表 SQL TOP`));
    blocks.push(B.table(['DB', '摘要', '调用次数', '磁盘临时表', '磁盘占比'],
      n.sqlWithTmp.slice(0, 10).map(s => [s.db ?? '-', s.query ?? '-', s.execCount ?? '-', s.diskTmp ?? '-', s.diskPct ? `${s.diskPct}%` : '-'])));
  }
  blocks.push(B.callout('info', '本章小结：展示慢查询统计、TOP SQL（按平均/累计延迟）及临时表 SQL TOP；优化建议详见第十六章行动计划。'));

  // ── 第十五章 备份评估 ────────────────────────────────────────
  blocks.push(B.heading(2, '第十五章 备份评估'));
  const ba = facts.backupAssessment || {};
  blocks.push(B.table(['工具', '是否安装', '详情'],
    (ba.tools || []).map(t => [t.tool ?? '-', t.installed ? '是' : '否', t.detail ?? '-'])));
  blocks.push(B.heading(3, '备份产物'));
  const backupArtifactRows = [];
  for (const d of (ba.dirs || [])) {
    if (!d.exists) continue;
    for (const f of (d.files || [])) backupArtifactRows.push([d.ip ?? '-', f.path ?? '-', f.bytes ?? '-', f.mtime ?? '-']);
  }
  blocks.push(B.table(['节点', '路径', '大小(字节)', '最近修改'], backupArtifactRows));
  if (ba.assessment) {
    blocks.push(B.callout(ba.severity === 'P0' ? 'crit' : 'warn', `备份能力评估：${ba.assessment}`));
  }
  blocks.push(B.callout('info', `本章小结：展示备份工具检测、备份产物发现及备份能力评估；${ba.assessment ? `当前评估：${ba.assessment}` : '维持现状。'}`));

  // ── 第十六章 行动计划 ────────────────────────────────────────
  blocks.push(B.heading(2, '第十六章 行动计划'));
  const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
  const sorted = [...facts.issues].sort((a, b) =>
    (order[a.priority] ?? 9) - (order[b.priority] ?? 9) || (a.seq || 0) - (b.seq || 0));
  for (const pr of ['P0', 'P1', 'P2', 'P3']) {
    const group = sorted.filter(i => i.priority === pr);
    if (!group.length) continue;
    const kind = pr === 'P0' ? 'crit' : pr === 'P1' ? 'warn' : 'info';
    blocks.push(B.heading(3, `${pr} 优先级（${group.length} 项）`));
    group.forEach((i) => {
      blocks.push(B.callout(kind, `[${pr}] ${i.node ? i.node + '：' : ''}${i.description || ''}`));
      if (i.currentValue && i.recommendedValue) {
        blocks.push(B.paragraph(`✦ 当前值：${i.currentValue}　→　推荐值：${i.recommendedValue}`));
      }
      if (i.action) blocks.push(B.paragraph(`处置：${i.action}`));
      if (i.sql) blocks.push(B.codeblock('sql', i.sql));
    });
  }

  // ── 第十七章 结论 ────────────────────────────────────────────
  blocks.push(B.heading(2, '第十七章 结论'));
  const radarDims = Object.entries(hs.dimensions || {}).map(([k, v]) => ({ label: k, value: v, max: 100 }));
  blocks.push(B.chart(charts.radar(radarDims), '六维健康度雷达'));
  if (facts.recommendations) {
    const rec = facts.recommendations;
    const toItems = arr => (arr || []).map(r => typeof r === 'string' ? r : (r.text || r.action || JSON.stringify(r)));
    if ((rec.immediate || []).length) {
      blocks.push(B.heading(3, '立即处理'));
      blocks.push(B.list(toItems(rec.immediate)));
    }
    if ((rec.shortTerm || []).length) {
      blocks.push(B.heading(3, '近期处理'));
      blocks.push(B.list(toItems(rec.shortTerm)));
    }
    if ((rec.midTerm || []).length) {
      blocks.push(B.heading(3, '中长期优化'));
      blocks.push(B.list(toItems(rec.midTerm)));
    }
    if ((rec.longTerm || []).length) {
      blocks.push(B.heading(3, '长期演进'));
      blocks.push(B.list(toItems(rec.longTerm)));
    }
    if (Array.isArray(rec)) {
      blocks.push(B.list(toItems(rec)));
    }
  }
  const verdict = hs.total >= 90 ? '良好' : hs.total >= 70 ? '关注' : '关键';
  blocks.push(B.paragraph(`综合健康度 ${hs.total}/100，结论：${verdict}。${facts.overallAssessment ? String(facts.overallAssessment) : ''}`));

  return { title, blocks };
}

function renderReport(facts) {
  const { title, blocks } = buildReportBlocks(facts);
  return { title, markdown: toMarkdown(blocks), html: toHtml(blocks, { title }) };
}

module.exports = { B, toMarkdown, toHtml, buildReportBlocks, renderReport };

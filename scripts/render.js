#!/usr/bin/env node
/**
 * MySQL 巡检报告渲染器
 *
 * 用法：
 *   node render.js <data.json> [--out output.docx]
 *
 * 输入：extract.js 生成的 data.json
 * 输出：标准化的 .docx 报告
 */

'use strict';

const fs = require('fs');
const path = require('path');

// 自动定位 docx 模块
// docx 8.x 的 package.json:main 指向 UMD bundle，对 CommonJS require 不友好；
// 优先尝试 build/index.cjs / dist/index.cjs，回落到 main。
function loadDocx() {
  const roots = [
    path.join(__dirname, 'node_modules', 'docx'),
    path.join('/tmp', 'node_modules', 'docx'),
  ];
  const subpaths = ['build/index.cjs', 'dist/index.cjs', 'build/index.mjs', ''];
  for (const root of roots) {
    for (const sub of subpaths) {
      try {
        const m = require(sub ? path.join(root, sub) : root);
        if (m && typeof m.Document === 'function') return m;
      } catch (_) {}
    }
  }
  // 最后试系统 require
  try { const m = require('docx'); if (typeof m.Document === 'function') return m; } catch (_) {}
  console.error('错误：未找到可用的 docx 依赖。请先执行：cd ' + __dirname + ' && npm install');
  process.exit(1);
}

const {
  Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun,
  HeadingLevel, AlignmentType, WidthType, BorderStyle, ShadingType,
  TableLayoutType, Header, Footer, PageNumber, PageBreak, ImageRun,
} = loadDocx();

// ============== CLI 参数 ==============
const args = process.argv.slice(2);
if (!args[0] || args[0].startsWith('--')) {
  console.error('用法: node render.js <data.json> [--out output.docx]');
  process.exit(1);
}
const dataPath = path.resolve(args[0]);
let outPath = null;
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--out') outPath = args[++i];
}

const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
if (!outPath) {
  // 默认放在 data.json 同目录，文件名按项目命名
  const safeName = (data.project || 'report').replace(/[^\w一-鿿-]+/g, '_');
  outPath = path.join(
    path.dirname(dataPath),
    `${safeName}_MySQL数据库巡检报告_详细版_v3.1.docx`,
  );
}

// ============== 视觉常量 ==============
const COLOR = {
  primary: '1F4E79',
  secondary: '2E75B6',
  tertiary: '2F5496',
  text: '404040',
  muted: '666666',
  light: '888888',
  rule: '2E75B6',
  borderLite: 'CCCCCC',
  shadeRow: 'EAF3FB',
  shadeTitle: '1F4E79',
  shadeHead: '2E75B6',
  codeBg: 'EBF5FB',
  codeFg: '1A5276',
  p0: 'FFCCCC',
  p1: 'FFE4B5',
  p2: 'FFFACD',
  p3: 'FFFFFF',
};
const FONT = 'Microsoft YaHei';
// A4 (11907) - 左 1800 - 右 1440 = 8667 内容宽，留 30 DXA 余量
const TABLE_WIDTH = 8640;

// ============== 基础样式工具 ==============
const h1 = t => new Paragraph({ text: t, heading: HeadingLevel.HEADING_1, spacing: { before: 300, after: 120 } });
const h2 = t => new Paragraph({ text: t, heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 80 } });
const h3 = t => new Paragraph({ text: t, heading: HeadingLevel.HEADING_3, spacing: { before: 160, after: 60 } });

function para(text, opts = {}) {
  const runs = Array.isArray(text) ? text : [{ text }];
  return new Paragraph({
    children: runs.map(r => new TextRun({
      text: String(r.text == null ? '' : r.text),
      size: 22, font: FONT, ...r,
    })),
    spacing: { before: 60, after: 60 },
    ...opts.paraOpts,
  });
}

function bullet(text, level = 0) {
  return new Paragraph({
    children: [new TextRun({ text, size: 22, font: FONT })],
    bullet: { level },
    spacing: { before: 40, after: 40 },
  });
}

function emptyLine() {
  return new Paragraph({ text: '', spacing: { before: 60, after: 60 } });
}

function code(text) {
  return new Paragraph({
    children: [new TextRun({ text, font: 'Courier New', size: 20, color: COLOR.codeFg })],
    shading: { fill: COLOR.codeBg, type: ShadingType.CLEAR, color: 'auto' },
    indent: { left: 360 },
    spacing: { before: 60, after: 60 },
  });
}

// 列宽分配：默认等分；可按 headers 关键字给"重内容列"更多权重
function deriveColumnWidths(headers) {
  // 权重：1 = 普通，2 = 描述类（占两份），0.6 = 极窄类（序号/状态）
  const weights = headers.map(h => {
    const k = String(h || '').toLowerCase();
    if (/序号|seq|^#$/.test(k)) return 0.5;
    if (/状态|status|level/.test(k)) return 0.7;
    if (/优先级|priority|级别/.test(k)) return 0.7;
    if (/问题描述|description|建议措施|action|措施|事务详情|配置/.test(k)) return 2.2;
    if (/sql|info|error|内容|说明|备注|表名|table[_ ]?name|os|model|cpu型号/.test(k)) return 1.8;
    if (/^节点$|ip$|节点 ip|主机名|hostname/.test(k)) return 1.1;
    return 1;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map(w => Math.floor(TABLE_WIDTH * w / total));
}

function tableTitle(text, cols) {
  return new TableRow({
    children: [new TableCell({
      children: [new Paragraph({
        children: [new TextRun({ text, bold: true, color: 'FFFFFF', size: 22, font: FONT })],
        alignment: AlignmentType.CENTER,
      })],
      columnSpan: cols,
      width: { size: TABLE_WIDTH, type: WidthType.DXA },
      shading: { fill: COLOR.shadeTitle, type: ShadingType.CLEAR, color: 'auto' },
    })],
  });
}

function headerRow(cells, widths) {
  return new TableRow({
    tableHeader: true,
    children: cells.map((c, i) => new TableCell({
      children: [new Paragraph({
        children: [new TextRun({ text: String(c), bold: true, color: 'FFFFFF', size: 20, font: FONT })],
        alignment: AlignmentType.CENTER,
      })],
      width: { size: widths[i], type: WidthType.DXA },
      shading: { fill: COLOR.shadeHead, type: ShadingType.CLEAR, color: 'auto' },
    })),
  });
}

function dataRow(cells, shade, headers, widths) {
  return new TableRow({
    children: cells.map((c, i) => {
      const hkey = String(headers[i] || '').toLowerCase();
      let align = AlignmentType.CENTER;
      if (/表名|table[_ ]?name|sql|info|建议|action|描述|description|error|措施|配置|os|内容|备注|说明|cpu型号|事务详情|配置项/.test(hkey)) {
        align = AlignmentType.LEFT;
      }
      const text = c == null || c === '' ? '-' : String(c);
      return new TableCell({
        children: [new Paragraph({
          children: [new TextRun({ text, size: 20, font: FONT })],
          alignment: align,
        })],
        width: { size: widths[i], type: WidthType.DXA },
        shading: shade
          ? { fill: COLOR.shadeRow, type: ShadingType.CLEAR, color: 'auto' }
          : undefined,
      });
    }),
  });
}

function priorityRow(cells, priority, widths) {
  const map = { P0: COLOR.p0, P1: COLOR.p1, P2: COLOR.p2, P3: COLOR.p3 };
  const bg = map[priority] || COLOR.p3;
  return new TableRow({
    children: cells.map((c, i) => new TableCell({
      children: [new Paragraph({
        children: [new TextRun({ text: c == null ? '-' : String(c), size: 20, font: FONT })],
        alignment: i <= 1 ? AlignmentType.CENTER : AlignmentType.LEFT,
      })],
      width: { size: widths[i], type: WidthType.DXA },
      shading: { fill: bg, type: ShadingType.CLEAR, color: 'auto' },
    })),
  });
}

function emptyRowSpan(cols, text, widths) {
  return new TableRow({
    children: [new TableCell({
      children: [new Paragraph({
        children: [new TextRun({ text, italics: true, size: 20, color: COLOR.muted, font: FONT })],
        alignment: AlignmentType.CENTER,
      })],
      columnSpan: cols,
      width: { size: TABLE_WIDTH, type: WidthType.DXA },
    })],
  });
}

function makeTable(headers, rows, title) {
  const widths = deriveColumnWidths(headers);
  const trs = [];
  if (title) trs.push(tableTitle(title, headers.length));
  trs.push(headerRow(headers, widths));
  if (!rows || rows.length === 0) {
    trs.push(emptyRowSpan(headers.length, '（本次巡检未采集到对应数据）', widths));
  } else {
    rows.forEach((r, idx) => trs.push(dataRow(r, idx % 2 === 1, headers, widths)));
  }
  return new Table({
    rows: trs,
    width: { size: TABLE_WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
  });
}

function makePriorityTable(headers, issues, title) {
  const widths = deriveColumnWidths(headers);
  const trs = [];
  if (title) trs.push(tableTitle(title, headers.length));
  trs.push(headerRow(headers, widths));
  if (!issues || issues.length === 0) {
    trs.push(emptyRowSpan(headers.length, '本次巡检未发现需上报的问题', widths));
  } else {
    for (const i of issues) {
      trs.push(priorityRow(
        [i.seq, `${i.priority} ${priorityLabel(i.priority)}`, i.description, i.node, i.action, i.status],
        i.priority,
        widths,
      ));
    }
  }
  return new Table({
    rows: trs,
    width: { size: TABLE_WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
  });
}

function priorityLabel(p) {
  return { P0: '紧急', P1: '重要', P2: '建议', P3: '观察' }[p] || '';
}

function noteParagraph(text) {
  return new Paragraph({
    children: [new TextRun({ text: '说明：' + text, italics: true, size: 20, color: COLOR.muted, font: FONT })],
    spacing: { before: 40, after: 40 },
  });
}

// ============== 章节构造器 ==============
function chapterCover(data) {
  const dateText = formatChineseDate(data.inspectionDate);
  const reportText = formatChineseDate(data.reportDate);
  return [
    emptyLine(), emptyLine(), emptyLine(),
    new Paragraph({
      children: [new TextRun({ text: data.project, size: 52, bold: true, color: COLOR.primary, font: FONT })],
      alignment: AlignmentType.CENTER,
      spacing: { before: 200, after: 100 },
    }),
    new Paragraph({
      children: [new TextRun({ text: 'MySQL 数据库巡检报告（详细版）', size: 52, bold: true, color: COLOR.primary, font: FONT })],
      alignment: AlignmentType.CENTER,
      spacing: { before: 100, after: 400 },
    }),
    new Paragraph({
      children: [new TextRun({ text: `巡检日期：${dateText}`, size: 28, color: COLOR.text, font: FONT })],
      alignment: AlignmentType.CENTER,
      spacing: { before: 100, after: 80 },
    }),
    new Paragraph({
      children: [new TextRun({ text: `报告日期：${reportText}`, size: 28, color: COLOR.text, font: FONT })],
      alignment: AlignmentType.CENTER,
      spacing: { before: 80, after: 80 },
    }),
    new Paragraph({
      children: [new TextRun({ text: `集群拓扑：${data.cluster.topology}（${data.cluster.nodeCount} 节点）`, size: 28, color: COLOR.text, font: FONT })],
      alignment: AlignmentType.CENTER,
      spacing: { before: 80, after: 80 },
    }),
    new Paragraph({
      children: [new TextRun({ text: '版本：v3.1', size: 28, color: COLOR.text, font: FONT })],
      alignment: AlignmentType.CENTER,
      spacing: { before: 80, after: 400 },
    }),
    emptyLine(), emptyLine(),
    new Paragraph({
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: COLOR.rule } },
      spacing: { before: 100, after: 200 },
    }),
    new Paragraph({ children: [new PageBreak()], spacing: { before: 0, after: 0 } }),
  ];
}

function chapterSummary(data) {
  const p0 = data.issues.filter(i => i.priority === 'P0').length;
  const p1 = data.issues.filter(i => i.priority === 'P1').length;
  const p2 = data.issues.filter(i => i.priority === 'P2').length;
  const p3 = data.issues.filter(i => i.priority === 'P3').length;

  const clusterIssues = data.issues.filter(i => i.node === '全部节点' || /\d\/\d+\s+节点/.test(i.node));
  const nodeIssues = data.issues.filter(i => !clusterIssues.includes(i));

  const out = [
    h1('一、巡检摘要'),
    para(`本次对【${data.project}】生产环境 MySQL 集群（${data.cluster.topology}）进行月度巡检，采集日期 ${formatChineseDate(data.inspectionDate)}，覆盖 ${data.cluster.nodeCount} 个节点（${data.cluster.ips.join('、')}）。`),
    para(`整体评估：${data.overallAssessment}。`),
    para([
      { text: '问题分布：', bold: true },
      { text: `P0 紧急 ${p0} 项 / P1 重要 ${p1} 项 / P2 建议 ${p2} 项 / P3 观察 ${p3} 项。` },
    ]),
    para([
      { text: '问题分类：', bold: true },
      { text: `集群级问题 ${clusterIssues.length} 项（一次修复影响全部节点），节点级问题 ${nodeIssues.length} 项。` },
    ]),
    emptyLine(),
  ];

  // 1.1 集群级问题（一次修复影响所有节点）
  if (clusterIssues.length > 0) {
    out.push(h2('1.1 集群级问题'));
    out.push(para('以下问题影响多个节点，建议作为一项任务统一处理：'));
    out.push(emptyLine());
    out.push(makePriorityTable(
      ['序号', '级别', '问题描述', '影响范围', '建议措施', '状态'],
      clusterIssues.map((i, idx) => ({ ...i, seq: idx + 1 })),
      '集群级问题',
    ));
    out.push(emptyLine());
  }

  // 1.2 节点级问题
  if (nodeIssues.length > 0) {
    out.push(h2(clusterIssues.length > 0 ? '1.2 节点级问题' : '1.1 问题汇总'));
    out.push(para('以下问题仅影响特定节点：'));
    out.push(emptyLine());
    out.push(makePriorityTable(
      ['序号', '级别', '问题描述', '节点', '建议措施', '状态'],
      nodeIssues.map((i, idx) => ({ ...i, seq: idx + 1 })),
      '节点级问题',
    ));
    out.push(emptyLine());
  }

  // 1.3 根因关联分析
  if ((data.correlations || []).length > 0) {
    out.push(h2(clusterIssues.length > 0 ? '1.3 根因关联分析' : '1.2 根因关联分析'));
    out.push(para('巡检过程中识别到以下问题间存在因果或相关关系，处理时建议关联考虑：'));
    out.push(emptyLine());
    data.correlations.forEach((c, idx) => {
      out.push(para([{ text: `[关联 ${idx + 1}] `, bold: true, color: COLOR.secondary }, { text: c.title, bold: true }]));
      out.push(para([{ text: '现象：', bold: true, color: COLOR.muted }, { text: c.detail }]));
      out.push(para([{ text: '建议：', bold: true, color: '548235' }, { text: c.suggestion, color: '548235' }]));
      out.push(emptyLine());
    });
  }

  out.push(para([
    { text: '说明：', bold: true, color: COLOR.muted },
    { text: 'P0=立即处理（影响可用性），P1=本周内处理，P2=本月内规划，P3=持续观察。', color: COLOR.muted },
  ]));

  return out;
}

function chapterServers(data) {
  const out = [h1('二、服务器与拓扑概况'), h2('2.1 集群拓扑')];
  out.push(para(`本集群采用「${data.cluster.topology}」结构，节点角色及基础配置如下：`));
  out.push(emptyLine());

  out.push(makeTable(
    ['节点 IP', '主机名', '角色', 'MySQL 版本', 'server_id', 'Uptime'],
    data.nodes.map(n => [
      n.ip, n.hostname || '-',
      roleLabel(n.role),
      n.mysqlVersion || '-',
      n.variables?.server_id || '-',
      n.uptimeText || '-',
    ]),
    '集群节点信息',
  ));
  out.push(emptyLine());

  out.push(h2('2.2 操作系统与硬件'));
  out.push(makeTable(
    ['节点 IP', 'OS 内核', 'CPU 型号', '核心数', '内存总量', '内存使用率'],
    data.nodes.map(n => [
      n.ip,
      truncate(n.osKernel, 50),
      truncate(n.cpuModel, 40),
      n.cpuCores != null ? `${n.cpuCores} 核` : '-',
      n.memTotal || '-',
      n.memUsagePct ? `${n.memUsagePct}%` : '-',
    ]),
    'OS / 硬件配置',
  ));
  out.push(emptyLine());

  out.push(h2('2.3 内存与 Swap'));
  out.push(makeTable(
    ['节点 IP', '内存总量', '内存空闲', '内存已用', 'Swap 总量', 'Swap 空闲'],
    data.nodes.map(n => [
      n.ip, n.memTotal || '-', n.memFree || '-', n.memUsed || '-',
      n.swapTotal || '-', n.swapFree || '-',
    ]),
    '内存使用概况',
  ));
  out.push(emptyLine());
  out.push(noteParagraph('数据库节点建议禁用 Swap 或将 vm.swappiness 调至 1，避免性能抖动。'));
  out.push(emptyLine());

  out.push(h2('2.4 磁盘使用'));
  const diskRows = [];
  for (const n of data.nodes) {
    (n.disks || []).forEach((d, idx) => {
      diskRows.push([
        idx === 0 ? n.ip : '',
        d.mount, d.total, d.used, d.avail, d.usePct,
        diskHealthLabel(d.usePct),
      ]);
    });
  }
  out.push(makeTable(
    ['节点 IP', '挂载点', '总容量', '已用', '可用', '使用率', '状态'],
    diskRows,
    '磁盘挂载与使用',
  ));
  return out;
}

function chapterConnections(data) {
  const out = [h1('三、连接与会话分析'), h2('3.1 连接配置与现状')];
  out.push(para('各节点连接配置参数与当前使用情况：'));
  out.push(emptyLine());
  out.push(makeTable(
    ['节点 IP', '角色', 'max_connections', 'wait_timeout (s)', 'interactive_timeout (s)', '当前线程数 (Threads)'],
    data.nodes.map(n => [
      n.ip, roleLabel(n.role),
      n.variables?.max_connections || '-',
      n.variables?.wait_timeout || '-',
      n.variables?.interactive_timeout || '-',
      n.threadsConnected != null ? n.threadsConnected : '-',
    ]),
    '连接配置',
  ));
  out.push(emptyLine());

  out.push(h2('3.2 当前 Processlist 分布'));
  out.push(para('基于 SHOW PROCESSLIST 采集时刻的会话命令分布：'));
  out.push(emptyLine());
  out.push(makeTable(
    ['节点 IP', '总会话', 'Sleep', 'Query', 'Connect', 'Binlog Dump', '其他'],
    data.nodes.map(n => {
      const pl = n.processlist || [];
      const count = (cmd) => pl.filter(p => (p.command || '').toLowerCase() === cmd).length;
      const sleep = count('sleep');
      const query = count('query');
      const conn = count('connect');
      const binlogDump = pl.filter(p => /binlog/i.test(p.command || '')).length;
      const other = pl.length - sleep - query - conn - binlogDump;
      return [n.ip, pl.length, sleep, query, conn, binlogDump, other];
    }),
    'Processlist 命令分布',
  ));
  out.push(emptyLine());

  out.push(h2('3.3 长时间运行的会话 (TIME ≥ 60s)'));
  out.push(para('已过滤：Sleep / Binlog Dump / 从库复制线程（system user）：'));
  out.push(emptyLine());
  const longRows = [];
  const isSlaveThread = (p) => {
    if (p.user === 'system user') return true;
    const st = p.state || '';
    return /Waiting for master|Queueing master event|Slave has read all|Reading event from the relay log|Has read all relay log/i.test(st);
  };
  for (const n of data.nodes) {
    for (const p of (n.processlist || [])) {
      const t = Number(p.time);
      const cmd = (p.command || '').toLowerCase();
      if (t < 60) continue;
      if (cmd === 'sleep') continue;
      if (/binlog/i.test(p.command || '')) continue;
      if (isSlaveThread(p)) continue;
      longRows.push([n.ip, p.id, p.user, p.db || '-', p.command, `${t} s`, truncate(p.state, 30)]);
      if (longRows.length >= 30) break;
    }
  }
  out.push(makeTable(
    ['节点 IP', 'ID', '用户', '库', '命令', '运行时长', '状态'],
    longRows,
    '长会话明细',
  ));
  if (longRows.length === 0) {
    out.push(noteParagraph('采集时刻未发现需关注的长会话。'));
  }
  return out;
}

function chapterDatabases(data) {
  const out = [h1('四、数据库清单')];
  const primary = data.nodes.find(n => n.role === 'primary') || data.nodes[0];
  out.push(para(`当前实例的所有数据库（取自主库 ${primary.ip}）：`));
  out.push(emptyLine());
  const dbRows = (primary.databases || []).map(db => [
    primary.ip, db.name, db.charset, db.collation, '业务库',
  ]);
  out.push(makeTable(
    ['节点 IP', '数据库名', '默认字符集', '默认排序规则', '说明'],
    dbRows,
    `业务数据库清单（${primary.ip}）`,
  ));
  out.push(emptyLine());

  // 跨节点库差异
  if (data.nodes.length > 1) {
    const primaryDbs = new Set((primary.databases || []).map(d => d.name));
    const diffs = [];
    for (const n of data.nodes) {
      if (n.ip === primary.ip) continue;
      const slaveDbs = new Set((n.databases || []).map(d => d.name));
      const extra = [...slaveDbs].filter(x => !primaryDbs.has(x));
      const missing = [...primaryDbs].filter(x => !slaveDbs.has(x));
      if (extra.length > 0 || missing.length > 0) {
        diffs.push(`${n.ip}（${roleLabel(n.role)}）：${extra.length>0?`多出 ${extra.join('、')}`:''}${missing.length>0?` 缺失 ${missing.join('、')}`:''}`);
      }
    }
    if (diffs.length > 0) {
      out.push(para([{ text: '⚠️ 库差异：', bold: true, color: 'C00000' }]));
      diffs.forEach(d => out.push(bullet(d)));
      out.push(emptyLine());
    }
  }

  out.push(noteParagraph('建议所有业务库统一使用 utf8mb4 字符集，以支持 emoji 与 4 字节字符。'));
  return out;
}

function chapterParams(data) {
  const out = [h1('五、关键配置参数对比'), h2('5.1 核心参数')];
  out.push(para('全节点关键参数对比（巡检时实际值）：'));
  out.push(emptyLine());

  const keys = [
    ['MySQL 版本', 'mysqlVersion', '主从一致'],
    ['server_id', 'server_id', '各节点唯一'],
    ['innodb_buffer_pool_size (MB)', 'innodb_buffer_pool_size_in_mb', '建议为内存的 50-70%'],
    ['innodb_buffer_pool_instances', 'innodb_buffer_pool_instances', '建议 ≥8'],
    ['innodb_log_file_size (MB)', 'innodb_log_file_size_in_mb', '建议 ≥512MB'],
    ['innodb_flush_log_at_trx_commit', 'innodb_flush_log_at_trx_commit', '主库建议 1'],
    ['sync_binlog', 'sync_binlog', '主库建议 1'],
    ['max_connections', 'max_connections', '按业务并发设定'],
    ['binlog_format', 'binlog_format', '建议 ROW'],
    ['gtid_mode', 'gtid_mode', '建议 ON'],
    ['enforce_gtid_consistency', 'enforce_gtid_consistency', '建议 ON'],
    ['read_only', 'read_only', '主 0 / 从 1'],
    ['expire_logs_days', 'expire_logs_days', '建议 7-15 天'],
    ['long_query_time', 'long_query_time', '建议 1s'],
    ['slow_query_log', 'slow_query_log', '建议 ON'],
    ['transaction_isolation', 'transaction_isolation', '建议 READ-COMMITTED'],
    ['innodb_flush_method', 'innodb_flush_method', '建议 O_DIRECT'],
    ['innodb_file_per_table', 'innodb_file_per_table', '建议 1'],
    ['open_files_limit', 'open_files_limit', '建议 ≥65535'],
    ['table_open_cache', 'table_open_cache', '建议 4000-8000'],
    ['default_storage_engine', 'default_storage_engine', 'InnoDB'],
  ];

  const headers = ['参数名称', ...data.nodes.map(n => `${n.ip}\n${roleLabel(n.role)}`), '建议值/说明'];
  const rows = keys.map(([label, key, advice]) => {
    const cells = [label];
    for (const n of data.nodes) {
      let v;
      if (key === 'mysqlVersion') v = n.mysqlVersion || '-';
      else v = n.variables?.[key] || '-';
      cells.push(v);
    }
    cells.push(advice);
    return cells;
  });
  out.push(makeTable(headers, rows, '核心配置参数对比'));
  out.push(emptyLine());

  // 配置差异（带 ✅/❌ 自动判断）
  out.push(h2('5.2 参数差异分析'));
  const judgments = data.paramJudgments || [];
  if (judgments.length > 0) {
    out.push(para('各节点间检测到以下参数差异，已自动标注是否需要统一：'));
    out.push(emptyLine());
    const jRows = judgments.map(j => [
      j.key,
      j.unique.join(' / '),
      j.ok ? '✅ 正常' : '❌ 需关注',
      j.reason,
    ]);
    out.push(makeTable(
      ['参数', '不同取值', '判断', '说明'],
      jRows,
      '参数差异判断',
    ));
    out.push(emptyLine());
    const needFix = judgments.filter(j => !j.ok);
    if (needFix.length > 0) {
      out.push(para([{ text: `合计 ${needFix.length} 项需统一：`, bold: true }, { text: needFix.map(j => j.key).join('、') }]));
    }
  } else {
    out.push(para('各节点核心参数完全一致。'));
  }

  return out;
}

function chapterPerformance(data) {
  const out = [h1('六、性能指标分析'), h2('6.1 总体运行指标')];
  out.push(makeTable(
    ['节点 IP', '角色', 'Uptime', '累计查询数', 'QPS (平均)', '累计慢查询', '慢查询占比'],
    data.nodes.map(n => {
      const slowPct = (n.slowQueries && n.questions)
        ? (n.slowQueries / n.questions * 100).toFixed(4) + '%' : '-';
      return [
        n.ip, roleLabel(n.role),
        n.uptimeText || '-',
        n.questions != null ? n.questions.toLocaleString() : '-',
        n.qps != null ? n.qps.toLocaleString() : '-',
        n.slowQueries != null ? n.slowQueries.toLocaleString() : '-',
        slowPct,
      ];
    }),
    '性能指标',
  ));
  out.push(emptyLine());

  out.push(h2('6.2 Buffer Pool 状态'));
  out.push(makeTable(
    ['节点 IP', 'buffer_pool_size', 'Database pages', 'Free buffers', 'Modified pages', '命中率'],
    data.nodes.map(n => {
      const hit = n.innodb?.bufferPoolHitRate;
      const hitPct = hit
        ? ((parts => parts[0] / parts[1] * 100).bind(null,
            hit.split('/').map(s => Number(s.trim())))()) : null;
      return [
        n.ip,
        n.variables?.innodb_buffer_pool_size_in_mb ? n.variables.innodb_buffer_pool_size_in_mb + ' MB' : '-',
        n.innodb?.databasePages || '-',
        n.innodb?.freeBuffers || '-',
        n.innodb?.modifiedDbPages || '-',
        hit ? `${hit}（${hitPct.toFixed(1)}%）` : '-',
      ];
    }),
    'Buffer Pool 状态',
  ));
  out.push(emptyLine());
  out.push(noteParagraph('命中率公式：(1 - reads/read_requests) × 100%。生产环境建议保持 ≥99%；低于 95% 需评估扩大 innodb_buffer_pool_size。'));
  out.push(emptyLine());

  out.push(h2('6.3 慢查询配置'));
  out.push(makeTable(
    ['节点 IP', 'slow_query_log', 'long_query_time', 'slow_query_log_file', '累计慢查询'],
    data.nodes.map(n => [
      n.ip,
      n.variables?.slow_query_log || '-',
      n.variables?.long_query_time || '-',
      truncate(n.variables?.slow_query_log_file, 50),
      n.slowQueries != null ? n.slowQueries.toLocaleString() : '-',
    ]),
    '慢查询配置',
  ));
  out.push(emptyLine());
  out.push(para('慢查询治理建议：'));
  out.push(bullet('每周以 pt-query-digest 汇总慢日志，输出 TOP10 SQL'));
  out.push(bullet('优先处理全表扫描、缺失索引、占用 tmp disk 的 SQL'));
  out.push(bullet('对历史大表评估归档或分区'));
  return out;
}

function chapterStorage(data) {
  const out = [h1('七、存储空间分析'), h2('7.1 数据库容量汇总')];
  const refNode = data.nodes.find(n => n.role === 'primary') || data.nodes[0];
  const dbRows = (refNode.dbSizes || []).map(d => [
    refNode.ip, d.name, d.sizeGB + ' GB',
  ]);
  if (refNode.dbTotalSizeGB) {
    dbRows.push([refNode.ip, '合计', refNode.dbTotalSizeGB + ' GB']);
  }
  out.push(makeTable(
    ['节点 IP', '数据库', '容量 (GB)'],
    dbRows,
    `库级容量（取自主库 ${refNode.ip}）`,
  ));
  out.push(emptyLine());

  // TOP10 + 归档表识别
  out.push(h2('7.2 TOP 10 大表（按数据量）'));
  const ARCHIVE_RE = /_\d{8}$|_\d{6}$|_\d{4}_\d{2}$|_\d{4}-\d{2}/;
  const archives = (refNode.topTables || []).filter(t => ARCHIVE_RE.test(t.table));
  const topRows = (refNode.topTables || []).map(t => [
    t.schema, t.table, t.sizeGB + ' GB',
    Number(t.rows).toLocaleString(), t.engine,
    ARCHIVE_RE.test(t.table) ? '历史归档表' : '业务表',
  ]);
  out.push(makeTable(
    ['库名', '表名', '大小', '估算行数', '引擎', '类型'],
    topRows,
    'TOP 10 大表',
  ));
  if (archives.length > 0) {
    const totalGB = archives.reduce((s, t) => s + Number(t.sizeGB), 0);
    out.push(emptyLine());
    out.push(para([
      { text: `⚠️ TOP10 中识别到 ${archives.length} 张带日期后缀的历史归档表，合计约 ${totalGB.toFixed(1)} GB：`, bold: true, color: 'BF8F00' },
    ]));
    archives.forEach(t => out.push(bullet(`${t.schema}.${t.table}（${t.sizeGB} GB）`)));
    out.push(para('建议评估：导出冷存 + DROP，或改造为分区表按月自动滚动，可显著释放主库空间。'));
  }
  out.push(emptyLine());

  // 碎片表 — 过滤小表（碎片绝对值 < 100MB 的不展示）
  out.push(h2('7.3 高碎片表（碎片率 ≥70% 且碎片空间 ≥100MB）'));
  const SIG_FRAG_THRESHOLD = 100 * 1024 * 1024;
  const sigFrags = (refNode.fragTables || []).filter(t =>
    Number(t.fragRate) >= 0.7 && Number(t.dataFree) >= SIG_FRAG_THRESHOLD
  );
  const fragRows = sigFrags
    .sort((a, b) => Number(b.dataFree) - Number(a.dataFree))
    .map(t => [
      t.schema, t.table,
      Number(t.rows).toLocaleString(),
      formatBytesNum(t.dataLength),
      formatBytesNum(t.dataFree),
      (Number(t.fragRate) * 100).toFixed(1) + '%',
      Number(t.dataFree) >= 10 * 1073741824 ? '高优先级重建' : '建议重建',
    ]);
  out.push(makeTable(
    ['库名', '表名', '行数', '数据大小', '碎片空间', '碎片率', '建议'],
    fragRows,
    '显著高碎片表清单（已过滤 <100MB 小表噪声）',
  ));
  if (sigFrags.length === 0) {
    out.push(noteParagraph('未发现需关注的高碎片大表。'));
  } else {
    const totalFree = sigFrags.reduce((s, t) => s + Number(t.dataFree), 0);
    out.push(noteParagraph(`重建后可回收约 ${(totalFree / 1073741824).toFixed(1)} GB 空间。大表（≥10GB）推荐 pt-online-schema-change 在线重建，避免锁表。`));
  }
  out.push(emptyLine());

  out.push(h2('7.4 无主键表'));
  const noPkRows = (refNode.noPkTables || []).map(t => [
    t.schema, t.table,
    /^(tmp|temp|test|_)/i.test(t.table) ? '临时/测试' : '业务表',
    '补充自增主键或唯一索引',
  ]);
  out.push(makeTable(
    ['库名', '表名', '类型', '建议'],
    noPkRows,
    `无主键表清单（共 ${(refNode.noPkTables||[]).length} 张）`,
  ));
  out.push(emptyLine());
  out.push(noteParagraph('无主键表在 ROW 格式复制下从库需全表扫描匹配行，复制效率极低且无法 MTS 并行复制。表名含 tmp/temp/test/_ 前缀的可保留，正式业务表建议补充主键。'));
  out.push(emptyLine());

  out.push(h2('7.5 非 utf8 表'));
  const utf8Rows = (refNode.nonUtf8Tables || []).map(t => [
    t.schema, t.table, t.collation, '转换为 utf8mb4',
  ]);
  out.push(makeTable(
    ['库名', '表名', '当前排序规则', '建议'],
    utf8Rows,
    '非 utf8 表清单',
  ));
  return out;
}

function chapterIbtmp1(data) {
  const out = [h1('八、临时表空间（ibtmp1）分析'), h2('8.1 当前状态')];
  out.push(para('各节点 ibtmp1 配置与实际占用：'));
  out.push(emptyLine());
  out.push(makeTable(
    ['节点 IP', '角色', '当前占用', '初始大小', '自动扩展', '配置 (innodb_temp_data_file_path)'],
    data.nodes.map(n => [
      n.ip, roleLabel(n.role),
      n.ibtmp1?.sizeFormatted || '-',
      n.ibtmp1?.initialSize || '-',
      n.ibtmp1?.autoExtendSize || '-',
      n.variables?.innodb_temp_data_file_path || '-',
    ]),
    'ibtmp1 临时表空间使用',
  ));
  out.push(emptyLine());

  out.push(h2('8.2 原理与触发场景'));
  out.push(para('ibtmp1 存储 InnoDB 内部临时表数据，由以下场景触发增长：'));
  out.push(bullet('GROUP BY / ORDER BY 命中磁盘临时表（tmp_table_size 不足）'));
  out.push(bullet('复杂 JOIN / 子查询导致 filesort 落盘'));
  out.push(bullet('长事务未提交，临时表数据持续驻留'));
  out.push(bullet('ALTER TABLE / CREATE INDEX 的在线 DDL 操作'));
  out.push(emptyLine());

  out.push(h2('8.3 处置建议'));
  out.push(para('短期：在 my.cnf 中设置上限，避免无限增长：'));
  out.push(code('innodb_temp_data_file_path = ibtmp1:12M:autoextend:max:50G'));
  out.push(para('重启后 ibtmp1 将重建为 12MB 初始大小，最大增长至 50GB（达到上限后报错 1114 而非耗尽磁盘）。'));
  out.push(para('中期：通过慢查询日志定位触发临时表的 SQL，优化业务查询。'));
  return out;
}

function chapterInnodb(data) {
  const out = [h1('九、InnoDB 引擎状态'), h2('9.1 状态概览')];
  out.push(makeTable(
    ['节点 IP', 'History List Length', 'Log Sequence Number', 'Buffer Pool Hit Rate', 'Free Buffers'],
    data.nodes.map(n => [
      n.ip,
      n.innodb?.historyListLength || '-',
      n.innodb?.logSequenceNumber || '-',
      n.innodb?.bufferPoolHitRate || '-',
      n.innodb?.freeBuffers || '-',
    ]),
    'InnoDB 关键状态',
  ));
  out.push(emptyLine());
  out.push(noteParagraph('History List Length 是未清理的 undo 历史长度，持续 >10000 表示 purge 线程跟不上事务速度；可能由长事务、长查询导致。'));
  out.push(emptyLine());

  out.push(h2('9.2 Buffer Pool 详细'));
  out.push(makeTable(
    ['节点 IP', 'Buffer Pool Size (pages)', 'Database Pages', 'Free Buffers', 'Modified DB Pages'],
    data.nodes.map(n => [
      n.ip,
      n.innodb?.bufferPoolSize || '-',
      n.innodb?.databasePages || '-',
      n.innodb?.freeBuffers || '-',
      n.innodb?.modifiedDbPages || '-',
    ]),
    '缓冲池细节',
  ));
  out.push(emptyLine());

  out.push(h2('9.3 累计 I/O 统计'));
  out.push(makeTable(
    ['节点 IP', 'Pages Read', 'Pages Created', 'Pages Written'],
    data.nodes.map(n => [
      n.ip,
      n.innodb?.pagesRead ? Number(n.innodb.pagesRead).toLocaleString() : '-',
      n.innodb?.pagesCreated ? Number(n.innodb.pagesCreated).toLocaleString() : '-',
      n.innodb?.pagesWritten ? Number(n.innodb.pagesWritten).toLocaleString() : '-',
    ]),
    'I/O 累计',
  ));
  return out;
}

function chapterTransactions(data) {
  const out = [h1('十、事务与锁分析'), h2('10.1 活跃事务')];
  const trxRows = [];
  for (const n of data.nodes) {
    for (const t of (n.innodb?.activeTransactions || [])) {
      trxRows.push([n.ip, t.id, t.state, truncate(t.detail, 80)]);
    }
  }
  out.push(makeTable(
    ['节点 IP', '事务 ID', '状态', '事务详情'],
    trxRows,
    '采集时刻的活跃事务（排除 not started）',
  ));
  if (trxRows.length === 0) {
    out.push(noteParagraph('采集时刻未发现活跃事务（所有事务均为 not started 状态，属于空闲连接）。'));
  }
  out.push(emptyLine());

  out.push(h2('10.2 最近死锁'));
  let hasDeadlock = false;
  for (const n of data.nodes) {
    if (n.innodb?.latestDeadlock) {
      hasDeadlock = true;
      out.push(para([{ text: `节点 ${n.ip}：`, bold: true }]));
      out.push(code(n.innodb.latestDeadlock));
      out.push(emptyLine());
    }
  }
  if (!hasDeadlock) {
    out.push(para('各节点 SHOW ENGINE INNODB STATUS 未输出 LATEST DETECTED DEADLOCK 段，说明自上次 InnoDB 启动以来未发生死锁（或已过期）。'));
  }
  out.push(emptyLine());

  out.push(h2('10.3 锁等待说明'));
  out.push(para('本次采集脚本未单独导出 innodb_lock_waits 视图。如需排查锁等待，建议在线上执行：'));
  out.push(code('SELECT * FROM information_schema.innodb_lock_waits;'));
  out.push(code('SELECT * FROM sys.innodb_lock_waits;  -- MySQL 5.7+'));
  return out;
}

function chapterUsers(data) {
  const out = [h1('十一、用户权限审计')];
  const primary = data.nodes.find(n => n.role === 'primary') || data.nodes[0];

  out.push(h2('11.1 用户清单'));
  out.push(para(`取自主库 ${primary.ip} mysql.user：`));
  out.push(emptyLine());
  const userRows = (primary.users || []).map(u => [
    primary.ip, u.user, u.host,
    u.passwordExpired === 'Y' ? '已过期' : '正常',
    u.passwordLastChanged || '-',
    u.accountLocked === 'Y' ? '已锁定' : '未锁',
  ]);
  out.push(makeTable(
    ['节点 IP', '用户', '允许主机', '密码状态', '上次修改', '账户状态'],
    userRows,
    `用户清单（共 ${userRows.length} 个）`,
  ));
  out.push(emptyLine());

  // host=% 用户按危险等级分组
  out.push(h2('11.2 host=% 用户分级'));
  const wildcards = (primary.users || []).filter(u => u.host === '%');
  if (wildcards.length === 0) {
    out.push(para('未发现 host=% 的用户，账号策略合规。'));
  } else {
    const classify = (user) => {
      const u = (user || '').toLowerCase();
      if (u === 'root' || /admin|dba|super/.test(u)) return { level: 'critical', label: '🔴 致命', reason: 'root / 管理员账号' };
      if (u === 'repl' || /replic/.test(u)) return { level: 'high', label: '🔴 高危', reason: '复制账号，应限制为复制源 IP' };
      if (/backup|dump/.test(u)) return { level: 'high', label: '🟠 高危', reason: '备份账号，权限较广' };
      if (/zabbix|prometheus|nagios|monitor|exporter/.test(u)) return { level: 'low', label: '🟢 低危', reason: '监控只读账号' };
      if (/^ro|readonly/.test(u)) return { level: 'low', label: '🟢 低危', reason: '只读账号' };
      return { level: 'medium', label: '🟡 中危', reason: '业务账号' };
    };
    const grouped = { critical: [], high: [], medium: [], low: [] };
    wildcards.forEach(u => {
      const c = classify(u.user);
      grouped[c.level].push({ user: u.user, host: u.host, label: c.label, reason: c.reason });
    });
    const rows = [];
    for (const lvl of ['critical', 'high', 'medium', 'low']) {
      for (const item of grouped[lvl]) {
        rows.push([item.label, item.user, item.host, item.reason, lvl==='low'?'可保留':lvl==='medium'?'建议缩限网段':'立即收紧到具体 IP/网段']);
      }
    }
    out.push(makeTable(
      ['等级', '用户', '主机', '类型', '建议'],
      rows,
      `host=% 用户清单（${wildcards.length} 个，按危险等级排序）`,
    ));
    out.push(emptyLine());

    const critCount = grouped.critical.length + grouped.high.length;
    if (critCount > 0) {
      out.push(para([
        { text: `⚠️ 必须立即收紧 ${critCount} 个高风险账号：`, bold: true, color: 'C00000' },
        { text: [...grouped.critical, ...grouped.high].map(u => u.user).join('、') },
      ]));
    }
  }
  out.push(emptyLine());

  out.push(h2('11.3 安全建议'));
  out.push(bullet('立即清理 host=% 的 root / 管理员账号：DROP USER \'root\'@\'%\';'));
  out.push(bullet('复制账号 repl 应限制为从库 IP 列表：CREATE USER \'repl\'@\'172.16.0.0/255.255.0.0\' ...'));
  out.push(bullet('为业务账号设置 password_lifetime（强制定期改密）'));
  out.push(bullet('MySQL 5.7 默认 mysql_native_password 插件，建议评估迁移到 caching_sha2_password'));
  out.push(bullet('定期审计权限，回收离职人员账号'));
  return out;
}

function chapterReplication(data) {
  const out = [h1('十二、主从复制状态'), h2('12.1 复制拓扑')];
  const primary = data.nodes.find(n => n.role === 'primary');
  const gtid = primary?.variables?.gtid_mode || '-';
  out.push(para(`集群采用 ${data.cluster.topology}，GTID 模式：${gtid}。`));
  if (primary?.replication?.slaveIps?.length) {
    out.push(para(`主库 ${primary.ip} 检测到从库 IP：${primary.replication.slaveIps.join('、')}`));
  }
  out.push(emptyLine());

  out.push(h2('12.2 从库复制状态'));
  const slaveRows = data.nodes
    .filter(n => n.replication?.isSlave)
    .map(n => {
      const s = n.replication.status || {};
      return [
        n.ip, s.masterHost || '-',
        s.slaveIoRunning || '-',
        s.slaveSqlRunning || '-',
        s.masterLogFile || '-',
        s.readMasterLogPos || '-',
        s.secondsBehindMaster != null ? `${s.secondsBehindMaster} s` : '-',
      ];
    });
  out.push(makeTable(
    ['从库 IP', '主库地址', 'IO 线程', 'SQL 线程', '主库 binlog', '已读位置', '延迟'],
    slaveRows,
    '从库复制状态',
  ));
  out.push(emptyLine());

  out.push(h2('12.3 关键复制参数'));
  const keys = [
    ['log_bin', '主库 binlog 开关'],
    ['binlog_format', 'binlog 格式（建议 ROW）'],
    ['sync_binlog', 'binlog 刷盘策略'],
    ['gtid_mode', 'GTID 模式'],
    ['enforce_gtid_consistency', '强制 GTID 一致性'],
    ['slave_parallel_workers', '并行复制 worker 数'],
    ['slave_net_timeout', '从库网络超时'],
    ['expire_logs_days', 'binlog 保留天数'],
  ];
  const headers = ['参数', ...data.nodes.map(n => `${n.ip}\n${roleLabel(n.role)}`), '说明'];
  const rows = keys.map(([k, desc]) => {
    const cells = [k];
    for (const n of data.nodes) cells.push(n.variables?.[k] || '-');
    cells.push(desc);
    return cells;
  });
  out.push(makeTable(headers, rows, '复制相关参数'));
  out.push(emptyLine());

  out.push(h2('12.4 复制风险与建议'));
  const recs = [];
  if (gtid === 'OFF') recs.push('当前 GTID 关闭：建议规划升级到 GTID 模式，便于自动 failover 与跨实例迁移');
  const parW = primary?.variables?.slave_parallel_workers;
  if (parW != null && Number(parW) === 0) {
    recs.push('从库并行复制未启用 (slave_parallel_workers=0)：单线程应用 binlog 在写入高峰可能延迟，建议设为 4-8 + slave_parallel_type=LOGICAL_CLOCK');
  }
  if ((primary?.variables?.sync_binlog || '0') === '0') {
    recs.push('主库 sync_binlog=0：主库异常宕机可能丢失 binlog 事件，建议设为 1');
  }
  if (recs.length === 0) recs.push('复制配置整体合理，建议持续监控 Seconds_Behind_Master 与从库报错日志');
  recs.forEach(r => out.push(bullet(r)));
  return out;
}

function chapterConclusion(data) {
  const out = [h1('十三、巡检总结与行动计划')];
  out.push(h2('13.1 整体结论'));
  out.push(para(`【${data.project}】MySQL 集群本次巡检整体评估：${data.overallAssessment}。`));
  const sl = data.nodes.filter(n => n.replication?.isSlave);
  if (sl.length > 0) {
    const okSlaves = sl.filter(n => n.replication.status?.slaveIoRunning === 'Yes' && n.replication.status?.slaveSqlRunning === 'Yes').length;
    const maxLag = Math.max(...sl.map(n => Number(n.replication.status?.secondsBehindMaster || 0)));
    out.push(para(`主从复制状态：${okSlaves}/${sl.length} 从库 IO+SQL 双线程正常，当前最大延迟 ${maxLag} 秒。`));
  }
  out.push(emptyLine());

  // 13.2 行动计划（按优先级，带具体 issue 与 SQL hint）
  out.push(h2('13.2 行动计划（按优先级）'));
  const renderActionBlock = (label, color, issues) => {
    if (!issues || issues.length === 0) return;
    out.push(para([{ text: label, bold: true, color }]));
    issues.forEach((i, idx) => {
      out.push(para([
        { text: `${idx + 1}. `, bold: true },
        { text: i.description },
        { text: `  [节点：${i.node}]`, color: COLOR.muted },
      ]));
      out.push(para([
        { text: '   ✦ 措施：', color: '548235' },
        { text: i.action },
      ]));
      if (i.sql) {
        out.push(code(i.sql));
      }
    });
    out.push(emptyLine());
  };

  const p0 = data.issues.filter(i => i.priority === 'P0');
  const p1 = data.issues.filter(i => i.priority === 'P1');
  const p2 = data.issues.filter(i => i.priority === 'P2');

  renderActionBlock('🔴 本周内（P0 紧急）', 'C00000', p0);
  renderActionBlock('🟠 两周内（P1 重要）', 'BF8F00', p1);
  renderActionBlock('🟡 本月内（P2 建议）', '548235', p2);

  const recs = data.recommendations || {};
  if ((recs.longTerm || []).length > 0) {
    out.push(para([{ text: '🔵 长期规划：', bold: true, color: COLOR.secondary }]));
    recs.longTerm.forEach(r => out.push(bullet(r)));
    out.push(emptyLine());
  }

  out.push(h2('13.3 附录 · 数据来源'));
  out.push(para('本报告基于以下原始采集文件生成：'));
  for (const n of data.nodes) {
    out.push(bullet(`${n.ip}（${roleLabel(n.role)}）：${n._file || '-'}`));
  }
  out.push(emptyLine());
  out.push(para('采集脚本覆盖的子段：os info / db info（hostname、mem info、CPU、disk mount、my.cnf detail、MySQL Database Version、MySQL Replication Info、Engine innodb status、MySQL Variables、Processlist info、user check、database CHARACTER、Top 10 Tables、Tables fragment rate、Not utf8 table、NO PRIMARY KEY TABLES、ROUTINES OBJECTS 等）。'));
  return out;
}

// ============== 辅助 ==============
function roleLabel(role) {
  if (!role) return '未知';
  if (role === 'primary') return '主库';
  if (/^slave/.test(role)) return '从库';
  return role;
}
function diskHealthLabel(pctText) {
  const pct = parseInt((pctText || '0').replace('%', ''));
  if (pct >= 90) return '紧急';
  if (pct >= 80) return '关注';
  if (pct >= 70) return '正常';
  return '充裕';
}
function truncate(s, n) {
  if (!s) return '-';
  s = String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}
function formatBytesNum(n) {
  if (n == null) return '-';
  const v = Number(n);
  if (isNaN(v)) return '-';
  if (v >= 1073741824) return (v / 1073741824).toFixed(2) + ' GB';
  if (v >= 1048576) return (v / 1048576).toFixed(2) + ' MB';
  if (v >= 1024) return (v / 1024).toFixed(2) + ' KB';
  return v + ' B';
}
function formatChineseDate(iso) {
  if (!iso) return '-';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${m[1]}年${m[2]}月${m[3]}日`;
}

// ============== 文档组装 ==============
function buildDocument(data) {
  const logoPath = path.join(__dirname, 'assets', 'logo.png');
  const logoImage = fs.existsSync(logoPath) ? fs.readFileSync(logoPath) : null;

  const headerChildren = [];
  if (logoImage) {
    headerChildren.push(new ImageRun({
      data: logoImage,
      transformation: { width: 90, height: 30 },
      type: 'png',
    }));
    headerChildren.push(new TextRun({ text: '  ', font: FONT }));
  }
  headerChildren.push(new TextRun({
    text: `${data.project} MySQL 数据库巡检报告 （${data.cluster.ips.join(', ')}）`,
    font: FONT, color: COLOR.light, size: 16,
  }));

  return new Document({
    creator: 'MySQL Inspection Skill v3.1',
    title: `${data.project} MySQL 数据库巡检报告（详细版）`,
    styles: {
      default: { document: { run: { font: FONT, size: 22 } } },
      paragraphStyles: [
        { id: 'Normal', name: 'Normal', run: { font: FONT, size: 22 } },
        { id: 'Heading1', name: 'Heading 1',
          run: { font: FONT, size: 32, bold: true, color: COLOR.primary },
          paragraph: { spacing: { before: 360, after: 160 } } },
        { id: 'Heading2', name: 'Heading 2',
          run: { font: FONT, size: 26, bold: true, color: COLOR.secondary },
          paragraph: { spacing: { before: 240, after: 80 } } },
        { id: 'Heading3', name: 'Heading 3',
          run: { font: FONT, size: 24, bold: true, color: COLOR.tertiary },
          paragraph: { spacing: { before: 160, after: 60 } } },
      ],
    },
    sections: [{
      properties: { page: { margin: { top: 1440, bottom: 1440, left: 1800, right: 1440 } } },
      headers: {
        default: new Header({
          children: [new Paragraph({
            border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'AAAAAA', space: 1 } },
            children: headerChildren,
          })],
        }),
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({ text: '第 ', color: COLOR.muted, size: 18, font: FONT }),
              new TextRun({ children: [PageNumber.CURRENT], color: COLOR.muted, size: 18, font: FONT }),
              new TextRun({ text: ' 页', color: COLOR.muted, size: 18, font: FONT }),
            ],
          })],
        }),
      },
      children: [
        ...chapterCover(data),
        ...chapterSummary(data),
        ...chapterServers(data),
        ...chapterConnections(data),
        ...chapterDatabases(data),
        ...chapterParams(data),
        ...chapterPerformance(data),
        ...chapterStorage(data),
        ...chapterIbtmp1(data),
        ...chapterInnodb(data),
        ...chapterTransactions(data),
        ...chapterUsers(data),
        ...chapterReplication(data),
        ...chapterConclusion(data),
      ],
    }],
  });
}

// ============== 占位符校验 ==============
// 把 docx (zip) 中的 word/document.xml 抽出，查找形如 {汉字/字母} 的残留占位符
function checkPlaceholders(buf) {
  const zlib = require('zlib');
  // 找 'word/document.xml' 的本地文件头（PK\x03\x04）
  const sig = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  let i = 0;
  let xml = null;
  while ((i = buf.indexOf(sig, i)) !== -1) {
    const compMethod = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString('utf-8');
    const dataStart = i + 30 + nameLen + extraLen;
    if (name === 'word/document.xml') {
      const compressed = buf.slice(dataStart, dataStart + compSize);
      xml = compMethod === 8 ? zlib.inflateRawSync(compressed).toString('utf-8') : compressed.toString('utf-8');
      break;
    }
    i = dataStart + compSize;
  }
  if (!xml) return [];
  // 文本内容里的 {xxx}：去掉 XML 标签后再搜
  const text = xml.replace(/<[^>]+>/g, '');
  const matches = text.match(/\{[A-Za-z一-鿿][^{}]{0,40}\}/g) || [];
  // 去重
  return [...new Set(matches)];
}

// ============== 主流程 ==============
(async function main() {
  const doc = buildDocument(data);
  const buf = await Packer.toBuffer(doc);
  fs.writeFileSync(outPath, buf);

  // 残留占位符校验：把 docx 当作 zip，解压 word/document.xml 后搜 {xxx}
  try {
    const residue = checkPlaceholders(buf);
    if (residue.length > 0) {
      console.warn(`⚠️ 警告：docx 内疑似残留 ${residue.length} 处花括号占位符（应在 data.json 中补齐）。示例：${residue.slice(0,5).join(' | ')}`);
    } else {
      console.error('✓ 占位符校验通过：未发现残留 {…} 模板字符串');
    }
  } catch (e) {
    console.warn('占位符校验失败：' + e.message);
  }

  console.error(`生成成功：${outPath}`);
  console.error(`  文件大小：${(buf.length / 1024).toFixed(1)} KB`);
})().catch(e => { console.error(e); process.exit(1); });

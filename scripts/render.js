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
  TableOfContents, StyleLevel, Bookmark, InternalHyperlink,
} = loadDocx();

// ============== 图表生成 ==============
let charts = null;
try { charts = require('./lib/charts.js'); } catch (_) {}

function chartImage(svgFn, opts = {}) {
  if (!charts) return null;
  try {
    const svg = svgFn();
    const png = charts.svgToPng(svg);
    if (!png) return null;
    return new ImageRun({
      data: png,
      transformation: { width: opts.width || 480, height: opts.height || 280 },
      type: 'png',
    });
  } catch (e) {
    console.warn('图表生成失败：' + e.message);
    return null;
  }
}

function chartParagraph(svgFn, opts = {}) {
  const img = chartImage(svgFn, opts);
  if (!img) return null;
  return new Paragraph({
    children: [img],
    alignment: AlignmentType.CENTER,
    spacing: { before: 100, after: 100 },
  });
}

// ============== CLI 参数 ==============
const args = process.argv.slice(2);
if (!args[0] || args[0].startsWith('--')) {
  console.error('用法: node render.js <data.json> [--out output.docx]');
  process.exit(1);
}
const dataPath = path.resolve(args[0]);
let outPath = null;
let validateOnly = false;
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--out') outPath = args[++i];
  else if (args[i] === '--validate') validateOnly = true;
}

const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));

// ============== Schema 校验（Codex #5）==============
// 渲染前快速诊断 data.json 完整性，避免运行时崩溃。
// --validate 模式：只校验不渲染。
let schema;
try { schema = require('./lib/schema.js'); } catch (_) {}
if (schema) {
  const result = schema.validate(data);
  schema.printReport(result);
  if (!result.ok) {
    console.error('✗ 数据校验失败，渲染终止。修复 data.json 或重跑 extract.js 后再试。');
    process.exit(2);
  }
  if (validateOnly) {
    console.error('--validate 模式：仅校验，不生成 docx。');
    process.exit(0);
  }
}
if (!outPath) {
  // 默认放在 data.json 同目录，文件名按项目命名
  const safeName = (data.project || 'report').replace(/[^\w一-鿿-]+/g, '_');
  outPath = path.join(
    path.dirname(dataPath),
    `${safeName}_MySQL健康巡检报告_v${data.reportVersion || '1.0'}.docx`,
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
const COMPANY_NAME = '云和恩墨(北京)信息技术有限公司';
const COMPANY_SLOGAN = '实力成就卓越 技术创造价值';
const COMPANY_SITE = 'http://www.enmotech.com';
const DOC_EDITOR = 'Bethune';
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
      const cell = c && typeof c === 'object' && !Array.isArray(c) ? c : { text: c };
      const text = cell.text == null || cell.text === '' ? '-' : String(cell.text);
      return new TableCell({
        children: [new Paragraph({
          children: [new TextRun({
            text,
            size: cell.size || 20,
            font: FONT,
            color: cell.color || COLOR.text,
            bold: !!cell.bold,
          })],
          alignment: align,
        })],
        width: { size: widths[i], type: WidthType.DXA },
        shading: cell.fill
          ? { fill: cell.fill, type: ShadingType.CLEAR, color: 'auto' }
          : shade
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
      // 评审反馈 #13：needsConfirmation 的 issue 在描述前加 🔍 标记
      const descPrefix = i.needsConfirmation ? '🔍 [需人工确认] ' : '';
      // 评审反馈 #6：dualTrigger 在级别后加 ⚡ 标识（一条 issue 命中多个维度）
      const lvlSuffix = (i.dualTrigger && i.dualTrigger.length > 1) ? ' ⚡' : '';
      trs.push(priorityRow(
        [i.seq, `${i.priority} ${priorityLabel(i.priority)}${lvlSuffix}`,
         descPrefix + i.description, i.node, i.action, i.status],
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
  // v4.9.3：P0 措辞从「紧急」改为「关键」— 数据库实际在正常运行，
  //         用「紧急」会过度警示客户；用「关键」保留高优先级语义而不 alarmist。
  return { P0: '关键', P1: '重要', P2: '建议', P3: '观察' }[p] || '';
}

function noteParagraph(text) {
  return new Paragraph({
    children: [new TextRun({ text: '说明：' + text, italics: true, size: 20, color: COLOR.muted, font: FONT })],
    spacing: { before: 40, after: 40 },
  });
}

function simpleGridTable(rows, widths) {
  return new Table({
    rows: rows.map((row) => new TableRow({
      children: row.map((cell, i) => new TableCell({
        children: [new Paragraph({
          children: [new TextRun({
            text: String(cell.text == null ? '' : cell.text),
            size: cell.size || 20,
            font: FONT,
            bold: !!cell.bold,
            color: cell.color || COLOR.text,
          })],
          alignment: cell.align || AlignmentType.LEFT,
        })],
        width: { size: widths[i], type: WidthType.DXA },
        shading: cell.fill ? { fill: cell.fill, type: ShadingType.CLEAR, color: 'auto' } : undefined,
      })),
    })),
    width: { size: TABLE_WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
  });
}

// ============== 章节构造器 ==============
function chapterCover(data) {
  const monthText = formatMonthText(data.inspectionDate);
  return [
    new Paragraph({
      children: [new TextRun({ text: `${data.project} 数据库巡检报告`, size: 44, bold: true, color: '000000', font: FONT })],
      alignment: AlignmentType.CENTER,
      spacing: { before: 2200, after: 220 },
    }),
    new Paragraph({
      children: [new TextRun({ text: `(${monthText})`, size: 24, color: '000000', font: FONT })],
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 2500 },
    }),
    new Paragraph({
      children: [new TextRun({ text: COMPANY_NAME, size: 30, color: '000000', font: FONT })],
      alignment: AlignmentType.CENTER,
      spacing: { before: 1400, after: 120 },
    }),
    new Paragraph({
      children: [new TextRun({ text: COMPANY_SITE, size: 22, color: '000000', font: FONT })],
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 0 },
    }),
    new Paragraph({ children: [new PageBreak()], spacing: { before: 0, after: 0 } }),
  ];
}

function chapterDocumentControl(data) {
  const reportDate = data.reportDate || data.inspectionDate || '';
  const version = `${data.reportVersion || '1.0'}版`;
  return [
    new Paragraph({
      children: [new TextRun({ text: '文档控制', size: 34, bold: true, color: '000000', font: FONT })],
      spacing: { before: 120, after: 180 },
    }),
    simpleGridTable([
      [
        { text: '序', fill: COLOR.primary, color: 'FFFFFF', bold: true, align: AlignmentType.CENTER },
        { text: '版本号', fill: COLOR.primary, color: 'FFFFFF', bold: true, align: AlignmentType.CENTER },
        { text: '更改人', fill: COLOR.primary, color: 'FFFFFF', bold: true, align: AlignmentType.CENTER },
        { text: '日期', fill: COLOR.primary, color: 'FFFFFF', bold: true, align: AlignmentType.CENTER },
        { text: '备注', fill: COLOR.primary, color: 'FFFFFF', bold: true, align: AlignmentType.CENTER },
      ],
      [
        { text: '1', align: AlignmentType.CENTER },
        { text: version, align: AlignmentType.CENTER },
        { text: DOC_EDITOR, align: AlignmentType.CENTER },
        { text: reportDate, align: AlignmentType.CENTER },
        { text: '初始版本', align: AlignmentType.CENTER },
      ],
    ], [800, 1300, 1500, 1400, 2000]),
    new Paragraph({ text: '', spacing: { before: 0, after: 7600 } }),
    simpleGridTable([
      [
        { text: '编制', bold: true }, { text: DOC_EDITOR },
        { text: '日期', bold: true }, { text: reportDate },
      ],
      [
        { text: '校对', bold: true }, { text: '' },
        { text: '日期', bold: true }, { text: reportDate },
      ],
      [
        { text: '审核', bold: true }, { text: '' },
        { text: '日期', bold: true }, { text: reportDate },
      ],
      [
        { text: '批准', bold: true }, { text: '' },
        { text: '日期', bold: true }, { text: reportDate },
      ],
    ], [1200, 2500, 1200, 2500]),
    new Paragraph({ children: [new PageBreak()] }),
  ];
}

// ============== 执行摘要（一页面向管理层）==============
function chapterExecutiveSummary(data) {
  const out = [h1('执行摘要')];
  const hs = data.healthScore || { total: 0, dimensions: {} };
  const p0 = data.issues.filter(i => i.priority === 'P0').length;
  const p1 = data.issues.filter(i => i.priority === 'P1').length;
  const p2 = data.issues.filter(i => i.priority === 'P2').length;
  const p3 = data.issues.filter(i => i.priority === 'P3').length;

  // 健康度仪表 + 维度雷达 并排（图表）
  if (charts) {
    const gaugeP = chartParagraph(() => charts.gauge(hs.total, '集群健康度'), { width: 380, height: 240 });
    const radarP = chartParagraph(() => charts.radar([
      { label: '可用性', value: hs.dimensions.availability || 0, max: 100 },
      { label: '安全性', value: hs.dimensions.security || 0, max: 100 },
      { label: '性能', value: hs.dimensions.performance || 0, max: 100 },
      { label: '数据规范', value: hs.dimensions.dataDesign || 0, max: 100 },
      { label: '持久化', value: hs.dimensions.durability || 0, max: 100 },
      { label: '运维', value: hs.dimensions.operations || 0, max: 100 },
    ], { title: '6 维度健康评分' }), { width: 380, height: 320 });
    if (gaugeP) out.push(gaugeP);
    if (radarP) out.push(radarP);
  }

  // 维度评分表
  out.push(makeTable(
    ['维度', '得分', '等级', '说明'],
    [
      ['可用性 (HA)', `${hs.dimensions.availability || 0}/100`, levelOf(hs.dimensions.availability), '复制状态、磁盘、节点健康'],
      ['安全性',     `${hs.dimensions.security || 0}/100`,     levelOf(hs.dimensions.security),     '账号策略、加密、审计'],
      ['性能',       `${hs.dimensions.performance || 0}/100`,  levelOf(hs.dimensions.performance),  '命中率、慢查询、IO'],
      ['数据规范',   `${hs.dimensions.dataDesign || 0}/100`,   levelOf(hs.dimensions.dataDesign),   '主键、字符集、索引'],
      ['持久化',     `${hs.dimensions.durability || 0}/100`,   levelOf(hs.dimensions.durability),   'sync_binlog、刷盘、GTID'],
      ['运维',       `${hs.dimensions.operations || 0}/100`,   levelOf(hs.dimensions.operations),   '备份、参数一致性、监控'],
    ],
    `六维度健康度评分（总分 ${hs.total}/100）`,
  ));
  out.push(emptyLine());

  // 关键事实表（v4.6：单节点时改为"节点信息"而非"集群"，避免对单点采集场景造成误导）
  const isSingleNodeKF = data.cluster.nodeCount === 1;
  out.push(makeTable(
    ['指标', '值'],
    [
      ['项目名称', data.project],
      ['采集日期', formatChineseDate(data.inspectionDate)],
      [isSingleNodeKF ? '采集范围' : '集群拓扑', `${data.cluster.topology}（${data.cluster.nodeCount} 节点）`],
      [isSingleNodeKF ? '节点 IP' : '集群 IP', data.cluster.ips.join('、')],
      ['整体评估', data.overallAssessment.replace(/（健康度评分.*?）/, '')],
      ['问题分布', `P0 关键 ${p0} 项 / P1 重要 ${p1} 项 / P2 建议 ${p2} 项 / P3 观察 ${p3} 项`],
      ['备份能力', data.backupAssessment?.assessment || '-'],
      // v4.7.2：合规等级行已移除（连同第十六章「安全合规审计」一起，
      // 因为这部分内容属于咨询性/框架对照，不是日常巡检关注点）
    ],
    '关键事实速览',
  ));
  out.push(emptyLine());

  out.push(para([
    { text: '本报告组成：', bold: true },
    { text: '本页（执行摘要） + 目录页 + 16 章详细分析。管理层可仅阅读本页与第十六章总结；DBA 团队建议完整阅读全部章节。' },
  ]));
  out.push(new Paragraph({ children: [new PageBreak()] }));
  return out;
}

function levelOf(score) {
  // v4.9.3：等级标签同步软化 — 不出现「严重」「较差」等过激词
  // 配合 computeHealthScore 的 55 分下限，所有分段都是"操作中可改进"的语义
  if (score == null) return '-';
  if (score >= 90) return '✅ 优秀';
  if (score >= 80) return '✓ 良好';
  if (score >= 70) return '✓ 中等';
  if (score >= 60) return '⚠ 关注';
  return '⚠ 建议优化';
}

// ============== 目录页 ==============
function chapterTOC() {
  return [
    h1('目录'),
    new Paragraph({
      children: [
        new TableOfContents('目录', {
          hyperlink: true,
          headingStyleRange: '1-3',
        }),
      ],
    }),
    new Paragraph({
      // v4.7：如导出时检测到 LibreOffice，TOC 已自动填充含页码 + 超链接；
      // 如未检测到 / 刷新失败，则首次打开为空，需手动右键 → 更新域。
      children: [new TextRun({ text: '提示：本目录在导出时已自动刷新（如检测到 LibreOffice）。若 TOC 仍显示为空，请在目录上右键 → 更新域 → 更新整个目录。', italics: true, size: 18, color: COLOR.muted, font: FONT })],
      spacing: { before: 200, after: 100 },
    }),
    new Paragraph({ children: [new PageBreak()] }),
  ];
}

function chapterSummary(data) {
  const p0 = data.issues.filter(i => i.priority === 'P0').length;
  const p1 = data.issues.filter(i => i.priority === 'P1').length;
  const p2 = data.issues.filter(i => i.priority === 'P2').length;
  const p3 = data.issues.filter(i => i.priority === 'P3').length;

  const clusterIssues = data.issues.filter(i => i.node === '全部节点' || /\d\/\d+\s+节点/.test(i.node));
  const nodeIssues = data.issues.filter(i => !clusterIssues.includes(i));
  // v4.6：单节点时不再区分"集群级 / 节点级问题"
  const isSingleNode = data.cluster.nodeCount === 1;

  const out = [
    h1('一、巡检摘要'),
    para(isSingleNode
      ? `本次对【${data.project}】生产环境 MySQL 实例（${data.cluster.topology}）进行月度巡检，采集日期 ${formatChineseDate(data.inspectionDate)}，覆盖 ${data.cluster.nodeCount} 个节点（${data.cluster.ips.join('、')}）。`
      : `本次对【${data.project}】生产环境 MySQL 集群（${data.cluster.topology}）进行月度巡检，采集日期 ${formatChineseDate(data.inspectionDate)}，覆盖 ${data.cluster.nodeCount} 个节点（${data.cluster.ips.join('、')}）。`),
    para(`整体评估：${data.overallAssessment}。`),
    para([
      { text: '问题分布：', bold: true },
      { text: `P0 关键 ${p0} 项 / P1 重要 ${p1} 项 / P2 建议 ${p2} 项 / P3 观察 ${p3} 项。` },
    ]),
  ];
  if (!isSingleNode) {
    out.push(para([
      { text: '问题分类：', bold: true },
      { text: `集群级问题 ${clusterIssues.length} 项（一次修复影响全部节点），节点级问题 ${nodeIssues.length} 项。` },
    ]));
  }
  out.push(emptyLine());

  // 问题分布饼图
  if (charts && data.issues.length > 0) {
    const pieP = chartParagraph(() => charts.pie([
      { label: 'P0 关键', value: p0, color: charts.COLORS.p0 },
      { label: 'P1 重要', value: p1, color: charts.COLORS.p1 },
      { label: 'P2 建议', value: p2, color: charts.COLORS.p2 },
      { label: 'P3 观察', value: p3, color: charts.COLORS.p3 },
    ].filter(x => x.value > 0), { title: '问题优先级分布', width: 520, height: 260 }),
    { width: 520, height: 260 });
    if (pieP) out.push(pieP);
  }

  // 1.1 集群级问题（一次修复影响所有节点）— v4.6: 单节点跳过 cluster/node 拆分
  if (!isSingleNode && clusterIssues.length > 0) {
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
  if (nodeIssues.length > 0 || (isSingleNode && clusterIssues.length > 0)) {
    // 单节点：把所有 issue 合并展示
    const itemsToShow = isSingleNode ? [...clusterIssues, ...nodeIssues] : nodeIssues;
    out.push(h2(isSingleNode ? '1.1 问题汇总' : (clusterIssues.length > 0 ? '1.2 节点级问题' : '1.1 问题汇总')));
    out.push(para(isSingleNode ? '本次巡检发现的全部问题：' : '以下问题仅影响特定节点：'));
    out.push(emptyLine());
    out.push(makePriorityTable(
      ['序号', '级别', '问题描述', '节点', '建议措施', '状态'],
      itemsToShow.map((i, idx) => ({ ...i, seq: idx + 1 })),
      isSingleNode ? '问题汇总' : '节点级问题',
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
    { text: 'P0=优先处置（潜在影响可用性），P1=近期规划处置，P2=本月内评估优化，P3=持续观察。', color: COLOR.muted },
  ]));

  return out;
}

function chapterServers(data) {
  const isSingleNode = data.nodes.length === 1;
  // v4.5：单节点报告章节标题改为"节点拓扑"，避免"集群"造成误导
  const out = [h1('二、服务器与拓扑概况'), h2(isSingleNode ? '2.1 节点拓扑' : '2.1 集群拓扑')];
  out.push(para(isSingleNode
    ? `本次仅采集到单个节点（${data.cluster.topology}），节点角色及基础配置如下：`
    : `本集群采用「${data.cluster.topology}」结构，节点角色及基础配置如下：`));
  out.push(emptyLine());
  if (charts) {
    out.push(para([{ text: isSingleNode ? '节点拓扑图' : 'MySQL 复制拓扑图', bold: true, color: COLOR.secondary }]));
    // v4.6：单节点时根据是否有 self-ref 警告动态决定高度（与 charts.topology 内部计算一致）
    const hasSelfRefWarn = isSingleNode && !!(data.nodes[0]?.replication?.selfReferencingSlaveResidue);
    const h = isSingleNode
      ? (hasSelfRefWarn ? 190 : 160)
      : Math.max(220, 120 + (data.nodes.length - 1) * 42);
    const p = chartParagraph(() => charts.topology(data.nodes, {
      title: isSingleNode ? '节点拓扑图' : 'MySQL 复制拓扑图',
      width: 620,
      height: h,
    }), { width: 620, height: h });
    if (p) out.push(p);
  }

  out.push(makeTable(
    ['节点 IP', '主机名', '角色', 'MySQL 版本', 'server_id', 'Uptime'],
    data.nodes.map(n => {
      // v4.5：needsConfirmation 角色加 🔍 提示
      const confirm = n.roleInference?.needsConfirmation;
      const roleCell = confirm
        ? { text: `${roleLabel(n.role)} 🔍`, color: 'BF8F00', bold: true }
        : roleLabel(n.role);
      return [
        n.ip, n.hostname || '-',
        roleCell,
        n.mysqlVersion || '-',
        n.variables?.server_id || '-',
        n.uptimeText || '-',
      ];
    }),
    isSingleNode ? '节点信息' : '集群节点信息',
  ));
  // v4.5：角色推断来源说明（标 needsConfirmation 的节点）
  const confirmNodes = data.nodes.filter(n => n.roleInference?.needsConfirmation);
  if (confirmNodes.length > 0) {
    const lines = confirmNodes.map(n => {
      const src = n.roleInference.source;
      const reason = src === 'standalone_readonly' ? '只读主库（read_only=1 + log_bin 启用）'
        : src === 'single_node_fallback' ? '单节点采集兜底（建议确认）'
        : src;
      return `${n.ip}（${roleLabel(n.role)}）：${reason}`;
    });
    out.push(noteParagraph(`🔍 角色需人工确认：${lines.join('；')}。`));
  }
  out.push(emptyLine());

  out.push(h2('2.2 操作系统与硬件'));
  out.push(makeTable(
    ['节点 IP', '操作系统版本', '生命周期', 'OS 内核', 'CPU 型号', '核心数', '内存总量', '内存使用率'],
    data.nodes.map(n => [
      n.ip,
      n.osRelease || '-',
      osLifecycleLabel(n),
      truncate(n.osKernel, 50),
      truncate(n.cpuModel, 40),
      n.cpuCores != null ? `${n.cpuCores} 核` : '-',
      n.memTotal || '-',
      n.memUsagePct ? `${n.memUsagePct}%` : '-',
    ]),
    'OS / 硬件配置',
  ));
  const eolNodes = data.nodes.filter(n => n.osEolStatus?.status === 'eol');
  if (eolNodes.length > 0) {
    out.push(noteParagraph(`操作系统版本已停止维护：${eolNodes.map(n => `${n.ip} ${n.osEolStatus.major}`).join('、')}。EOL 系统不再获得官方安全补丁，建议纳入主机升级或替换计划。`));
  }
  out.push(emptyLine());

  out.push(h2('2.3 内存与 Swap'));
  out.push(makeTable(
    ['节点 IP', '内存总量', '内存已用', '内存使用率', 'Swap 总量', 'Swap 已用', 'Swap 使用率'],
    data.nodes.map(n => {
      const swapPct = Number(n.swapUsagePct || 0);
      const swapWarn = swapPct > 0;
      return [
        n.ip,
        n.memTotal || '-',
        n.memUsed || '-',
        n.memUsagePct ? `${n.memUsagePct}%` : '-',
        n.swapTotal || '-',
        { text: n.swapUsed || '-', color: swapWarn ? 'C00000' : COLOR.text, bold: swapWarn },
        { text: n.swapUsagePct != null ? `${n.swapUsagePct}%` : '-', color: swapWarn ? 'C00000' : COLOR.text, bold: swapWarn },
      ];
    }),
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

  // 磁盘使用率柱状图（每节点 /data 挂载点）
  if (charts) {
    const dataPoints = [];
    for (const n of data.nodes) {
      const dataMount = (n.disks || []).find(d => d.mount === '/data') || (n.disks || []).find(d => d.mount === '/');
      if (dataMount) {
        const pct = parseInt((dataMount.usePct || '0').replace('%', '')) || 0;
        let color = charts.COLORS.good;
        if (pct >= 90) color = charts.COLORS.p0;
        else if (pct >= 80) color = charts.COLORS.p1;
        else if (pct >= 70) color = charts.COLORS.p2;
        dataPoints.push({ label: `${n.ip}\n${dataMount.mount}`, value: pct, color });
      }
    }
    if (dataPoints.length > 0) {
      const p = chartParagraph(() => charts.hbar(dataPoints, {
        title: '磁盘使用率（关键挂载点）', max: 100,
        format: v => `${v}%`,
        width: 600, height: Math.max(180, 60 + dataPoints.length * 32),
      }), { width: 600, height: Math.max(180, 60 + dataPoints.length * 32) });
      if (p) out.push(p);
    }
  }

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
  if (charts) {
    out.push(para([{ text: '连接使用率', bold: true, color: COLOR.secondary }]));
    const points = data.nodes.map(n => {
      const maxConn = Number(n.variables?.max_connections || 0);
      const used = Number(n.threadsConnected || 0);
      const pct = maxConn > 0 ? used / maxConn * 100 : 0;
      return {
        label: `${n.ip}\n${roleLabel(n.role)}`,
        value: Math.round(pct * 10) / 10,
        color: pct >= 80 ? charts.COLORS.p0 : pct >= 60 ? charts.COLORS.p1 : charts.COLORS.good,
      };
    });
    const h = Math.max(180, 60 + points.length * 34);
    const p = chartParagraph(() => charts.hbar(points, {
      title: '连接使用率（Threads / max_connections）',
      max: 100,
      format: v => `${v}%`,
      width: 600,
      height: h,
    }), { width: 600, height: h });
    if (p) out.push(p);
  }
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
  if (charts) {
    const totals = { Sleep: 0, Query: 0, Connect: 0, 'Binlog Dump': 0, Other: 0 };
    for (const n of data.nodes) {
      for (const p of (n.processlist || [])) {
        const cmd = (p.command || '').toLowerCase();
        if (cmd === 'sleep') totals.Sleep++;
        else if (cmd === 'query') totals.Query++;
        else if (cmd === 'connect') totals.Connect++;
        else if (/binlog/i.test(p.command || '')) totals['Binlog Dump']++;
        else totals.Other++;
      }
    }
    const slices = Object.entries(totals)
      .filter(([, value]) => value > 0)
      .map(([label, value], idx) => ({ label, value, color: charts.COLORS.series[idx % charts.COLORS.series.length] }));
    if (slices.length > 0) {
      const p = chartParagraph(() => charts.pie(slices, {
        title: 'Processlist 命令分布',
        width: 520,
        height: 260,
      }), { width: 520, height: 260 });
      if (p) out.push(p);
    }
  }
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
  } else {
    out.push(noteParagraph('长会话需先确认业务上下文。若处于 Sending data、Copying to tmp table 等状态且持续增长，可能占用 IO/CPU 或拖慢 purge；确认异常后再由 DBA 执行 KILL CONNECTION。'));
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
  // v4.8：单节点场景下 "主从一致"/"主 0/从 1"/"各节点唯一" 等多节点措辞需要替换
  const isSingleNode = data.cluster.nodeCount === 1;
  const out = [h1('五、关键配置参数对比'), h2('5.1 核心参数')];
  out.push(para(isSingleNode ? '本节点关键参数（巡检时实际值）：' : '全节点关键参数对比（巡检时实际值）：'));
  out.push(emptyLine());

  // 默认建议（多节点）→ 单节点对应措辞
  const keys = [
    ['MySQL 版本', 'mysqlVersion',                isSingleNode ? '-'                      : '主从一致'],
    ['server_id', 'server_id',                    isSingleNode ? '本节点唯一标识'         : '各节点唯一'],
    ['innodb_buffer_pool_size (MB)', 'innodb_buffer_pool_size_in_mb', '建议为内存的 50-70%'],
    ['innodb_buffer_pool_instances', 'innodb_buffer_pool_instances', '建议 ≥8'],
    ['innodb_log_file_size (MB)', 'innodb_log_file_size_in_mb', '建议 ≥512MB'],
    ['innodb_flush_log_at_trx_commit', 'innodb_flush_log_at_trx_commit', '主库建议 1'],
    ['sync_binlog', 'sync_binlog',                '主库建议 1'],
    ['max_connections', 'max_connections',        '按业务并发设定'],
    ['binlog_format', 'binlog_format',            '建议 ROW'],
    ['gtid_mode', 'gtid_mode',                    '建议 ON'],
    ['enforce_gtid_consistency', 'enforce_gtid_consistency', '建议 ON'],
    ['read_only', 'read_only',                    isSingleNode ? '主库建议 0（除非只读主场景）' : '主 0 / 从 1'],
    ['expire_logs_days', 'expire_logs_days',      '建议 7-15 天'],
    ['long_query_time', 'long_query_time',        '建议 1s'],
    ['slow_query_log', 'slow_query_log',          '建议 ON'],
    ['transaction_isolation', 'transaction_isolation', '建议 READ-COMMITTED'],
    ['innodb_flush_method', 'innodb_flush_method', '建议 O_DIRECT'],
    ['innodb_file_per_table', 'innodb_file_per_table', '建议 1'],
    ['open_files_limit', 'open_files_limit',      '建议 ≥65535'],
    ['table_open_cache', 'table_open_cache',      '建议 4000-8000'],
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

  // 配置差异（带 ✅/❌ 自动判断）— v4.8：单节点跳过节点间对比
  out.push(h2('5.2 参数差异分析'));
  if (isSingleNode) {
    out.push(para('本次仅采集单节点，不涉及节点间参数差异分析。如该实例属于主从集群，建议补充采集从库 txt 后重新出报告，以校验主从参数一致性。'));
  } else {
    const judgments = data.paramJudgments || [];
    if (judgments.length > 0) {
      out.push(para('各节点间检测到以下参数差异，已自动标注是否需要统一：'));
      out.push(emptyLine());
      const jRows = judgments.map(j => [
        j.key,
        j.valueMap || j.unique.join(' / '),
        j.ok ? '✅ 正常' : '❌ 需关注',
        j.reason,
      ]);
      out.push(makeTable(
        ['参数', '节点取值', '判断', '说明'],
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

  // Buffer Pool 命中率柱状图
  if (charts) {
    const groups = [];
    for (const n of data.nodes) {
      const hit = n.innodb?.bufferPoolHitRate;
      if (!hit) continue;
      const parts = hit.split('/').map(s => Number(s.trim()));
      const pct = parts[1] ? (parts[0] / parts[1] * 100) : 0;
      groups.push({ label: n.ip, series: [{ name: 'Buffer Pool 命中率', value: Math.round(pct * 10) / 10, color: pct >= 99 ? charts.COLORS.good : pct >= 95 ? charts.COLORS.warn : charts.COLORS.bad }] });
    }
    if (groups.length > 0) {
      const p = chartParagraph(() => charts.vbar(groups, {
        title: 'Buffer Pool 命中率（推荐 ≥99%）',
        max: 100, formatY: v => v.toFixed(0) + '%', formatV: v => v.toFixed(1) + '%',
        showValues: true, width: 600, height: 280,
      }), { width: 600, height: 280 });
      if (p) out.push(p);
    }
  }
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

  // TOP10 横向柱状图
  if (charts && (refNode.topTables || []).length > 0) {
    const points = refNode.topTables.slice(0, 10).map(t => ({
      label: t.table.length > 24 ? t.table.slice(0, 22) + '…' : t.table,
      value: Number(t.sizeGB) || 0,
      color: ARCHIVE_RE.test(t.table) ? charts.COLORS.p1 : charts.COLORS.primary,
    }));
    const p = chartParagraph(() => charts.hbar(points, {
      title: 'TOP 10 大表（GB，橙色=历史归档）',
      format: v => v.toFixed(1) + ' GB',
      width: 640, height: Math.max(180, 60 + points.length * 32),
    }), { width: 640, height: Math.max(180, 60 + points.length * 32) });
    if (p) out.push(p);
  }

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
  const fragTotalGB = sigFrags.reduce((s, t) => s + Number(t.dataFree), 0) / 1073741824;
  if (sigFrags.length === 0) {
    out.push(noteParagraph('未发现需关注的高碎片大表。'));
  } else {
    out.push(noteParagraph(`重建后可回收约 ${fragTotalGB.toFixed(1)} GB 空间。大表（≥10GB）推荐 pt-online-schema-change 在线重建，避免锁表。`));
  }
  out.push(emptyLine());

  // 评审 #12 (v4.4)：可释放空间汇总（碎片 + 历史归档），帮助客户快速看到清理收益
  const archiveTotalGB = archives.reduce((s, t) => s + Number(t.sizeGB || 0), 0);
  const releasableGB = fragTotalGB + archiveTotalGB;
  if (releasableGB >= 1) {
    const dbTotalGB = Number(refNode.dbTotalSizeGB) || 0;
    const pctText = dbTotalGB > 0
      ? `，相当于主库当前数据量（${dbTotalGB.toFixed(0)} GB）的约 ${((releasableGB / dbTotalGB) * 100).toFixed(0)}%`
      : '';
    out.push(para([
      { text: '💡 可释放空间汇总：', bold: true, color: '1F6FEB' },
      { text: `本次巡检识别可释放空间合计约 ${releasableGB.toFixed(0)} GB（其中碎片可回收 ${fragTotalGB.toFixed(0)} GB + 历史归档表可清理 ${archiveTotalGB.toFixed(0)} GB）${pctText}。`, bold: true },
    ]));
    out.push(noteParagraph('建议优先级：① 高优先级重建碎片大表（≥10GB） → ② 评估历史归档表导出冷存或改造分区 → ③ 评估清理后扩容时间窗的延后效应。'));
    out.push(emptyLine());
  }

  out.push(h2('7.4 无主键表'));
  // 评审 #14 (v4.4)：v4.3 一次性列出 30+ 张无主键表（含临时/字典/历史表）噪声严重；
  // 改为按类型分组、只展开 TOP 10 业务表，临时/历史/字典表只显示分类计数。
  const noPkAll = refNode.noPkTables || [];
  const noPkSummary = summarizeTableCategories(noPkAll);
  out.push(noteParagraph(`无主键表分类汇总：业务表 ${noPkSummary.business} 张，历史/归档表 ${noPkSummary.history} 张，临时/测试表 ${noPkSummary.temp} 张。`));
  // 业务表按行数（若可得）/ 表名排序，取前 10
  const noPkBiz = noPkAll
    .filter(t => tableCategory(t.table).key === 'business')
    .sort((a, b) => Number(b.rows || 0) - Number(a.rows || 0) || String(a.table).localeCompare(b.table));
  const bizTop = noPkBiz.slice(0, 10);
  const bizTopRows = bizTop.map(t => [
    t.schema, t.table,
    t.rows != null ? Number(t.rows).toLocaleString() : '-',
    '业务表',
    '补充自增主键或唯一索引',
  ]);
  out.push(makeTable(
    ['库名', '表名', '估算行数', '类型', '建议'],
    bizTopRows,
    `业务表无主键 TOP 10（按行数排序，共 ${noPkBiz.length} 张业务表）`,
  ));
  if (noPkBiz.length > bizTop.length) {
    out.push(noteParagraph(`另有 ${noPkBiz.length - bizTop.length} 张业务表未在表中展示，完整清单见 data.json (noPkTables) 或单独导出。`));
  }
  // 历史/归档表 + 临时/测试表 折叠为单行计数
  if (noPkSummary.history > 0 || noPkSummary.temp > 0) {
    const histExamples = noPkAll.filter(t => tableCategory(t.table).key === 'history').slice(0, 5).map(t => `${t.schema}.${t.table}`).join('、');
    const tempExamples = noPkAll.filter(t => tableCategory(t.table).key === 'temp').slice(0, 5).map(t => `${t.schema}.${t.table}`).join('、');
    const collapsed = [];
    if (noPkSummary.history > 0) collapsed.push(`历史/归档表 ${noPkSummary.history} 张${histExamples ? '（示例：' + histExamples + (noPkSummary.history > 5 ? ' 等' : '') + '）' : ''}`);
    if (noPkSummary.temp > 0) collapsed.push(`临时/测试/字典表 ${noPkSummary.temp} 张${tempExamples ? '（示例：' + tempExamples + (noPkSummary.temp > 5 ? ' 等' : '') + '）' : ''}`);
    out.push(noteParagraph(`已折叠：${collapsed.join('；')} — 建议确认是否仍被业务访问，满足条件后归档或清理。`));
  }
  out.push(emptyLine());
  out.push(noteParagraph('无主键表在 ROW 格式复制下从库需全表扫描匹配行，复制效率极低且无法 MTS 并行复制。正式业务表建议补充主键；历史、临时、测试类表建议确认是否仍被业务访问，满足条件后归档或清理。'));
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
  out.push(noteParagraph('V3 采集脚本已采集 innodb_tablespaces（含 ibtmp1）。当前占用来自 innodb_tablespaces 返回的 ibtmp1 行；若显示未返回，表示采集时该查询未返回 ibtmp1 记录或权限/版本视图受限，并非渲染错误。'));
  out.push(emptyLine());
  out.push(makeTable(
    ['节点 IP', '角色', '当前占用', '初始大小', '自动扩展', '采集状态', '配置 (innodb_temp_data_file_path)'],
    data.nodes.map(n => [
      n.ip, roleLabel(n.role),
      n.ibtmp1?.sizeFormatted || '-',
      n.ibtmp1?.initialSize || '-',
      n.ibtmp1?.autoExtendSize || '-',
      ibtmp1StatusLabel(n),
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
  // v4.9.5：根据节点实际配置生成建议，避免「已配置 :max:」也提醒「设置上限」
  const nodesNoMax = data.nodes.filter(n => {
    const cfg = n.variables?.innodb_temp_data_file_path || '';
    return cfg && !/:max:/i.test(cfg);
  });
  const nodesWithMax = data.nodes.filter(n => /:max:/i.test(n.variables?.innodb_temp_data_file_path || ''));
  const oversizeNodes = data.nodes.filter(n => n.ibtmp1?.sizeBytes && n.ibtmp1.sizeBytes > 5 * 1073741824);

  if (nodesNoMax.length > 0) {
    out.push(para(`短期：${nodesNoMax.length} 个节点（${nodesNoMax.map(n => n.ip).join('、')}）尚未配置 :max: 上限，建议在 my.cnf 中加入：`));
    out.push(code('innodb_temp_data_file_path = ibtmp1:12M:autoextend:max:50G'));
    out.push(para('重启后 ibtmp1 将重建为 12MB 初始大小，最大增长至 50GB（达到上限后报错 1114 而非耗尽磁盘）。'));
  } else if (data.nodes.length > 0) {
    out.push(noteParagraph(`✓ 全部节点的 innodb_temp_data_file_path 已配置 :max: 上限（${nodesWithMax[0].variables.innodb_temp_data_file_path}），无需调整。`));
  }

  if (oversizeNodes.length > 0) {
    out.push(emptyLine());
    out.push(para(`当前已偏大节点：${oversizeNodes.map(n => `${n.ip} (${n.ibtmp1.sizeFormatted})`).join('、')} — 可在维护窗口重启 MySQL 让 ibtmp1 重建回收空间。`));
  }
  out.push(emptyLine());
  out.push(para('中期：通过慢查询日志定位触发临时表的 SQL（filesort / Using temporary），优化业务查询从源头降低 ibtmp1 增长速度。'));
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
  out.push(para('采集脚本已采集 INNODB LOCKS / INNODB LOCK WAITS / INNODB TRX / Metadata locks，并补充 Lock status counters 累计指标。'));
  const waitRows = [];
  const counterRows = [];
  for (const n of data.nodes) {
    const waits = (n.innodbLockWaits || []).length + (n.innodbLockDetails || []).length;
    const metadata = (n.metadataLocks || []).length;
    if (waits > 0 || metadata > 0) {
      waitRows.push([n.ip, waits, metadata, '存在锁等待，需结合 SQL 与事务线程定位阻塞源']);
    }
    const c = n.lockStatusCounters || {};
    counterRows.push([
      n.ip,
      c.Innodb_row_lock_current_waits ?? '-',
      c.Innodb_row_lock_waits ?? '-',
      c.Innodb_row_lock_time_avg ?? '-',
      c.Table_locks_waited ?? '-',
    ]);
  }
  out.push(makeTable(
    ['节点 IP', '当前行锁等待', '累计行锁等待', '平均等待(ms)', '累计表锁等待'],
    counterRows,
    '锁等待累计指标',
  ));
  if (waitRows.length > 0) {
    out.push(makeTable(['节点 IP', '行锁等待记录', '元数据锁记录', '建议'], waitRows, '采集时刻锁等待明细汇总'));
  } else {
    out.push(noteParagraph('本次采集时 INNODB LOCKS / INNODB LOCK WAITS / LOCK DETAILS / Metadata locks 未返回等待记录，说明采集瞬间未发现阻塞；该结论不代表历史上没有发生过锁等待，历史趋势需结合监控或错误日志判断。'));
  }
  out.push(emptyLine());

  // v4.9.6：10.4 错误日志摘要 — 之前数据已采集（n.errorLogAnalysis）但未渲染
  out.push(h2('10.4 错误日志摘要'));
  const nodesWithLog = data.nodes.filter(n => n.errorLogAnalysis?.available);
  if (nodesWithLog.length === 0) {
    out.push(noteParagraph('本次采集中错误日志均不可读 / 未启用 / 未采集。'));
    return out;
  }

  const logSummaryRows = nodesWithLog.map(n => {
    const a = n.errorLogAnalysis;
    const path = (n.errorLogStatus || '').match(/log_error:\s*(\S+)/)?.[1] || '-';
    const span = (a.firstTs && a.lastTs) ? `${a.firstTs} → ${a.lastTs}` : '-';
    const age = a.ageDays != null
      ? (a.ageDays === 0 ? '今日' : a.ageDays + ' 天前')
      : '-';
    const realErrCnt = `${a.recentErrors} 近期 / ${a.historicalErrors} 历史`;
    const realWarnCnt = `${a.recentWarnings} 近期 / ${a.historicalWarnings} 历史`;
    return [n.ip, path, n.errorLogSizeBytes ? formatBytesNum(n.errorLogSizeBytes) : '-', span, age, realErrCnt, realWarnCnt, a.deprecatedCount > 0 ? a.deprecatedCount + ' 条' : '-'];
  });
  out.push(makeTable(
    ['节点 IP', '错误日志路径', '文件大小', '采集时间跨度', '最后一条距今', `真实错误（${nodesWithLog[0].errorLogAnalysis.recentDaysWindow}天内/历史）`, '真实警告（同上）', '8.0 deprecation 提示'],
    logSummaryRows,
    `错误日志采集摘要（采集行数：tail ${nodesWithLog[0].errorLogAnalysis.totalLines} 行）`,
  ));
  out.push(emptyLine());

  // 整体诊断：日志静默 vs 活跃
  const allStale = nodesWithLog.every(n => n.errorLogAnalysis.ageDays > 30);
  const anyActive = nodesWithLog.some(n => n.errorLogAnalysis.recentErrors > 0 || n.errorLogAnalysis.recentWarnings > 5);
  if (allStale) {
    out.push(noteParagraph(`✓ 所有节点错误日志最后一条均在 30 天前 — 说明数据库长期稳定运行，近期未触发新的错误或警告。${nodesWithLog[0].errorLogAnalysis.spanDays != null ? `（日志总跨度 ${nodesWithLog[0].errorLogAnalysis.spanDays} 天，多为历史记录。）` : ''}`));
  } else if (anyActive) {
    out.push(noteParagraph('近期（采集时间窗口内）发现真实错误或警告，建议下方 TOP 模式表逐项核查。'));
  }
  out.push(emptyLine());

  // TOP 错误模式聚合（所有节点合并）
  const aggPatterns = (kind) => {
    const map = new Map();
    for (const n of nodesWithLog) {
      const arr = n.errorLogAnalysis['top' + kind] || [];
      for (const p of arr) {
        const e = map.get(p.sample) || { sample: p.sample, count: 0, recentCount: 0, ips: new Set(), lastTs: p.lastTs };
        e.count += p.count;
        e.recentCount += (p.recentCount || 0);
        e.ips.add(n.ip);
        if (p.lastTs && (!e.lastTs || p.lastTs > e.lastTs)) e.lastTs = p.lastTs;
        map.set(p.sample, e);
      }
    }
    return [...map.values()].sort((a, b) => b.count - a.count).slice(0, 5);
  };

  const topErrors = aggPatterns('Errors');
  if (topErrors.length > 0) {
    out.push(para([{ text: '🔴 TOP 错误模式（按出现次数）：', bold: true }]));
    out.push(makeTable(
      ['模式样例', '总次数', '近期次数', '出现节点', '最近时间'],
      topErrors.map(e => [truncate(e.sample, 100), e.count, e.recentCount, [...e.ips].join('、'), e.lastTs || '-']),
      '错误日志 TOP 错误模式',
    ));
    out.push(emptyLine());
  }

  const topWarnings = aggPatterns('Warnings');
  if (topWarnings.length > 0) {
    out.push(para([{ text: '🟠 TOP 警告模式：', bold: true }]));
    out.push(makeTable(
      ['模式样例', '总次数', '近期次数', '出现节点', '最近时间'],
      topWarnings.map(e => [truncate(e.sample, 100), e.count, e.recentCount, [...e.ips].join('、'), e.lastTs || '-']),
      '错误日志 TOP 警告模式',
    ));
    out.push(emptyLine());
  }

  // Deprecation 提示折叠为一行
  const totalDeprecated = nodesWithLog.reduce((s, n) => s + (n.errorLogAnalysis.deprecatedCount || 0), 0);
  if (totalDeprecated > 0) {
    const sample = nodesWithLog.find(n => n.errorLogAnalysis.deprecatedTop?.length > 0)?.errorLogAnalysis.deprecatedTop[0];
    out.push(noteParagraph(`ℹ️ 共采集到 ${totalDeprecated} 条 MySQL 8.0 deprecation 警告（如 log_slave_updates → log_replica_updates 等参数重命名提示）— 不影响运行，仅在未来升级 8.4+ 时需要调整。示例：${sample?.sample?.slice(0, 120) || '-'}`));
  }

  out.push(noteParagraph('注：「近期 / 历史」按错误日志最后一条时间向前回溯 90 天划分；日志模式按内容签名去重，反复打印的同一类信息只算一类。'));

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

  // host=% 用户按危险等级分组（v4.8：每 (等级,原因) 聚合为 1 行，列出所有用户）
  out.push(h2('11.2 host=% 用户分级'));
  const wildcards = (primary.users || []).filter(u => u.host === '%');
  if (wildcards.length === 0) {
    out.push(para('未发现 host=% 的用户，账号策略合规。'));
  } else {
    const classify = (user) => {
      const u = (user || '').toLowerCase();
      if (u === 'root' || /admin|dba|super/.test(u)) return { level: 'critical', label: '🔴 关键', reason: 'root / 管理员账号' };
      if (u === 'repl' || /replic/.test(u)) return { level: 'high', label: '🔴 高危', reason: '复制账号，应限制为复制源 IP' };
      if (/backup|dump/.test(u)) return { level: 'high', label: '🟠 高危', reason: '备份账号，权限较广' };
      if (/zabbix|prometheus|nagios|monitor|exporter/.test(u)) return { level: 'low', label: '🟢 低危', reason: '监控只读账号' };
      if (/^ro|readonly/.test(u)) return { level: 'low', label: '🟢 低危', reason: '只读账号' };
      return { level: 'medium', label: '🟡 中危', reason: '业务账号' };
    };
    // 按 (level, reason) 聚合：同等级 + 同原因的多个用户合并为一行
    const groupKey = (c) => `${c.level}|${c.reason}`;
    const groups = new Map();
    wildcards.forEach(u => {
      const c = classify(u.user);
      const key = groupKey(c);
      if (!groups.has(key)) groups.set(key, { level: c.level, label: c.label, reason: c.reason, users: [] });
      groups.get(key).users.push(u.user);
    });
    const lvlOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    const advice = (lvl) => lvl === 'low' ? '可保留' : lvl === 'medium' ? '建议缩限网段' : '建议优先收紧到具体 IP/网段';
    const sortedGroups = [...groups.values()].sort((a, b) => lvlOrder[a.level] - lvlOrder[b.level]);
    const rows = sortedGroups.map(g => [
      g.label,
      g.users.length === 1 ? g.users[0] : `${g.users.join('、')}（共 ${g.users.length} 个）`,
      '%',
      g.reason,
      advice(g.level),
    ]);
    out.push(makeTable(
      ['等级', '用户', '主机', '类型', '建议'],
      rows,
      `host=% 用户清单（${wildcards.length} 个用户、${sortedGroups.length} 类，按危险等级排序）`,
    ));
    out.push(emptyLine());

    // 高危/致命 警示行（仍然展示具体用户名以便修复）
    const criticalUsers = sortedGroups.filter(g => g.level === 'critical' || g.level === 'high').flatMap(g => g.users);
    if (criticalUsers.length > 0) {
      out.push(para([
        { text: `⚠ 建议优先收紧 ${criticalUsers.length} 个高风险账号：`, bold: true, color: 'C00000' },
        { text: criticalUsers.join('、') },
      ]));
    }
  }
  out.push(emptyLine());

  // v4.8：11.3 安全建议 — 按实际情况条件渲染，避免「无 root@% 却建议 DROP root@%」之类无效告警
  out.push(h2('11.3 安全建议'));
  const criticalWildcards = wildcards.filter(u => /^root$/i.test(u.user) || /admin|dba|super/i.test(u.user));
  const replWildcards = wildcards.filter(u => /^repl$/i.test(u.user) || /replic/i.test(u.user));
  const backupWildcards = wildcards.filter(u => /backup|dump/i.test(u.user));
  const isMySQL57 = /^5\.7/.test(primary.mysqlVersion || '');

  if (criticalWildcards.length > 0) {
    const sqls = criticalWildcards.map(u => `DROP USER '${u.user}'@'%';`).join(' ');
    out.push(bullet(`建议优先收紧 host=% 的 root / 管理员账号（${criticalWildcards.map(u => u.user).join('、')}）：${sqls}`));
  }
  if (replWildcards.length > 0) {
    const name = replWildcards[0].user;
    out.push(bullet(`复制账号 ${replWildcards.map(u => u.user).join('、')} 应限制为从库 IP 列表：CREATE USER '${name}'@'<slave_net/mask>' ...`));
  }
  if (backupWildcards.length > 0) {
    out.push(bullet(`备份账号 ${backupWildcards.map(u => u.user).join('、')} 权限较广，应限制为执行备份的固定主机/网段`));
  }
  // 通用建议（始终展示）
  out.push(bullet('为业务账号设置 password_lifetime（强制定期改密）'));
  if (isMySQL57) {
    out.push(bullet('MySQL 5.7 默认 mysql_native_password 插件，建议评估迁移到 caching_sha2_password'));
  }
  out.push(bullet('定期审计权限，回收离职人员账号'));
  // 如果没有任何 host=% 用户，给一句正面反馈
  if (wildcards.length === 0) {
    out.push(noteParagraph('本节点未发现 host=% 用户，账号策略整体合规。'));
  }
  return out;
}

function chapterReplication(data) {
  const out = [h1('十二、主从复制状态'), h2('12.1 复制拓扑')];
  const primary = data.nodes.find(n => n.role === 'primary');
  const gtid = primary?.variables?.gtid_mode || '-';
  // v4.5：真从库 = 实际在复制（不是 self-ref 残留）
  const realSlaves = data.nodes.filter(n => n.replication?.isSlave);
  const isSingleNode = data.nodes.length === 1;
  const hasNoRealSlaves = realSlaves.length === 0;

  out.push(para(isSingleNode
    ? `本次仅采集单节点，无主从复制配置；GTID 模式：${gtid}。`
    : `集群采用 ${data.cluster.topology}，GTID 模式：${gtid}。`));
  if (primary?.replication?.slaveIps?.length) {
    out.push(para(`主库 ${primary.ip} 检测到从库 IP：${primary.replication.slaveIps.join('、')}`));
  }
  // v4.5：单节点 / 仅采集主库场景的明确提示，避免空表误导客户
  if (isSingleNode) {
    out.push(noteParagraph('本次仅采集到单个节点（未提供从库 txt）。如该集群实际配置了主从复制，建议补充采集从库数据后重新出报告；如本就是独立单实例，可忽略本章节中与"从库"相关的小节。'));
  } else if (hasNoRealSlaves) {
    out.push(noteParagraph('本次采集的所有节点均不是从库（未发现真实复制关系）。如该集群预期存在主从复制，请确认采集是否完整。'));
  }
  // v4.5：self-referencing slave 残留提示
  const selfRefNodes = data.nodes.filter(n => n.replication?.selfReferencingSlaveResidue);
  if (selfRefNodes.length > 0) {
    out.push(noteParagraph(`检测到 ${selfRefNodes.length} 个节点存在 SHOW SLAVE STATUS 残留（Master_Host 指向本机自身）：${selfRefNodes.map(n => n.ip).join('、')}。这通常是历史从库被提升为主后未执行 RESET SLAVE ALL 留下的元数据，不影响主库职能但建议清理。`));
  }
  out.push(emptyLine());

  // v4.5：只有真从库存在时才渲染 12.2 从库状态表
  if (!hasNoRealSlaves) {
    out.push(h2('12.2 从库复制状态'));
    const fmtBreak = (secs) => {
      if (secs == null) return '-';
      if (secs < 60) return `${secs}s`;
      if (secs < 3600) return `${Math.floor(secs/60)}m`;
      if (secs < 86400) return `${Math.floor(secs/3600)}h${Math.floor((secs%3600)/60)}m`;
      return `${Math.floor(secs/86400)}d${Math.floor((secs%86400)/3600)}h`;
    };
    const fmtRelaySpace = (bytesStr) => {
      if (!bytesStr) return '-';
      const b = Number(bytesStr);
      if (isNaN(b)) return '-';
      if (b >= 1073741824) return (b/1073741824).toFixed(1) + ' GB';
      if (b >= 1048576) return (b/1048576).toFixed(0) + ' MB';
      if (b >= 1024) return (b/1024).toFixed(0) + ' KB';
      return b + ' B';
    };
    const slaveRows = realSlaves.map(n => {
      const s = n.replication.status || {};
      const ioDown = s.slaveIoRunning === 'No' || s.slaveIoRunning === 'Connecting';
      const sqlDown = s.slaveSqlRunning === 'No';
      const ioBreak = ioDown ? fmtBreak(s.ioBreakSeconds) : '-';
      const sqlBreak = sqlDown ? fmtBreak(s.sqlBreakSeconds) : '-';
      const breakCell = (ioDown || sqlDown)
        ? `${ioDown ? 'IO:' + ioBreak : ''}${(ioDown && sqlDown) ? ' ' : ''}${sqlDown ? 'SQL:' + sqlBreak : ''}`
        : '-';
      return [
        n.ip, s.masterHost || '-',
        s.slaveIoRunning || '-',
        s.slaveSqlRunning || '-',
        s.masterLogFile || '-',
        s.readMasterLogPos || '-',
        s.secondsBehindMaster != null ? `${s.secondsBehindMaster} s` : '-',
        fmtRelaySpace(s.relayLogSpace),
        breakCell,
      ];
    });
    out.push(makeTable(
      ['从库 IP', '主库地址', 'IO 线程', 'SQL 线程', '主库 binlog', '已读位置', '延迟', 'Relay积压', '中断时长'],
      slaveRows,
      '从库复制状态',
    ));
    out.push(emptyLine());
  } else if (selfRefNodes.length > 0) {
    // 即使没真从库，self-ref 残留细节也单独列出来便于 DBA 清理
    out.push(h2('12.2 SHOW SLAVE STATUS 残留详情'));
    const residueRows = selfRefNodes.map(n => {
      const r = n.replication.selfReferencingSlaveResidue;
      return [n.ip, r.masterHost, r.slaveIoRunning || '-', r.slaveSqlRunning || '-', 'STOP SLAVE; RESET SLAVE ALL;'];
    });
    out.push(makeTable(
      ['节点 IP', 'Master_Host (指向自身)', 'IO 线程', 'SQL 线程', '建议清理 SQL'],
      residueRows,
      'self-referencing slave 残留',
    ));
    out.push(emptyLine());
  }

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
  // 评审 #6 (v4.4)：从 issues[] 引用复制相关风险，消除手写文案与 issue 描述的数字冲突
  const replIssueTypes = new Set([
    'gtid_off',
    'slave_parallel_workers_zero',
    'sync_binlog_weak',
    'repl_delay_high',
    'repl_delay_low',
    'repl_thread_down',
    'replica_io_running_no',
    'replica_sql_running_no',
    'self_ref_slave_residue',
  ]);
  const replIssues = (data.issues || []).filter(i => replIssueTypes.has(i.type));
  if (replIssues.length === 0) {
    // v4.6：单节点无主从，避免误导性的"复制配置合理"措辞
    out.push(bullet(isSingleNode
      ? '本次仅采集单节点，无主从复制可分析；如该实例属于主从集群，建议补充采集从库 txt 后重新出报告'
      : '复制配置整体合理，建议持续监控 Seconds_Behind_Master 与从库报错日志'));
  } else {
    for (const i of replIssues) {
      const action = i.action ? `（${i.action}）` : '';
      out.push(bullet(`${i.description}${action}`));
    }
  }

  // 12.5 双主专项：行数对比（仅在双主拓扑时渲染）
  const dmNodes = data.nodes.filter(n => n.isDualMaster);
  if (dmNodes.length >= 2) {
    out.push(emptyLine());
    out.push(h2('12.5 双主数据一致性对比'));
    out.push(para('双主互为主从时，两端数据量差异可辅助判断数据是否已出现分叉。以下为各端 TOP 表行数对比（基于采集时快照，仅供参考；精确核对需用 pt-table-checksum）。'));

    const [nodeA, nodeB] = dmNodes;
    // 汇总 DB 总大小对比
    const sizeA = nodeA.dbTotalSizeGB || '-';
    const sizeB = nodeB.dbTotalSizeGB || '-';
    out.push(makeTable(
      ['节点', '角色', '数据库总大小'],
      [
        [nodeA.ip, roleLabel(nodeA.role), sizeA],
        [nodeB.ip, roleLabel(nodeB.role), sizeB],
      ],
      '双主数据量对比',
    ));
    out.push(emptyLine());

    // TOP 表行数对比
    const tablesA = nodeA.topTables || [];
    const tablesB = nodeB.topTables || [];
    // 取两端 TOP 表并集，按 schema.table 匹配
    const tableKeys = new Set([
      ...tablesA.map(t => `${t.schema}.${t.table}`),
      ...tablesB.map(t => `${t.schema}.${t.table}`),
    ]);
    if (tableKeys.size > 0) {
      const mapA = new Map(tablesA.map(t => [`${t.schema}.${t.table}`, t]));
      const mapB = new Map(tablesB.map(t => [`${t.schema}.${t.table}`, t]));
      const compareRows = [...tableKeys].slice(0, 20).map(key => {
        const tA = mapA.get(key);
        const tB = mapB.get(key);
        const rowsA = tA?.rows ?? '-';
        const rowsB = tB?.rows ?? '-';
        const diff = (rowsA !== '-' && rowsB !== '-' && rowsA !== rowsB) ? '⚠ 差异' : '';
        return [key, rowsA, rowsB, diff];
      });
      out.push(makeTable(
        ['表', `${nodeA.ip} 行数`, `${nodeB.ip} 行数`, '一致性'],
        compareRows,
        '双主 TOP 表行数对比',
      ));
      const hasDiff = compareRows.some(r => r[3]);
      if (hasDiff) {
        out.push(noteParagraph('发现两端行数不一致的表（标记 ⚠）。建议用 pt-table-checksum 做精确校验，并用 pt-table-sync 修复差异数据。'));
      } else {
        out.push(para('TOP 表行数两端一致，暂无明显数据分叉迹象（仅 TOP 表快照对比，非完整校验）。'));
      }
    }
  }

  return out;
}

// ============== 十三、Schema 设计审计（V4 新增）==============
function chapterSchemaDesignAudit(data) {
  const out = [h1('十三、Schema 设计审计')];
  const refNode = data.nodes.find(n => n.role === 'primary') || data.nodes[0];

  out.push(h2('13.1 数据库对象总览'));
  if ((refNode.dbObjects || []).length > 0) {
    const byDb = {};
    for (const o of refNode.dbObjects) {
      byDb[o.db] = byDb[o.db] || { TABLE: 0, EVENT: 0, TRIGGER: 0, PROCEDURE: 0, FUNCTION: 0, VIEW: 0 };
      byDb[o.db][o.type] = o.count;
    }
    const rows = Object.entries(byDb).map(([db, c]) => [db, c.TABLE || 0, c.VIEW || 0, c.PROCEDURE || 0, c.FUNCTION || 0, c.TRIGGER || 0, c.EVENT || 0]);
    out.push(makeTable(['数据库', '表', '视图', '存储过程', '函数', '触发器', '事件'], rows, '业务库对象统计'));
  } else {
    out.push(para('（采集数据中未含对象汇总，请确认 V3 采集脚本运行结果）'));
  }
  out.push(emptyLine());

  out.push(h2('13.2 未使用索引（Schema Unused Indexes）'));
  const unused = refNode.unusedIndexes || [];
  if (unused.length === 0) {
    out.push(para('未检测到未使用索引（或采集源不含该数据）。'));
  } else {
    // v4.9.7：之前只截取 TOP 30，剩余 N - 30 个无任何展示位置，客户无法看到全量
    // 现在补足：分类计数 + TOP 受影响表（聚合）+ TOP 30 明细 + 数据出口 + 三步处置流程
    const unusedSummary = summarizeTableCategories(unused);
    out.push(para([{ text: `检测到 ${unused.length} 个长期未使用的索引（自 MySQL 启动以来从未被读取），占用空间且拖慢写入。`, bold: true }]));
    out.push(noteParagraph(`分类：业务表索引 ${unusedSummary.business} 个 / 历史归档表 ${unusedSummary.history} 个 / 临时/测试表 ${unusedSummary.temp} 个。`));
    out.push(emptyLine());

    // TOP 受影响表（按索引数排序）— 帮 DBA 锁定"哪几张表上无用索引最多"
    const byTable = new Map();
    for (const u of unused) {
      const k = `${u.schema}.${u.table}`;
      const e = byTable.get(k) || { schema: u.schema, table: u.table, indexes: [] };
      e.indexes.push(u.index);
      byTable.set(k, e);
    }
    const topTables = [...byTable.values()].sort((a, b) => b.indexes.length - a.indexes.length).slice(0, 10);
    if (topTables.length > 0 && byTable.size > 3) {
      out.push(para([{ text: `📊 TOP ${Math.min(10, topTables.length)} 受影响表（按未使用索引数排序，共涉及 ${byTable.size} 张表）：`, bold: true }]));
      out.push(makeTable(
        ['库名', '表名', '类型', '未使用索引数', '索引名'],
        topTables.map(t => [t.schema, t.table, tableCategory(t.table).label, t.indexes.length, truncate(t.indexes.join('、'), 100)]),
        `未使用索引 — 受影响表 TOP ${topTables.length}`,
      ));
      out.push(emptyLine());
    }

    // TOP 30 明细（含截断状态）
    const showLimit = 30;
    const rows = unused.slice(0, showLimit).map(u => [u.schema, u.table, tableCategory(u.table).label, u.index]);
    out.push(para([{ text: `📋 明细 TOP ${Math.min(showLimit, unused.length)} 条`, bold: true }, { text: unused.length > showLimit ? `（共 ${unused.length} 条；剩余 ${unused.length - showLimit} 条详见 data.json 的 nodes[].unusedIndexes 字段或附录）` : '' }]));
    out.push(makeTable(['库名', '表名', '类型', '索引名'], rows, `未使用索引明细（${rows.length}/${unused.length}）`));
    out.push(emptyLine());

    // 处置流程：三步走 + 可批量生成 DROP 语句的 SQL
    out.push(para([{ text: '✦ 建议处置流程（三步走）：', bold: true, color: '548235' }]));
    out.push(bullet('① 用以下 SQL 查出每个索引的真实大小，先聚焦"大且无用"的索引：'));
    out.push(code(`SELECT TABLE_SCHEMA, TABLE_NAME, INDEX_NAME,
       ROUND(SUM(STAT_VALUE) * @@innodb_page_size / 1024 / 1024, 2) AS size_mb
FROM mysql.innodb_index_stats
WHERE STAT_NAME = 'size'
  AND INDEX_NAME != 'PRIMARY'
  AND (TABLE_SCHEMA, TABLE_NAME, INDEX_NAME) IN (
    -- 这里粘贴本节明细表里的 (库名, 表名, 索引名) 组合
    ('${unused[0].schema}', '${unused[0].table}', '${unused[0].index}')
    ${unused.length > 1 ? `, ('${unused[1].schema}', '${unused[1].table}', '${unused[1].index}')` : ''}
    -- ...
  )
GROUP BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME
ORDER BY size_mb DESC;`));
    out.push(bullet('② 观察至少 1 个完整业务周期（含月初/月末/促销/月度报表）后再确认；可重置统计后定期复查：'));
    out.push(code(`-- 重置 performance_schema 索引访问统计（重置后从 0 计数，需等 1 周期再看）
TRUNCATE TABLE performance_schema.table_io_waits_summary_by_index_usage;`));
    out.push(bullet('③ 维护窗口批量删除（建议 pt-online-schema-change 在大表上执行避免锁表）：'));
    out.push(code((unused.length <= 5
      ? unused.map(u => `DROP INDEX ${u.index} ON ${u.schema}.${u.table};`).join('\n')
      : unused.slice(0, 3).map(u => `DROP INDEX ${u.index} ON ${u.schema}.${u.table};`).join('\n') + `\n-- 还有 ${unused.length - 3} 条 DROP 语句，可基于明细表批量生成：\n-- awk -F'\\t' '{print "DROP INDEX " $4 " ON " $1 "." $2 ";"}' unused_indexes.tsv`)));
    out.push(emptyLine());
    out.push(noteParagraph('Schema_unused_indexes 视图依赖 performance_schema，结果只反映 MySQL 运行期间未被使用的索引（重启后归零）。业务表索引在删除前**建议至少观察一个完整业务周期**；历史、临时、测试类表建议先评估归档/清理/下线策略后再决定是否单独删索引。完整 N 条清单见 data.json 的 `nodes[].unusedIndexes` 字段。'));
  }
  out.push(emptyLine());

  out.push(h2('13.3 冗余索引'));
  const redundant = refNode.redundantIndexes || [];
  if (redundant.length === 0) {
    out.push(para('未检测到明显冗余索引。'));
  } else {
    // v4.9.7：与 13.2 同样改造，提示截断状态 + 数据出口 + 处置流程
    const redundantSummary = summarizeTableCategories(redundant);
    out.push(para([{ text: `检测到 ${redundant.length} 组冗余索引（左前缀重复或完全覆盖），删除"被覆盖"的索引可直接节省空间并加速写入。`, bold: true }]));
    out.push(noteParagraph(`分类：业务表索引 ${redundantSummary.business} 组 / 历史归档表 ${redundantSummary.history} 组 / 临时/测试表 ${redundantSummary.temp} 组。`));
    out.push(emptyLine());

    // TOP 受影响表（按冗余组数排序）
    const byTableR = new Map();
    for (const r of redundant) {
      const k = `${r.schema}.${r.table}`;
      const e = byTableR.get(k) || { schema: r.schema, table: r.table, count: 0 };
      e.count += 1;
      byTableR.set(k, e);
    }
    const topTablesR = [...byTableR.values()].sort((a, b) => b.count - a.count).slice(0, 10);
    if (topTablesR.length > 0 && byTableR.size > 3) {
      out.push(para([{ text: `📊 TOP ${Math.min(10, topTablesR.length)} 受影响表（按冗余组数排序，共涉及 ${byTableR.size} 张表）：`, bold: true }]));
      out.push(makeTable(
        ['库名', '表名', '类型', '冗余组数'],
        topTablesR.map(t => [t.schema, t.table, tableCategory(t.table).label, t.count]),
        `冗余索引 — 受影响表 TOP ${topTablesR.length}`,
      ));
      out.push(emptyLine());
    }

    // 明细表（含截断状态）
    const showLimitR = 15;
    const rows = redundant.slice(0, showLimitR).map(r => [
      r.schema || '-', r.table || '-', tableCategory(r.table).label,
      r.redundantIndex || '-', r.dominantIndex || '-',
      truncate(r.redundantColumns, 36), truncate(r.dominantColumns, 36),
    ]);
    out.push(para([{ text: `📋 明细 TOP ${Math.min(showLimitR, redundant.length)} 组`, bold: true }, { text: redundant.length > showLimitR ? `（共 ${redundant.length} 组；剩余 ${redundant.length - showLimitR} 组详见 data.json 的 nodes[].redundantIndexes 字段）` : '' }]));
    out.push(makeTable(['库名', '表名', '类型', '冗余索引', '覆盖索引', '冗余列', '覆盖列'], rows, `冗余索引明细（${rows.length}/${redundant.length}）`));
    out.push(emptyLine());

    // 处置流程：三步走
    out.push(para([{ text: '✦ 建议处置流程（三步走）：', bold: true, color: '548235' }]));
    out.push(bullet('① 用 EXPLAIN 复核覆盖关系，确认删除"冗余索引"后执行计划不会回退到"覆盖索引"以外的扫描方式：'));
    out.push(code(`-- 示例：在删除前对涉及 ${redundant[0].redundantIndex || 'IDX_A'} 的核心 SQL 做 EXPLAIN
EXPLAIN SELECT ... FROM ${redundant[0].schema || 'db'}.${redundant[0].table || 'tbl'}
WHERE ${(redundant[0].redundantColumns || 'col1').split(',')[0]} = ?;
-- 期望：key 应命中"${redundant[0].dominantIndex || 'IDX_B'}"（覆盖索引）`));
    out.push(bullet('② 用以下 SQL 查出"冗余索引"实际占用，先聚焦"大且冗余"的索引：'));
    out.push(code(`SELECT TABLE_SCHEMA, TABLE_NAME, INDEX_NAME,
       ROUND(SUM(STAT_VALUE) * @@innodb_page_size / 1024 / 1024, 2) AS size_mb
FROM mysql.innodb_index_stats
WHERE STAT_NAME = 'size'
  AND INDEX_NAME != 'PRIMARY'
  AND (TABLE_SCHEMA, TABLE_NAME, INDEX_NAME) IN (
    ('${redundant[0].schema}', '${redundant[0].table}', '${redundant[0].redundantIndex}')
    ${redundant.length > 1 ? `, ('${redundant[1].schema}', '${redundant[1].table}', '${redundant[1].redundantIndex}')` : ''}
    -- ...
  )
GROUP BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME
ORDER BY size_mb DESC;`));
    out.push(bullet('③ 维护窗口批量删除（大表建议 pt-online-schema-change 避免锁表）：'));
    out.push(code((redundant.length <= 5
      ? redundant.map(r => `DROP INDEX ${r.redundantIndex} ON ${r.schema}.${r.table};  -- 已被 ${r.dominantIndex} 覆盖`).join('\n')
      : redundant.slice(0, 3).map(r => `DROP INDEX ${r.redundantIndex} ON ${r.schema}.${r.table};  -- 已被 ${r.dominantIndex} 覆盖`).join('\n') + `\n-- 还有 ${redundant.length - 3} 条 DROP 语句，可从 data.json 的 nodes[].redundantIndexes 批量生成：\n-- jq -r '.nodes[].redundantIndexes[] | "DROP INDEX " + .redundantIndex + " ON " + .schema + "." + .table + ";"' data.json`)));
    out.push(emptyLine());
    out.push(noteParagraph('优先处理正式业务表上的冗余；历史/临时表上的冗余索引应与表归档、清理动作合并评估，避免对已准备下线的数据对象做重复优化。完整清单见 data.json 的 `nodes[].redundantIndexes` 字段。'));
  }
  out.push(emptyLine());

  out.push(h2('13.4 大字段（BLOB/TEXT）分布'));
  const blobs = refNode.blobColumns || [];
  if (blobs.length > 0) {
    // 按表汇总
    const byTable = {};
    for (const c of blobs) {
      const key = `${c.schema}.${c.table}`;
      byTable[key] = byTable[key] || { table: key, columns: [], types: new Set() };
      byTable[key].columns.push(c.column);
      byTable[key].types.add(c.type);
    }
    const rows = Object.values(byTable).slice(0, 20).map(t => [
      t.table, t.columns.length, t.columns.join(', '), [...t.types].join('/')
    ]);
    out.push(makeTable(['表', '大字段数', '字段名', '类型'], rows, `含 BLOB/TEXT 的表（前 20 张，共 ${Object.keys(byTable).length}）`));
    out.push(noteParagraph('TEXT/BLOB 行外存储会增加 IO 与备份大小。若字段实际较短且更新频繁，可评估改为 VARCHAR；若仅冷数据查询，可拆出归档表。'));
  } else {
    out.push(para('未检测到大字段使用。'));
  }
  out.push(emptyLine());

  out.push(h2('13.5 分区表使用情况'));
  const partitions = refNode.partitionTables || [];
  if (partitions.length > 0) {
    const rows = partitions.slice(0, 30).map(p => [p.schema, p.table, p.count]);
    out.push(makeTable(['库名', '表名', '分区数'], rows, `分区表清单（共 ${partitions.length}）`));
    out.push(noteParagraph('分区数过多（>100）会显著增加优化器开销。历史数据归档型分区表应有定期清理机制。'));
  } else {
    out.push(para('未使用分区表（如有大表按时间归档需求，可考虑 RANGE 分区）。'));
  }
  out.push(emptyLine());

  out.push(h2('13.6 自增主键使用率'));
  const autoInc = refNode.autoIncrementUsage || [];
  if (autoInc.length > 0) {
    const rows = autoInc.slice(0, 20).map(a => [a.schema, a.table, a.column, a.autoIncrement, (a.rate * 100).toFixed(2) + '%', a.rate >= 0.8 ? '🔴 关键' : a.rate >= 0.5 ? '🟠 关注' : '✅ 正常']);
    out.push(makeTable(['库名', '表名', '列名', '当前值', '使用率', '风险'], rows, `自增列使用率（前 20，共 ${autoInc.length}）`));
    out.push(noteParagraph('使用率超过 80% 建议优先扩容（如 INT→BIGINT 或重建表）；超过 50% 应纳入容量规划。'));
  } else {
    out.push(para('未发现自增主键使用率超过 50% 的表。'));
  }
  out.push(emptyLine());

  out.push(h2('13.7 存储过程与函数'));
  const routines = refNode.routines || [];
  if (routines.length > 0) {
    const rows = routines.slice(0, 30).map(r => [r.schema, r.name, r.type, r.definer]);
    out.push(makeTable(['库名', '名称', '类型', '定义者'], rows, `存储过程/函数清单（共 ${routines.length}）`));
    out.push(noteParagraph('过多存储过程不利于横向扩展。建议将业务逻辑放在应用层，数据库仅做数据存取。'));
  } else {
    out.push(para('未使用存储过程或函数。'));
  }
  return out;
}

// ============== 十四、SQL 治理（V4 新增）==============
function chapterSqlGovernance(data) {
  const out = [h1('十四、SQL 性能治理')];
  const refNode = data.nodes.find(n => n.role === 'primary') || data.nodes[0];

  out.push(h2('14.1 慢日志状态'));
  if (refNode.slowLogStatus) {
    out.push(code(refNode.slowLogStatus));
  } else {
    out.push(para('（V2 采集不含慢日志详情；运行 V3 采集脚本可获取）'));
  }
  out.push(emptyLine());

  out.push(h2('14.2 TOP 20 慢 SQL（按总延迟）'));
  const top = refNode.topSqlByLatency || [];
  if (top.length > 0) {
    const rows = top.slice(0, 20).map((s, i) => [
      i + 1, truncate(s.db, 14), truncate(s.query, 80),
      s.execCount, s.avgLatency, s.totalLatency,
    ]);
    out.push(makeTable(['#', 'DB', 'SQL（已脱敏）', '执行次数', '平均时长', '总时长'], rows, 'TOP 20 SQL（performance_schema.events_statements_summary_by_digest）'));
    out.push(emptyLine());
  } else {
    out.push(para('（无 TOP SQL 数据；V3 采集脚本会自动包含此项）'));
    out.push(emptyLine());
  }

  out.push(h2('14.3 慢日志样本（实际 SQL）'));
  const sl = refNode.slowLogAnalysis;
  if (sl?.available && (sl.top || []).length > 0) {
    out.push(para([
      { text: '慢日志统计：', bold: true },
      { text: `共 ${sl.totalEntries} 条；最长 ${sl.maxQueryTime.toFixed(2)}s；平均 ${sl.avgQueryTime.toFixed(2)}s；扫描最多行数 ${sl.maxRowsExamined.toLocaleString()}。` },
    ]));
    out.push(para(`时间跨度：${sl.timeSpan}`));
    out.push(emptyLine());
    const samples = sl.top.slice(0, 10);
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      out.push(para([
        { text: `[#${i + 1}] `, bold: true, color: COLOR.secondary },
        { text: `${s.queryTime}s | rows ${s.rowsSent}/${s.rowsExamined} | db: ${s.db || '-'} | ${s.time}`, color: COLOR.muted, size: 18 },
      ]));
      out.push(code(s.sql || '(无 SQL)'));
    }
  } else {
    out.push(para('（无慢日志样本；V3 采集脚本会 tail 慢日志写入到报告中）'));
  }
  out.push(emptyLine());

  out.push(h2('14.4 全表扫描 / 缺索引 SQL'));
  const noIdx = refNode.sqlNoGoodIndex || [];
  if (noIdx.length > 0) {
    const rows = noIdx.slice(0, 15).map((s, i) => [
      i + 1, truncate(s.db, 14), truncate(s.query, 80),
      s.execCount, s.totalLatency, s.noIndexPct + '%',
    ]);
    out.push(makeTable(['#', 'DB', 'SQL（脱敏）', '执行次数', '总时长', '无索引占比'], rows, '未使用索引的 SQL'));
  } else {
    out.push(para('（无相关数据）'));
  }
  out.push(emptyLine());

  out.push(h2('14.5 临时表磁盘溢出 SQL'));
  const tmp = refNode.sqlWithTmp || [];
  if (tmp.length > 0) {
    const rows = tmp.slice(0, 15).map((s, i) => [
      i + 1, truncate(s.db, 14), truncate(s.query, 80),
      s.execCount, s.memoryTmp, s.diskTmp, s.diskPct + '%',
    ]);
    out.push(makeTable(['#', 'DB', 'SQL（脱敏）', '执行次数', '内存临时表', '磁盘临时表', '磁盘占比'], rows, '触发临时表的 SQL'));
  } else {
    out.push(para('（无相关数据）'));
  }
  out.push(emptyLine());

  out.push(h2('14.6 治理建议'));
  out.push(bullet('每周用 pt-query-digest 跑慢日志，对比上周 Top SQL 变化'));
  out.push(bullet('为执行频次 >1000 + 平均延迟 >500ms 的 SQL 加索引或重写'));
  out.push(bullet('对 14.5 表中的 SQL，调优策略：增加 tmp_table_size / 增加索引避免临时表 / 重写为多步 SQL'));
  out.push(bullet('对 14.4 表中的 SQL，用 EXPLAIN 分析；若确实需全表扫描的报表 SQL，移到从库或归档库执行'));
  return out;
}

// ============== 十五、备份与恢复评估（V4 新增）==============
function chapterBackupRecovery(data) {
  const out = [h1('十五、备份与恢复评估')];
  const ba = data.backupAssessment || {};

  out.push(h2('15.1 综合评估'));
  const sevColor = ba.severity === 'P0' ? 'C00000' : ba.severity === 'P1' ? 'BF8F00' : ba.severity === 'OK' ? '548235' : COLOR.text;
  out.push(para([
    { text: '当前状态：', bold: true },
    { text: ba.assessment || '未评估', color: sevColor, bold: true },
  ]));
  if (ba.severity && ba.severity !== 'OK') {
    out.push(para([
      { text: '严重程度：', bold: true },
      { text: ba.severity, color: sevColor, bold: true },
    ]));
  }
  out.push(emptyLine());

  out.push(h2('15.2 备份工具检测'));
  if ((ba.tools || []).length > 0) {
    const rows = ba.tools.map(t => [t.tool, t.installed ? '✅ 已安装' : '❌ 未安装', t.detail || '-']);
    out.push(makeTable(['工具', '状态', '版本/路径'], rows, '常见备份工具'));
  } else {
    out.push(para('（V2 采集不含备份工具信息；运行 V3 采集脚本可获取）'));
  }
  out.push(emptyLine());

  out.push(h2('15.3 备份调度（crontab）'));
  let hasCron = false;
  for (const c of (ba.crontabs || [])) {
    const items = [];
    if (c.mysqlUser && !/无 crontab/.test(c.mysqlUser)) items.push(['mysql 用户', c.mysqlUser]);
    if (c.rootUser) items.push(['root 用户', c.rootUser]);
    if (c.system) items.push(['系统级 cron', c.system]);
    if (items.length > 0) {
      hasCron = true;
      out.push(para([{ text: `节点 ${c.ip}：`, bold: true }]));
      for (const [src, txt] of items) {
        out.push(para([{ text: `[${src}]`, bold: true, color: COLOR.muted }]));
        out.push(code(String(txt).slice(0, 600)));
      }
    }
  }
  if (!hasCron) out.push(para('未发现备份相关 cron 任务（可能在外部调度系统中，建议人工确认）。'));
  if ((ba.hintPaths || []).length > 0) {
    out.push(noteParagraph(`根据 crontab 和扫描结果推断，建议重点核实以下备份目录或脚本邻近目录：${ba.hintPaths.join('、')}。`));
  }
  out.push(emptyLine());

  out.push(h2('15.4 备份产物清单'));
  if ((ba.dirs || []).length > 0) {
    const rows = [];
    for (const d of ba.dirs) {
      if (d.exists === false) {
        rows.push([d.ip || '-', d.path, '不存在', '-', '-']);
        continue;
      }
      const fileCount = (d.files || []).length;
      const latest = (d.files || [])[0];
      rows.push([
        d.ip || '-', d.path, d.totalSize || '-',
        fileCount + ' 个文件',
        latest ? latest.mtime : '-',
      ]);
    }
    out.push(makeTable(['节点', '路径', '总大小', '文件数', '最近修改'], rows, '备份目录扫描'));
  } else {
    out.push(para('（V2 采集不含备份目录信息）'));
  }
  if (ba.latestBackup) {
    out.push(emptyLine());
    out.push(para([
      { text: '最新备份：', bold: true },
      { text: `${ba.latestBackup.path}（${ba.latestBackup.mtime}, ${formatBytesNum(ba.latestBackup.sizeBytes)}）` },
    ]));
  }
  out.push(emptyLine());

  out.push(h2('15.5 Binlog 保留情况'));
  for (const b of (ba.binlogs || [])) {
    if (b.info) {
      out.push(para([{ text: `节点 ${b.ip}：`, bold: true }]));
      out.push(code(b.info.slice(0, 1000)));
    }
  }
  out.push(emptyLine());

  out.push(h2('15.6 RTO / RPO 推算'));
  out.push(para('基于当前观察到的备份能力（实际值需结合演练数据）：'));
  out.push(bullet(`理论 RPO：${ba.latestBackup ? '取决于备份频率（见 15.3）' : '无完整备份 → RPO 不可估'}`));
  out.push(bullet(`理论 RTO：基于备份大小 ${ba.latestBackup ? formatBytesNum(ba.latestBackup.sizeBytes) : '-'} 与磁盘恢复速度估算（参考 200 MB/s）`));
  out.push(bullet('真实 RTO/RPO 需通过 **恢复演练** 验证，建议每季度执行一次'));
  out.push(emptyLine());

  out.push(h2('15.7 行动建议'));
  if (!ba.hasTool) {
    out.push(bullet('🔴 建议优先安装备份工具：xtrabackup（推荐）或 mariabackup（MariaDB 兼容）'));
  }
  if (!ba.hasBackupArtifact) {
    out.push(bullet('🔴 制定备份策略：全量 + 增量 + binlog，至少异地保存'));
  }
  if (!ba.hasScheduledBackup) {
    out.push(bullet('🟠 将备份任务接入 cron 或调度系统（不依赖人工记忆）'));
  }
  out.push(bullet('每月校验：备份完整性 + 备份归档加密 + 异地保存（建议 3-2-1 策略）'));
  out.push(bullet('每季度演练：随机抽取一份备份恢复到测试环境，记录 RTO'));
  out.push(bullet('考虑物理备份（xtrabackup）+ 逻辑备份（mysqldump）双轨：物理快速、逻辑可移植'));
  return out;
}

// ============== 十六、安全合规审计（V4 新增）==============
function chapterSecurityCompliance(data) {
  const out = [h1('十六、安全合规审计')];
  const sa = data.securityAssessment || { items: [], pass: 0, warn: 0, fail: 0, unknown: 0 };

  out.push(h2('16.1 综合评估'));
  const levelColor = sa.complianceLevel === '高' ? '548235'
    : sa.complianceLevel === '中' ? 'BF8F00'
    : sa.complianceLevel === '低' ? 'C00000'
    : COLOR.muted;
  out.push(para([
    { text: '合规等级：', bold: true },
    { text: sa.complianceLevel || '-', color: levelColor, bold: true },
    { text: `（PASS ${sa.pass} / WARN ${sa.warn} / FAIL ${sa.fail} / UNKNOWN ${sa.unknown || 0} / 共 ${sa.total || sa.items.length} 项）` },
  ]));
  if ((sa.unknown || 0) > 0) {
    out.push(noteParagraph(`其中 ${sa.unknown} 项为 UNKNOWN（相关数据未采集），升级到 V3.0 采集脚本可获取完整合规判断。这些项不参与合规等级计算，避免「未采集」被误判为「未启用」。`));
  }
  out.push(emptyLine());

  // 安全合规结果饼图（含 UNKNOWN）
  if (charts) {
    const p = chartParagraph(() => charts.pie([
      { label: '通过 PASS', value: sa.pass || 0, color: charts.COLORS.good },
      { label: '告警 WARN', value: sa.warn || 0, color: charts.COLORS.warn },
      { label: '不合规 FAIL', value: sa.fail || 0, color: charts.COLORS.bad },
      { label: '未采集 UNKNOWN', value: sa.unknown || 0, color: charts.COLORS.muted },
    ].filter(x => x.value > 0), { title: '安全合规检查结果分布', width: 480, height: 240 }),
    { width: 480, height: 240 });
    if (p) out.push(p);
  }

  out.push(h2('16.2 合规检查清单'));
  const statusLabel = (s) => ({
    PASS: '✅ 通过',
    WARN: '⚠️ 告警',
    FAIL: '❌ 不合规',
    UNKNOWN: '❓ 未采集',
  })[s] || s;
  const rows = (sa.items || []).map(i => [i.label, statusLabel(i.status), i.detail]);
  out.push(makeTable(['检查项', '状态', '说明'], rows, '安全合规检查项'));
  out.push(emptyLine());

  out.push(h2('16.3 TLS / 加密细节'));
  const primary = data.nodes.find(n => n.role === 'primary') || data.nodes[0];
  if (primary?.tlsConfig) {
    const rows = Object.entries(primary.tlsConfig).map(([k, v]) => [k, v]);
    out.push(makeTable(['配置项', '值'], rows, 'TLS / SSL 配置'));
  } else {
    out.push(para('（V2 采集不含 TLS 详情；V3 采集脚本会包含）'));
  }
  out.push(emptyLine());

  out.push(h2('16.4 整改建议优先级'));
  const failItems = (sa.items || []).filter(i => i.status === 'FAIL');
  const warnItems = (sa.items || []).filter(i => i.status === 'WARN');
  if (failItems.length > 0) {
    out.push(para([{ text: '🔴 必须整改（FAIL）：', bold: true, color: 'C00000' }]));
    failItems.forEach(i => out.push(bullet(`${i.label} — ${i.detail}`)));
  }
  if (warnItems.length > 0) {
    out.push(para([{ text: '🟠 建议加强（WARN）：', bold: true, color: 'BF8F00' }]));
    warnItems.forEach(i => out.push(bullet(`${i.label} — ${i.detail}`)));
  }
  out.push(emptyLine());

  out.push(h2('16.5 常见合规框架对照'));
  // 评审 #15 (v4.4)：v4.3 只显示「满足/不满足」状态，未说明缺什么；
  // 增加「关键缺失项」列，让 DBA 看完直接知道下一步要修什么。
  const itemPassed = id => sa.items.find(i => i.id === id)?.status === 'PASS';
  const collectMissing = (idList) => idList.filter(id => !itemPassed(id));
  const labelOf = id => ({
    strong_password_policy: '密码强度策略',
    audit_log: '审计日志（audit plugin）',
    innodb_encryption: 'InnoDB at-rest 加密',
    tls_enabled: 'TLS/SSL 连接加密',
    root_remote: 'root 远程登录限制',
    weak_password: '弱口令账号',
    user_with_grant: '高权限授予限制',
  })[id] || id;
  const fmtMissing = (idList) => {
    const miss = collectMissing(idList);
    return miss.length === 0 ? '—' : miss.map(labelOf).join('、');
  };

  const dengbaoIds = ['strong_password_policy', 'audit_log'];
  const pciIds = ['innodb_encryption', 'tls_enabled', 'audit_log'];
  const gdprIds = ['audit_log'];

  const statusOf = (idList, partialOk = false) => {
    const miss = collectMissing(idList);
    if (miss.length === 0) return '✅ 满足';
    if (partialOk && miss.length < idList.length) return '⚠️ 部分满足';
    return '❌ 不满足';
  };

  out.push(makeTable(
    ['框架', '关键要求', '当前状态', '关键缺失项'],
    [
      ['等保 2.0 三级', '强密码 + 审计日志 + 操作可追溯', statusOf(dengbaoIds, false), fmtMissing(dengbaoIds)],
      ['PCI DSS', '数据加密（at rest + transit） + 审计', statusOf(pciIds, true), fmtMissing(pciIds)],
      ['GDPR', '数据可删除 + 访问审计', statusOf(gdprIds, true), fmtMissing(gdprIds)],
      ['SOX', '变更审计 + 职责分离', '⚠️ 需结合流程评估', '审计日志（如未启用）、变更审批流程（DBA 手工评估）'],
    ],
    '主流合规框架对照',
  ));
  out.push(noteParagraph('「关键缺失项」基于 16.2 检查项的 PASS/FAIL 状态自动汇总；如已在外部 KMS / 应用层实现等效控制，可在评估时人工排除。'));

  return out;
}

function chapterConclusion(data) {
  // v4.7.2：因移除第十六章，本章节号从「十七」改为「十六」
  const out = [h1('十六、巡检总结与行动计划')];
  out.push(h2('16.1 整体结论'));
  out.push(para(`【${data.project}】MySQL 集群本次巡检整体评估：${data.overallAssessment}。`));
  const sl = data.nodes.filter(n => n.replication?.isSlave);
  if (sl.length > 0) {
    const okSlaves = sl.filter(n => n.replication.status?.slaveIoRunning === 'Yes' && n.replication.status?.slaveSqlRunning === 'Yes').length;
    const maxLag = Math.max(...sl.map(n => Number(n.replication.status?.secondsBehindMaster || 0)));
    out.push(para(`主从复制状态：${okSlaves}/${sl.length} 从库 IO+SQL 双线程正常，当前最大延迟 ${maxLag} 秒。`));
  }
  out.push(emptyLine());

  // 13.2 行动计划（按优先级，带具体 issue 与 SQL hint）
  out.push(h2('16.2 行动计划（按优先级）'));
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
      // v4.8：senior-DBA 参数规则带 currentValue / recommendedValue，显式渲染对照行
      if (i.currentValue && i.recommendedValue) {
        out.push(para([
          { text: '   ✦ 当前值：', color: 'BF8F00' },
          { text: i.currentValue },
          { text: '   →   推荐值：', color: '548235' },
          { text: i.recommendedValue, bold: true },
        ]));
      }
      if (i.sql) {
        out.push(code(i.sql));
      }
    });
    out.push(emptyLine());
  };

  const p0 = data.issues.filter(i => i.priority === 'P0');
  const p1 = data.issues.filter(i => i.priority === 'P1');
  const p2 = data.issues.filter(i => i.priority === 'P2');

  // v4.9.3：标题措辞改为咨询性，避免"本周内/紧急"等急迫词汇
  renderActionBlock('🔴 优先处置（P0 关键风险点）', 'C00000', p0);
  renderActionBlock('🟠 近期规划（P1 重要风险点）', 'BF8F00', p1);
  renderActionBlock('🟡 本月内（P2 建议）', '548235', p2);

  const recs = data.recommendations || {};
  if ((recs.longTerm || []).length > 0) {
    out.push(para([{ text: '🔵 长期规划：', bold: true, color: COLOR.secondary }]));
    recs.longTerm.forEach(r => out.push(bullet(r)));
    out.push(emptyLine());
  }

  out.push(h2('16.3 附录 · 数据来源'));
  out.push(para('本报告基于以下原始采集文件生成：'));
  for (const n of data.nodes) {
    out.push(bullet(`${n.ip}（${roleLabel(n.role)}）：${n._file || '-'}`));
  }
  out.push(emptyLine());
  out.push(para('采集脚本覆盖的子段：os info / db info（hostname、mem info、CPU、disk mount、my.cnf detail、MySQL Database Version、MySQL Replication Info、Engine innodb status、MySQL Variables、Processlist info、user check、database CHARACTER、Top 10 Tables、Tables fragment rate、Not utf8 table、NO PRIMARY KEY TABLES、ROUTINES OBJECTS 等）。'));
  return out;
}

// ============== 辅助 ==============
function tableCategory(tableName) {
  const t = String(tableName || '');
  if (/^tmp_|^temp_|^test_|_tmp$|_temp$|_test$|tmp|temp|test/i.test(t)) {
    return { key: 'temp', label: '临时/测试表' };
  }
  if (/_bak$|_bak_|_backup$|_old$|_archive$|_his$|_history$|history|archive/i.test(t)
      || /_\d{8}$|_\d{6}$|_\d{4}-\d{2}|_\d{4}_\d{2}/.test(t)
      || /^_gho_|^_ghc_|^_(gho|ghc|del)_/i.test(t)) {
    return { key: 'history', label: '历史/归档表' };
  }
  if (/^_/i.test(t)) return { key: 'temp', label: '临时/测试表' };
  return { key: 'business', label: '业务表' };
}

function summarizeTableCategories(items) {
  const summary = { business: 0, history: 0, temp: 0 };
  for (const item of items || []) {
    const category = tableCategory(item.table || item.tableName || item.name);
    summary[category.key] = (summary[category.key] || 0) + 1;
  }
  return summary;
}

function ibtmp1StatusLabel(node) {
  if (node.ibtmp1?.source) return '已采集';
  if (node.ibtmp1CollectionStatus === 'collected_no_row') return '已采集但未返回 ibtmp1 行';
  if (node.ibtmp1CollectionStatus === 'collected') return '已采集';
  return '未采集';
}

function roleLabel(role) {
  if (!role) return '未知';
  if (role === 'primary') return '主库';
  if (role === 'dr') return '灾备';
  if (/^slave/.test(role)) return '从库';
  return role;
}
function osLifecycleLabel(n) {
  if (n.osEolStatus?.status === 'eol') {
    return `已停止维护（EOL ${n.osEolStatus.eolDate}）`;
  }
  if (n.osEolStatus?.status === 'unknown') return '生命周期需确认';
  return '未识别';
}
function diskHealthLabel(pctText) {
  const pct = parseInt((pctText || '0').replace('%', ''));
  if (pct >= 90) return '关键';
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

function formatMonthText(iso) {
  if (!iso) return '-';
  const m = iso.match(/^(\d{4})-(\d{2})/);
  if (!m) return iso;
  return `${m[1]}年${Number(m[2])}月`;
}

// ============== 文档组装 ==============
function buildDocument(data) {
  const logoPath = path.join(__dirname, 'assets', 'logo.png');
  const logoImage = fs.existsSync(logoPath) ? fs.readFileSync(logoPath) : null;
  const headerWidths = [1900, 4700, 1800];
  const footerWidths = [1800, 5000, 1800];

  return new Document({
    creator: 'mysql-healthcheck v4.7',
    title: `${data.project} MySQL 数据库健康巡检报告`,
    // v4.7：保留 features.updateFields=true，让 LibreOffice 在 headless
    // 模式下加载 docx 时识别「字段需要更新」并刷新 TOC。
    // 主流程会先尝试通过 LibreOffice 刷新（生成真实页码 + 超链接），
    // 失败或 LO 不可用时回退到 stripDirtyFields（剥离 dirty，TOC 空但
    // Word 打开无弹窗）。
    features: { updateFields: true },
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
          children: [new Table({
            rows: [new TableRow({
              children: [
                new TableCell({
                  children: [new Paragraph({
                    children: logoImage ? [new ImageRun({
                      data: logoImage,
                      transformation: { width: 100, height: 34 },
                      type: 'png',
                    })] : [new TextRun({ text: 'ENMOTECH', font: FONT, size: 16, color: COLOR.light })],
                    alignment: AlignmentType.CENTER,
                  })],
                  width: { size: headerWidths[0], type: WidthType.DXA },
                }),
                new TableCell({
                  children: [new Paragraph({
                    children: [new TextRun({ text: `${COMPANY_NAME} 成就所托`, font: FONT, color: COLOR.light, size: 18 })],
                    alignment: AlignmentType.CENTER,
                  })],
                  width: { size: headerWidths[1], type: WidthType.DXA },
                }),
                new TableCell({
                  children: [new Paragraph({
                    children: [new TextRun({ text: COMPANY_SITE, font: FONT, color: COLOR.light, size: 18 })],
                    alignment: AlignmentType.CENTER,
                  })],
                  width: { size: headerWidths[2], type: WidthType.DXA },
                }),
              ],
            })],
            width: { size: TABLE_WIDTH, type: WidthType.DXA },
            columnWidths: headerWidths,
            layout: TableLayoutType.FIXED,
          })],
        }),
      },
      footers: {
        default: new Footer({
          children: [new Table({
            rows: [new TableRow({
              children: [
                new TableCell({
                  children: [new Paragraph({
                    children: [new TextRun({ text: COMPANY_SITE, color: COLOR.light, size: 16, font: FONT })],
                    alignment: AlignmentType.CENTER,
                  })],
                  width: { size: footerWidths[0], type: WidthType.DXA },
                }),
                new TableCell({
                  children: [new Paragraph({
                    children: [new TextRun({ text: COMPANY_SLOGAN, color: COLOR.light, size: 16, font: FONT })],
                    alignment: AlignmentType.CENTER,
                  })],
                  width: { size: footerWidths[1], type: WidthType.DXA },
                }),
                new TableCell({
                  children: [new Paragraph({
                    children: [
                      new TextRun({ text: '-', color: COLOR.muted, size: 18, font: FONT }),
                      new TextRun({ children: [PageNumber.CURRENT], color: COLOR.muted, size: 18, font: FONT }),
                      new TextRun({ text: '-', color: COLOR.muted, size: 18, font: FONT }),
                    ],
                    alignment: AlignmentType.CENTER,
                  })],
                  width: { size: footerWidths[2], type: WidthType.DXA },
                }),
              ],
            })],
            width: { size: TABLE_WIDTH, type: WidthType.DXA },
            columnWidths: footerWidths,
            layout: TableLayoutType.FIXED,
          })],
        }),
      },
      children: [
        ...chapterCover(data),
        ...chapterDocumentControl(data),
        ...chapterExecutiveSummary(data),
        ...chapterTOC(),
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
        ...chapterSchemaDesignAudit(data),
        ...chapterSqlGovernance(data),
        ...chapterBackupRecovery(data),
        // v4.7.2：第十六章「安全合规审计」已移除 — 内容属于框架对照 / 咨询性总结，
        // 实际的安全风险（root@%, 弱口令, 复制账号 wildcard 等）已经在第十一章
        // 用户权限审计 + 第一章问题汇总里覆盖；合规等级 / GDPR / PCI / 等保对照
        // 等属于专项合规咨询范畴，不在日常巡检关注范围。
        // ...chapterSecurityCompliance(data),
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

// v4.7：检测本机 LibreOffice 二进制路径（按优先级返回首个存在的；都没有返回 null）
function detectLibreOffice() {
  const envOverride = process.env.SOFFICE || process.env.LIBREOFFICE;
  if (envOverride && fs.existsSync(envOverride)) return envOverride;
  const candidates = [
    '/Applications/LibreOffice.app/Contents/MacOS/soffice', // macOS GUI 安装
    '/usr/bin/soffice',                                      // Debian/Ubuntu/RHEL
    '/usr/local/bin/soffice',                                // Homebrew CLI / 自编译
    '/opt/libreoffice/program/soffice',                      // 部分 Linux 发行版
    '/opt/homebrew/bin/soffice',                             // Apple Silicon Homebrew
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  // 兜底：which / where
  try {
    const cp = require('child_process');
    const r = cp.spawnSync(process.platform === 'win32' ? 'where' : 'which', ['soffice'], { encoding: 'utf-8' });
    if (r.status === 0 && r.stdout && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0];
  } catch (_) {}
  return null;
}

// v4.7：调用 LibreOffice headless 刷新 TOC 字段（生成真实页码 + 内嵌 hyperlink）
// 成功返回刷新后的 Buffer，失败/超时/未刷新返回 null（主流程会回退到 stripDirtyFields）
async function refreshFieldsViaLibreOffice(buf, soffice) {
  const os = require('os');
  const cp = require('child_process');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysql-hc-toc-'));
  const profileDir = path.join(tmpDir, 'lo-profile');
  const inFile = path.join(tmpDir, 'input.docx');
  fs.writeFileSync(inFile, buf);
  try {
    const r = cp.spawnSync(soffice, [
      '--headless', '--norestore', '--nologo', '--nofirststartwizard',
      '-env:UserInstallation=file://' + profileDir, // 隔离用户配置，避免与桌面 LO 冲突
      '--convert-to', 'docx',
      '--outdir', tmpDir,
      inFile,
    ], { timeout: 60_000, encoding: 'utf-8' });
    if (r.status !== 0) {
      console.warn('⚠ LibreOffice 退出码 ' + r.status + '：' + ((r.stderr || r.stdout || '').slice(0, 200)));
      return null;
    }
    // LO --convert-to docx 默认覆盖同名文件；某些版本会跳过同名输出。
    // 扫描 tmpDir 找最新的 .docx（排除 input.docx 本身的引用判别用 mtime）。
    const candidates = fs.readdirSync(tmpDir)
      .filter(f => f.endsWith('.docx'))
      .map(f => ({ f, p: path.join(tmpDir, f), m: fs.statSync(path.join(tmpDir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (candidates.length === 0) return null;
    const refreshed = fs.readFileSync(candidates[0].p);
    if (await verifyTocPopulated(refreshed)) {
      return refreshed;
    }
    return null;
  } catch (e) {
    console.warn('⚠ LibreOffice 调用失败：' + e.message);
    return null;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// v4.7：验证 LO 输出的 docx 中 TOC 字段是否真的被刷新填充
// - fldChar 不再含 dirty="true"
// - TOC SDT 内部含 hyperlink（指向 _Toc... 书签）或 PAGEREF 字段（页码引用）
async function verifyTocPopulated(buf) {
  try {
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(buf);
    const docFile = zip.file('word/document.xml');
    if (!docFile) return false;
    const xml = await docFile.async('string');
    if (/<w:fldChar[^/]*w:dirty="true"/.test(xml)) return false;
    return /<w:hyperlink\s+w:anchor=/.test(xml) || /PAGEREF/.test(xml);
  } catch (_) {
    return false;
  }
}

// v4.6.1：post-process — 从 word/document.xml 中剥离 fldChar 上的 w:dirty="true"
// 原因：docx 库的 TableOfContents 硬编码 dirty=true，导致 Word/WPS 打开时弹出
// 「是否更新字段」提示。剥离后字段不再标"待更新"，Word 不再询问；TOC 内容打开
// 后为空，用户首次需在目录上右键 → 更新域 → 更新整个目录（已有提示段落引导）。
// v4.7：当本机有 LibreOffice 且刷新成功时跳过此函数，直接使用 LO 刷新后的 buf；
// 只有 LO 不可用 / 刷新失败 / --no-toc-refresh 时才走 stripDirtyFields 兜底。
async function stripDirtyFields(buf) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buf);
  const docFile = zip.file('word/document.xml');
  if (!docFile) return buf;
  let xml = await docFile.async('string');
  // 仅在 fldChar 元素上剥离 w:dirty 属性（不影响其它元素）
  const before = xml;
  xml = xml.replace(/<w:fldChar\s+([^/>]*?)\s+w:dirty="true"([^/>]*)\/?>/g, '<w:fldChar $1$2/>');
  xml = xml.replace(/<w:fldChar\s+w:dirty="true"\s+([^/>]*)\/?>/g, '<w:fldChar $1/>');
  if (xml === before) return buf;
  zip.file('word/document.xml', xml);
  return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ============== 主流程 ==============
(async function main() {
  // v4.7：CLI 解析 — --no-toc-refresh / --soffice <path>
  const skipRefresh = process.argv.includes('--no-toc-refresh');
  const userSofficeIdx = process.argv.indexOf('--soffice');
  const userSoffice = userSofficeIdx >= 0 ? process.argv[userSofficeIdx + 1] : null;

  const doc = buildDocument(data);
  let buf = await Packer.toBuffer(doc);

  // v4.7：尝试通过 LibreOffice 刷新 TOC 字段（生成真实页码 + 超链接）
  // 降级路径：LO 不可用 / 刷新失败 / --no-toc-refresh → stripDirtyFields（剥离 dirty 让 Word 不弹窗）
  // 用户传 --soffice 但路径不存在时也走降级路径（不强行调用）
  let soffice = userSoffice || detectLibreOffice();
  if (soffice && !fs.existsSync(soffice)) {
    console.warn(`⚠ --soffice 指定路径不存在：${soffice}，将自动降级`);
    soffice = null;
  }
  let tocSource = 'empty';  // 'libreoffice' | 'empty' | 'skipped'
  if (skipRefresh) {
    buf = await stripDirtyFields(buf);
    tocSource = 'skipped';
    console.error('⊘ --no-toc-refresh 已指定，跳过 LibreOffice 刷新（TOC 保持空，可在 Word 中右键 → 更新域）');
  } else if (soffice) {
    console.error(`⏳ 检测到 LibreOffice (${soffice})，正在刷新 TOC 字段……`);
    const refreshed = await refreshFieldsViaLibreOffice(buf, soffice);
    if (refreshed) {
      buf = refreshed;
      tocSource = 'libreoffice';
      console.error('✓ TOC 已通过 LibreOffice 自动刷新（含页码 + 超链接）');
    } else {
      buf = await stripDirtyFields(buf);
      console.warn('⚠ LibreOffice 刷新失败，已回退（TOC 空目录，可在 Word 中右键 → 更新域）');
    }
  } else {
    buf = await stripDirtyFields(buf);
    console.error('ⓘ 未检测到 LibreOffice，TOC 保持空目录（可在 Word/WPS 中右键 → 更新域显示页码）');
    console.error('  如希望导出即带完整目录，请安装 LibreOffice：');
    console.error('    macOS:  brew install --cask libreoffice');
    console.error('    Ubuntu: sudo apt install libreoffice');
    console.error('  或通过 --soffice <path> 指定二进制路径');
  }

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

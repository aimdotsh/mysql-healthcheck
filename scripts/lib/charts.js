// SVG 图表生成 + PNG 转换
// 6 类图形组件：gauge（健康度仪表）/ radar（雷达）/ pie（饼图）/ hbar（横向柱）/ vbar（纵向柱）/ topology（拓扑图）
'use strict';
const fs = require('fs');
const path = require('path');

const FONT_DIRS = [
  '/usr/share/fonts/opentype/noto',
].filter(dir => fs.existsSync(dir));

function loadResvg() {
  const candidates = [
    path.join(__dirname, '..', 'node_modules', '@resvg', 'resvg-js'),
    '@resvg/resvg-js',
  ];
  for (const c of candidates) {
    try { return require(c); } catch (_) {}
  }
  return null;
}

const COLORS = {
  primary: '#1F4E79',
  secondary: '#2E75B6',
  accent: '#5B9BD5',
  text: '#404040',
  muted: '#888888',
  grid: '#DDDDDD',
  bg: '#FFFFFF',
  p0: '#D9534F',
  p1: '#F0AD4E',
  p2: '#F0DD58',
  p3: '#A0CB85',
  good: '#5CB85C',
  ok: '#A0CB85',
  warn: '#F0AD4E',
  bad: '#D9534F',
  series: ['#1F4E79', '#2E75B6', '#5B9BD5', '#9DC3E6', '#BDD7EE', '#DEEBF7'],
};

// ============== SVG 基础 ==============
function svgWrap(width, height, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<style>
text { font-family: "Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC", Arial, sans-serif; }
</style>
<rect width="${width}" height="${height}" fill="${COLORS.bg}"/>
${body}
</svg>`;
}

function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// ============== 健康度仪表（圆环 + 中心数字）==============
function gauge(score, label, opts = {}) {
  const W = opts.width || 480;
  const H = opts.height || 280;
  const cx = W / 2, cy = H * 0.62;
  const r = Math.min(W, H) * 0.32;
  const stroke = 28;
  const start = Math.PI * 0.85;
  const end = Math.PI * 2.15;
  const ratio = Math.max(0, Math.min(100, score)) / 100;
  const cur = start + (end - start) * ratio;

  const arcBg = describeArc(cx, cy, r, start, end);
  const arcFg = describeArc(cx, cy, r, start, cur);

  let color = COLORS.bad;
  if (score >= 85) color = COLORS.good;
  else if (score >= 70) color = COLORS.ok;
  else if (score >= 55) color = COLORS.warn;

  const grade = score >= 85 ? '优秀' : score >= 70 ? '良好' : score >= 55 ? '中等' : score >= 40 ? '较差' : '严重';

  const body = `
<text x="${cx}" y="${H * 0.15}" text-anchor="middle" font-size="20" font-weight="bold" fill="${COLORS.primary}">${escapeXml(label)}</text>
<path d="${arcBg}" stroke="${COLORS.grid}" stroke-width="${stroke}" fill="none" stroke-linecap="round"/>
<path d="${arcFg}" stroke="${color}" stroke-width="${stroke}" fill="none" stroke-linecap="round"/>
<text x="${cx}" y="${cy + 12}" text-anchor="middle" font-size="56" font-weight="bold" fill="${color}">${score}</text>
<text x="${cx}" y="${cy + 42}" text-anchor="middle" font-size="14" fill="${COLORS.muted}">/ 100</text>
<text x="${cx}" y="${cy + 70}" text-anchor="middle" font-size="20" font-weight="bold" fill="${color}">${grade}</text>
`;
  return svgWrap(W, H, body);
}

function describeArc(cx, cy, r, startRad, endRad) {
  const sx = cx + r * Math.cos(startRad);
  const sy = cy + r * Math.sin(startRad);
  const ex = cx + r * Math.cos(endRad);
  const ey = cy + r * Math.sin(endRad);
  const largeArc = endRad - startRad > Math.PI ? 1 : 0;
  return `M ${sx.toFixed(2)} ${sy.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`;
}

// ============== 饼图 ==============
function pie(data, opts = {}) {
  const W = opts.width || 480;
  const H = opts.height || 280;
  const cx = W * 0.4, cy = H / 2;
  const r = Math.min(W, H) * 0.4;
  const total = data.reduce((a, b) => a + b.value, 0) || 1;
  const colors = opts.colors || COLORS.series;

  let startAngle = -Math.PI / 2;
  const slices = data.map((d, i) => {
    const v = d.value;
    const ratio = v / total;
    const angle = ratio * Math.PI * 2;
    const endAngle = startAngle + angle;
    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);
    const large = angle > Math.PI ? 1 : 0;
    const path = `M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
    const color = d.color || colors[i % colors.length];
    startAngle = endAngle;
    return { d, path, color, ratio };
  });

  const legendX = W * 0.78;
  const legendY = H * 0.2;
  const lineH = 22;
  const legendItems = data.map((d, i) => {
    const color = d.color || colors[i % colors.length];
    const pct = (slices[i].ratio * 100).toFixed(1);
    return `
<rect x="${legendX}" y="${legendY + i * lineH}" width="14" height="14" fill="${color}"/>
<text x="${legendX + 20}" y="${legendY + i * lineH + 12}" font-size="12" fill="${COLORS.text}">${escapeXml(d.label)} (${pct}%)</text>`;
  }).join('');

  const title = opts.title ? `<text x="${W/2}" y="22" text-anchor="middle" font-size="16" font-weight="bold" fill="${COLORS.primary}">${escapeXml(opts.title)}</text>` : '';

  const body = title + slices.map(s => `<path d="${s.path}" fill="${s.color}" stroke="white" stroke-width="2"/>`).join('') + legendItems;
  return svgWrap(W, H, body);
}

// ============== 横向柱状图 ==============
function hbar(data, opts = {}) {
  const W = opts.width || 600;
  const H = opts.height || Math.max(180, 50 + data.length * 32);
  const padL = opts.padLeft || 180;
  const padR = 100;
  const padT = opts.title ? 40 : 20;
  const padB = 20;
  const max = opts.max != null ? opts.max : Math.max(...data.map(d => d.value));
  const colors = opts.colors || COLORS.series;
  const barH = 22;
  const gap = 10;
  const chartW = W - padL - padR;

  const title = opts.title ? `<text x="${W/2}" y="22" text-anchor="middle" font-size="16" font-weight="bold" fill="${COLORS.primary}">${escapeXml(opts.title)}</text>` : '';

  const bars = data.map((d, i) => {
    const y = padT + i * (barH + gap);
    const w = Math.max(2, (d.value / max) * chartW);
    const color = d.color || colors[i % colors.length];
    const labelText = opts.format ? opts.format(d.value) : String(d.value);
    return `
<text x="${padL - 8}" y="${y + barH * 0.7}" text-anchor="end" font-size="12" fill="${COLORS.text}">${escapeXml(d.label)}</text>
<rect x="${padL}" y="${y}" width="${w.toFixed(1)}" height="${barH}" fill="${color}" rx="3"/>
<text x="${padL + w + 6}" y="${y + barH * 0.7}" font-size="11" fill="${COLORS.text}">${escapeXml(labelText)}</text>`;
  }).join('');

  return svgWrap(W, H, title + bars);
}

// ============== 纵向柱状图（多组）==============
function vbar(groups, opts = {}) {
  // groups: [{label: '节点A', series: [{name: 'Disk', value: 86, color: '...'}, ...]}, ...]
  const W = opts.width || 600;
  const H = opts.height || 280;
  const padL = 50;
  const padR = 20;
  const padT = opts.title ? 40 : 20;
  const padB = 50;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const colors = opts.colors || COLORS.series;

  const allValues = groups.flatMap(g => g.series.map(s => s.value));
  const max = opts.max != null ? opts.max : Math.max(...allValues) * 1.1;

  const groupCount = groups.length;
  const seriesCount = groups[0]?.series.length || 1;
  const groupWidth = chartW / groupCount;
  const barWidth = Math.min(40, (groupWidth - 20) / seriesCount);

  const title = opts.title ? `<text x="${W/2}" y="22" text-anchor="middle" font-size="16" font-weight="bold" fill="${COLORS.primary}">${escapeXml(opts.title)}</text>` : '';

  // Y 轴网格
  const gridLines = [];
  const ySteps = 4;
  for (let i = 0; i <= ySteps; i++) {
    const v = max * i / ySteps;
    const y = padT + chartH - (chartH * i / ySteps);
    gridLines.push(`<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${COLORS.grid}" stroke-width="1"/>`);
    gridLines.push(`<text x="${padL - 6}" y="${y + 3}" text-anchor="end" font-size="10" fill="${COLORS.muted}">${opts.formatY ? opts.formatY(v) : v.toFixed(0)}</text>`);
  }

  // 柱子
  const bars = [];
  groups.forEach((g, gi) => {
    const groupX = padL + gi * groupWidth + groupWidth / 2;
    g.series.forEach((s, si) => {
      const barX = groupX - (seriesCount * barWidth) / 2 + si * barWidth;
      const barH = (s.value / max) * chartH;
      const barY = padT + chartH - barH;
      const color = s.color || colors[si % colors.length];
      bars.push(`<rect x="${barX}" y="${barY.toFixed(1)}" width="${barWidth - 2}" height="${barH.toFixed(1)}" fill="${color}" rx="2"/>`);
      if (opts.showValues !== false) {
        bars.push(`<text x="${barX + barWidth/2 - 1}" y="${barY - 4}" text-anchor="middle" font-size="10" fill="${COLORS.text}">${opts.formatV ? opts.formatV(s.value) : s.value}</text>`);
      }
    });
    // X 轴标签
    bars.push(`<text x="${groupX}" y="${padT + chartH + 16}" text-anchor="middle" font-size="11" fill="${COLORS.text}">${escapeXml(g.label)}</text>`);
  });

  // 图例
  const legend = (groups[0]?.series || []).map((s, si) => {
    const color = s.color || colors[si % colors.length];
    const lx = padL + si * 110;
    return `<rect x="${lx}" y="${H - 25}" width="10" height="10" fill="${color}"/>
<text x="${lx + 14}" y="${H - 16}" font-size="11" fill="${COLORS.text}">${escapeXml(s.name)}</text>`;
  }).join('');

  return svgWrap(W, H, title + gridLines.join('') + bars.join('') + legend);
}

// ============== 雷达图 ==============
function radar(dims, opts = {}) {
  // dims: [{label, value, max}, ...]  (5-8 dims)
  const W = opts.width || 380;
  const H = opts.height || 360;
  const cx = W / 2, cy = H / 2 + 10;
  const r = Math.min(W, H) * 0.35;
  const n = dims.length;
  const color = opts.color || COLORS.secondary;

  const title = opts.title ? `<text x="${W/2}" y="22" text-anchor="middle" font-size="16" font-weight="bold" fill="${COLORS.primary}">${escapeXml(opts.title)}</text>` : '';

  // 网格
  const grid = [];
  for (let layer = 1; layer <= 4; layer++) {
    const lr = r * (layer / 4);
    const pts = [];
    for (let i = 0; i < n; i++) {
      const angle = -Math.PI / 2 + i * (Math.PI * 2 / n);
      pts.push(`${(cx + lr * Math.cos(angle)).toFixed(1)},${(cy + lr * Math.sin(angle)).toFixed(1)}`);
    }
    grid.push(`<polygon points="${pts.join(' ')}" fill="none" stroke="${COLORS.grid}" stroke-width="1"/>`);
  }
  // 轴线
  const axisLines = [];
  const axisLabels = [];
  for (let i = 0; i < n; i++) {
    const angle = -Math.PI / 2 + i * (Math.PI * 2 / n);
    const tx = cx + r * Math.cos(angle);
    const ty = cy + r * Math.sin(angle);
    axisLines.push(`<line x1="${cx}" y1="${cy}" x2="${tx.toFixed(1)}" y2="${ty.toFixed(1)}" stroke="${COLORS.grid}"/>`);
    // 标签放外面
    const lx = cx + (r + 22) * Math.cos(angle);
    const ly = cy + (r + 22) * Math.sin(angle);
    const anchor = Math.abs(Math.cos(angle)) < 0.3 ? 'middle' : Math.cos(angle) > 0 ? 'start' : 'end';
    axisLabels.push(`<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}" dominant-baseline="middle" font-size="12" fill="${COLORS.text}">${escapeXml(dims[i].label)}</text>`);
    axisLabels.push(`<text x="${lx.toFixed(1)}" y="${(ly+15).toFixed(1)}" text-anchor="${anchor}" dominant-baseline="middle" font-size="11" font-weight="bold" fill="${color}">${dims[i].value}</text>`);
  }

  // 数据多边形
  const dataPts = [];
  for (let i = 0; i < n; i++) {
    const angle = -Math.PI / 2 + i * (Math.PI * 2 / n);
    const max = dims[i].max || 100;
    const ratio = Math.max(0, Math.min(1, dims[i].value / max));
    const dx = cx + r * ratio * Math.cos(angle);
    const dy = cy + r * ratio * Math.sin(angle);
    dataPts.push(`${dx.toFixed(1)},${dy.toFixed(1)}`);
  }

  const body = title + grid.join('') + axisLines.join('') + axisLabels.join('') +
    `<polygon points="${dataPts.join(' ')}" fill="${color}" fill-opacity="0.3" stroke="${color}" stroke-width="2"/>`;
  return svgWrap(W, H, body);
}

// ============== MySQL 复制拓扑图 ==============
function topology(nodes, opts = {}) {
  const W = opts.width || 620;
  const primary = nodes.find(n => n.role === 'primary') || nodes[0];
  const replicas = nodes.filter(n => n !== primary);
  const title = opts.title ? `<text x="${W/2}" y="24" text-anchor="middle" font-size="16" font-weight="bold" fill="${COLORS.primary}">${escapeXml(opts.title)}</text>` : '';

  const roleLabel = (n) => {
    const r = n?.role;
    if (r === 'primary') return '主库';
    if (r === 'dr') return '灾备';
    if (r && /^slave/.test(r)) return '从库';
    return '未知';
  };

  const nodeBox = (x, y, node, role, color) => `
<rect x="${x - 95}" y="${y - 26}" width="190" height="52" rx="8" fill="${color}" stroke="${COLORS.primary}" stroke-width="1.5"/>
<text x="${x}" y="${y - 4}" text-anchor="middle" font-size="13" font-weight="bold" fill="#FFFFFF">${escapeXml(node.ip || '-')}</text>
<text x="${x}" y="${y + 16}" text-anchor="middle" font-size="11" fill="#FFFFFF">${escapeXml(role)} · server_id=${escapeXml(node.variables?.server_id || '-')}</text>`;

  // v4.5/v4.6：单节点拓扑 — 居中展示单个节点 + 副标题 + 可选警告
  // v4.6 修复：之前 H=180 导致 box(y=74-126) / 副标题(y=135) / 警告(y=150) 三者间距过小，
  // 在 docx 中渲染时文字看起来"压"在 box 边缘。重新按从上到下的固定锚点布局：
  //   - title:   y = 24            (font 16)
  //   - box:     y center = 80     (top=54, bottom=106, height 52)
  //   - subtitle:y = 130            (24px below box bottom, font 12)
  //   - warn:    y = 158            (28px below subtitle, font 11)
  // 不带警告时 H=160；带警告时 H=190。
  if (nodes.length === 1) {
    const hasSelfRefWarn = !!primary?.replication?.selfReferencingSlaveResidue;
    const H = opts.height || (hasSelfRefWarn ? 190 : 160);
    const cx = W / 2;
    const boxCy = 80;
    const subtitleY = 130;
    const warnY = 158;
    const subtitle = primary?.replication?.isSlave
      ? `复制角色未配置或异常`
      : `单节点 · 未配置主从复制（或仅采集到主库）`;
    const selfRefHint = hasSelfRefWarn
      ? `<text x="${cx}" y="${warnY}" text-anchor="middle" font-size="11" fill="#C00000">⚠ 存在 SHOW SLAVE STATUS 残留（Master_Host 指向自身），建议 RESET SLAVE ALL</text>`
      : '';
    const body = `
${title}
${nodeBox(cx, boxCy, primary || {}, roleLabel(primary), COLORS.primary)}
<text x="${cx}" y="${subtitleY}" text-anchor="middle" font-size="12" fill="${COLORS.muted}">${escapeXml(subtitle)}</text>
${selfRefHint}`;
    return svgWrap(W, H, body);
  }

  // 双主互为主从：两个节点并排 + 双向箭头
  const isDualMaster = nodes.length === 2 && nodes.every(n => n.isDualMaster);
  if (isDualMaster) {
    const H = opts.height || 220;
    const cx1 = 155;
    const cx2 = W - 155;
    const cy = H / 2;
    const ay1 = cy - 16;   // A→B 箭头 y
    const ay2 = cy + 16;   // B→A 箭头 y
    const mx = W / 2;
    const [nodeA, nodeB] = nodes;
    const arrowDefs = `<defs>
  <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="${COLORS.secondary}"/></marker>
</defs>`;
    const body = `
${arrowDefs}
${title}
${nodeBox(cx1, cy, nodeA, '主库/从库（双主节点 A）', COLORS.primary)}
<line x1="${cx1 + 96}" y1="${ay1}" x2="${cx2 - 96}" y2="${ay1}" stroke="${COLORS.secondary}" stroke-width="2" marker-end="url(#arrow)"/>
<text x="${mx}" y="${ay1 - 5}" text-anchor="middle" font-size="10" fill="${COLORS.muted}">async replication</text>
<line x1="${cx2 - 96}" y1="${ay2}" x2="${cx1 + 96}" y2="${ay2}" stroke="${COLORS.secondary}" stroke-width="2" marker-end="url(#arrow)"/>
<text x="${mx}" y="${ay2 + 15}" text-anchor="middle" font-size="10" fill="${COLORS.muted}">async replication</text>
${nodeBox(cx2, cy, nodeB, '主库/从库（双主节点 B）', COLORS.primary)}`;
    return svgWrap(W, H, body);
  }

  // 多节点拓扑：主库居左，所有非主库节点居右
  const H = opts.height || Math.max(220, 120 + Math.max(0, replicas.length - 1) * 42);
  const px = 150;
  const py = H / 2;
  const rx = W - 190;
  const startY = H / 2 - ((replicas.length - 1) * 42) / 2;

  const arrows = replicas.map((n, i) => {
    const y = startY + i * 42;
    return `
<line x1="${px + 100}" y1="${py}" x2="${rx - 100}" y2="${y}" stroke="${COLORS.secondary}" stroke-width="2" marker-end="url(#arrow)"/>
<text x="${(px + rx) / 2}" y="${y - 6}" text-anchor="middle" font-size="10" fill="${COLORS.muted}">async replication</text>`;
  }).join('');

  const replicaBoxes = replicas.map((n, i) => {
    // v4.5：使用每个节点真实角色（dr/slave/未知），而不是统一标为「从库」
    const color = n.role === 'dr' ? '#8E44AD' : COLORS.secondary;
    return nodeBox(rx, startY + i * 42, n, roleLabel(n), color);
  }).join('');

  const body = `
<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="${COLORS.secondary}"/></marker></defs>
${title}
${nodeBox(px, py, primary || {}, '主库', COLORS.primary)}
${arrows}
${replicaBoxes}`;
  return svgWrap(W, H, body);
}

// ============== SVG → PNG ==============
function svgToPng(svg, opts = {}) {
  const resvg = loadResvg();
  if (!resvg) {
    return null;
  }
  try {
    const Resvg = resvg.Resvg;
    const r = new Resvg(svg, {
      fitTo: opts.fitTo || { mode: 'original' },
      font: {
        loadSystemFonts: true,
        fontDirs: FONT_DIRS,
        defaultFontFamily: 'Noto Sans CJK SC',
      },
    });
    return r.render().asPng();
  } catch (e) {
    console.warn('SVG→PNG 转换失败：' + e.message);
    return null;
  }
}

module.exports = {
  COLORS,
  gauge,
  pie,
  hbar,
  vbar,
  radar,
  topology,
  svgToPng,
};

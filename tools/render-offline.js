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

module.exports = { B, toMarkdown, toHtml };

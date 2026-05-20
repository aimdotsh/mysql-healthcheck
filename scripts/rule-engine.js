// rule-engine.js — v5.0 声明式规则引擎
//
// 加载 scripts/rules/<dimension>/<id>.json，对节点/集群事实求值，
// 产出与原 extract.js push() 兼容的 issue 数组。
//
// 设计原则：
// - 零 eval / 零 Function 构造：表达式用自实现的迷你 AST
// - 兼容 v4.8 三层 cfg：thresholds / disabledRules / priorities
// - A/B 类纯 JSON；D/F 类用 handler 转交（v5.0.0-alpha 暂不启用 handler）
//
// 详细 schema 见 scripts/rules/SCHEMA.md。

'use strict';

const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────
// 1) 表达式：tokenizer + recursive-descent parser + evaluator
// ─────────────────────────────────────────────────────────────────────────

const T = Object.freeze({
  NUM: 'NUM', STR: 'STR', IDENT: 'IDENT', BOOL: 'BOOL', NULL: 'NULL',
  OP: 'OP', LP: 'LP', RP: 'RP', EOF: 'EOF',
});

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(') { tokens.push({ t: T.LP }); i++; continue; }
    if (c === ')') { tokens.push({ t: T.RP }); i++; continue; }
    // string
    if (c === "'" || c === '"') {
      const quote = c; i++;
      let s = '';
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < src.length) { s += src[i + 1]; i += 2; }
        else { s += src[i++]; }
      }
      if (i >= src.length) throw new Error(`unterminated string in expr: ${src}`);
      i++; // consume quote
      tokens.push({ t: T.STR, v: s });
      continue;
    }
    // number
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let s = '';
      while (i < src.length && /[0-9.]/.test(src[i])) s += src[i++];
      tokens.push({ t: T.NUM, v: Number(s) });
      continue;
    }
    // ident / keyword
    if (/[a-zA-Z_]/.test(c)) {
      let s = '';
      while (i < src.length && /[a-zA-Z0-9_.]/.test(src[i])) s += src[i++];
      if (s === 'true' || s === 'false') tokens.push({ t: T.BOOL, v: s === 'true' });
      else if (s === 'null') tokens.push({ t: T.NULL });
      else tokens.push({ t: T.IDENT, v: s });
      continue;
    }
    // multi-char operators
    const two = src.slice(i, i + 2);
    if (['>=', '<=', '==', '!=', '&&', '||'].includes(two)) {
      tokens.push({ t: T.OP, v: two }); i += 2; continue;
    }
    // single char operators
    if ('><+-*/!'.includes(c)) {
      tokens.push({ t: T.OP, v: c }); i++; continue;
    }
    throw new Error(`unexpected char '${c}' at ${i} in expr: ${src}`);
  }
  tokens.push({ t: T.EOF });
  return tokens;
}

function parse(src) {
  const tokens = tokenize(src);
  let p = 0;
  const peek = () => tokens[p];
  const next = () => tokens[p++];
  const expect = (t, v) => {
    const tk = next();
    if (tk.t !== t || (v !== undefined && tk.v !== v)) {
      throw new Error(`expected ${t}${v !== undefined ? `(${v})` : ''} got ${tk.t}(${tk.v}) in ${src}`);
    }
    return tk;
  };

  // expr → or_expr
  // or_expr → and_expr ('||' and_expr)*
  // and_expr → not_expr ('&&' not_expr)*
  // not_expr → '!'? cmp_expr
  // cmp_expr → add_expr (CMP add_expr)?
  // add_expr → mul_expr (('+' | '-') mul_expr)*
  // mul_expr → unary (('*' | '/') unary)*
  // unary → '-'? primary
  // primary → NUM | STR | BOOL | NULL | IDENT | '(' expr ')'

  function parseOr() {
    let left = parseAnd();
    while (peek().t === T.OP && peek().v === '||') { next(); left = { k: 'or', l: left, r: parseAnd() }; }
    return left;
  }
  function parseAnd() {
    let left = parseNot();
    while (peek().t === T.OP && peek().v === '&&') { next(); left = { k: 'and', l: left, r: parseNot() }; }
    return left;
  }
  function parseNot() {
    if (peek().t === T.OP && peek().v === '!') { next(); return { k: 'not', x: parseCmp() }; }
    return parseCmp();
  }
  function parseCmp() {
    const left = parseAdd();
    if (peek().t === T.OP && ['>', '<', '>=', '<=', '==', '!='].includes(peek().v)) {
      const op = next().v;
      return { k: 'cmp', op, l: left, r: parseAdd() };
    }
    return left;
  }
  function parseAdd() {
    let left = parseMul();
    while (peek().t === T.OP && (peek().v === '+' || peek().v === '-')) {
      const op = next().v;
      left = { k: 'arith', op, l: left, r: parseMul() };
    }
    return left;
  }
  function parseMul() {
    let left = parseUnary();
    while (peek().t === T.OP && (peek().v === '*' || peek().v === '/')) {
      const op = next().v;
      left = { k: 'arith', op, l: left, r: parseUnary() };
    }
    return left;
  }
  function parseUnary() {
    if (peek().t === T.OP && peek().v === '-') { next(); return { k: 'neg', x: parsePrimary() }; }
    return parsePrimary();
  }
  function parsePrimary() {
    const tk = peek();
    if (tk.t === T.NUM) { next(); return { k: 'num', v: tk.v }; }
    if (tk.t === T.STR) { next(); return { k: 'str', v: tk.v }; }
    if (tk.t === T.BOOL) { next(); return { k: 'bool', v: tk.v }; }
    if (tk.t === T.NULL) { next(); return { k: 'null' }; }
    if (tk.t === T.IDENT) { next(); return { k: 'ident', path: tk.v.split('.') }; }
    if (tk.t === T.LP) { next(); const e = parseOr(); expect(T.RP); return e; }
    throw new Error(`unexpected token ${tk.t}(${tk.v}) in ${src}`);
  }

  const ast = parseOr();
  if (peek().t !== T.EOF) throw new Error(`trailing tokens in expr: ${src}`);
  return ast;
}

function resolvePath(ctx, segs) {
  let cur = ctx;
  for (const s of segs) {
    if (cur == null) return undefined;
    cur = cur[s];
  }
  return cur;
}

function evalAst(ast, ctx) {
  switch (ast.k) {
    case 'num': case 'str': case 'bool': return ast.v;
    case 'null': return null;
    case 'ident': return resolvePath(ctx, ast.path);
    case 'neg': {
      const v = evalAst(ast.x, ctx);
      return v == null ? null : -Number(v);
    }
    case 'not': return !evalAst(ast.x, ctx);
    case 'and': return evalAst(ast.l, ctx) && evalAst(ast.r, ctx);
    case 'or': return evalAst(ast.l, ctx) || evalAst(ast.r, ctx);
    case 'cmp': {
      const lv = evalAst(ast.l, ctx);
      const rv = evalAst(ast.r, ctx);
      // MySQL-like NULL semantics: any comparison with undefined/null → false
      // (so missing fields never accidentally trigger)
      if (lv == null || rv == null) {
        if (ast.op === '==') return lv == rv;
        if (ast.op === '!=') return lv != rv;
        return false;
      }
      switch (ast.op) {
        case '>': return Number(lv) > Number(rv);
        case '<': return Number(lv) < Number(rv);
        case '>=': return Number(lv) >= Number(rv);
        case '<=': return Number(lv) <= Number(rv);
        case '==': return lv == rv;
        case '!=': return lv != rv;
      }
      throw new Error(`bad cmp op ${ast.op}`);
    }
    case 'arith': {
      const lv = Number(evalAst(ast.l, ctx));
      const rv = Number(evalAst(ast.r, ctx));
      if (Number.isNaN(lv) || Number.isNaN(rv)) return NaN;
      switch (ast.op) {
        case '+': return lv + rv;
        case '-': return lv - rv;
        case '*': return lv * rv;
        case '/': return rv === 0 ? NaN : lv / rv;
      }
      throw new Error(`bad arith op ${ast.op}`);
    }
    default: throw new Error(`bad ast kind ${ast.k}`);
  }
}

// Convenience: parse once, evaluate many
const _exprCache = new Map();
function compileExpr(src) {
  if (!_exprCache.has(src)) _exprCache.set(src, parse(src));
  return _exprCache.get(src);
}
function evalExpr(src, ctx) {
  return evalAst(compileExpr(src), ctx);
}

// ─────────────────────────────────────────────────────────────────────────
// 2) 模板渲染（Mustache-lite）
// ─────────────────────────────────────────────────────────────────────────

function renderTpl(tpl, ctx) {
  if (tpl == null) return undefined;
  return String(tpl).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, path) => {
    const v = resolvePath(ctx, path.trim().split('.'));
    return v == null ? '' : String(v);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// 3) 规则加载与求值
// ─────────────────────────────────────────────────────────────────────────

function loadRulesFromDir(rulesDir) {
  // v5.0.1：布局从「<dim>/<id>.json 子目录」改为「<dim>.json 文件」。
  // 每个 <dim>.json 文件含 `rules: [...]` 数组；dimension 由文件名（去 .json）推断。
  // 引擎接口和 rule 字段语义完全保持不变。
  const rules = [];
  if (!fs.existsSync(rulesDir)) return rules;
  const files = fs.readdirSync(rulesDir, { withFileTypes: true })
    .filter(d => d.isFile() && d.name.endsWith('.json'))
    .map(d => d.name)
    .sort();
  for (const file of files) {
    const full = path.join(rulesDir, file);
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (e) {
      throw new Error(`failed to parse rule file ${full}: ${e.message}`);
    }
    const dimension = file.replace(/\.json$/, '');
    // 兼容两种顶层结构：
    //   (a) v5.0.1：{ rules: [...] }
    //   (b) 旧 v5.0：单条规则对象（向后兼容自定义规则）
    const ruleArray = Array.isArray(payload?.rules) ? payload.rules
                    : Array.isArray(payload)        ? payload
                    : [payload];
    for (const rule of ruleArray) {
      if (!rule || typeof rule !== 'object') continue;
      validateRule(rule, full);
      rule._sourceFile = full;
      rule.dimension = dimension;
      rules.push(rule);
    }
  }
  return rules;
}

function validateRule(rule, sourceFile) {
  const errs = [];
  if (!rule.id || typeof rule.id !== 'string') errs.push('missing id');
  if (!rule.scope || !['node', 'cluster'].includes(rule.scope)) errs.push(`bad scope: ${rule.scope}`);
  const hasTrig = !!rule.trigger;
  const hasTiers = Array.isArray(rule.tiers) && rule.tiers.length > 0;
  const hasHandler = !!rule.handler;
  if ([hasTrig, hasTiers, hasHandler].filter(Boolean).length !== 1) {
    errs.push('must have exactly one of: trigger / tiers / handler');
  }
  if (hasTrig && !rule.priority) errs.push('trigger rules require priority');
  if (hasTiers) {
    for (const [i, t] of rule.tiers.entries()) {
      if (!t.when) errs.push(`tier[${i}] missing when`);
      if (!t.priority) errs.push(`tier[${i}] missing priority`);
    }
  }
  if (errs.length) throw new Error(`rule ${rule.id || '<no-id>'} (${sourceFile}) invalid: ${errs.join('; ')}`);
}

function evalSingleNodeRule(rule, ctx, helpersRegistry) {
  let firedPriority = null;
  let match = {};

  if (rule.handler) {
    const fn = helpersRegistry && helpersRegistry[rule.handler];
    if (!fn) throw new Error(`unknown handler '${rule.handler}' in rule ${rule.id}`);
    const patches = fn({ ...ctx, rule }) || [];
    const out = [];
    // Handler patches can either:
    //   (a) supply { priority, match: {...} } and let the rule's *Tpl fields render
    //   (b) override any field directly (type / description / action / sql / dimension
    //       / scope / groupKey / currentValue / recommendedValue / node /
    //       needsConfirmation / affectedUsers) — useful for multi-variant rules where
    //       one handler emits issues of different types (e.g. evalDisks → disk_critical
    //       AND disk_high AND disk_optical_full).
    const OVERRIDABLE = ['type', 'description', 'action', 'sql', 'dimension', 'scope',
      'groupKey', 'currentValue', 'recommendedValue', 'node', 'needsConfirmation',
      'affectedUsers'];
    for (const p of patches) {
      const pctx = { ...ctx, match: p.match || {}, value: p.value };
      const issue = buildIssue(rule, p.priority || rule.priority, pctx);
      for (const k of OVERRIDABLE) {
        if (p[k] !== undefined) issue[k] = p[k];
      }
      out.push(issue);
    }
    return out;
  }

  if (rule.trigger) {
    if (evalExpr(rule.trigger, ctx)) firedPriority = rule.priority;
  } else if (rule.tiers) {
    for (const tier of rule.tiers) {
      if (evalExpr(tier.when, ctx)) { firedPriority = tier.priority; match.tier = tier; break; }
    }
  }
  if (!firedPriority) return [];
  return [buildIssue(rule, firedPriority, { ...ctx, match })];
}

function buildIssue(rule, priority, ctx) {
  const issue = {
    type: rule.id,
    priority,
    dimension: rule.dimension,
    scope: rule.scope,
  };
  if (rule.groupKeyTpl)         issue.groupKey         = renderTpl(rule.groupKeyTpl, ctx);
  if (rule.descriptionTpl)      issue.description      = renderTpl(rule.descriptionTpl, ctx);
  if (rule.actionTpl)           issue.action           = renderTpl(rule.actionTpl, ctx);
  if (rule.sqlTpl)              issue.sql              = renderTpl(rule.sqlTpl, ctx);
  if (rule.currentValueTpl)     issue.currentValue     = renderTpl(rule.currentValueTpl, ctx);
  if (rule.recommendedValueTpl) issue.recommendedValue = renderTpl(rule.recommendedValueTpl, ctx);
  if (rule.needsConfirmation)   issue.needsConfirmation = true;
  // node label: explicit nodeTpl > ctx.node.label > ctx.node.ip > hostname
  // extract.js should set node.label = nodeLabel(n) before invoking engine
  // so the issue.node string matches existing format `IP（角色）`.
  if (rule.nodeTpl)             issue.node = renderTpl(rule.nodeTpl, ctx);
  else if (ctx.node)            issue.node = ctx.node.label || ctx.node.ip || ctx.node.hostname || undefined;
  return issue;
}

// ─────────────────────────────────────────────────────────────────────────
// 4) 引擎主 API
// ─────────────────────────────────────────────────────────────────────────

function createEngine(opts = {}) {
  const rulesDir = opts.rulesDir || path.join(__dirname, 'rules');
  const helpers = opts.helpers || {};
  const rules = loadRulesFromDir(rulesDir);

  function run({ nodes = [], cluster = {}, cfg = {} } = {}) {
    const disabled = new Set(cfg.disabledRules || []);
    const overrides = cfg.priorities || {};
    const issues = [];

    // Helper: filter issues by both rule.id and issue.type (so disabling a
    // multi-variant rule by EITHER name works).
    const applyOverrides = (rule, produced) => {
      for (const it of produced) {
        if (disabled.has(it.type)) continue;
        if (overrides[it.type]) it.priority = overrides[it.type];
        issues.push(it);
      }
    };

    for (const rule of rules) {
      if (disabled.has(rule.id)) continue;

      if (rule.scope === 'node') {
        for (const node of nodes) {
          const ctx = { node, cluster, nodes, cfg };
          try {
            applyOverrides(rule, evalSingleNodeRule(rule, ctx, helpers));
          } catch (e) {
            console.error(`[rule-engine] rule ${rule.id} failed on node ${node.ip || '?'}: ${e.message}`);
          }
        }
      } else if (rule.scope === 'cluster') {
        const ctx = { cluster, nodes, cfg };
        try {
          applyOverrides(rule, evalSingleNodeRule(rule, ctx, helpers));
        } catch (e) {
          console.error(`[rule-engine] cluster rule ${rule.id} failed: ${e.message}`);
        }
      }
    }
    return issues;
  }

  return { run, rules, _internals: { evalExpr, renderTpl, loadRulesFromDir } };
}

module.exports = {
  createEngine,
  // exported for unit tests
  _tokenize: tokenize,
  _parse: parse,
  _evalExpr: evalExpr,
  _renderTpl: renderTpl,
  _loadRulesFromDir: loadRulesFromDir,
  _validateRule: validateRule,
};

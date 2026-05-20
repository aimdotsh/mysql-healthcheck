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
  const rules = [];
  if (!fs.existsSync(rulesDir)) return rules;
  const dims = fs.readdirSync(rulesDir, { withFileTypes: true })
    .filter(d => d.isDirectory());
  for (const dim of dims) {
    const dimPath = path.join(rulesDir, dim.name);
    const files = fs.readdirSync(dimPath).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const full = path.join(dimPath, f);
      let rule;
      try {
        rule = JSON.parse(fs.readFileSync(full, 'utf8'));
      } catch (e) {
        throw new Error(`failed to parse rule ${full}: ${e.message}`);
      }
      validateRule(rule, full);
      rule._sourceFile = full;
      // dimension from dir always wins (single source of truth)
      rule.dimension = dim.name;
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
    // handler returns array of issues; each rendered separately
    const out = [];
    for (const p of patches) {
      const pctx = { ...ctx, match: p.match || {}, value: p.value };
      out.push(buildIssue(rule, p.priority || rule.priority, pctx));
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

    for (const rule of rules) {
      if (disabled.has(rule.id)) continue;

      if (rule.scope === 'node') {
        // Per-node trigger / tiers / handler evaluation.
        // Note: even rules that emit "cluster-scoped" issues (output.scope =
        // 'cluster') typically still iterate per node and rely on downstream
        // groupKey dedup. They should declare rule.scope='node' here unless
        // they truly need full cluster context (in which case use a handler).
        for (const node of nodes) {
          const ctx = { node, cluster, nodes, cfg };
          try {
            const produced = evalSingleNodeRule(rule, ctx, helpers);
            for (const it of produced) {
              if (overrides[rule.id]) it.priority = overrides[rule.id];
              issues.push(it);
            }
          } catch (e) {
            console.error(`[rule-engine] rule ${rule.id} failed on node ${node.ip || '?'}: ${e.message}`);
          }
        }
      } else if (rule.scope === 'cluster') {
        // Single evaluation with full cluster context. Typically used with
        // handler-based rules (D/F class), but trigger / tiers also supported
        // for rules whose expression only references `cluster.*` or `nodes`.
        const ctx = { cluster, nodes, cfg };
        try {
          const produced = evalSingleNodeRule(rule, ctx, helpers);
          for (const it of produced) {
            if (overrides[rule.id]) it.priority = overrides[rule.id];
            issues.push(it);
          }
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

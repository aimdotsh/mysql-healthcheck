// data.json schema 校验 + collector 版本识别
// 解决 Codex 反馈 #5：render.js 直接假设 data.cluster.ips 等字段存在，
// 缺字段会运行时崩溃。本文件提供运行前快速诊断。
'use strict';

const CURRENT_SCHEMA_VERSION = 3;

// 字段定义：required = 缺失立刻报 ERROR；optional 缺失只警告
const FIELD_SPEC = {
  schemaVersion:       { kind: 'number', required: true },
  project:             { kind: 'string', required: true },
  reportVersion:       { kind: 'string', required: false, default: '1.0' },
  inspectionDate:      { kind: 'string', required: true },
  reportDate:          { kind: 'string', required: true },
  'cluster.topology':  { kind: 'string', required: true },
  'cluster.nodeCount': { kind: 'number', required: true },
  'cluster.ips':       { kind: 'array',  required: true, minLen: 1 },
  healthScore:         { kind: 'object', required: false },
  overallAssessment:   { kind: 'string', required: true },
  issues:              { kind: 'array',  required: true },
  correlations:        { kind: 'array',  required: false },
  paramJudgments:      { kind: 'array',  required: false },
  backupAssessment:    { kind: 'object', required: false },
  securityAssessment:  { kind: 'object', required: false },
  nodes:               { kind: 'array',  required: true, minLen: 1 },
  recommendations:     { kind: 'object', required: false },
};

const NODE_FIELDS = {
  ip:       { kind: 'string', required: true },
  role:     { kind: 'string', required: true },
  hostname: { kind: 'string', required: false },
};

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function checkField(value, spec, label) {
  if (value === undefined || value === null) {
    if (spec.required) return { level: 'ERROR', msg: `${label} 缺失（必需字段）` };
    return null;
  }
  const actual = typeOf(value);
  const expected = spec.kind;
  if (actual !== expected) {
    return { level: 'ERROR', msg: `${label} 类型错误（期望 ${expected}，实际 ${actual}）` };
  }
  if (spec.minLen != null && value.length < spec.minLen) {
    return { level: 'ERROR', msg: `${label} 长度 ${value.length} < ${spec.minLen}` };
  }
  return null;
}

// 主校验入口：返回 { ok, errors, warnings, summary }
function validate(data) {
  const errors = [];
  const warnings = [];

  if (!data || typeof data !== 'object') {
    return {
      ok: false,
      errors: [{ level: 'ERROR', msg: 'data 不是对象（可能是 JSON 解析失败）' }],
      warnings: [],
      summary: '数据无效',
    };
  }

  // schemaVersion 兼容性
  const sv = data.schemaVersion;
  if (sv == null) {
    warnings.push({ level: 'WARN', msg: '缺 schemaVersion，按当前版本 ' + CURRENT_SCHEMA_VERSION + ' 处理' });
  } else if (sv > CURRENT_SCHEMA_VERSION) {
    warnings.push({ level: 'WARN', msg: `data.json 的 schemaVersion=${sv} 高于 render 当前支持 (${CURRENT_SCHEMA_VERSION})，可能渲染不完整` });
  } else if (sv < CURRENT_SCHEMA_VERSION) {
    warnings.push({ level: 'WARN', msg: `data.json 的 schemaVersion=${sv} 低于当前 (${CURRENT_SCHEMA_VERSION})，建议重跑 extract.js` });
  }

  // 顶层字段
  for (const [path, spec] of Object.entries(FIELD_SPEC)) {
    if (path === 'schemaVersion') continue;
    const v = getPath(data, path);
    const e = checkField(v, spec, path);
    if (e) (e.level === 'ERROR' ? errors : warnings).push(e);
  }

  // nodes[*] 字段
  if (Array.isArray(data.nodes)) {
    data.nodes.forEach((n, i) => {
      for (const [k, spec] of Object.entries(NODE_FIELDS)) {
        const e = checkField(n[k], spec, `nodes[${i}].${k}`);
        if (e) (e.level === 'ERROR' ? errors : warnings).push(e);
      }
    });
  }

  // issues[*] 字段
  if (Array.isArray(data.issues)) {
    data.issues.forEach((it, i) => {
      if (!it.priority) errors.push({ level: 'ERROR', msg: `issues[${i}].priority 缺失` });
      else if (!/^P[0-3]$/.test(it.priority)) warnings.push({ level: 'WARN', msg: `issues[${i}].priority="${it.priority}" 不符合 P0-P3` });
      if (!it.description) warnings.push({ level: 'WARN', msg: `issues[${i}].description 缺失` });
    });
  }

  // collector 元信息（可选）
  if (data.collectorVersion) {
    if (!/^\d+\.\d+/.test(String(data.collectorVersion))) {
      warnings.push({ level: 'WARN', msg: `collectorVersion="${data.collectorVersion}" 格式异常` });
    }
  }

  // 总结
  const summary = errors.length === 0
    ? `✓ schema 校验通过（${warnings.length} 个警告）`
    : `✗ schema 校验失败（${errors.length} 错误 / ${warnings.length} 警告）`;

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary,
  };
}

// 控制台输出校验结果
function printReport(result) {
  if (result.errors.length === 0 && result.warnings.length === 0) {
    console.error('✓ schema 校验通过');
    return;
  }
  console.error('');
  console.error('═══════════════════════════════════════════');
  console.error('  data.json schema 诊断');
  console.error('═══════════════════════════════════════════');
  for (const e of result.errors)   console.error('  ✗ ERROR: ' + e.msg);
  for (const w of result.warnings) console.error('  ⚠ WARN:  ' + w.msg);
  console.error('  ' + result.summary);
  console.error('');
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  validate,
  printReport,
};

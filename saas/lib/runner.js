// 把 scripts/extract.js + scripts/render.js 包装成可异步执行的 job。
// 用 child_process.spawn 避免污染主进程，并保留所有现有 CLI 行为。
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts');
const EXTRACT_SCRIPT = path.join(SCRIPTS_DIR, 'extract.js');
const RENDER_SCRIPT = path.join(SCRIPTS_DIR, 'render.js');

/**
 * 异步执行子进程，捕获 stdout/stderr。
 */
function runChild(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: SCRIPTS_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeout || 5 * 60 * 1000,   // 5 分钟默认上限
      ...opts,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => reject(err));
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(cmd)} ${args.join(' ')} 退出码 ${code}\n--- stderr ---\n${stderr.slice(-2000)}`));
    });
  });
}

/**
 * 跑一个 job：extract.js → render.js → 返回结果路径 + 摘要
 * @param {object} opts
 * @param {string} opts.uploadDir      含 MySQLHealthCheck_*.txt 的目录
 * @param {string} opts.outputDir      docx + data.json 的输出目录
 * @param {string} opts.project        项目名（写入报告标题）
 * @param {string} [opts.configPath]   可选阈值配置文件路径
 * @param {(stage: string) => void} [opts.onProgress]  进度回调
 * @returns {Promise<{docxPath, dataJsonPath, summary}>}
 */
async function generateReport(opts) {
  const { uploadDir, outputDir, project, configPath, onProgress } = opts;
  if (!fs.existsSync(uploadDir)) throw new Error(`上传目录不存在: ${uploadDir}`);
  fs.mkdirSync(outputDir, { recursive: true });

  const dataJsonPath = path.join(outputDir, 'data.json');
  const docxPath = path.join(outputDir, `${sanitizeFileName(project)}_MySQL健康巡检报告_v1.0.docx`);

  // Phase 1: extract
  onProgress?.('extract');
  const extractArgs = [EXTRACT_SCRIPT, uploadDir, '--project', project, '--out', dataJsonPath];
  if (configPath) extractArgs.push('--config', configPath);
  await runChild(process.execPath, extractArgs);

  // Phase 2: render
  onProgress?.('render');
  // 跳过 LibreOffice 刷新以加快 SaaS 响应；前端可以提示用户自行更新目录
  await runChild(process.execPath, [RENDER_SCRIPT, dataJsonPath, '--out', docxPath, '--no-toc-refresh']);

  // 读取 data.json 摘要供前端展示
  const data = JSON.parse(fs.readFileSync(dataJsonPath, 'utf-8'));
  const issues = data.issues || [];
  const summary = {
    nodeCount: data.cluster?.nodeCount || data.nodes?.length || 0,
    topology: data.cluster?.topology || '-',
    issueCount: issues.length,
    p0: issues.filter(i => i.priority === 'P0').length,
    p1: issues.filter(i => i.priority === 'P1').length,
    p2: issues.filter(i => i.priority === 'P2').length,
    p3: issues.filter(i => i.priority === 'P3').length,
    healthScoreTotal: data.healthScore?.total || null,
    overallAssessment: data.overallAssessment || '-',
    correlationCount: (data.correlations || []).length,
    disabledRules: data.disabledRulesApplied || [],
    docxSizeBytes: fs.statSync(docxPath).size,
  };

  return { docxPath, dataJsonPath, summary };
}

function sanitizeFileName(s) {
  return String(s || 'report').replace(/[\/\\:*?"<>|]/g, '_').slice(0, 80);
}

module.exports = { generateReport, sanitizeFileName };

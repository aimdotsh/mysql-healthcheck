#!/usr/bin/env node
/**
 * mysql-healthcheck SaaS server
 *
 * 启动：node saas/server.js
 *       PORT=3000 API_KEY=xxx node saas/server.js
 *
 * 提供：
 *   - 静态网页（/）         拖拽上传 *.txt → 生成 docx + 自动下载
 *   - REST API（/api/v1）  程序化对接
 *   - 健康检查（/api/v1/health）
 *
 * v1 设计：单进程、内存 job 表、文件系统存储。多副本生产部署需替换 jobs.js 为 Redis。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const { JobStore, STATUS } = require('./lib/jobs');
const { generateReport, sanitizeFileName } = require('./lib/runner');
const { groupIntoClusters } = require('./lib/grouper');
const { HistoryStore } = require('./lib/history');

const PORT = Number(process.env.PORT) || 3000;
const _apiKeyRaw = process.env.API_KEY || '';
const API_KEY = (_apiKeyRaw && _apiKeyRaw !== '<no value>') ? _apiKeyRaw : undefined;   // 可选鉴权；未设置或空则全开
const STORAGE_ROOT = process.env.STORAGE_ROOT || path.join(__dirname, 'storage');
const UPLOADS_DIR = path.join(STORAGE_ROOT, 'uploads');
const REPORTS_DIR = path.join(STORAGE_ROOT, 'reports');
const HISTORY_DIR = path.join(STORAGE_ROOT, 'history');
const MAX_FILES = Number(process.env.MAX_FILES) || 16;
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB) || 50;

// 准备存储目录
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(REPORTS_DIR, { recursive: true });
fs.mkdirSync(HISTORY_DIR, { recursive: true });

const jobs = new JobStore();
const history = new HistoryStore(HISTORY_DIR);

// v1.2：根据 jobId 在 storage/reports 目录里查找已生成的 docx 文件。
// 用于历史下载（in-memory job 可能已过期，但 docx 仍在磁盘）。
function findClusterDocx(jobId) {
  const dir = path.join(REPORTS_DIR, jobId);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.docx'));
  if (files.length === 0) return null;
  return path.join(dir, files[0]);
}
function findClusterDataJson(jobId) {
  const dir = path.join(REPORTS_DIR, jobId);
  const p = path.join(dir, 'data.json');
  return fs.existsSync(p) ? p : null;
}

// ============== multer：multipart 上传到 storage/uploads/<jobId>/ ==============
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const jobId = req._pendingJobId || (req._pendingJobId = crypto.randomBytes(8).toString('hex'));
      const dir = path.join(UPLOADS_DIR, jobId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      // 保留原始文件名，仅做基本清洗（防止穿越）
      const safe = path.basename(file.originalname).replace(/[\/\\]/g, '_');
      cb(null, safe);
    },
  }),
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024, files: MAX_FILES },
  fileFilter: (req, file, cb) => {
    // 只接受 txt（采集器输出）
    if (!/\.(txt|log)$/i.test(file.originalname)) {
      return cb(new Error(`只接受 .txt / .log 文件（收到：${file.originalname}）`));
    }
    cb(null, true);
  },
});

// ============== Express app ==============
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// 简易请求日志
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

// API Key 鉴权（仅对 /api/* 生效；GET /api/v1/health 放行；
// 非 /api/* 路径（如 /, /app.js, /static/* 等 Web UI 资源）一律放行 — 前端 JS
// 会从 localStorage 取 API Key 并在 fetch 时塞进 X-API-Key 头）
function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  if (!req.path.startsWith('/api/')) return next();   // 静态 UI 放行
  if (req.path === '/api/v1/health') return next();   // 健康检查 / LB 探针放行
  const provided = req.get('X-API-Key') || req.query.api_key;
  if (provided !== API_KEY) return res.status(401).json({ error: 'API key required (X-API-Key header)' });
  next();
}
app.use(requireApiKey);

// ============== 静态 Web UI ==============
app.use(express.static(path.join(__dirname, 'public')));

// ============== REST API ==============

// GET /api/v1/health
app.get('/api/v1/health', (req, res) => {
  let scriptsVersion = 'unknown';
  try {
    scriptsVersion = require(path.join(__dirname, '..', 'scripts', 'package.json')).version;
  } catch (_) {}
  res.json({
    status: 'ok',
    saasVersion: require('./package.json').version,
    scriptsVersion,
    apiKeyEnabled: !!API_KEY,
    storage: { uploadsDir: UPLOADS_DIR, reportsDir: REPORTS_DIR },
  });
});

// GET /api/v1/auth/check — Web UI 检查 API Key 是否正确（200 OK 即正确；401 = 错）
// 经过 requireApiKey 中间件后能到这里，说明 key 已通过校验
app.get('/api/v1/auth/check', (req, res) => {
  res.json({ ok: true, apiKeyEnabled: !!API_KEY });
});

// GET /collector/mysqlHealthCheckV3.0.sh — 下载采集脚本（公开，不需要 API key）
// 路径以 /collector 开头，不属于 /api/* — 已经被 requireApiKey 中间件放行
app.get('/collector/mysqlHealthCheckV3.0.sh', (req, res) => {
  const file = path.resolve(__dirname, '..', 'collectors', 'mysqlHealthCheckV3.0.sh');
  if (!fs.existsSync(file)) {
    return res.status(404).json({ error: '采集脚本未找到' });
  }
  res.setHeader('Content-Type', 'application/x-sh; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="mysqlHealthCheckV3.0.sh"');
  res.sendFile(file);
});

// POST /api/v1/reports  multipart/form-data
// fields: files[] (one or more *.txt) + project (optional) + configJson (optional)
//
// v1.1 重大改进：自动按复制拓扑分组。如果上传的 N 个 txt 来自 K 个独立集群
// （单点 / 主从），自动拆成 K 个子作业，每个子作业生成一份独立的报告。
// 响应一律返回 batch 形式 { batchId, clusters: [{jobId, label, ...}] }。
app.post('/api/v1/reports', upload.array('files', MAX_FILES), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: '未收到任何文件。请用 multipart/form-data，字段名 files' });
    }
    const batchId = req._pendingJobId;       // 用 multer 生成的 id 做 batch 父目录
    const batchUploadDir = path.join(UPLOADS_DIR, batchId);
    const projectBase = (req.body.project || '').trim();

    // 解析可选 configJson 一次，后面所有子作业共用
    let parsedConfig = null;
    if (req.body.configJson) {
      try {
        parsedConfig = JSON.parse(req.body.configJson);
      } catch (e) {
        return res.status(400).json({ error: `configJson 不是合法 JSON: ${e.message}` });
      }
    }

    // 自动按复制拓扑分组
    const filesForGrouper = req.files.map(f => ({ path: f.path, originalName: f.originalname }));
    let groups;
    try {
      groups = groupIntoClusters(filesForGrouper);
    } catch (e) {
      console.error('grouper failed:', e);
      return res.status(500).json({ error: `集群发现失败：${e.message}` });
    }
    if (groups.length === 0) {
      return res.status(400).json({ error: '未能从上传文件中识别任何 MySQL 节点（请确认是 MySQLHealthCheck_*.txt 采集脚本输出）' });
    }

    console.log(`[batch ${batchId}] 收到 ${req.files.length} 个 txt → 自动识别 ${groups.length} 个集群`);

    // 为每个集群创建独立的 jobId + 子目录 + 子作业
    const clusterInfo = [];
    for (let idx = 0; idx < groups.length; idx++) {
      const g = groups[idx];
      const subJobId = crypto.randomBytes(8).toString('hex');
      const subUploadDir = path.join(UPLOADS_DIR, subJobId);
      const subOutputDir = path.join(REPORTS_DIR, subJobId);
      fs.mkdirSync(subUploadDir, { recursive: true });
      fs.mkdirSync(subOutputDir, { recursive: true });

      // 把该集群涉及的 txt 移动到独立目录（用 hard link 节省空间）
      for (const f of g.files) {
        const dst = path.join(subUploadDir, path.basename(f.originalName));
        try {
          fs.linkSync(f.path, dst);
        } catch (_) {
          fs.copyFileSync(f.path, dst);
        }
      }
      // 落盘共享 config
      if (parsedConfig) {
        fs.writeFileSync(path.join(subUploadDir, 'mysql-healthcheck.config.json'),
                         JSON.stringify(parsedConfig, null, 2));
      }

      // 项目名：用户给的优先；多集群时附加 「(集群标签)」 后缀
      const subProject = projectBase
        ? (groups.length > 1 ? `${projectBase}_${g.primaryIp || idx + 1}` : projectBase)
        : `Report_${g.primaryIp || subJobId.slice(0, 6)}`;

      const fileNames = g.files.map(f => f.originalName);
      const job = jobs.create({ project: subProject, uploadDir: subUploadDir, fileNames });
      job.id = subJobId;
      jobs.jobs.set(subJobId, job);
      job.batchId = batchId;
      job.clusterLabel = g.label;
      job.clusterTopology = g.topology;
      job.clusterNodes = g.nodes.map(n => n.ip || n.hostname || '?');

      // 异步执行
      setImmediate(async () => {
        try {
          jobs.update(subJobId, { status: STATUS.RUNNING_EXTRACT, progress: 'extract' });
          history.updateCluster(batchId, subJobId, { status: 'running:extract', progress: 'extract' });
          const { docxPath, dataJsonPath, summary } = await generateReport({
            uploadDir: subUploadDir,
            outputDir: subOutputDir,
            project: subProject,
            onProgress: (stage) => {
              const next = stage === 'extract' ? STATUS.RUNNING_EXTRACT : STATUS.RUNNING_RENDER;
              jobs.update(subJobId, { status: next, progress: stage });
              history.updateCluster(batchId, subJobId, { status: 'running:' + stage, progress: stage });
            },
          });
          jobs.update(subJobId, {
            status: STATUS.DONE,
            progress: 'done',
            result: { docxPath, dataJsonPath, summary },
          });
          // 持久化到 history：记录相对路径便于跨进程恢复
          history.updateCluster(batchId, subJobId, {
            status: 'done',
            progress: 'done',
            summary,
            docxRelPath: path.relative(REPORTS_DIR, docxPath),
            dataJsonRelPath: path.relative(REPORTS_DIR, dataJsonPath),
            completedAt: new Date().toISOString(),
          });
          console.log(`[job ${subJobId}] (${g.label}) done — ${summary.issueCount} issues, ${(summary.docxSizeBytes / 1024).toFixed(1)} KB`);
        } catch (err) {
          console.error(`[job ${subJobId}] (${g.label}) error:`, err.message);
          jobs.update(subJobId, { status: STATUS.ERROR, error: err.message });
          history.updateCluster(batchId, subJobId, {
            status: 'error',
            error: err.message,
            completedAt: new Date().toISOString(),
          });
        }
      });

      clusterInfo.push({
        jobId: subJobId,
        label: g.label,
        topology: g.topology,
        nodes: g.nodes.map(n => n.ip || n.hostname || '?'),
        primaryIp: g.primaryIp,
        fileCount: g.files.length,
        files: g.files.map(f => f.originalName),
        project: subProject,
        statusUrl: `/api/v1/reports/${subJobId}`,
      });
    }

    const batchResp = {
      batchId,
      receivedFiles: req.files.length,
      clusterCount: groups.length,
      project: projectBase || null,
      clusters: clusterInfo,
      // v1.2：批量下载 zip 链接（所有 cluster done 后可用）
      batchDownloadUrl: `/api/v1/reports/batch/${batchId}/download`,
    };

    // 立即写一份历史记录（status=queued），用户在历史 tab 可即时看到
    history.create({
      batchId,
      createdAt: new Date().toISOString(),
      project: projectBase || null,
      receivedFiles: req.files.length,
      clusterCount: groups.length,
      clusters: clusterInfo,
    });

    res.status(202).json(batchResp);
  } catch (err) {
    console.error('POST /api/v1/reports failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/reports/:id
app.get('/api/v1/reports/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json(jobs.toPublic(job));
});

// GET /api/v1/reports/:id/download
// 优先用内存 job 的 result 路径；缺失时从 disk 兜底查找（历史记录场景）
app.get('/api/v1/reports/:id/download', (req, res) => {
  const job = jobs.get(req.params.id);
  let docxPath = job?.result?.docxPath;
  if (!docxPath || !fs.existsSync(docxPath)) {
    docxPath = findClusterDocx(req.params.id);
  }
  if (!docxPath || !fs.existsSync(docxPath)) {
    if (!job) return res.status(404).json({ error: 'job 不存在或文件已清理' });
    return res.status(409).json({ error: `job 状态 ${job.status}，尚无可下载文件` });
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(docxPath))}"`);
  fs.createReadStream(docxPath).pipe(res);
});

// GET /api/v1/reports/:id/data.json
app.get('/api/v1/reports/:id/data.json', (req, res) => {
  const job = jobs.get(req.params.id);
  let dataPath = job?.result?.dataJsonPath;
  if (!dataPath || !fs.existsSync(dataPath)) {
    dataPath = findClusterDataJson(req.params.id);
  }
  if (!dataPath || !fs.existsSync(dataPath)) {
    return res.status(404).json({ error: '文件不存在或已清理' });
  }
  res.setHeader('Content-Type', 'application/json');
  fs.createReadStream(dataPath).pipe(res);
});

// ============== v1.2：历史记录 API ==============

// GET /api/v1/history?limit=50&offset=0&q=
app.get('/api/v1/history', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const q = String(req.query.q || '').trim();
  res.json(history.list({ limit, offset, q }));
});

// GET /api/v1/history/:batchId
app.get('/api/v1/history/:batchId', (req, res) => {
  const entry = history.get(req.params.batchId);
  if (!entry) return res.status(404).json({ error: 'batch not found in history' });
  res.json(entry);
});

// DELETE /api/v1/history/:batchId — 删除历史记录 + 对应 storage 子目录
app.delete('/api/v1/history/:batchId', (req, res) => {
  const entry = history.get(req.params.batchId);
  if (!entry) return res.status(404).json({ error: 'batch not found in history' });
  // 删除每个 cluster 的 storage 目录
  for (const c of entry.clusters || []) {
    try { fs.rmSync(path.join(UPLOADS_DIR, c.jobId), { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(path.join(REPORTS_DIR, c.jobId), { recursive: true, force: true }); } catch (_) {}
    jobs.jobs.delete(c.jobId);
  }
  // 也删 batch 上传父目录（multer 创建的）
  try { fs.rmSync(path.join(UPLOADS_DIR, req.params.batchId), { recursive: true, force: true }); } catch (_) {}
  history.delete(req.params.batchId);
  res.json({ ok: true, deletedBatchId: req.params.batchId });
});

// ============== v1.2：批量下载 zip ==============

// GET /api/v1/reports/batch/:batchId/download — 把该 batch 所有 cluster 的 docx 打包 zip 返回
app.get('/api/v1/reports/batch/:batchId/download', async (req, res) => {
  const entry = history.get(req.params.batchId);
  if (!entry) return res.status(404).json({ error: 'batch not found' });
  const doneClusters = (entry.clusters || []).filter(c => c.status === 'done');
  if (doneClusters.length === 0) {
    return res.status(409).json({ error: '该批次尚无任何已完成的报告' });
  }
  try {
    const JSZip = require('jszip');
    const zip = new JSZip();
    const projectFolder = (entry.project || 'reports').replace(/[\/\\:*?"<>|]/g, '_').slice(0, 60);
    const folder = zip.folder(`${projectFolder}_${entry.batchId.slice(0, 8)}`);

    // 加入每个 cluster 的 docx
    let added = 0;
    for (const c of doneClusters) {
      const docxPath = findClusterDocx(c.jobId);
      if (!docxPath) continue;
      const buf = fs.readFileSync(docxPath);
      folder.file(path.basename(docxPath), buf);
      added++;
    }
    // 加一个 README.txt 描述清单
    const manifest = [
      `MySQL 健康巡检报告批量打包`,
      ``,
      `batchId:      ${entry.batchId}`,
      `project:      ${entry.project || '-'}`,
      `createdAt:    ${entry.createdAt}`,
      `received:     ${entry.receivedFiles} 个 txt`,
      `clusters:     ${entry.clusterCount} 个独立集群`,
      `included:     ${added} 份已生成报告`,
      ``,
      `集群清单：`,
      ...entry.clusters.map((c, i) => {
        const s = c.summary || {};
        const issuePart = c.status === 'done'
          ? `[${s.p0 || 0} P0 / ${s.p1 || 0} P1 / ${s.p2 || 0} P2 / ${s.p3 || 0} P3, 健康度 ${s.healthScoreTotal ?? '-'}]`
          : `[${c.status}]`;
        return `  ${i + 1}. ${c.label}  ${issuePart}`;
      }),
    ].join('\n');
    folder.file('README.txt', manifest);

    if (added === 0) return res.status(409).json({ error: '所有报告文件已被清理（TTL 过期），无法打包' });

    const zipBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(projectFolder + '_' + entry.batchId.slice(0, 8))}.zip"`);
    res.send(zipBuf);
  } catch (err) {
    console.error('batch zip failed:', err);
    res.status(500).json({ error: `打包失败：${err.message}` });
  }
});

// multer 错误处理
app.use((err, req, res, next) => {
  if (err) {
    console.error('handler error:', err.message);
    return res.status(400).json({ error: err.message });
  }
  next();
});

// 启动
app.listen(PORT, () => {
  console.log(`🚀 mysql-healthcheck SaaS listening on http://0.0.0.0:${PORT}`);
  console.log(`   API:      http://localhost:${PORT}/api/v1/health`);
  console.log(`   Web UI:   http://localhost:${PORT}/`);
  console.log(`   Storage:  ${STORAGE_ROOT}`);
  if (API_KEY) console.log(`   API key:  required (X-API-Key header)`);
  else console.log(`   API key:  not required (set API_KEY env var to enable)`);
});

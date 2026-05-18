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

const PORT = Number(process.env.PORT) || 3000;
const _apiKeyRaw = process.env.API_KEY || '';
const API_KEY = (_apiKeyRaw && _apiKeyRaw !== '<no value>') ? _apiKeyRaw : undefined;   // 可选鉴权；未设置或空则全开
const STORAGE_ROOT = process.env.STORAGE_ROOT || path.join(__dirname, 'storage');
const UPLOADS_DIR = path.join(STORAGE_ROOT, 'uploads');
const REPORTS_DIR = path.join(STORAGE_ROOT, 'reports');
const MAX_FILES = Number(process.env.MAX_FILES) || 16;
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB) || 50;

// 准备存储目录
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(REPORTS_DIR, { recursive: true });

const jobs = new JobStore();

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

// API Key 鉴权（仅对 /api/* 生效；GET /api/v1/health 放行；前端 / 走 cookie 或同源）
function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  if (req.path === '/api/v1/health') return next();
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
          const { docxPath, dataJsonPath, summary } = await generateReport({
            uploadDir: subUploadDir,
            outputDir: subOutputDir,
            project: subProject,
            onProgress: (stage) => {
              const next = stage === 'extract' ? STATUS.RUNNING_EXTRACT : STATUS.RUNNING_RENDER;
              jobs.update(subJobId, { status: next, progress: stage });
            },
          });
          jobs.update(subJobId, {
            status: STATUS.DONE,
            progress: 'done',
            result: { docxPath, dataJsonPath, summary },
          });
          console.log(`[job ${subJobId}] (${g.label}) done — ${summary.issueCount} issues, ${(summary.docxSizeBytes / 1024).toFixed(1)} KB`);
        } catch (err) {
          console.error(`[job ${subJobId}] (${g.label}) error:`, err.message);
          jobs.update(subJobId, { status: STATUS.ERROR, error: err.message });
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
        statusUrl: `/api/v1/reports/${subJobId}`,
      });
    }

    res.status(202).json({
      batchId,
      receivedFiles: req.files.length,
      clusterCount: groups.length,
      project: projectBase || null,
      clusters: clusterInfo,
    });
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
app.get('/api/v1/reports/:id/download', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  if (job.status !== STATUS.DONE || !job.result?.docxPath) {
    return res.status(409).json({ error: `job 状态 ${job.status}，尚无可下载文件` });
  }
  const docxPath = job.result.docxPath;
  if (!fs.existsSync(docxPath)) return res.status(410).json({ error: '报告文件已被清理（TTL 过期）' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(docxPath))}"`);
  fs.createReadStream(docxPath).pipe(res);
});

// GET /api/v1/reports/:id/data.json
app.get('/api/v1/reports/:id/data.json', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== STATUS.DONE) return res.status(404).json({ error: 'not available' });
  res.setHeader('Content-Type', 'application/json');
  fs.createReadStream(job.result.dataJsonPath).pipe(res);
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

// 内存中的 job 存储 + 状态机。
// 适用于单进程 SaaS（v1）；多副本需替换为 Redis / DB。
'use strict';

const crypto = require('crypto');

const STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING_EXTRACT: 'running:extract',
  RUNNING_RENDER: 'running:render',
  DONE: 'done',
  ERROR: 'error',
});

class JobStore {
  constructor({ ttlMs = 6 * 3600 * 1000 } = {}) {
    this.jobs = new Map();
    this.ttlMs = ttlMs;
    // 周期性清理过期 job（保留 docx 文件由调用方处理）
    this.cleanupTimer = setInterval(() => this.cleanup(), 30 * 60 * 1000);
    this.cleanupTimer.unref?.();
  }

  create({ project, uploadDir, fileNames }) {
    const id = crypto.randomBytes(8).toString('hex');
    const job = {
      id,
      project: project || `Demo_${id.slice(0, 6)}`,
      status: STATUS.QUEUED,
      progress: 'queued',
      uploadDir,
      fileNames,
      createdAt: new Date().toISOString(),
      completedAt: null,
      error: null,
      result: null,    // { docxPath, dataJsonPath, summary: {...} }
    };
    this.jobs.set(id, job);
    return job;
  }

  get(id) {
    return this.jobs.get(id) || null;
  }

  update(id, patch) {
    const job = this.jobs.get(id);
    if (!job) return null;
    Object.assign(job, patch);
    if (patch.status === STATUS.DONE || patch.status === STATUS.ERROR) {
      job.completedAt = new Date().toISOString();
    }
    return job;
  }

  toPublic(job) {
    if (!job) return null;
    return {
      jobId: job.id,
      project: job.project,
      status: job.status,
      progress: job.progress,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      error: job.error,
      summary: job.result?.summary || null,
      downloadUrl: job.status === STATUS.DONE ? `/api/v1/reports/${job.id}/download` : null,
      dataJsonUrl: job.status === STATUS.DONE ? `/api/v1/reports/${job.id}/data.json` : null,
    };
  }

  cleanup() {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      const created = Date.parse(job.createdAt);
      if (now - created > this.ttlMs) {
        this.jobs.delete(id);
      }
    }
  }
}

module.exports = { JobStore, STATUS };

// 巡检历史记录的持久化存储。
// 与内存 jobs 表互补：jobs 表只保留运行中状态（含 6h TTL），history 是长期归档。
//
// 每个 batch 落盘成 storage/history/<batchId>.json，含：
//   - batchId / createdAt / updatedAt
//   - project / receivedFiles / clusterCount
//   - clusters[]：每个 cluster 的 jobId / label / topology / nodes / files /
//                  status / summary / docxRelPath（用于跨进程查找文件）
//
// 启动时自动扫描所有 *.json 加载到内存 Map，按 createdAt 倒序检索。
'use strict';

const fs = require('fs');
const path = require('path');

class HistoryStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.cache = new Map();
    this._load();
  }

  _load() {
    const start = Date.now();
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf-8'));
        if (data.batchId) this.cache.set(data.batchId, data);
      } catch (e) {
        console.warn(`[history] 加载 ${f} 失败：${e.message}`);
      }
    }
    console.log(`[history] 已加载 ${this.cache.size} 条历史记录（${Date.now() - start} ms）`);
  }

  _persist(batchId) {
    const entry = this.cache.get(batchId);
    if (!entry) return;
    fs.writeFileSync(path.join(this.dir, `${batchId}.json`), JSON.stringify(entry, null, 2));
  }

  /** 创建新 batch 历史（POST 时立即调用，让历史 Tab 第一时间能看到）*/
  create(entry) {
    const data = {
      batchId: entry.batchId,
      createdAt: entry.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      project: entry.project || null,
      receivedFiles: entry.receivedFiles || 0,
      clusterCount: entry.clusterCount || 0,
      clusters: (entry.clusters || []).map(c => ({
        jobId: c.jobId,
        label: c.label,
        topology: c.topology,
        nodes: c.nodes || [],
        primaryIp: c.primaryIp || null,
        fileCount: c.fileCount || 0,
        files: c.files || [],
        project: c.project || null,
        status: 'queued',
        progress: 'queued',
        summary: null,
        docxRelPath: null,
        dataJsonRelPath: null,
        error: null,
        completedAt: null,
      })),
    };
    this.cache.set(data.batchId, data);
    this._persist(data.batchId);
    return data;
  }

  /** 子作业状态变化时更新对应 cluster */
  updateCluster(batchId, jobId, patch) {
    const entry = this.cache.get(batchId);
    if (!entry) return null;
    const c = entry.clusters.find(x => x.jobId === jobId);
    if (!c) return null;
    Object.assign(c, patch);
    entry.updatedAt = new Date().toISOString();
    this._persist(batchId);
    return c;
  }

  list({ limit = 50, offset = 0, q = '' } = {}) {
    let all = [...this.cache.values()];
    if (q) {
      const qLower = String(q).toLowerCase();
      all = all.filter(e => {
        if (e.project && e.project.toLowerCase().includes(qLower)) return true;
        if (e.batchId.toLowerCase().includes(qLower)) return true;
        for (const c of e.clusters) {
          for (const n of c.nodes) if (n.toLowerCase().includes(qLower)) return true;
        }
        return false;
      });
    }
    all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      total: all.length,
      items: all.slice(offset, offset + limit).map(e => this.toListView(e)),
    };
  }

  /** 列表视图：只返回关键字段，便于前端渲染表格 */
  toListView(entry) {
    const summaryAgg = entry.clusters.reduce((acc, c) => {
      const s = c.summary || {};
      acc.p0 += s.p0 || 0;
      acc.p1 += s.p1 || 0;
      acc.p2 += s.p2 || 0;
      acc.p3 += s.p3 || 0;
      acc.done += c.status === 'done' ? 1 : 0;
      acc.error += c.status === 'error' ? 1 : 0;
      return acc;
    }, { p0: 0, p1: 0, p2: 0, p3: 0, done: 0, error: 0 });
    return {
      batchId: entry.batchId,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      project: entry.project,
      receivedFiles: entry.receivedFiles,
      clusterCount: entry.clusterCount,
      doneCount: summaryAgg.done,
      errorCount: summaryAgg.error,
      issueAggregate: { p0: summaryAgg.p0, p1: summaryAgg.p1, p2: summaryAgg.p2, p3: summaryAgg.p3 },
    };
  }

  get(batchId) {
    return this.cache.get(batchId) || null;
  }

  delete(batchId) {
    const entry = this.cache.get(batchId);
    if (!entry) return null;
    this.cache.delete(batchId);
    try { fs.unlinkSync(path.join(this.dir, `${batchId}.json`)); } catch (_) {}
    return entry;
  }
}

module.exports = { HistoryStore };

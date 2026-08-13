(() => {
  'use strict';

  // ============== API Key 管理（localStorage 持久化） ==============
  const API_KEY_STORAGE = 'mysql-hc-saas-api-key';
  let apiKey = localStorage.getItem(API_KEY_STORAGE) || '';

  // 统一的 fetch 封装 — 自动塞 X-API-Key 头；401 时引导填 key
  async function apiFetch(url, opts = {}) {
    const headers = new Headers(opts.headers || {});
    if (apiKey) headers.set('X-API-Key', apiKey);
    const resp = await fetch(url, { ...opts, headers });
    if (resp.status === 401) {
      showApiKeyBar('error', 'API Key 不正确或缺失，请填写');
    }
    return resp;
  }

  // 下载链接（<a href>）无法设置自定义 header，只能用 query 参数
  function withApiKey(url) {
    if (!apiKey) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}api_key=${encodeURIComponent(apiKey)}`;
  }

  // ============== DOM refs ==============
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const fileList = document.getElementById('fileList');
  const submitBtn = document.getElementById('submitBtn');
  const clearBtn = document.getElementById('clearBtn');
  const projectName = document.getElementById('projectName');
  const configJson = document.getElementById('configJson');
  const statusText = document.getElementById('statusText');
  const batchHeader = document.getElementById('batchHeader');
  const clustersContainer = document.getElementById('clustersContainer');
  const errorCard = document.getElementById('errorCard');
  // 历史 Tab
  const historyListView = document.getElementById('historyListView');
  const historyDetailView = document.getElementById('historyDetailView');
  const historyItems = document.getElementById('historyItems');
  const historyDetailBody = document.getElementById('historyDetailBody');
  const historyBack = document.getElementById('historyBack');
  const historySearch = document.getElementById('historySearch');
  const historyRefresh = document.getElementById('historyRefresh');

  let pendingFiles = [];
  let currentBatchId = null;  // 用于显示「下载全部 zip」按钮

  // ============== Tab 切换 ==============
  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      const target = t.dataset.tab;
      document.getElementById('tab-' + target).classList.add('active');
      if (target === 'history') loadHistoryList();
    });
  });

  // ============== 拖放 + 文件清单 ==============
  ['dragenter', 'dragover'].forEach(evt => {
    dropZone.addEventListener(evt, e => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach(evt => {
    dropZone.addEventListener(evt, e => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
    });
  });
  dropZone.addEventListener('drop', e => addFiles(e.dataTransfer.files));
  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => addFiles(e.target.files));

  clearBtn.addEventListener('click', () => {
    pendingFiles = [];
    renderFileList();
    projectName.value = '';
    configJson.value = '';
    document.querySelectorAll('#ruleOptions input[type="checkbox"]').forEach(cb => { cb.checked = true; });
    if (typeof syncRuleToggleStyles === 'function') syncRuleToggleStyles();
    clearBatch();
    hideError();
  });

  submitBtn.addEventListener('click', submit);

  function addFiles(fileList) {
    for (const f of fileList) {
      if (!/\.(txt|log)$/i.test(f.name)) {
        showError(`忽略非 .txt/.log 文件：${f.name}`);
        continue;
      }
      if (pendingFiles.some(x => x.name === f.name)) continue;
      pendingFiles.push(f);
    }
    if (pendingFiles.length > 16) {
      pendingFiles = pendingFiles.slice(0, 16);
      showError('最多上传 16 个文件，多余的已忽略');
    }
    renderFileList();
  }

  function renderFileList() {
    fileList.innerHTML = '';
    for (const [i, f] of pendingFiles.entries()) {
      const div = document.createElement('div');
      div.className = 'file-item';
      div.innerHTML = `
        <span class="name">📄 ${escapeHtml(f.name)}</span>
        <span class="size">${formatSize(f.size)}</span>
        <button data-index="${i}" title="移除">✕</button>
      `;
      fileList.appendChild(div);
    }
    fileList.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', e => {
        const idx = Number(e.target.dataset.index);
        pendingFiles.splice(idx, 1);
        renderFileList();
      });
    });
    submitBtn.disabled = pendingFiles.length === 0;
    statusText.textContent = pendingFiles.length === 0
      ? ''
      : `已选 ${pendingFiles.length} 个文件，合计 ${formatSize(pendingFiles.reduce((s, f) => s + f.size, 0))}`;
  }

  // 把 ruleOptions 面板里取消勾选的规则收集起来，合进最终 configJson
  // 与用户在「高级阈值配置 JSON」里写的合并：disabledRules 取并集，
  // 其它字段（thresholds / priorities）以高级输入为准。
  function buildFinalConfig() {
    let userJson = null;
    const raw = configJson.value.trim();
    if (raw) {
      try {
        userJson = JSON.parse(raw);
      } catch (e) {
        throw new Error(`高级配置 JSON 不是合法 JSON：${e.message}`);
      }
    }
    const optedOut = [];
    document.querySelectorAll('#ruleOptions input[type="checkbox"][data-rule]').forEach(cb => {
      if (!cb.checked) optedOut.push(cb.dataset.rule);
    });
    if (optedOut.length === 0 && !userJson) return null;
    const merged = userJson ? JSON.parse(JSON.stringify(userJson)) : {};
    const existing = Array.isArray(merged.disabledRules) ? merged.disabledRules : [];
    merged.disabledRules = Array.from(new Set([...existing, ...optedOut]));
    return merged;
  }

  // 视觉反馈：未勾选时给整行加 .disabled 类（label 划掉灰色）
  function syncRuleToggleStyles() {
    document.querySelectorAll('#ruleOptions .rule-toggle').forEach(lbl => {
      const cb = lbl.querySelector('input[type="checkbox"]');
      lbl.classList.toggle('disabled', cb && !cb.checked);
    });
  }
  document.querySelectorAll('#ruleOptions input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', syncRuleToggleStyles);
  });
  syncRuleToggleStyles();

  async function submit() {
    hideError();
    clearBatch();
    submitBtn.disabled = true;
    statusText.textContent = '上传中…';

    let finalConfig;
    try {
      finalConfig = buildFinalConfig();
    } catch (e) {
      showError(e.message);
      submitBtn.disabled = false;
      statusText.textContent = '';
      return;
    }

    const fd = new FormData();
    for (const f of pendingFiles) fd.append('files', f);
    if (projectName.value.trim()) fd.append('project', projectName.value.trim());
    if (finalConfig) fd.append('configJson', JSON.stringify(finalConfig));

    try {
      const resp = await apiFetch('/api/v1/reports', { method: 'POST', body: fd });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      const batch = await resp.json();
      currentBatchId = batch.batchId;
      renderBatch(batch);
      batch.clusters.forEach(c => pollJob(c.jobId, false));
    } catch (err) {
      showError(`提交失败：${err.message}`);
      submitBtn.disabled = false;
      statusText.textContent = '';
    }
  }

  function clearBatch() {
    batchHeader.classList.remove('active');
    batchHeader.innerHTML = '';
    clustersContainer.innerHTML = '';
    currentBatchId = null;
  }

  function renderBatch(batch) {
    batchHeader.classList.add('active');
    const isMulti = batch.clusterCount > 1;
    batchHeader.innerHTML = `
      <div class="batch-summary">
        <h3>${isMulti ? '🔍 已自动识别 ' + batch.clusterCount + ' 个独立集群' : '✅ 上传完成'}</h3>
        <p>${batch.receivedFiles} 个文件 → ${batch.clusterCount} 份报告（每个集群一份，并发生成中）</p>
        <div class="batch-actions" id="batchActions"></div>
      </div>
    `;
    for (const c of batch.clusters) {
      const card = document.createElement('div');
      card.className = 'card cluster-card';
      card.id = 'cluster-' + c.jobId;
      const topoBadge = c.topology === '单节点'
        ? '<span class="badge badge-single">单节点</span>'
        : '<span class="badge badge-cluster">' + escapeHtml(c.topology) + '</span>';
      card.innerHTML = `
        <div class="cluster-header">
          <div>
            <h3>${escapeHtml(c.label)} ${topoBadge}</h3>
            <div class="cluster-meta">
              节点：${c.nodes.map(n => escapeHtml(n)).join('、')}
              · ${c.fileCount} 个 txt
              · Job ID: <code>${c.jobId}</code>
            </div>
          </div>
        </div>
        <div class="cluster-body">
          <div class="cluster-progress">
            <div class="progress-bar"><div class="fill"></div></div>
            <div class="stage" id="stage-${c.jobId}">排队中…</div>
          </div>
        </div>
      `;
      clustersContainer.appendChild(card);
    }
  }

  async function pollJob(jobId, fromHistory) {
    let lastStatus = '';
    while (true) {
      await sleep(2000);
      try {
        const resp = await apiFetch(`/api/v1/reports/${jobId}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const job = await resp.json();
        if (job.progress !== lastStatus) {
          updateStage(jobId, job.progress);
          lastStatus = job.progress;
        }
        if (job.status === 'done') {
          finalizeCluster(jobId, job, 'done');
          checkAllDone();
          return;
        }
        if (job.status === 'error') {
          finalizeCluster(jobId, job, 'error');
          checkAllDone();
          return;
        }
      } catch (err) {
        showError(`查询 ${jobId} 状态失败：${err.message}`);
        return;
      }
    }
  }

  function updateStage(jobId, stage) {
    const labels = {
      'queued': '排队中…',
      'extract': '解析采集文件…',
      'ai-review': '大模型辅助研判…',
      'render': '渲染报告…',
      'done': '完成',
    };
    const el = document.getElementById('stage-' + jobId);
    if (el) el.textContent = labels[stage] || stage;
  }

  function finalizeCluster(jobId, job, status) {
    const card = document.getElementById('cluster-' + jobId);
    if (!card) return;
    const body = card.querySelector('.cluster-body');
    if (status === 'error') {
      body.innerHTML = `<div class="error active">⚠ 生成失败：${escapeHtml(job.error || '未知错误')}</div>`;
      card.classList.add('cluster-error');
      return;
    }
    const s = job.summary || {};
    card.classList.add('cluster-done');
    const metrics = [
      { label: 'P0 紧急', value: s.p0 || 0, cls: 'p0' },
      { label: 'P1 重要', value: s.p1 || 0, cls: 'p1' },
      { label: 'P2 建议', value: s.p2 || 0, cls: 'p2' },
      { label: 'P3 观察', value: s.p3 || 0, cls: 'p3' },
      { label: '健康度', value: s.healthScoreTotal != null ? s.healthScoreTotal + '/100' : '-' },
      { label: '根因关联', value: s.correlationCount || 0 },
    ];
    body.innerHTML = `
      <div class="summary-grid">
        ${metrics.map(m => `<div class="metric ${m.cls || ''}"><div class="label">${m.label}</div><div class="value">${m.value}</div></div>`).join('')}
      </div>
      <div class="cluster-actions">
        <a class="btn" href="${withApiKey(job.downloadUrl || '/api/v1/reports/' + jobId + '/download')}" download>📥 下载 docx</a>
        <a class="btn btn-secondary" href="${withApiKey(job.dataJsonUrl || '/api/v1/reports/' + jobId + '/data.json')}" download>📊 data.json</a>
      </div>
      ${s.overallAssessment ? '<div class="cluster-assessment">' + escapeHtml(s.overallAssessment) + '</div>' : ''}
      ${s.aiEnabled ? '<div class="cluster-assessment">🤖 大模型研判：' + escapeHtml(s.aiStatus || '-') + ' · 补充 ' + Number(s.aiFindingCount || 0) + ' 条' + (s.aiError ? '（已降级为规则报告）' : '') + '</div>' : ''}
    `;
  }

  function checkAllDone() {
    const total = clustersContainer.querySelectorAll('.cluster-card').length;
    const done = clustersContainer.querySelectorAll('.cluster-done, .cluster-error').length;
    if (done >= total) {
      submitBtn.disabled = false;
      statusText.textContent = `已完成 ${done} / ${total}`;
      // v1.2：所有集群完成 → 显示「下载全部 (zip)」按钮
      const okCount = clustersContainer.querySelectorAll('.cluster-done').length;
      if (okCount >= 1 && currentBatchId) {
        const actions = document.getElementById('batchActions');
        if (actions && !actions.querySelector('.btn-zip')) {
          actions.innerHTML = `<a class="btn btn-zip" href="${withApiKey('/api/v1/reports/batch/' + currentBatchId + '/download')}" download>📦 下载全部 (${okCount} 份, zip)</a>`;
        }
      }
    } else {
      statusText.textContent = `进度 ${done} / ${total} 已完成…`;
    }
  }

  // ============== 历史记录 ==============
  async function loadHistoryList() {
    historyDetailView.classList.remove('active');
    historyListView.style.display = 'block';
    historyItems.innerHTML = '<div class="history-empty">加载中…</div>';
    try {
      const q = historySearch.value.trim();
      const url = '/api/v1/history?limit=100' + (q ? '&q=' + encodeURIComponent(q) : '');
      const resp = await apiFetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      renderHistoryList(data);
    } catch (err) {
      historyItems.innerHTML = `<div class="history-empty">加载失败：${escapeHtml(err.message)}</div>`;
    }
  }

  function renderHistoryList(data) {
    if (data.total === 0) {
      historyItems.innerHTML = '<div class="history-empty">📋 暂无历史记录<br><span style="font-size: 12px;">每次生成报告会自动保存到这里</span></div>';
      return;
    }
    historyItems.innerHTML = data.items.map(it => {
      const agg = it.issueAggregate || {};
      const chips = [];
      if (agg.p0 > 0) chips.push(`<span class="chip p0">P0 ${agg.p0}</span>`);
      if (agg.p1 > 0) chips.push(`<span class="chip p1">P1 ${agg.p1}</span>`);
      if (agg.p2 > 0) chips.push(`<span class="chip p2">P2 ${agg.p2}</span>`);
      if (it.errorCount > 0) chips.push(`<span class="chip" style="background:#fecaca;color:#991b1b">❌ ${it.errorCount}</span>`);
      return `
        <div class="history-item" data-batch="${it.batchId}">
          <div class="top">
            <div class="title">${escapeHtml(it.project || '(未命名)')} <span style="color:#9ca3af;font-weight:normal;font-size:12px;">· ${it.batchId.slice(0, 8)}</span></div>
            <div class="time">${formatTime(it.createdAt)}</div>
          </div>
          <div class="meta">
            <span class="chip">${it.receivedFiles} 个 txt</span>
            <span class="chip">${it.clusterCount} 个集群</span>
            <span class="chip">${it.doneCount}/${it.clusterCount} 完成</span>
            ${chips.join('')}
          </div>
          <div class="actions">
            <a href="#" class="view-btn" data-batch="${it.batchId}">查看详情</a>
            <a href="${withApiKey('/api/v1/reports/batch/' + it.batchId + '/download')}" download>📦 下载全部</a>
            <a href="#" class="danger delete-btn" data-batch="${it.batchId}">删除</a>
          </div>
        </div>
      `;
    }).join('');
    // 绑定事件
    historyItems.querySelectorAll('.history-item').forEach(item => {
      item.addEventListener('click', e => {
        if (e.target.closest('.actions')) return;   // 点 actions 不展开
        showHistoryDetail(item.dataset.batch);
      });
    });
    historyItems.querySelectorAll('.view-btn').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        showHistoryDetail(a.dataset.batch);
      });
    });
    historyItems.querySelectorAll('.delete-btn').forEach(a => {
      a.addEventListener('click', async e => {
        e.preventDefault();
        if (!confirm('确定删除该批次及其所有报告文件？此操作不可恢复。')) return;
        try {
          const resp = await apiFetch(`/api/v1/history/${a.dataset.batch}`, { method: 'DELETE' });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          loadHistoryList();
        } catch (err) {
          alert(`删除失败：${err.message}`);
        }
      });
    });
  }

  async function showHistoryDetail(batchId) {
    historyListView.style.display = 'none';
    historyDetailView.classList.add('active');
    historyDetailBody.innerHTML = '加载中…';
    try {
      const resp = await apiFetch(`/api/v1/history/${batchId}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const entry = await resp.json();
      renderHistoryDetail(entry);
    } catch (err) {
      historyDetailBody.innerHTML = `<div class="error active">加载失败：${escapeHtml(err.message)}</div>`;
    }
  }

  function renderHistoryDetail(entry) {
    const html = [];
    html.push(`
      <div class="batch-summary active">
        <h3>${escapeHtml(entry.project || '(未命名)')}</h3>
        <p>批次 <code>${entry.batchId}</code> · ${formatTime(entry.createdAt)} · ${entry.receivedFiles} 个 txt → ${entry.clusterCount} 份报告</p>
        <div class="batch-actions">
          <a class="btn" href="${withApiKey('/api/v1/reports/batch/' + entry.batchId + '/download')}" download>📦 下载全部 (zip)</a>
        </div>
      </div>
    `);
    for (const c of entry.clusters) {
      const topoBadge = c.topology === '单节点'
        ? '<span class="badge badge-single">单节点</span>'
        : '<span class="badge badge-cluster">' + escapeHtml(c.topology) + '</span>';
      const isDone = c.status === 'done';
      const isError = c.status === 'error';
      const s = c.summary || {};
      let bodyHtml;
      if (isDone) {
        bodyHtml = `
          <div class="summary-grid">
            <div class="metric p0"><div class="label">P0 紧急</div><div class="value">${s.p0 || 0}</div></div>
            <div class="metric p1"><div class="label">P1 重要</div><div class="value">${s.p1 || 0}</div></div>
            <div class="metric p2"><div class="label">P2 建议</div><div class="value">${s.p2 || 0}</div></div>
            <div class="metric p3"><div class="label">P3 观察</div><div class="value">${s.p3 || 0}</div></div>
            <div class="metric"><div class="label">健康度</div><div class="value">${s.healthScoreTotal != null ? s.healthScoreTotal + '/100' : '-'}</div></div>
            <div class="metric"><div class="label">根因关联</div><div class="value">${s.correlationCount || 0}</div></div>
          </div>
          <div class="cluster-actions">
            <a class="btn" href="${withApiKey('/api/v1/reports/' + c.jobId + '/download')}" download>📥 下载 docx</a>
            <a class="btn btn-secondary" href="${withApiKey('/api/v1/reports/' + c.jobId + '/data.json')}" download>📊 data.json</a>
          </div>
          ${s.overallAssessment ? '<div class="cluster-assessment">' + escapeHtml(s.overallAssessment) + '</div>' : ''}
          ${s.aiEnabled ? '<div class="cluster-assessment">🤖 大模型研判：' + escapeHtml(s.aiStatus || '-') + ' · 补充 ' + Number(s.aiFindingCount || 0) + ' 条' + (s.aiError ? '（已降级为规则报告）' : '') + '</div>' : ''}
        `;
      } else if (isError) {
        bodyHtml = `<div class="error active">⚠ ${escapeHtml(c.error || '生成失败')}</div>`;
      } else {
        bodyHtml = `<div class="cluster-progress"><div class="progress-bar"><div class="fill"></div></div><div class="stage">${escapeHtml(c.progress || 'queued')}</div></div>`;
      }
      html.push(`
        <div class="card cluster-card ${isDone ? 'cluster-done' : isError ? 'cluster-error' : ''}">
          <div class="cluster-header">
            <div>
              <h3>${escapeHtml(c.label)} ${topoBadge}</h3>
              <div class="cluster-meta">节点：${c.nodes.map(n => escapeHtml(n)).join('、')} · ${c.fileCount} 个 txt · Job <code>${c.jobId}</code></div>
            </div>
          </div>
          <div class="cluster-body">${bodyHtml}</div>
        </div>
      `);
    }
    historyDetailBody.innerHTML = html.join('');
  }

  historyBack.addEventListener('click', () => {
    historyDetailView.classList.remove('active');
    historyListView.style.display = 'block';
  });
  historyRefresh.addEventListener('click', loadHistoryList);
  historySearch.addEventListener('keyup', e => {
    if (e.key === 'Enter') loadHistoryList();
  });

  // ============== 辅助 ==============
  function showError(msg) {
    errorCard.classList.add('active');
    errorCard.textContent = '⚠ ' + msg;
  }
  function hideError() {
    errorCard.classList.remove('active');
  }
  function formatSize(b) {
    if (b == null) return '-';
    if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB';
    if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
    if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
    return b + ' B';
  }
  function formatTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const now = new Date();
    const ms = now.getTime() - d.getTime();
    if (ms < 60_000) return Math.floor(ms / 1000) + ' 秒前';
    if (ms < 3600_000) return Math.floor(ms / 60_000) + ' 分钟前';
    if (ms < 86400_000) return Math.floor(ms / 3600_000) + ' 小时前';
    return d.toLocaleString('zh-CN');
  }
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ============== API Key UI ==============
  const apiKeyBar     = document.getElementById('apiKeyBar');
  const apiKeyInput   = document.getElementById('apiKeyInput');
  const apiKeySave    = document.getElementById('apiKeySaveBtn');
  const apiKeyClear   = document.getElementById('apiKeyClearBtn');
  const apiKeyStatus  = document.getElementById('apiKeyStatus');

  function showApiKeyBar(state, msg) {
    apiKeyBar.style.display = 'flex';
    apiKeyStatus.className = 'api-key-status ' + (state === 'ok' ? 'ok' : state === 'error' ? 'err' : '');
    apiKeyStatus.textContent = msg || '';
  }
  function hideApiKeyBar() { apiKeyBar.style.display = 'none'; }

  // 检测服务端是否启用了鉴权；启用 → 显示输入条；用户已经存了 key 就先校验
  (async () => {
    try {
      const r = await fetch('/api/v1/health');
      const data = await r.json();
      if (!data.apiKeyEnabled) { hideApiKeyBar(); return; }
      // 启用了鉴权
      apiKeyInput.value = apiKey;
      showApiKeyBar('', apiKey ? '已加载本地保存的 Key，可点"保存"验证' : '请输入 API Key（来自服务器 .env 的 API_KEY）');
      // 已有 key 自动验证一下
      if (apiKey) verifyKey();
    } catch (e) {
      console.warn('health check failed:', e);
    }
  })();

  async function verifyKey() {
    try {
      const r = await apiFetch('/api/v1/auth/check');
      if (r.ok) {
        showApiKeyBar('ok', '✓ API Key 已验证，可以上传 / 查看历史');
      } else {
        showApiKeyBar('error', '✗ API Key 不正确（HTTP ' + r.status + '）');
      }
    } catch (e) {
      showApiKeyBar('error', '✗ 验证失败：' + e.message);
    }
  }

  apiKeySave.addEventListener('click', async () => {
    apiKey = apiKeyInput.value.trim();
    if (!apiKey) return showApiKeyBar('error', '请输入 API Key');
    localStorage.setItem(API_KEY_STORAGE, apiKey);
    await verifyKey();
  });
  apiKeyClear.addEventListener('click', () => {
    apiKey = '';
    apiKeyInput.value = '';
    localStorage.removeItem(API_KEY_STORAGE);
    showApiKeyBar('', '已清除本地 Key');
  });
  // 回车提交
  apiKeyInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); apiKeySave.click(); }
  });
})();

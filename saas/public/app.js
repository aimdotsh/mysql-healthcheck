(() => {
  'use strict';

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

  let pendingFiles = [];

  // === 拖放交互 ===
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
  dropZone.addEventListener('drop', e => {
    addFiles(e.dataTransfer.files);
  });
  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => addFiles(e.target.files));

  clearBtn.addEventListener('click', () => {
    pendingFiles = [];
    renderFileList();
    projectName.value = '';
    configJson.value = '';
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

  async function submit() {
    hideError();
    clearBatch();
    submitBtn.disabled = true;
    statusText.textContent = '上传中…';

    const fd = new FormData();
    for (const f of pendingFiles) fd.append('files', f);
    if (projectName.value.trim()) fd.append('project', projectName.value.trim());
    if (configJson.value.trim()) fd.append('configJson', configJson.value.trim());

    try {
      const resp = await fetch('/api/v1/reports', { method: 'POST', body: fd });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      const batch = await resp.json();
      renderBatch(batch);
      // 并发轮询所有 job
      batch.clusters.forEach(c => pollJob(c.jobId));
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
  }

  function renderBatch(batch) {
    // 批次头
    batchHeader.classList.add('active');
    const isMulti = batch.clusterCount > 1;
    batchHeader.innerHTML = `
      <div class="batch-summary">
        <h3>${isMulti ? '🔍 已自动识别 ' + batch.clusterCount + ' 个独立集群' : '✅ 上传完成'}</h3>
        <p>${batch.receivedFiles} 个文件 → ${batch.clusterCount} 份报告（每个集群一份，并发生成中）</p>
      </div>
    `;

    // 每个集群一张卡片
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

  async function pollJob(jobId) {
    let lastStatus = '';
    while (true) {
      await sleep(2000);
      try {
        const resp = await fetch(`/api/v1/reports/${jobId}`);
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
    // done — 渲染摘要 + 下载按钮
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
        ${metrics.map(m => `
          <div class="metric ${m.cls || ''}">
            <div class="label">${m.label}</div>
            <div class="value">${m.value}</div>
          </div>
        `).join('')}
      </div>
      <div class="cluster-actions">
        <a class="btn" href="${job.downloadUrl}" download>📥 下载 docx</a>
        <a class="btn btn-secondary" href="${job.dataJsonUrl}" download>📊 data.json</a>
      </div>
      ${s.overallAssessment ? '<div class="cluster-assessment">' + escapeHtml(s.overallAssessment) + '</div>' : ''}
    `;
  }

  function checkAllDone() {
    const total = clustersContainer.querySelectorAll('.cluster-card').length;
    const done = clustersContainer.querySelectorAll('.cluster-done, .cluster-error').length;
    if (done >= total) {
      submitBtn.disabled = false;
      statusText.textContent = `已完成 ${done} / ${total}`;
    } else {
      statusText.textContent = `进度 ${done} / ${total} 已完成…`;
    }
  }

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
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
})();

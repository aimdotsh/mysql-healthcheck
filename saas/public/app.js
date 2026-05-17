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
  const progressCard = document.getElementById('progressCard');
  const progressStage = document.getElementById('progressStage');
  const jobIdDisplay = document.getElementById('jobIdDisplay');
  const summaryCard = document.getElementById('summaryCard');
  const summaryGrid = document.getElementById('summaryGrid');
  const summaryExtra = document.getElementById('summaryExtra');
  const downloadDocx = document.getElementById('downloadDocx');
  const downloadJson = document.getElementById('downloadJson');
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
    hideProgress();
    hideSummary();
    hideError();
  });

  submitBtn.addEventListener('click', submit);

  function addFiles(fileList) {
    for (const f of fileList) {
      if (!/\.(txt|log)$/i.test(f.name)) {
        showError(`忽略非 .txt/.log 文件：${f.name}`);
        continue;
      }
      if (pendingFiles.some(x => x.name === f.name)) continue;  // 去重
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
    hideSummary();
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
      const job = await resp.json();
      showProgress(job);
      pollJob(job.jobId);
    } catch (err) {
      showError(`提交失败：${err.message}`);
      submitBtn.disabled = false;
      statusText.textContent = '';
    }
  }

  function showProgress(job) {
    progressCard.classList.add('active');
    jobIdDisplay.textContent = job.jobId;
    updateProgressStage('queued');
  }
  function hideProgress() {
    progressCard.classList.remove('active');
  }
  function updateProgressStage(stage) {
    const labels = {
      queued: '排队中',
      'queued': '排队中',
      'extract': '解析采集文件（extract.js）',
      'render': '渲染报告（render.js）',
      'done': '完成',
    };
    progressStage.textContent = labels[stage] || stage;
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
          updateProgressStage(job.progress);
          lastStatus = job.progress;
        }
        if (job.status === 'done') {
          hideProgress();
          showSummary(job);
          submitBtn.disabled = false;
          statusText.textContent = '';
          return;
        }
        if (job.status === 'error') {
          hideProgress();
          showError(`生成失败：${job.error || '未知错误'}`);
          submitBtn.disabled = false;
          statusText.textContent = '';
          return;
        }
      } catch (err) {
        showError(`查询状态失败：${err.message}`);
        submitBtn.disabled = false;
        return;
      }
    }
  }

  function showSummary(job) {
    summaryCard.classList.add('active');
    const s = job.summary || {};
    const metrics = [
      { label: '节点数', value: s.nodeCount },
      { label: '集群拓扑', value: s.topology },
      { label: '健康度', value: s.healthScoreTotal != null ? s.healthScoreTotal + '/100' : '-' },
      { label: 'P0 紧急', value: s.p0 || 0, cls: 'p0' },
      { label: 'P1 重要', value: s.p1 || 0, cls: 'p1' },
      { label: 'P2 建议', value: s.p2 || 0, cls: 'p2' },
      { label: 'P3 观察', value: s.p3 || 0, cls: 'p3' },
      { label: '根因关联', value: s.correlationCount || 0 },
    ];
    summaryGrid.innerHTML = metrics.map(m => `
      <div class="metric ${m.cls || ''}">
        <div class="label">${m.label}</div>
        <div class="value">${m.value}</div>
      </div>
    `).join('');
    const extra = [];
    if (s.overallAssessment) extra.push(`整体评估：${s.overallAssessment}`);
    if (s.docxSizeBytes) extra.push(`报告文件：${formatSize(s.docxSizeBytes)}`);
    if (s.disabledRules?.length) extra.push(`已禁用规则：${s.disabledRules.join('、')}`);
    summaryExtra.textContent = extra.join(' · ');
    downloadDocx.href = job.downloadUrl;
    downloadJson.href = job.dataJsonUrl;
  }
  function hideSummary() {
    summaryCard.classList.remove('active');
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

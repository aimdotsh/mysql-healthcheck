// rule-helpers/index.js — D/F 类复杂规则的 handler 注册表
//
// Handler 接口：
//   (ctx) → Array<patch>
// patch = { priority, match?, value?, ...overrides }
// 其中 overrides 可以是 type / description / action / sql / dimension / scope /
// groupKey / currentValue / recommendedValue / node / needsConfirmation /
// affectedUsers 中的任意字段；提供的会覆盖 rule JSON 的渲染结果。
//
// 多变体规则（如一个 rule.id='disks' 输出 disk_critical / disk_high / disk_optical_full
// 三种 type）就把 type/description/action/sql 写在 patch 里，rule JSON 不需要 *Tpl。

'use strict';

// ─────────────────────────────────────────────────────────────
// 通用工具（不应放到全局，但放这里避免循环依赖）
// ─────────────────────────────────────────────────────────────

function fmtMB(mbVal) {
  if (mbVal == null) return '-';
  return mbVal >= 1024 ? (mbVal / 1024).toFixed(1) + ' GB' : Math.round(mbVal) + ' MB';
}

function recommendBufferPoolMB(memGB) {
  if (!memGB || memGB <= 0) return null;
  const reserveGB = memGB <= 4 ? 1 : memGB <= 16 ? 2 : 4;
  return Math.round(Math.max(1, Math.min(memGB * 0.6, memGB - reserveGB)) * 1024);
}

function _kb(node, key) {
  const v = node.variables?.[key]; if (v == null) return null;
  const m = String(v).trim().match(/^([\d.]+)\s*([KMGT])?B?$/i);
  if (!m) return null;
  const num = parseFloat(m[1]);
  const u = (m[2] || '').toUpperCase();
  if (u === 'G') return num * 1024 * 1024;
  if (u === 'M') return num * 1024;
  if (u === 'K') return num;
  if (/_in_kb$/.test(key)) return num;
  if (/_in_mb$/.test(key)) return num * 1024;
  return num / 1024;
}
function _mb(node, key) {
  const k = _kb(node, key); return k == null ? null : k / 1024;
}

// ─────────────────────────────────────────────────────────────
// 1) 磁盘：critical / high / optical_full / install_iso_full / removable_full / pseudo_fs_full
// ─────────────────────────────────────────────────────────────

const DISK_SPECIAL_LABEL = {
  optical:       '光驱',
  'install-iso': '安装 ISO',
  removable:     '可移动介质',
  'pseudo-fs':   '伪文件系统',
};

function classifyDiskSpecial(d) {
  const dev = (d.filesystem || '').toLowerCase();
  const mount = (d.mount || '').toLowerCase();
  if (/sr\d|\/cdrom|\/dvd|iso9660|udf/i.test(dev + ' ' + mount)) return 'optical';
  if (/run\/media/i.test(mount) && /(rhel-|centos-|ubuntu-|debian-|fedora-|rocky|alma|opensuse|sles)/i.test(mount)) {
    return 'install-iso';
  }
  if (/run\/media/i.test(mount)) return 'removable';
  if (/tmpfs|devtmpfs|overlay|squashfs/i.test(dev)) return 'pseudo-fs';
  return null;
}

function evalDisks(ctx) {
  const { node, cfg } = ctx;
  const T = cfg.thresholds?.disk || {};
  const critical = T.critical_pct ?? 90;
  const high = T.high_pct ?? 80;
  const out = [];
  for (const d of (node.disks || [])) {
    const pct = parseInt((d.usePct || '0').replace('%', ''));
    if (Number.isNaN(pct) || pct < high) continue;
    const special = classifyDiskSpecial(d);
    if (special) {
      const label = DISK_SPECIAL_LABEL[special];
      const tpe = `disk_${special.replace(/-/g, '_')}_full`;
      out.push({
        type: tpe,
        priority: 'P3',
        groupKey: `disk:${node.ip}:${d.mount}`,
        description: `${label}「${d.mount}」使用率 ${d.usePct}（${d.filesystem}，容量 ${d.total}）— 设计如此，无需处理`,
        action: (special === 'install-iso' || special === 'optical')
          ? '光驱/安装 ISO 100% 占用是正常现象（只读介质本来就装满）；如确认无需保留挂载，可 umount 卸载'
          : '可移动介质，使用率高时由设备所有者决定是否清理或卸载',
        sql: null,
        dimension: 'operations',
        scope: 'node',
        needsConfirmation: true,
      });
    } else if (pct >= critical) {
      out.push({
        type: 'disk_critical', priority: 'P0',
        groupKey: `disk:${node.ip}:${d.mount}`,
        description: `磁盘 ${d.mount} 使用率 ${d.usePct}（容量 ${d.total}，已用 ${d.used}）`,
        action: '建议优先清理日志 / 历史数据，或评估扩容',
        sql: `df -h ${d.mount}\nfind ${d.mount} -type f -size +1G -mtime +30 -exec ls -lh {} \\;`,
        scope: 'node',
      });
    } else {
      out.push({
        type: 'disk_high', priority: 'P1',
        groupKey: `disk:${node.ip}:${d.mount}`,
        description: `磁盘 ${d.mount} 使用率 ${d.usePct}`,
        action: '近期内规划清理或评估扩容',
        scope: 'node',
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 2) 复制：thread_down / delay_high / delay_low
// ─────────────────────────────────────────────────────────────

function evalReplication(ctx) {
  const { node, cfg } = ctx;
  if (!node.replication?.isSlave) return [];
  const s = node.replication.status || {};
  const ioR = s.slaveIoRunning, sqlR = s.slaveSqlRunning;
  const sbm = s.secondsBehindMaster;
  const T = cfg.thresholds?.replication || {};
  const delayP1 = T.delay_p1_seconds ?? 300;
  const delayP2 = T.delay_p2_seconds ?? 60;

  if (ioR !== 'Yes' || sqlR !== 'Yes') {
    return [{
      type: 'repl_thread_down', priority: 'P0',
      groupKey: `repl_thread:${node.ip}`,
      description: `复制线程异常（IO=${ioR}, SQL=${sqlR}）`,
      action: '查 Last_IO_Error / Last_SQL_Error；必要时 STOP SLAVE; 处理后 START SLAVE',
      sql: 'SHOW SLAVE STATUS\\G',
      scope: 'node',
    }];
  }
  if (sbm != null && Number(sbm) > delayP1) {
    return [{
      type: 'repl_delay_high', priority: 'P1',
      groupKey: `repl_delay:${node.ip}`,
      description: `从库延迟 ${sbm} 秒`,
      action: '排查 SQL 线程瓶颈/大事务；启用并行复制',
      scope: 'node',
    }];
  }
  if (sbm != null && Number(sbm) > delayP2) {
    return [{
      type: 'repl_delay_low', priority: 'P2',
      groupKey: `repl_delay:${node.ip}`,
      description: `从库延迟 ${sbm} 秒`,
      action: '持续关注延迟变化',
      scope: 'node',
    }];
  }
  return [];
}

// ─────────────────────────────────────────────────────────────
// 3) 角色一致性：master_readonly / dr_writable / slave_writable
// ─────────────────────────────────────────────────────────────

function evalRoleReadOnly(ctx) {
  const { node } = ctx;
  const v = node.variables || {};
  if (node.role === 'primary' && v.read_only === '1') {
    const inferred = node.roleInference?.source === 'standalone_readonly';
    return [{
      type: 'master_readonly',
      priority: inferred ? 'P3' : 'P1',
      groupKey: `master_readonly:${node.ip}`,
      description: inferred
        ? `节点 ${node.ip} 被推断为「只读主库」（read_only = 1 + log_bin 启用，常见于 zabbix/监控/报表/备机场景）`
        : `主库 read_only = 1（无法写入）`,
      action: inferred
        ? '若属设计预留（zabbix / 报表只读库 / 备机），请确认并文档化；如非预期，关闭 read_only'
        : '核实是否被错误置为只读',
      sql: 'SET GLOBAL read_only = 0; SET GLOBAL super_read_only = 0;',
      scope: 'node',
      needsConfirmation: inferred,
    }];
  }
  if (node.role !== 'primary' && node.replication?.isSlave && v.read_only === '0') {
    const isDr = !!node.isDrNode;
    return [{
      type: isDr ? 'dr_writable' : 'slave_writable',
      priority: isDr ? 'P3' : 'P1',
      groupKey: `slave_writable:${node.ip}`,
      description: isDr
        ? `灾备节点 ${node.hostname || node.ip} read_only = 0（疑似 DR 切换设计预留）`
        : `从库 read_only = 0（可写入，存在数据漂移风险）`,
      action: isDr
        ? '若属灾备快切设计，请确认并文档化该例外；常态下仍建议 read_only=1，切换时再放开'
        : '从库应设为只读',
      sql: isDr ? null : 'SET GLOBAL read_only = 1; SET GLOBAL super_read_only = 1;',
      scope: 'node',
      needsConfirmation: isDr,
    }];
  }
  return [];
}

// ─────────────────────────────────────────────────────────────
// 4) Schema 聚合
// ─────────────────────────────────────────────────────────────

function isTempOrHistoryTable(name) {
  if (!name) return false;
  return /^(tmp|temp|test|bak|old|backup)_/i.test(name)
    || /_(tmp|temp|test|bak|old|backup)$/i.test(name)
    || /_20\d{2}[01]\d[0-3]\d$/.test(name)
    || /_\d{6,8}$/.test(name);
}
function isGhostTable(name) {
  if (!name) return false;
  return /^_.*_(new|del|gho|old|ghc)$/i.test(name) || /^_.*_ghost$/i.test(name);
}

function evalNoPkTables(ctx) {
  const { node } = ctx;
  const list = node.noPkTables || [];
  if (list.length === 0) return [];
  const business = list.filter(t => !isTempOrHistoryTable(t.table));
  const tempCount = list.length - business.length;
  if (business.length > 0) {
    return [{
      type: 'no_pk_tables', priority: 'P2', groupKey: 'no_pk_tables',
      description: `存在业务表无主键 ${business.length} 张${tempCount > 0 ? `（另有 ${tempCount} 张临时/历史表已过滤）` : ''}，TOP：${business.slice(0, 3).map(t => `${t.schema}.${t.table}`).join('、')}`,
      action: '评估补充自增主键或唯一索引；ROW 复制下无主键表全表扫描匹配，且无法 MTS 并行复制',
      sql: `-- 示例：ALTER TABLE ${business[0].schema}.${business[0].table} ADD COLUMN id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST;`,
      scope: 'cluster',
    }];
  }
  if (tempCount > 0) {
    return [{
      type: 'no_pk_tables_temp_only', priority: 'P3', groupKey: 'no_pk_tables_temp_only',
      description: `存在无主键表 ${tempCount} 张，但均为临时/历史/备份表（tmp_/temp_/test_/_bak/_20YYMMDD 等），可忽略或随归档清理`,
      action: '若临时表已无业务引用，建议 DROP 清理',
      scope: 'cluster',
    }];
  }
  return [];
}

function evalGhostTables(ctx) {
  const { node } = ctx;
  const ghost = (node.fragTables || []).filter(t => isGhostTable(t.table));
  const big = ghost.filter(t => Number(t.dataFree || 0) + Number(t.dataLength || 0) >= 1073741824);
  if (big.length === 0) return [];
  const totalGB = big.reduce((s, t) => s + (Number(t.dataLength || 0) + Number(t.dataFree || 0)) / 1073741824, 0);
  return [{
    type: 'ghost_tables', priority: 'P2', groupKey: 'ghost_tables',
    description: `疑似在线 DDL 残留 ghost 表 ${big.length} 张，合计 ~${totalGB.toFixed(1)} GB（${big.slice(0, 3).map(t => `${t.schema}.${t.table}`).join('、')}）`,
    action: 'gh-ost / pt-osc 操作未正常清理；确认无业务引用后可 DROP 直接释放空间',
    sql: `-- 先确认无引用：\nSELECT * FROM information_schema.statistics WHERE table_name = '${big[0].table}';\n-- 确认后执行：\nDROP TABLE ${big[0].schema}.${big[0].table};`,
    scope: 'cluster',
    needsConfirmation: true,
  }];
}

function evalNonUtf8Tables(ctx) {
  const { node } = ctx;
  const list = node.nonUtf8Tables || [];
  if (list.length === 0) return [];
  return [{
    type: 'non_utf8_tables', priority: 'P2', groupKey: 'non_utf8_tables',
    description: `存在非 utf8 表 ${list.length} 张（${list.slice(0, 3).map(t => `${t.schema}.${t.table}(${t.collation})`).join('、')}）`,
    action: '评估转换为 utf8mb4 以支持完整字符集',
    sql: `-- 示例：ALTER TABLE ${list[0].schema}.${list[0].table} CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;`,
    scope: 'cluster',
  }];
}

function evalHeavyFragTables(ctx) {
  const { node, cfg } = ctx;
  const T = cfg.thresholds?.frag || {};
  const rate = T.rate ?? 0.7;
  const minMB = T.min_mb ?? 100;
  const big = (node.fragTables || []).filter(t => {
    const fr = Number(t.fragRate);
    const free = Number(t.dataFree);
    return fr >= rate && free >= minMB * 1024 * 1024;
  });
  if (big.length === 0) return [];
  big.sort((a, b) => Number(b.dataFree) - Number(a.dataFree));
  const top = big.slice(0, 3).map(t => `${t.table}(${(Number(t.dataFree) / 1073741824).toFixed(1)}GB)`).join('、');
  return [{
    type: 'heavy_frag_tables', priority: 'P2', groupKey: 'heavy_frag_tables',
    description: `存在高碎片大表 ${big.length} 张（碎片率≥${(rate * 100).toFixed(0)}% 且碎片≥${minMB}MB；TOP：${top}）`,
    action: '维护窗口期 OPTIMIZE TABLE 或 pt-online-schema-change 重建',
    sql: '-- 示例：OPTIMIZE TABLE pioneer_db.tbl_order_refund;\n-- 大表推荐：pt-online-schema-change --alter "ENGINE=InnoDB" D=pioneer_db,t=tbl_order_refund --execute',
    scope: 'cluster',
  }];
}

// ─────────────────────────────────────────────────────────────
// 5) 参数推荐：bp / redo / max_conn / data_memory / auto_inc
// ─────────────────────────────────────────────────────────────

function evalBufferPoolSize(ctx) {
  const { node, cfg } = ctx;
  const memGB = node.memGB;
  const bpMB = node.bpMB;
  const T = cfg.thresholds?.innodb || {};
  const minMemGB = T.bp_too_small_min_mem_gb ?? 4;
  const warnRatio = T.bp_too_small_ratio ?? 0.4;
  const p1Ratio = T.bp_too_small_p1_ratio ?? 0.2;
  const largeRatio = T.bp_too_large_ratio ?? 0.8;
  if (!memGB || !bpMB || memGB < minMemGB) return [];
  const ratio = (bpMB / 1024) / memGB;
  const rec = recommendBufferPoolMB(memGB);
  const pct = (ratio * 100).toFixed(0);
  if (ratio < warnRatio) {
    return [{
      type: 'bp_too_small',
      priority: ratio < p1Ratio ? 'P1' : 'P2',
      groupKey: `bp_too_small:${node.ip}`,
      dimension: 'performance',
      description: `innodb_buffer_pool_size = ${fmtMB(bpMB)}，仅占 RAM ${memGB.toFixed(0)} GB 的 ${pct}%，远低于 50-70% 推荐区间`,
      currentValue: `${fmtMB(bpMB)}（占 RAM ${memGB.toFixed(0)} GB 的 ${pct}%）`,
      recommendedValue: `${fmtMB(rec)}（~60% RAM，保留 OS/连接/临时表余量）`,
      action: `调大 innodb_buffer_pool_size 至 ~${fmtMB(rec)}；> 1GB 时建议 buffer_pool_instances=8`,
      sql: [
        `SET GLOBAL innodb_buffer_pool_size = ${rec * 1024 * 1024};`,
        '-- my.cnf:',
        `innodb_buffer_pool_size = ${fmtMB(rec).replace(' ', '')}`,
        'innodb_buffer_pool_instances = 8',
      ].join('\n'),
      scope: 'node',
    }];
  }
  if (ratio > largeRatio) {
    return [{
      type: 'bp_too_large',
      priority: 'P1',
      groupKey: `bp_too_large:${node.ip}`,
      dimension: 'availability',
      description: `innodb_buffer_pool_size = ${fmtMB(bpMB)} 已占 RAM ${memGB.toFixed(0)} GB 的 ${pct}%，OS/连接/临时表无足够余量，可能触发 OOM 或 Swap`,
      currentValue: `${fmtMB(bpMB)}（占 RAM ${memGB.toFixed(0)} GB 的 ${pct}%）`,
      recommendedValue: `${fmtMB(rec)}（~60% RAM）`,
      action: `下调 innodb_buffer_pool_size 至 ~${fmtMB(rec)}；同时检查 Swap 是否已启用，必要时降低 max_connections`,
      sql: [
        `SET GLOBAL innodb_buffer_pool_size = ${rec * 1024 * 1024};`,
        '-- my.cnf:',
        `innodb_buffer_pool_size = ${fmtMB(rec).replace(' ', '')}`,
      ].join('\n'),
      scope: 'node',
    }];
  }
  return [];
}

function evalRedoLog(ctx) {
  const { node, cfg } = ctx;
  const logMB = _mb(node, 'innodb_log_file_size_in_mb');
  const dbGB = Number(node.dbTotalSizeGB || 0);
  const T = cfg.thresholds?.innodb || {};
  const minMB = T.redo_log_min_mb ?? 512;
  const busyGB = T.redo_log_db_gb_busy ?? 50;
  const heavyGB = T.redo_log_db_gb_heavy ?? 200;
  if (logMB == null || logMB >= minMB) return [];
  if (!(dbGB >= busyGB || Number(node.qps || 0) > 200)) return [];
  const targetMB = dbGB >= heavyGB ? 2048 : dbGB >= busyGB ? 1024 : 512;
  return [{
    type: 'redo_log_too_small',
    priority: logMB < 128 ? 'P1' : 'P2',
    groupKey: `redo_log_small:${node.ip}`,
    dimension: 'performance',
    description: `innodb_log_file_size = ${fmtMB(logMB)}（库数据量 ${dbGB.toFixed(0)} GB），redo 频繁切换会拉低写吞吐并放大故障恢复时间`,
    currentValue: fmtMB(logMB),
    recommendedValue: `${fmtMB(targetMB)}（依据库大小 ${dbGB.toFixed(0)} GB）`,
    action: 'MySQL 8.0 可动态调整；5.7 需停机改 my.cnf 后重启',
    sql: [
      '-- MySQL 8.0+ 动态：',
      `SET GLOBAL innodb_redo_log_capacity = ${targetMB * 2 * 1024 * 1024};`,
      '-- MySQL 5.7 需重启：',
      '-- my.cnf:',
      `innodb_log_file_size = ${targetMB}M`,
      'innodb_log_files_in_group = 2',
    ].join('\n'),
    scope: 'node',
  }];
}

function evalMaxConnectionsVsMemory(ctx) {
  const { node, cfg } = ctx;
  const v = node.variables || {};
  const memGB = node.memGB;
  const maxConn = Number(v.max_connections || 0);
  const T = cfg.thresholds?.max_connections || {};
  const warnRatio = T.peak_memory_ratio_warn ?? 0.3;
  const p1Ratio = T.peak_memory_ratio_p1 ?? 0.5;
  if (!memGB || maxConn <= 0) return [];
  const perConnMB =
    (_kb(node, 'sort_buffer_size_in_kb') || 0) / 1024 +
    (_kb(node, 'join_buffer_size_in_kb') || 0) / 1024 +
    (_kb(node, 'read_buffer_size_in_kb') || 0) / 1024 +
    (_kb(node, 'read_rnd_buffer_size_in_kb') || 0) / 1024 +
    (_mb(node, 'tmp_table_size_in_mb') || 0);
  const peakMB = perConnMB * maxConn;
  const peakRatio = peakMB / (memGB * 1024);
  if (peakRatio <= warnRatio) return [];
  const targetMaxConn = Math.floor(memGB * 1024 * warnRatio / Math.max(perConnMB, 1));
  return [{
    type: 'max_connections_vs_memory',
    priority: peakRatio > p1Ratio ? 'P1' : 'P2',
    groupKey: `max_conn_mem:${node.ip}`,
    dimension: 'availability',
    description: `max_connections=${maxConn} × 单连接峰值 ~${fmtMB(perConnMB)} = 总峰值 ~${fmtMB(peakMB)}，约占 RAM ${memGB.toFixed(0)} GB 的 ${(peakRatio * 100).toFixed(0)}%（仅估算，实际并发不会全用满 buffer）`,
    currentValue: `max_connections=${maxConn}（每连接 ~${fmtMB(perConnMB)}，理论峰值 ${(peakRatio * 100).toFixed(0)}% RAM）`,
    recommendedValue: `max_connections=${targetMaxConn} 或缩减 sort_buffer / join_buffer / read_buffer（通常 256KB-2MB 即可）`,
    action: '下调 max_connections，或缩减单连接 buffer；中长期改用连接池（ProxySQL / HAProxy）',
    sql: `SET GLOBAL max_connections = ${targetMaxConn};`,
    scope: 'node',
  }];
}

function evalDataToMemoryRatio(ctx) {
  const { node, cfg } = ctx;
  const memGB = node.memGB;
  const dbGB = Number(node.dbTotalSizeGB || 0);
  const T = cfg.thresholds?.data_memory || {};
  const warn = T.ratio_warn ?? 10;
  const p1 = T.ratio_p1 ?? 50;
  if (!memGB || dbGB <= 0) return [];
  const ratio = dbGB / memGB;
  if (ratio <= warn) return [];
  return [{
    type: 'data_to_memory_ratio_high',
    priority: ratio > p1 ? 'P1' : 'P2',
    groupKey: `data_memory_ratio:${node.ip}`,
    dimension: 'performance',
    description: `数据集 ${dbGB.toFixed(0)} GB 是 RAM ${memGB.toFixed(0)} GB 的 ${ratio.toFixed(1)} 倍 — 工作集大概率无法常驻 buffer pool，会持续磁盘 IO`,
    currentValue: `${dbGB.toFixed(0)} GB 数据 / ${memGB.toFixed(0)} GB RAM = ${ratio.toFixed(1)}x`,
    recommendedValue: `扩容 RAM 到 ${Math.ceil(dbGB / 5)} GB（数据 / 5），或冷热分离 / 归档 / 分库`,
    action: '架构层调整（不是 SET GLOBAL 能改的）；评估扩容 / 冷数据归档 / 业务分表',
    sql: null,
    scope: 'node',
  }];
}

function evalAutoIncrementExhausting(ctx) {
  const { node, cfg } = ctx;
  const T = cfg.thresholds?.auto_increment || {};
  const p2Rate = T.rate_p2 ?? 0.7;
  const p1Rate = T.rate_p1 ?? 0.8;
  const p0Rate = T.rate_p0 ?? 0.9;
  const critical = (node.autoIncrementUsage || []).filter(x => Number(x.rate || 0) >= p2Rate);
  if (critical.length === 0) return [];
  critical.sort((a, b) => Number(b.rate) - Number(a.rate));
  const top = critical[0];
  const maxRate = Number(top.rate);
  const priority = maxRate >= p0Rate ? 'P0' : maxRate >= p1Rate ? 'P1' : 'P2';
  const top3 = critical.slice(0, 3).map(x => `${x.schema}.${x.table}.${x.column}=${(Number(x.rate) * 100).toFixed(0)}%`).join('、');
  return [{
    type: 'auto_increment_exhausting',
    priority,
    groupKey: 'auto_increment_exhausting',
    dimension: 'dataDesign',
    description: `自增列接近耗尽 — TOP ${Math.min(3, critical.length)}：${top3}；耗尽后 INSERT 会报 ER_AUTOINC_READ_FAILED`,
    currentValue: `最高 ${(maxRate * 100).toFixed(0)}%（${top.schema}.${top.table}.${top.column}）`,
    recommendedValue: '升级该列为 BIGINT UNSIGNED（增至 ~1.8×10^19 上限）',
    action: 'pt-online-schema-change 在线改大表；小表直接 ALTER TABLE 即可',
    sql: [
      '-- pt-osc 在线变更（推荐，大表）：',
      `pt-online-schema-change --alter "MODIFY COLUMN ${top.column} BIGINT UNSIGNED NOT NULL AUTO_INCREMENT" \\`,
      `  D=${top.schema},t=${top.table},u=<user>,p=<pwd> --execute`,
      '-- 小表直接 ALTER：',
      `ALTER TABLE ${top.schema}.${top.table} MODIFY COLUMN ${top.column} BIGINT UNSIGNED NOT NULL AUTO_INCREMENT;`,
    ].join('\n'),
    scope: 'node',
  }];
}

// ─────────────────────────────────────────────────────────────
// 6) 用户安全：wildcard host=% 三级
// ─────────────────────────────────────────────────────────────

function classifyWildcardUser(user) {
  const u = String(user || '').toLowerCase();
  if (u === 'root' || u === 'admin' || u === 'mysql.session' || u === 'mysql.sys') {
    return { level: 'critical', reason: '系统管理员账号开放给所有 host' };
  }
  if (/repl|backup|monitor|orchestrator|pmm|prometheus/i.test(u)) {
    return { level: 'high', reason: '复制/备份/监控账号高权限' };
  }
  return { level: 'medium', reason: '业务账号 host=% 攻击面大' };
}

function evalWildcardUsers(ctx) {
  const { node } = ctx;
  const wildcards = (node.users || []).filter(u => u.host === '%');
  const byLevel = { critical: [], high: [], medium: [] };
  for (const u of wildcards) {
    const cat = classifyWildcardUser(u.user);
    if (byLevel[cat.level]) byLevel[cat.level].push({ user: u.user, reason: cat.reason });
  }
  const userList = (arr) => arr.map(x => x.user).join('、');
  const sample = (arr) => arr[0]?.reason || '';
  const out = [];
  if (byLevel.critical.length > 0) {
    const list = byLevel.critical;
    out.push({
      type: 'wildcard_critical', priority: 'P0',
      groupKey: `wildcard_critical:${node.ip}`,
      description: list.length === 1
        ? `存在 host=% 的最高危用户：${list[0].user}（${list[0].reason}）`
        : `存在 host=% 的最高危用户 ${list.length} 个：${userList(list)}（${sample(list)}）`,
      action: "建议优先收紧：限制为内网网段或固定 IP；至少删除 '@'%' 项",
      sql: list.map(x => `DROP USER '${x.user}'@'%';\nCREATE USER '${x.user}'@'10.0.0.0/255.0.0.0' IDENTIFIED BY '<原密码>';\nGRANT <原权限> ON *.* TO '${x.user}'@'10.0.0.0/255.0.0.0';`).join('\n-- ----\n'),
      scope: 'cluster',
      affectedUsers: list.map(x => x.user),
    });
  }
  if (byLevel.high.length > 0) {
    const list = byLevel.high;
    out.push({
      type: 'wildcard_high', priority: 'P1',
      groupKey: `wildcard_high:${node.ip}`,
      description: list.length === 1
        ? `存在 host=% 的高风险用户：${list[0].user}（${list[0].reason}）`
        : `存在 host=% 的高风险用户 ${list.length} 个：${userList(list)}（${sample(list)}）`,
      action: '限制到必要的主机/网段',
      scope: 'cluster',
      affectedUsers: list.map(x => x.user),
    });
  }
  if (byLevel.medium.length > 0) {
    const list = byLevel.medium;
    out.push({
      type: 'wildcard_medium', priority: 'P2',
      groupKey: `wildcard_medium:${node.ip}`,
      description: list.length === 1
        ? `存在 host=% 的业务用户：${list[0].user}（${list[0].reason}）`
        : `存在 host=% 的业务用户 ${list.length} 个：${userList(list)}（${sample(list)}）`,
      action: '若业务来源固定，建议限制到具体网段以缩小攻击面',
      scope: 'cluster',
      affectedUsers: list.map(x => x.user),
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 7) 集群级：slave_parallel_workers_zero
// ─────────────────────────────────────────────────────────────

function evalSlaveParallelWorkersZero(ctx) {
  const { node, nodes, cfg } = ctx;
  if (node.role === 'primary' || !node.replication?.isSlave) return [];
  const v = node.variables || {};
  const parW = Number(v.slave_parallel_workers || 0);
  const primary = nodes.find(nn => nn.role === 'primary');
  const dataSizeGB = Number(primary?.dbTotalSizeGB || node.dbTotalSizeGB || 0);
  const T = cfg.thresholds?.replication || {};
  const p2Gb = T.parallel_workers_data_gb_p2 ?? 100;
  const p1Gb = T.parallel_workers_data_gb_p1 ?? 500;
  if (parW !== 0 || dataSizeGB < p2Gb) return [];
  return [{
    type: 'slave_parallel_workers_zero',
    priority: dataSizeGB >= p1Gb ? 'P1' : 'P2',
    groupKey: 'slave_parallel_workers_zero',
    description: `slave_parallel_workers = 0（并行复制未启用，集群数据量约 ${dataSizeGB.toFixed(0)} GB，大事务可能导致从库延迟积压）`,
    action: '建议设为 8-16 + slave_parallel_type = LOGICAL_CLOCK（需 binlog_format=ROW，已满足）',
    sql: 'SET GLOBAL slave_parallel_type = LOGICAL_CLOCK;\nSET GLOBAL slave_parallel_workers = 16;\n# 然后 STOP SLAVE; START SLAVE; 生效',
    scope: 'cluster',
  }];
}

// ─────────────────────────────────────────────────────────────
// 8) MySQL EOL（用 node.mysqlEolStatus）
// ─────────────────────────────────────────────────────────────

function evalMysqlVersionEol(ctx) {
  const { node } = ctx;
  const info = node.mysqlEolStatus;
  if (!info || info.status === 'supported') return [];
  return [{
    type: `mysql_version_${info.status}`,
    priority: info.priority,
    groupKey: `mysql_version_${info.major}`,
    description: `MySQL ${info.major} 已${info.statusLabel}（${info.eolDate}）— 当前实例 ${node.mysqlVersion}`,
    action: info.action,
    sql: info.status === 'eol'
      ? '# 升级路径示例（5.7 → 8.0）：\n# 1. 备份全量数据\n# 2. 用 mysql_upgrade_checker 检查兼容性\n# 3. 滚动升级从库 → 主从切换 → 升级旧主库'
      : null,
    scope: 'cluster',
  }];
}

// ─────────────────────────────────────────────────────────────
// 9) OS EOL（用 node.osEolStatus）
// ─────────────────────────────────────────────────────────────

function evalOsVersionEol(ctx) {
  const { node } = ctx;
  if (node.osEolStatus?.status !== 'eol') return [];
  return [{
    type: 'os_version_eol',
    priority: node.osEolStatus.priority || 'P2',
    groupKey: `os_version_eol:${node.osEolStatus.major}`,
    description: `操作系统版本已停止维护：${node.osEolStatus.major}（${node.osRelease || '-'}，EOL ${node.osEolStatus.eolDate}）`,
    action: node.osEolStatus.action,
    scope: 'cluster',
  }];
}

// ─────────────────────────────────────────────────────────────
// 10) 集群级：parameter inconsistency
// ─────────────────────────────────────────────────────────────

function evalParamInconsistent(ctx) {
  const { nodes } = ctx;
  if (nodes.length <= 1) return [];
  const keys = [
    'innodb_buffer_pool_size_in_mb',
    'innodb_log_file_size_in_mb',
    'max_connections',
    'binlog_format',
    'expire_logs_days',
    'long_query_time',
    'slow_query_log',
    'wait_timeout',
  ];
  const out = [];
  for (const k of keys) {
    const vals = new Set(nodes.map(n => n.variables?.[k]).filter(v => v != null));
    if (vals.size > 1) {
      out.push({
        type: 'param_inconsistent', priority: 'P2',
        groupKey: `param_inconsistent:${k}`,
        description: `节点间参数 ${k} 不一致：${[...vals].join(' / ')}`,
        node: '全部节点',
        action: '评估是否需要统一（部分参数允许节点差异）',
        scope: 'cluster',
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 11) 长事务会话 TOP
// ─────────────────────────────────────────────────────────────

function evalLongRunningSession(ctx) {
  const { node, cfg } = ctx;
  const top = node.longSessTop;
  if (!top) return [];
  const T = cfg.thresholds?.session || {};
  const p2 = T.long_running_seconds_p2 ?? 600;
  return [{
    type: 'long_running_session',
    priority: Number(top.time) >= p2 ? 'P2' : 'P3',
    groupKey: `long_running_session:${node.ip}`,
    description: `存在长时间运行会话：${top.user}@${top.host || '-'} ${top.time}s，状态 ${top.state || '-'}${top.db ? `，库 ${top.db}` : ''}`,
    action: '先确认业务影响和 SQL 内容；若阻塞、消耗资源或确认异常，再由 DBA 执行 KILL CONNECTION',
    sql: `SHOW FULL PROCESSLIST;\n-- 确认异常后：KILL CONNECTION ${top.id};`,
    scope: 'node',
    needsConfirmation: true,
  }];
}

// ─────────────────────────────────────────────────────────────
// 12) BP 命中率 tiered（小数格式化）
// ─────────────────────────────────────────────────────────────

function evalBpHit(ctx) {
  const { node, cfg } = ctx;
  if (node.bpHitPct == null) return [];
  const T = cfg.thresholds?.innodb || {};
  const lowPct = T.bp_hit_low_pct ?? 95;
  const warnPct = T.bp_hit_warn_pct ?? 99;
  const rateStr = node.bpHitPct.toFixed(1);
  if (node.bpHitPct < lowPct) {
    return [{
      type: 'bp_hit_low', priority: 'P1',
      groupKey: `bp_hit:${node.ip}`,
      description: `Buffer Pool 命中率 ${rateStr}%（${node.bpHitDisplay}），低于 ${lowPct}% 阈值`,
      action: '评估扩大 innodb_buffer_pool_size 至内存的 50-70%',
      scope: 'node',
    }];
  }
  if (node.bpHitPct < warnPct) {
    return [{
      type: 'bp_hit_sub99', priority: 'P3',
      groupKey: `bp_hit:${node.ip}`,
      description: `Buffer Pool 命中率 ${rateStr}%（${node.bpHitDisplay}），未达 ${warnPct}% 推荐线`,
      action: '观察是否随业务增长继续下降；若持续偏低评估扩容',
      scope: 'node',
    }];
  }
  return [];
}

// ─────────────────────────────────────────────────────────────
// 13) 慢查询累计 tiered（toLocaleString）
// ─────────────────────────────────────────────────────────────

function evalSlowQueriesAbs(ctx) {
  const { node, cfg } = ctx;
  if (node.slowQueries == null) return [];
  const slow = Number(node.slowQueries);
  const pct = node.questions ? (slow / Number(node.questions) * 100) : null;
  const T = cfg.thresholds?.sql || {};
  const high = T.slow_query_abs_high ?? 1000000;
  const med = T.slow_query_abs_med ?? 100000;
  const slowStr = slow.toLocaleString();
  const pctClause = pct != null ? `（占总查询 ${pct.toFixed(4)}%）` : '';
  if (slow > high) {
    return [{
      type: 'slow_query_abs_high', priority: 'P1',
      groupKey: `slow_abs:${node.ip}`,
      description: `累计慢查询 ${slowStr} 次${pctClause}`,
      action: '使用 pt-query-digest 输出 TOP10 SQL，优先优化全表扫描和高 IO 查询',
      sql: 'pt-query-digest /data/mysql/data/*-slow.log | head -200',
      scope: 'node',
    }];
  }
  if (slow > med) {
    return [{
      type: 'slow_query_abs_med', priority: 'P2',
      groupKey: `slow_abs:${node.ip}`,
      description: `累计慢查询 ${slowStr} 次`,
      action: '定期 pt-query-digest 汇总分析',
      scope: 'node',
    }];
  }
  return [];
}

// ─────────────────────────────────────────────────────────────
// 14) InnoDB HLL（toLocaleString）
// ─────────────────────────────────────────────────────────────

function evalInnodbHll(ctx) {
  const { node, cfg } = ctx;
  const hll = Number(node.innodb?.historyListLength);
  if (!hll || Number.isNaN(hll)) return [];
  const T = cfg.thresholds?.innodb || {};
  const warn = T.hll_warn ?? 10000;
  const p1 = T.hll_p1 ?? 50000;
  if (hll <= warn) return [];
  return [{
    type: 'innodb_hll_high',
    priority: hll >= p1 ? 'P1' : 'P2',
    groupKey: `innodb_hll_high:${node.ip}`,
    description: `History List Length = ${hll.toLocaleString()}（超过 ${warn.toLocaleString()} 预警线，undo 历史清理滞后）`,
    action: '排查长事务/长查询和 purge 线程压力；优先确认 PROCESSLIST 与 INNODB TRX 中是否存在长期未提交事务',
    sql: 'SHOW ENGINE INNODB STATUS\\G\nSELECT * FROM information_schema.INNODB_TRX\\G\nSHOW FULL PROCESSLIST;',
    scope: 'node',
  }];
}

module.exports = {
  evalDisks,
  evalReplication,
  evalRoleReadOnly,
  evalNoPkTables,
  evalGhostTables,
  evalNonUtf8Tables,
  evalHeavyFragTables,
  evalBufferPoolSize,
  evalRedoLog,
  evalMaxConnectionsVsMemory,
  evalDataToMemoryRatio,
  evalAutoIncrementExhausting,
  evalWildcardUsers,
  evalSlaveParallelWorkersZero,
  evalMysqlVersionEol,
  evalOsVersionEol,
  evalParamInconsistent,
  evalLongRunningSession,
  evalBpHit,
  evalSlowQueriesAbs,
  evalInnodbHll,
};

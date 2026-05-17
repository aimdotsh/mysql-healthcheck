#!/usr/bin/env node
/**
 * MySQL 巡检数据提取器
 *
 * 用法：
 *   node extract.js <数据目录> [--project "项目名"] [--report-version 1.0] [--out data.json]
 *
 * 输入：目录下的 MySQLHealthCheck_<IP>_<时间戳>.txt（必须）
 *      和 <IP>_<项目>_<角色>-<日期>.html（可选，用于 ibtmp1/容量补充）
 * 输出：data.json，供 render.js 消费
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ============== CLI 参数解析 ==============
const args = process.argv.slice(2);
if (!args[0] || args[0].startsWith('--')) {
  console.error('用法: node extract.js <数据目录> [--project "项目名"] [--report-version 1.0] [--out data.json] [--config <path>]');
  process.exit(1);
}
const dataDir = path.resolve(args[0]);
const opts = { project: null, reportVersion: '1.0', out: null, config: null };
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--project') opts.project = args[++i];
  else if (args[i] === '--report-version') opts.reportVersion = args[++i];
  else if (args[i] === '--out') opts.out = args[++i];
  else if (args[i] === '--config') opts.config = args[++i];
}

if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
  console.error(`错误：目录不存在或不是目录：${dataDir}`);
  process.exit(1);
}

const outPath = opts.out
  ? path.resolve(opts.out)
  : path.join(dataDir, 'data.json');

// ============== v4.8：阈值与规则配置（三层合并：内置默认 < 采集目录同名 < CLI --config） ==============
function loadHcConfig(dataDir, cliPath) {
  const defaultPath = path.join(__dirname, 'config', 'default-thresholds.json');
  let result = {};
  const sourcesApplied = [];
  // Layer 1: 内置默认（必须存在；否则配置层失效，但程序继续，避免阻塞）
  try {
    result = JSON.parse(fs.readFileSync(defaultPath, 'utf-8'));
    sourcesApplied.push({ source: 'default', path: defaultPath });
  } catch (e) {
    console.warn(`⚠ 默认配置加载失败 (${defaultPath})：${e.message}`);
    result = { thresholds: {}, priorities: {}, disabledRules: [] };
  }
  // Layer 2: <dataDir>/mysql-healthcheck.config.json
  if (dataDir) {
    const auto = path.join(dataDir, 'mysql-healthcheck.config.json');
    if (fs.existsSync(auto)) {
      try {
        deepMergeConfig(result, JSON.parse(fs.readFileSync(auto, 'utf-8')));
        sourcesApplied.push({ source: 'dataDir', path: auto });
      } catch (e) {
        console.warn(`⚠ 采集目录配置 ${auto} 解析失败：${e.message}（已忽略）`);
      }
    }
  }
  // Layer 3: --config <path>
  if (cliPath) {
    const resolved = path.resolve(cliPath);
    if (fs.existsSync(resolved)) {
      try {
        deepMergeConfig(result, JSON.parse(fs.readFileSync(resolved, 'utf-8')));
        sourcesApplied.push({ source: 'cli', path: resolved });
      } catch (e) {
        console.warn(`⚠ --config 文件 ${resolved} 解析失败：${e.message}（已忽略）`);
      }
    } else {
      console.warn(`⚠ --config 文件不存在：${resolved}（已忽略）`);
    }
  }
  // 标准化 disabledRules：过滤掉注释 / 非字符串
  result.disabledRules = Array.isArray(result.disabledRules)
    ? result.disabledRules.filter(s => typeof s === 'string' && !s.startsWith('_'))
    : [];
  // priorities 同样过滤掉注释键
  if (result.priorities && typeof result.priorities === 'object') {
    for (const k of Object.keys(result.priorities)) {
      if (k.startsWith('_')) delete result.priorities[k];
    }
  } else {
    result.priorities = {};
  }
  result._sources = sourcesApplied;
  return result;
}

// 深合并 source 进 target，跳过以 _ 开头的注释键（_doc / _comment / _schema 等）
function deepMergeConfig(target, source) {
  if (!source || typeof source !== 'object') return target;
  for (const k of Object.keys(source)) {
    if (k.startsWith('_')) continue;
    const v = source[k];
    if (Array.isArray(v)) {
      target[k] = v;
    } else if (v && typeof v === 'object') {
      if (!target[k] || typeof target[k] !== 'object' || Array.isArray(target[k])) {
        target[k] = {};
      }
      deepMergeConfig(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

const hcConfig = loadHcConfig(dataDir, opts.config);
const T = hcConfig.thresholds || {};
const DISABLED_RULES = new Set(hcConfig.disabledRules || []);
const PRIORITY_OVERRIDES = hcConfig.priorities || {};

// ============== 辅助函数 ==============
function fmtBytes(bytes) {
  if (bytes == null || isNaN(bytes)) return '-';
  const n = Number(bytes);
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
  if (n >= 1048576) return (n / 1048576).toFixed(2) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(2) + ' KB';
  return n + ' B';
}

function fmtKB(kb) {
  if (kb == null) return '-';
  return fmtBytes(Number(kb) * 1024);
}

function fmtSeconds(s) {
  if (s == null) return '-';
  const n = Number(s);
  const d = Math.floor(n / 86400);
  const h = Math.floor((n % 86400) / 3600);
  const m = Math.floor((n % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时 ${m} 分`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分`;
}

// ============== v4.8 senior-DBA 规则辅助函数 ==============
// 主机内存 GB（从 memTotalKB 推导）
function memTotalGB(n) {
  return n.memTotalKB ? n.memTotalKB / 1024 / 1024 : null;
}

// 按 MB 取参数值；自动兼容 *_in_mb / *_in_kb 后缀 + "1G" / "512M" / 纯数字字节
function mb(n, key) {
  const v = n.variables?.[key];
  if (v == null) return null;
  const s = String(v).trim();
  const m = s.match(/^([\d.]+)\s*([KMGT])?B?$/i);
  if (!m) return null;
  const num = parseFloat(m[1]);
  const u = (m[2] || '').toUpperCase();
  if (u === 'G') return num * 1024;
  if (u === 'M') return num;
  if (u === 'K') return num / 1024;
  if (u === 'T') return num * 1024 * 1024;
  if (/_in_mb$/.test(key)) return num;
  if (/_in_kb$/.test(key)) return num / 1024;
  return num / 1024 / 1024;   // 默认按字节
}

function kb(n, key) {
  const m = mb(n, key);
  return m == null ? null : m * 1024;
}

function formatMB(mbVal) {
  if (mbVal == null) return '-';
  return mbVal >= 1024 ? (mbVal / 1024).toFixed(1) + ' GB' : Math.round(mbVal) + ' MB';
}

// 推荐缓冲池：60% RAM；RAM ≤ 4G 保留 1G，4-16G 保留 2G，>16G 保留 4G
function recommendBufferPoolMB(memGB) {
  if (!memGB || memGB <= 0) return null;
  const reserveGB = memGB <= 4 ? 1 : memGB <= 16 ? 2 : 4;
  return Math.round(Math.max(1, Math.min(memGB * 0.6, memGB - reserveGB)) * 1024);
}

// 把 sql_mode 字符串解析为 Set，便于 has() 判断
function parseSqlMode(str) {
  return new Set(String(str || '').toUpperCase().split(',').map(s => s.trim()).filter(Boolean));
}

// 是否 MySQL 8.0+（含 8.0、8.1、8.4 …）
function isMysql80Plus(versionStr) {
  const m = String(versionStr || '').match(/^(\d+)\.(\d+)/);
  if (!m) return false;
  const maj = Number(m[1]);
  return maj > 8 || (maj === 8 && Number(m[2]) >= 0);
}
// ============== /v4.8 辅助 ==============

// ============== v4.9 senior-DBA 根因关联辅助函数 ==============
// 把 "152 days 8 hours 44 min 21 sec" / "1 days 5 hours 30 min" / "23 hours 15 min" 解析为秒
function parseUptimeToSec(s) {
  if (!s) return null;
  const str = String(s).toLowerCase();
  let sec = 0;
  const m = (re) => {
    const r = str.match(re);
    return r ? Number(r[1]) : 0;
  };
  sec += m(/(\d+)\s*days?/) * 86400;
  sec += m(/(\d+)\s*hours?/) * 3600;
  sec += m(/(\d+)\s*min/) * 60;
  sec += m(/(\d+)\s*sec/);
  return sec || null;
}

// 把人类可读字节数（"1.2G" / "52G" / "500M" / "120K"）解析为字节数
function parseHumanSizeToBytes(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^([\d.]+)\s*([KMGT])?B?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const u = (m[2] || '').toUpperCase();
  if (u === 'T') return Math.round(n * 1024 * 1024 * 1024 * 1024);
  if (u === 'G') return Math.round(n * 1024 * 1024 * 1024);
  if (u === 'M') return Math.round(n * 1024 * 1024);
  if (u === 'K') return Math.round(n * 1024);
  return Math.round(n);
}

// 把秒数 → 「X 天」/「X 小时」/「X 分」简洁文本
function formatUptimeShort(sec) {
  if (!sec || sec <= 0) return '-';
  if (sec >= 86400) return Math.floor(sec / 86400) + ' 天';
  if (sec >= 3600) return Math.floor(sec / 3600) + ' 小时';
  if (sec >= 60) return Math.floor(sec / 60) + ' 分';
  return sec + ' 秒';
}
// ============== /v4.9 辅助 ==============



// 抽取 txt 中由 ----->>>---->>>  XXX 分隔的某段
function getSection(content, sectionName, options = {}) {
  const { caseInsensitive = true } = options;
  const lines = content.split(/\r?\n/);
  const marker = '----->>>---->>>';
  const result = [];
  let inSec = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(marker)) {
      // 兼容 V3 新格式 "[NN] 段名" 和 V2 旧格式 "段名"
      let after = line.split(marker)[1].trim();
      after = after.replace(/^\[\d+\]\s*/, ''); // 去掉 [01] 等前缀
      const matches = caseInsensitive
        ? after.toLowerCase().startsWith(sectionName.toLowerCase())
        : after.startsWith(sectionName);
      if (matches) {
        inSec = true;
        continue;
      }
      if (inSec) break;
    } else if (inSec) {
      result.push(line);
    }
  }
  return result.join('\n');
}

function hasSection(content, sectionName, options = {}) {
  const { caseInsensitive = true } = options;
  const lines = content.split(/\r?\n/);
  const marker = '----->>>---->>>';
  for (const line of lines) {
    if (!line.includes(marker)) continue;
    let after = line.split(marker)[1].trim();
    after = after.replace(/^\[\d+\]\s*/, '');
    const matches = caseInsensitive
      ? after.toLowerCase().startsWith(sectionName.toLowerCase())
      : after.startsWith(sectionName);
    if (matches) return true;
  }
  return false;
}

// 解析 mysql 命令行 +----+ 表格
function parseMysqlTable(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  let headers = null;
  const rows = [];
  let separatorCount = 0;
  for (const line of lines) {
    if (/^\+[-+]+\+$/.test(line.trim())) {
      separatorCount++;
      continue;
    }
    if (!line.trim().startsWith('|')) continue;
    const parts = line.split('|').slice(1, -1).map(s => s.trim());
    if (!headers) {
      headers = parts;
    } else {
      rows.push(parts);
    }
  }
  return { headers: headers || [], rows };
}

function rowObject(headers, row) {
  const obj = {};
  headers.forEach((header, idx) => {
    obj[header] = row[idx];
  });
  return obj;
}

function numberOrNull(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s || /^NULL$/i.test(s) || s === '-') return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parseIbtmp1FromTablespaces(text, configValue) {
  const table = parseMysqlTable(text || '');
  const row = table.rows.find((r) => {
    const joined = r.join(' ').toLowerCase();
    return joined.includes('ibtmp') || joined.includes('innodb_temporary');
  });
  if (!row) return null;
  const obj = rowObject(table.headers, row);
  const totalExtents = numberOrNull(obj.TOTAL_EXTENTS);
  const extentSize = numberOrNull(obj.EXTENT_SIZE);
  const fileSize = numberOrNull(obj.FILE_SIZE);
  const allocatedSize = numberOrNull(obj.ALLOCATED_SIZE);
  const initialSize = numberOrNull(obj.INITIAL_SIZE);
  const autoExtendSize = numberOrNull(obj.AUTOEXTEND_SIZE);
  const dataFree = numberOrNull(obj.DATA_FREE);
  const sizeBytes = fileSize
    ?? allocatedSize
    ?? (totalExtents != null && extentSize != null ? totalExtents * extentSize : null)
    ?? initialSize
    ?? dataFree;
  const cfg = String(configValue || '');
  const cfgInitial = (cfg.match(/ibtmp1:([^:]+)(?::|$)/i) || [])[1];
  const cfgAuto = /autoextend/i.test(cfg) ? 'autoextend' : '-';
  return {
    sizeBytes,
    dataFreeBytes: dataFree,
    sizeFormatted: fmtBytes(sizeBytes),
    initialSize: initialSize != null ? fmtBytes(initialSize) : (cfgInitial || '-'),
    autoExtendSize: autoExtendSize != null ? fmtBytes(autoExtendSize) : cfgAuto,
    source: 'txt:innodb_tablespaces',
  };
}

function stripCollectorBanner(text) {
  return String(text || '').split(/\r?\n/).filter((line) => {
    if (/^\|\+{5,}\|$/.test(line.trim())) return false;
    if (/^\|\s+\[\d+\]\s+.+\|$/.test(line.trim())) return false;
    return true;
  }).join('\n');
}

function parseOsRelease(text) {
  if (!text) return '';
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const meaningful = lines.find(l => !/^cat: /.test(l));
  if (!meaningful) return '';
  const pretty = meaningful.match(/^PRETTY_NAME=(.+)$/);
  if (pretty) return pretty[1].replace(/^["']|["']$/g, '');
  return meaningful;
}

const OS_EOL_TABLE = [
  { match: /CentOS(?: Linux)? release 6\b|CentOS Linux 6\b/i, major: 'CentOS 6', eolDate: '2020-11-30', priority: 'P1' },
  { match: /CentOS(?: Linux)? release 7\b|CentOS Linux 7\b/i, major: 'CentOS 7', eolDate: '2024-06-30', priority: 'P2' },
  { match: /CentOS(?: Linux)? release 8\b|CentOS Linux 8\b/i, major: 'CentOS 8', eolDate: '2021-12-31', priority: 'P2' },
];

function osEolStatus(release) {
  if (!release) return null;
  for (const row of OS_EOL_TABLE) {
    if (row.match.test(release)) {
      return {
        major: row.major,
        status: 'eol',
        statusLabel: '已停止维护',
        eolDate: row.eolDate,
        priority: row.priority,
        action: `规划迁移到受支持的企业 Linux 发行版；${row.major} 已无官方安全补丁，需纳入主机安全整改`,
      };
    }
  }
  return { status: 'unknown', statusLabel: '需人工确认生命周期', priority: 'P3' };
}

// ============== txt 解析器 ==============
function parseTxt(filepath) {
  const content = fs.readFileSync(filepath, 'utf-8');
  const node = { _file: path.basename(filepath) };

  // -------- 基础信息 --------
  const hostnameSec = getSection(content, 'hostname');
  node.hostname = hostnameSec.trim().split('\n')[0] || '';

  const kernel = getSection(content, 'os kernal') || getSection(content, 'os kernel');
  node.osKernel = (kernel.trim().split('\n')[0] || '').trim();
  const osReleaseSec = getSection(content, 'os release');
  node.osRelease = parseOsRelease(osReleaseSec);
  node.osEolStatus = osEolStatus(node.osRelease);

  // 内存
  const memInfo = getSection(content, 'mem info');
  const memMatch = memInfo.match(/MemTotal:\s+(\d+)/);
  const memFreeMatch = memInfo.match(/MemFree:\s+(\d+)/);
  const buffersMatch = memInfo.match(/Buffers:\s+(\d+)/);
  const cachedMatch = memInfo.match(/^Cached:\s+(\d+)/m);
  const swapTotalMatch = memInfo.match(/SwapTotal:\s+(\d+)/);
  const swapFreeMatch = memInfo.match(/SwapFree:\s+(\d+)/);
  if (memMatch) {
    const total = Number(memMatch[1]);
    const free = memFreeMatch ? Number(memFreeMatch[1]) : 0;
    const buf = buffersMatch ? Number(buffersMatch[1]) : 0;
    const cache = cachedMatch ? Number(cachedMatch[1]) : 0;
    node.memTotalKB = total;
    node.memFreeKB = free;
    node.memUsedKB = total - free - buf - cache;
    node.memUsagePct = ((total - free - buf - cache) / total * 100).toFixed(1);
    node.memTotal = fmtKB(total);
    node.memFree = fmtKB(free);
    node.memUsed = fmtKB(total - free - buf - cache);
  }
  if (swapTotalMatch) {
    const total = Number(swapTotalMatch[1]);
    const free = swapFreeMatch ? Number(swapFreeMatch[1]) : null;
    const used = free == null ? null : Math.max(0, total - free);
    node.swapTotalKB = total;
    node.swapFreeKB = free;
    node.swapUsedKB = used;
    node.swapTotal = fmtKB(total);
    node.swapFree = free == null ? '-' : fmtKB(free);
    node.swapUsed = used == null ? '-' : fmtKB(used);
    node.swapUsagePct = total > 0 && used != null ? (used / total * 100).toFixed(1) : '0.0';
  }

  // CPU
  const cpuCoresSec = getSection(content, 'CPU cores');
  const coreMatch = cpuCoresSec.match(/(\d+)\s*$/m) || cpuCoresSec.match(/(\d+)/);
  node.cpuCores = coreMatch ? Number(coreMatch[1]) : null;

  // CPU 型号 (从 top info 找 model name)
  const topInfo = getSection(content, 'Top Info');
  const modelMatch = topInfo.match(/model name\s*:\s*(.+)/i);
  node.cpuModel = modelMatch ? modelMatch[1].trim() : '-';

  // 磁盘
  const diskMount = getSection(content, 'disk mount');
  node.disks = parseDiskMount(diskMount);

  // resource limit（评审反馈 #2：仅作为 OS 端参考值，MySQL 生效值应从 SHOW VARIABLES 读）
  const resLimit = getSection(content, 'resource limit');
  const openFilesMatch = resLimit.match(/open files\s+\([^)]+\)\s+(\d+)/i);
  node.openFilesLimitOs = openFilesMatch ? Number(openFilesMatch[1]) : null;

  // mysqld 进程实际 limits（V3 采集脚本会写入 mysqld process limits 段）
  const procLimits = getSection(content, 'mysqld process limits');
  if (procLimits) {
    const procOpenFiles = procLimits.match(/Max open files\s+(\d+)/i);
    if (procOpenFiles) node.openFilesLimitProcess = Number(procOpenFiles[1]);
  }
  // 最终 openFilesLimit：优先 MySQL 进程 limits（最准），再 MySQL Variables，再 OS ulimit
  // node.variables.open_files_limit 由 parseVariables 处理
  node.openFilesLimit = node.openFilesLimitProcess || null; // 后续 main() 会用 variables 补全

  // -------- MySQL 版本 / Uptime --------
  const mysqlVer = getSection(content, 'MySQL Database Version');
  const serverVerMatch = mysqlVer.match(/Server version:\s*(.+)/);
  node.mysqlVersion = serverVerMatch ? serverVerMatch[1].trim() : '-';
  const uptimeMatch = mysqlVer.match(/Uptime:\s*(.+)$/m);
  node.uptimeText = uptimeMatch ? uptimeMatch[1].trim() : '-';
  // v4.9：把 uptimeText 解析为秒，供根因关联用（区分「冷重启」「长期运行」）
  node.uptimeSec = parseUptimeToSec(node.uptimeText);
  // Threads / Questions / Slow_queries
  const statsLine = mysqlVer.match(/Threads:\s*(\d+)\s+Questions:\s*(\d+)\s+Slow queries:\s*(\d+)\s+Opens:\s*(\d+)[^Q]*Queries per second avg:\s*([\d.]+)/);
  if (statsLine) {
    node.threadsConnected = Number(statsLine[1]);
    node.questions = Number(statsLine[2]);
    node.slowQueries = Number(statsLine[3]);
    node.qps = Number(statsLine[5]);
  }

  // -------- 配置变量 --------
  const variables = getSection(content, 'MySQL Variables');
  node.variables = parseVariables(variables);

  // -------- 从 my.cnf 补充 server_id（MySQL Variables 段不含）--------
  // 注意：my.cnf 中可能有多个 server_id 赋值，按 MySQL 行为后者覆盖前者，所以取最后一行
  const mycnf = getSection(content, 'my.cnf detail');
  if (mycnf) {
    const sidMatches = [...mycnf.matchAll(/^\s*server_id\s*=\s*(\d+)/gm)];
    if (sidMatches.length > 0) node.variables.server_id = sidMatches[sidMatches.length - 1][1];
    const lbMatches = [...mycnf.matchAll(/^\s*log_bin\s*=\s*(\S+)/gm)];
    if (lbMatches.length > 0 && !node.variables.log_bin) {
      node.variables.log_bin = lbMatches[lbMatches.length - 1][1];
    }
  }

  // -------- 主从复制 --------
  const replSec = getSection(content, 'MySQL Replication Info');
  node.replication = parseReplication(replSec);

  // -------- 数据库清单（含字符集）--------
  const dbCharSec = getSection(content, 'database CHARACTER');
  node.databases = parseMysqlTable(dbCharSec).rows.map(r => ({
    name: r[0], charset: r[1], collation: r[2],
  }));

  // -------- 数据库总大小（过滤聚合行）--------
  const dbSize = getSection(content, 'DB TOTAL SIZE');
  node.dbSizes = parseMysqlTable(dbSize).rows
    .map(r => ({ name: r[0], sizeGB: r[1] }))
    .filter(d => d.name !== 'DATABASE TOTAL SIZE');
  // 单独保存合计
  const totalRow = parseMysqlTable(dbSize).rows.find(r => r[0] === 'DATABASE TOTAL SIZE');
  if (totalRow) node.dbTotalSizeGB = totalRow[1];

  // -------- innodb_tablespaces（含 ibtmp1）--------
  const tablespaceSec = getSection(content, 'innodb_tablespaces');
  node.ibtmp1CollectionStatus = hasSection(content, 'innodb_tablespaces') ? 'collected_no_row' : 'not_collected';
  if (tablespaceSec) {
    const ibtmp1 = parseIbtmp1FromTablespaces(tablespaceSec, node.variables?.innodb_temp_data_file_path);
    if (ibtmp1) {
      node.ibtmp1 = ibtmp1;
      node.ibtmp1CollectionStatus = 'collected';
    }
  }

  // -------- TOP10 大表 --------
  const top10 = getSection(content, 'Top 10 Tables');
  node.topTables = parseMysqlTable(top10).rows.map(r => ({
    schema: r[0], table: r[1], sizeGB: r[2], rows: r[3], engine: r[4],
  }));

  // -------- 碎片表 --------
  const fragSec = getSection(content, 'Tables fragment rate');
  node.fragTables = parseMysqlTable(fragSec).rows.map(r => ({
    schema: r[0], table: r[1], rows: r[2],
    dataLength: r[3], indexLength: r[4], dataFree: r[5], fragRate: r[6],
  }));

  // -------- 非 utf8 表 --------
  const utf8Sec = getSection(content, 'Not utf8 table');
  node.nonUtf8Tables = parseMysqlTable(utf8Sec).rows.map(r => ({
    schema: r[0], table: r[1], collation: r[2],
  }));

  // -------- 无主键表 --------
  const noPkSec = getSection(content, 'NO PRIMARY KEY TABLES');
  node.noPkTables = parseMysqlTable(noPkSec).rows.map(r => ({
    schema: r[0], table: r[1],
  }));

  // -------- 用户 --------
  const userSec = getSection(content, 'user check');
  node.users = parseMysqlTable(userSec).rows.map(r => ({
    user: r[0], host: r[1], passwordExpired: r[2],
    passwordLastChanged: r[3], passwordLifetime: r[4], accountLocked: r[5],
  }));

  // -------- Processlist --------
  const plSec = getSection(content, 'Processlist info');
  node.processlist = parseMysqlTable(plSec).rows.map(r => ({
    id: r[0], user: r[1], host: r[2], db: r[3],
    command: r[4], time: r[5], state: r[6], info: r[7],
  }));

  // -------- Engine innodb status --------
  const innodb = getSection(content, 'Engine innodb status');
  node.innodb = parseInnodbStatus(innodb);

  // -------- BLOB 字段统计 --------
  const blobSec = getSection(content, 'BLOB info');
  node.blobColumns = parseMysqlTable(blobSec).rows.map(r => ({
    schema: r[0], table: r[1], column: r[2], type: r[3],
  }));

  // -------- Partitions --------
  const partSec = getSection(content, 'PARTITIONS table');
  node.partitionTables = parseMysqlTable(partSec).rows.map(r => ({
    schema: r[0], table: r[1], count: r[2],
  }));

  // -------- Routines --------
  const routinesSec = getSection(content, 'ROUTINES OBJECTS');
  node.routines = parseMysqlTable(routinesSec).rows.map(r => ({
    schema: r[0], name: r[1], type: r[2], definer: r[3],
  }));

  // -------- CPU model (V3 新增) --------
  const cpuModelSec = getSection(content, 'CPU model');
  if (cpuModelSec) {
    const cpuLine = cpuModelSec.trim().split('\n')[0];
    if (cpuLine) node.cpuModel = cpuLine.trim();
  }

  // -------- 数据库对象汇总 (V3 新增) --------
  const dbObjSec = getSection(content, 'Database objects summary');
  if (dbObjSec) {
    node.dbObjects = parseMysqlTable(dbObjSec).rows.map(r => ({
      db: r[0], type: r[1], count: Number(r[2]) || 0,
    }));
  }

  // -------- TOP 10 索引大小 (V3 新增) --------
  const top10IdxSec = getSection(content, 'Top 10 Index Size');
  if (top10IdxSec) {
    node.topIndexes = parseMysqlTable(top10IdxSec).rows.map(r => ({
      schema: r[0], table: r[1], index: r[2], sizeMB: r[3], type: r[5], columns: r[6],
    }));
  }

  // -------- TOP SQL by latency (V3 新增) --------
  // 评审 #5/#17 (v4.4)：过滤 SHOW / DESC / INFORMATION_SCHEMA 等元数据查询噪声
  const topSqlLat = getSection(content, 'TOP 20 SQL by total latency');
  if (topSqlLat) {
    node.topSqlByLatency = parseMysqlTable(topSqlLat).rows.map(r => ({
      query: r[0], db: r[1], execCount: r[2], totalLatency: r[3],
      avgLatency: r[4], maxLatency: r[5], rowsExamined: r[6], rowsSent: r[7],
      digest: r[r.length - 1],
    })).filter(s => !isMetadataQuery(s.query, s.db));
  }

  // -------- TOP SQL by exec count --------
  const topSqlExec = getSection(content, 'TOP 20 SQL by exec count');
  if (topSqlExec) {
    node.topSqlByExec = parseMysqlTable(topSqlExec).rows.map(r => ({
      query: r[0], db: r[1], execCount: r[2], totalLatency: r[3], avgLatency: r[4],
    })).filter(s => !isMetadataQuery(s.query, s.db));
  }

  // -------- TOP SQL by avg latency --------
  const topSqlAvg = getSection(content, 'TOP 20 SQL by avg latency');
  if (topSqlAvg) {
    node.topSqlByAvg = parseMysqlTable(topSqlAvg).rows.map(r => ({
      query: r[0], db: r[1], execCount: r[2], avgLatency: r[3], totalLatency: r[4],
    })).filter(s => !isMetadataQuery(s.query, s.db));
  }

  // -------- SQL no good index --------
  const sqlNoIdx = getSection(content, 'SQL no good index');
  if (sqlNoIdx) {
    node.sqlNoGoodIndex = parseMysqlTable(sqlNoIdx).rows.map(r => ({
      query: r[0], db: r[1], execCount: r[2], totalLatency: r[3],
      noIndexCount: r[4], noGoodIndexCount: r[5], noIndexPct: r[6],
    })).filter(s => !isMetadataQuery(s.query, s.db));
  }

  // -------- SQL with temp tables --------
  const sqlTmp = getSection(content, 'SQL with temp tables');
  if (sqlTmp) {
    node.sqlWithTmp = parseMysqlTable(sqlTmp).rows.map(r => ({
      query: r[0], db: r[1], execCount: r[2], totalLatency: r[3],
      memoryTmp: r[4], diskTmp: r[5], diskPct: r[6],
    })).filter(s => !isMetadataQuery(s.query, s.db));
  }

  // -------- Schema unused indexes --------
  const unusedIdx = getSection(content, 'Schema unused indexes');
  if (unusedIdx) {
    node.unusedIndexes = parseMysqlTable(unusedIdx).rows.map(r => ({
      schema: r[0], table: r[1], index: r[2],
    }));
  }

  // -------- Schema redundant indexes --------
  const redundantIdx = getSection(content, 'Schema redundant indexes');
  if (redundantIdx) {
    const parsed = parseMysqlTable(redundantIdx);
    node.redundantIndexes = parsed.rows.slice(0, 200).map((r) => {
      const o = rowObject(parsed.headers, r);
      return {
        schema: o.table_schema || r[0],
        table: o.table_name || r[1],
        redundantIndex: o.redundant_index_name || r[2],
        redundantColumns: o.redundant_index_columns || r[3],
        redundantNonUnique: o.redundant_index_non_unique || r[4],
        dominantIndex: o.dominant_index_name || r[5],
        dominantColumns: o.dominant_index_columns || r[6],
        dominantNonUnique: o.dominant_index_non_unique || r[7],
        sqlDrop: o.sql_drop_index || r[9],
      };
    });
  }

  // -------- 锁等待与锁统计 --------
  node.lockCollectionStatus = [
    'INNODB LOCKS',
    'INNODB LOCK WAITS',
    'INNODB TRX',
    'LOCK DETAILS',
    'Metadata locks',
  ].some(name => hasSection(content, name)) ? 'collected' : 'not_collected';
  node.innodbLocks = parseMysqlTable(getSection(content, 'INNODB LOCKS')).rows;
  node.innodbLockWaits = parseMysqlTable(getSection(content, 'INNODB LOCK WAITS')).rows;
  node.innodbLockDetails = parseMysqlTable(getSection(content, 'LOCK DETAILS')).rows;
  node.metadataLocks = parseMysqlTable(getSection(content, 'Metadata locks')).rows;
  const lockCounterTable = parseMysqlTable(getSection(content, 'Lock status counters'));
  node.lockStatusCounters = Object.fromEntries(lockCounterTable.rows.map(r => [r[0], r[1]]));

  // -------- 慢日志 tail --------
  const slowLogStatus = getSection(content, 'Slow query log status');
  if (slowLogStatus) {
    node.slowLogStatus = slowLogStatus.trim();
    // v4.9：从「file size: 12M」/「file size: 2.4G」中提取慢日志文件实际大小（字节）
    const m = slowLogStatus.match(/file size:\s*([\d.]+\s*[KMGT]?B?)/i);
    if (m) node.slowLogSizeBytes = parseHumanSizeToBytes(m[1]);
  }
  const slowLog = getSection(content, 'Slow query log tail');
  if (slowLog) {
    node.slowLogAnalysis = analyzeSlowLog(slowLog);
  }

  // -------- 错误日志 tail --------
  const errLogStatus = getSection(content, 'Error log status');
  if (errLogStatus) {
    node.errorLogStatus = errLogStatus.trim();
    // v4.9：从「file size: 50K」中提取错误日志文件实际大小（字节）
    const m = errLogStatus.match(/file size:\s*([\d.]+\s*[KMGT]?B?)/i);
    if (m) node.errorLogSizeBytes = parseHumanSizeToBytes(m[1]);
  }
  const errLog = getSection(content, 'Error log tail');
  if (errLog) {
    node.errorLogAnalysis = analyzeErrorLog(errLog);
  }

  // -------- 备份信息 --------
  const backupTools = getSection(content, 'Backup tools available');
  if (backupTools) {
    node.backupTools = backupTools.trim().split('\n').filter(l => l.startsWith('[OK]') || l.startsWith('[--]'))
      .map(l => {
        const m = l.match(/^\[(OK|--)\]\s+(\S+):\s*(.*)$/);
        return m ? { tool: m[2], installed: m[1] === 'OK', detail: m[3] } : null;
      })
      .filter(Boolean);
  }
  const cronUserSec = getSection(content, 'Crontab for mysql user');
  if (cronUserSec) {
    node.mysqlCrontab = cronUserSec.trim();
  }
  const cronRootSec = getSection(content, 'Crontab for root');
  if (cronRootSec) {
    node.rootCrontab = cronRootSec.trim();
  }
  const sysCronSec = getSection(content, 'System cron files for backup');
  if (sysCronSec) {
    node.systemCronBackup = sysCronSec.trim();
  }
  const backupDir = getSection(content, 'Backup directory inspection');
  if (backupDir) {
    node.backupDirs = parseBackupDirs(backupDir);
  }
  const binlogDir = getSection(content, 'Binlog directory');
  if (binlogDir) {
    node.binlogDirInfo = stripCollectorBanner(binlogDir).trim();
    // v4.9：从「总大小: 52G」中提取 binlog 目录总大小（字节）
    const m = node.binlogDirInfo.match(/总大小:\s*([\d.]+\s*[KMGT]?B?)/);
    if (m) node.binlogDirSizeBytes = parseHumanSizeToBytes(m[1]);
    // 从「binlog dir: /path」中提取路径，供后续磁盘归因
    const p = node.binlogDirInfo.match(/binlog dir:\s*(\S+)/);
    if (p) node.binlogDirPath = p[1];
  }

  // v4.9：扩展采集段——datadir / relay log 目录大小（collector v3.1+ 提供，老版本采集会缺失）
  const datadirSec = getSection(content, 'Datadir size');
  if (datadirSec) {
    const m = datadirSec.match(/总大小:\s*([\d.]+\s*[KMGT]?B?)/) || datadirSec.match(/([\d.]+\s*[KMGT]?B?)\s/);
    if (m) node.datadirSizeBytes = parseHumanSizeToBytes(m[1]);
    const p = datadirSec.match(/datadir:\s*(\S+)/);
    if (p) node.datadirPath = p[1];
  }
  const relayDirSec = getSection(content, 'Relay log directory');
  if (relayDirSec) {
    const m = relayDirSec.match(/总大小:\s*([\d.]+\s*[KMGT]?B?)/);
    if (m) node.relayLogDirSizeBytes = parseHumanSizeToBytes(m[1]);
    const p = relayDirSec.match(/relay log dir:\s*(\S+)/);
    if (p) node.relayLogDirPath = p[1];
  }

  // -------- 安全配置 --------
  const auditSec = getSection(content, 'Audit plugin status');
  if (auditSec) {
    node.auditPlugin = auditSec.trim();
    node.hasAuditPlugin = /audit/i.test(auditSec);
  }
  const tlsSec = getSection(content, 'TLS / SSL configuration');
  if (tlsSec) {
    const tlsTable = parseMysqlTable(tlsSec);
    const map = {};
    tlsTable.rows.forEach(r => { map[r[0]] = r[1]; });
    node.tlsConfig = map;
  }
  const tlsStatus = getSection(content, 'TLS / SSL status');
  if (tlsStatus) {
    const table = parseMysqlTable(tlsStatus);
    const map = {};
    table.rows.forEach(r => { map[r[0]] = r[1]; });
    node.tlsStatus = map;
  }
  const pwdPolicy = getSection(content, 'Password validation policy');
  if (pwdPolicy || hasSection(content, 'Password validation policy')) {
    node.passwordPolicy = pwdPolicy.trim();
    node.hasPasswordPolicy = /validate_password/i.test(pwdPolicy) && !/未启用/.test(pwdPolicy);
  }
  const encryptSec = getSection(content, 'InnoDB encryption status');
  if (encryptSec || hasSection(content, 'InnoDB encryption status')) {
    node.encryptionStatus = encryptSec.trim();
    node.hasInnodbEncryption = !/未启用/.test(encryptSec) && parseMysqlTable(encryptSec).rows.length > 0;
  }
  const keyringSec = getSection(content, 'Keyring plugin');
  if (keyringSec || hasSection(content, 'Keyring plugin')) {
    node.keyringPlugin = keyringSec.trim();
    node.hasKeyringPlugin = /keyring/i.test(keyringSec || '');
  }
  const emptyPwdSec = getSection(content, 'Users with empty password');
  if (emptyPwdSec || hasSection(content, 'Users with empty password')) {
    node.emptyPasswordUsers = parseMysqlTable(emptyPwdSec).rows.map(r => ({ user: r[0], host: r[1] }));
  }
  const oldAuthSec = getSection(content, 'Users with old auth plugin');
  if (oldAuthSec) {
    node.oldAuthUsers = parseMysqlTable(oldAuthSec).rows.map(r => ({ user: r[0], host: r[1], plugin: r[2] }));
  }
  const failedLoginSec = getSection(content, 'failed login attempts');
  if (failedLoginSec || hasSection(content, 'failed login attempts')) {
    node.failedLogins = parseMysqlTable(failedLoginSec).rows.slice(0, 10).map(r => ({
      ip: r[0], host: r[1], connectErrors: r[2], handshakeErrors: r[3], authErrors: r[4],
    }));
  }
  const sqlModeSec = getSection(content, 'Global SQL_MODE');
  if (sqlModeSec) {
    const m = sqlModeSec.match(/\|\s*([A-Z_,]+)\s*\|/);
    if (m) node.sqlMode = m[1];
  }

  // -------- 客户访谈占位 --------
  const interview = getSection(content, 'interview template');
  if (interview) {
    node.interviewTemplate = interview.trim();
  }

  // -------- auto_increment 高使用率 --------
  const autoIncSec = getSection(content, 'auto_increment usage');
  if (autoIncSec) {
    const table = parseMysqlTable(autoIncSec);
    node.autoIncrementUsage = table.rows.map(r => ({
      schema: r[0], table: r[1], column: r[2],
      autoIncrement: r[3], rate: parseFloat(r[4]) || 0,
    })).filter(x => x.rate > 0.5);
  }

  // 评审反馈 #2：openFilesLimit 优先级 mysqld 进程 limits > MySQL Variables > OS ulimit
  // OS ulimit (1024) 在 mysqld 被 systemd LimitNOFILE 或 ulimit -n 提升后已不再准确
  if (!node.openFilesLimit) {
    const fromVars = Number(node.variables?.open_files_limit);
    if (fromVars) node.openFilesLimit = fromVars;
  }
  if (!node.openFilesLimit) {
    node.openFilesLimit = node.openFilesLimitOs;
  }

  return node;
}

// ============== 慢日志简要分析 ==============
function analyzeSlowLog(text) {
  if (!text || text.trim().length === 0 || /不可读|未启用/.test(text)) {
    return { available: false, reason: '慢日志未启用或不可读' };
  }
  const lines = text.split(/\r?\n/);
  const sqls = [];
  let currentSql = null;
  for (const line of lines) {
    if (line.startsWith('# Time:')) {
      if (currentSql) sqls.push(currentSql);
      currentSql = { time: line.replace('# Time:', '').trim() };
    } else if (line.startsWith('# User@Host:')) {
      if (currentSql) currentSql.userHost = line.replace('# User@Host:', '').trim();
    } else if (line.startsWith('# Query_time:')) {
      if (currentSql) {
        const m = line.match(/Query_time:\s+([\d.]+)\s+Lock_time:\s+([\d.]+)\s+Rows_sent:\s+(\d+)\s+Rows_examined:\s+(\d+)/);
        if (m) {
          currentSql.queryTime = parseFloat(m[1]);
          currentSql.lockTime = parseFloat(m[2]);
          currentSql.rowsSent = Number(m[3]);
          currentSql.rowsExamined = Number(m[4]);
        }
      }
    } else if (line.startsWith('use ')) {
      if (currentSql) currentSql.db = line.replace('use ', '').replace(';', '').trim();
    } else if (line.startsWith('SET timestamp=')) {
      // ignore
    } else if (currentSql && !line.startsWith('#') && line.trim()) {
      currentSql.sql = (currentSql.sql || '') + ' ' + line.trim();
    }
  }
  if (currentSql) sqls.push(currentSql);

  // 排序：按 query_time 取 TOP 20
  const valid = sqls.filter(s => s.queryTime != null && s.sql);
  valid.sort((a, b) => b.queryTime - a.queryTime);
  const top = valid.slice(0, 20).map(s => ({
    time: s.time,
    userHost: s.userHost,
    queryTime: s.queryTime,
    lockTime: s.lockTime,
    rowsSent: s.rowsSent,
    rowsExamined: s.rowsExamined,
    db: s.db,
    sql: (s.sql || '').trim().slice(0, 400),
  }));

  // 简单统计
  const stats = {
    available: true,
    totalEntries: valid.length,
    maxQueryTime: valid[0]?.queryTime || 0,
    avgQueryTime: valid.length > 0 ? valid.reduce((a, b) => a + b.queryTime, 0) / valid.length : 0,
    maxRowsExamined: Math.max(...valid.map(s => s.rowsExamined || 0)),
    timeSpan: valid.length > 1 ? `${valid[valid.length-1].time} ~ ${valid[0].time}` : '-',
    top,
  };
  return stats;
}

// ============== 错误日志分析 ==============
function analyzeErrorLog(text) {
  if (!text || text.trim().length === 0 || /不可读|未启用/.test(text)) {
    return { available: false, reason: '错误日志不可读' };
  }
  const lines = text.split(/\r?\n/);
  const errors = [];
  const warnings = [];
  const startupEvents = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    if (/\[ERROR\]/.test(line) || /\bERROR\b/.test(line) && !/\[Note\]/i.test(line)) {
      errors.push(line);
    } else if (/\[Warning\]/i.test(line) || /\bWarning\b/.test(line) && !/\[Note\]/i.test(line)) {
      warnings.push(line);
    } else if (/ready for connections|shutdown|starting|aborted|crash/i.test(line)) {
      startupEvents.push(line);
    }
  }

  return {
    available: true,
    totalLines: lines.length,
    errorCount: errors.length,
    warningCount: warnings.length,
    errors: errors.slice(-20),       // 最后 20 条
    warnings: warnings.slice(-10),
    startupEvents: startupEvents.slice(-20),
  };
}

// ============== 备份目录解析 ==============
// 评审 #9 (v4.4) 修复：原逻辑遇到 "[--] /path 不存在" 时会**覆盖** current 指针，
// 导致前一个正在累积的目录（含真实备份文件）被丢弃。
// 实测影响：172.16.7.4 节点 /data/backup 下有 93GB 真实备份产物
// （tbl_order_detail_20240729.sql 48GB / tbl_order_20240724.sql 13GB /
// tbl_topup_20240718.sql 36GB），但报告显示"未发现备份产物"。
// 修复策略：碰到不存在行时先 flush 已累积的 current，再 push exists:false 条目。
function parseBackupDirs(text) {
  const dirs = [];
  let current = null;
  const flushCurrent = () => {
    if (current) {
      dirs.push(current);
      current = null;
    }
  };
  for (const line of text.split(/\r?\n/)) {
    // header 形式：===== /path =====
    const headMatch = line.match(/^=====\s+(.+?)\s+=====$/);
    if (headMatch) {
      flushCurrent();
      current = { path: headMatch[1], exists: true, totalSize: '-', files: [] };
      continue;
    }
    // 不存在行：[--] /path 不存在
    const notExistMatch = line.match(/\[--\]\s+(\S+)\s+不存在/);
    if (notExistMatch) {
      flushCurrent();   // 先保留前一个正在累积的目录
      dirs.push({ path: notExistMatch[1], exists: false, totalSize: '-', files: [] });
      continue;
    }
    if (!current) continue;
    const sizeMatch = line.match(/^总大小:\s*(.+)$/);
    if (sizeMatch) current.totalSize = sizeMatch[1].trim();
    // 文件行：YYYY-MM-DD+HH:MM:SS BYTES /path
    const fileMatch = line.match(/^(\d{4}-\d{2}-\d{2}\+[\d:.]+)\s+(\d+)\s+(.+)$/);
    if (fileMatch) {
      current.files.push({
        mtime: fileMatch[1].replace('+', ' '),
        bytes: Number(fileMatch[2]),
        path: fileMatch[3],
      });
    }
  }
  flushCurrent();
  return dirs;
}

function parseDiskMount(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('Filesystem'));
  const disks = [];
  let pending = null;
  for (const line of lines) {
    const cols = line.trim().split(/\s+/);
    if (cols.length === 1 && line.startsWith('/')) {
      pending = cols[0];
      continue;
    }
    let fs0, total, used, avail, usePct, mount;
    if (pending) {
      [total, used, avail, usePct, mount] = cols;
      fs0 = pending;
      pending = null;
    } else if (cols.length >= 6) {
      [fs0, total, used, avail, usePct, mount] = cols;
    } else {
      continue;
    }
    if (!/^\d/.test(total)) continue;
    disks.push({
      filesystem: fs0,
      total, used, avail,
      usePct: usePct,
      mount,
    });
  }
  return disks;
}

function parseVariables(text) {
  const result = {};
  text.split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*(@@global\.)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/);
    if (m) {
      const key = m[2];
      result[key] = normalizeVarValue(m[3].trim());
    }
  });
  return result;
}

// 规范化变量值：
// - 纯小数 "40960.00000000" → "40960"
// - 含意义的小数 "1.500000" → "1.5"
// - 非数值 "ROW" / "O_DIRECT" 原样返回
function normalizeVarValue(v) {
  if (v == null) return v;
  const s = String(v).trim();
  if (/^-?\d+\.\d+$/.test(s)) {
    const n = parseFloat(s);
    if (Number.isNaN(n)) return s;
    // 整数值
    if (Number.isInteger(n)) return String(n);
    // 保留有效小数，最多 6 位
    return n.toString();
  }
  return s;
}

function parseReplication(text) {
  const result = { isSlave: false, slaves: [], status: {} };
  // Master 节点：列出 Slave_UUID
  const mGroup = text.match(/Server_id\s*\|\s*Host[\s\S]*?(\+[-+]+\+\s*$)/m);
  if (text.includes('Slave_UUID')) {
    const parsed = parseMysqlTable(text);
    if (parsed.headers.includes('Slave_UUID')) {
      result.connectedSlaves = parsed.rows.length;
    }
  }
  // slave IP 提示
  const slaveIpMatch = text.match(/slave IP is\s*:\s*([\d.\s]+)/);
  if (slaveIpMatch) {
    result.slaveIps = slaveIpMatch[1].trim().split(/\s+/);
  }
  // 从库：SHOW SLAVE STATUS \G 输出
  const ssMatch = text.match(/Slave_IO_State:[\s\S]*?Master_Server_Id:\s*\d+/);
  if (ssMatch) {
    result.isSlave = true;
    const block = ssMatch[0];
    const grab = (k) => {
      const m = block.match(new RegExp(`\\b${k}:\\s*(.+)`));
      return m ? m[1].trim() : null;
    };
    result.status = {
      masterHost: grab('Master_Host'),
      masterPort: grab('Master_Port'),
      masterLogFile: grab('Master_Log_File'),
      readMasterLogPos: grab('Read_Master_Log_Pos'),
      relayMasterLogFile: grab('Relay_Master_Log_File'),
      slaveIoRunning: grab('Slave_IO_Running'),
      slaveSqlRunning: grab('Slave_SQL_Running'),
      lastIoError: grab('Last_IO_Error'),
      lastSqlError: grab('Last_SQL_Error'),
      secondsBehindMaster: grab('Seconds_Behind_Master'),
      masterUuid: grab('Master_UUID'),
      retrievedGtidSet: grab('Retrieved_Gtid_Set'),
      executedGtidSet: grab('Executed_Gtid_Set'),
      autoPosition: grab('Auto_Position'),
      slaveSqlRunningState: grab('Slave_SQL_Running_State'),
    };
  }
  return result;
}

// v4.5 评审：节点 IP/hostname 已知后，对 self-referencing slave（残留配置）做后处理
// 场景：MySQL 节点曾经是从库，后来被提升为主，但 STOP SLAVE / RESET SLAVE ALL 未执行，
// SHOW SLAVE STATUS 仍返回 Master_Host = 本机 IP（或本机 hostname），实际并没有真的在做复制。
// 此前 parseReplication 把 isSlave=true，导致 normalizeNodeRoles 把它错标成 'slave'。
// 修复：识别后把 isSlave=false 并保留 selfReferencingSlaveResidue 标识，供后续告警引用。
function refineSelfReferencingSlave(node) {
  if (!node.replication?.isSlave) return;
  const masterHost = node.replication.status?.masterHost || '';
  if (!masterHost) return;
  const selfIp = node.ip || '';
  const selfHostname = (node.hostname || '').toLowerCase();
  const masterLower = masterHost.toLowerCase();
  const isSelf =
    (selfIp && masterHost === selfIp) ||
    (selfHostname && (masterLower === selfHostname || masterLower === selfHostname.split('.')[0])) ||
    masterLower === 'localhost' || masterLower === '127.0.0.1' || masterLower === '::1';
  if (!isSelf) return;
  node.replication.isSlave = false;
  node.replication.selfReferencingSlaveResidue = {
    masterHost,
    slaveIoRunning: node.replication.status?.slaveIoRunning || null,
    slaveSqlRunning: node.replication.status?.slaveSqlRunning || null,
    hint: '检测到 SHOW SLAVE STATUS 残留指向本机自身，可能是历史从库提升为主后未执行 RESET SLAVE ALL；不视为真从库。',
  };
}

function inferRoleFromHostname(hostname) {
  return canonicalRole(hostname);
}

function parseInnodbStatus(text) {
  const result = {};
  const grab = (re) => { const m = text.match(re); return m ? m[1] : null; };
  result.historyListLength = grab(/History list length\s+(\d+)/);
  result.logSequenceNumber = grab(/Log sequence number\s+(\d+)/);
  result.logFlushedUpTo = grab(/Log flushed up to\s+(\d+)/);
  result.bufferPoolSize = grab(/^Buffer pool size\s+(\d+)/m);
  result.freeBuffers = grab(/^Free buffers\s+(\d+)/m);
  result.databasePages = grab(/^Database pages\s+(\d+)/m);
  result.modifiedDbPages = grab(/^Modified db pages\s+(\d+)/m);
  result.bufferPoolHitRate = grab(/Buffer pool hit rate\s+(\d+\s*\/\s*\d+)/);
  const pagesMatch = text.match(/Pages read (\d+), created (\d+), written (\d+)/);
  if (pagesMatch) {
    result.pagesRead = pagesMatch[1];
    result.pagesCreated = pagesMatch[2];
    result.pagesWritten = pagesMatch[3];
  }
  // 最近死锁
  const deadlockMatch = text.match(/LATEST DETECTED DEADLOCK\s*\n[-=]+\s*\n([\s\S]*?)(?=\n[-=]{3,}\n|\Z)/);
  result.latestDeadlock = deadlockMatch ? deadlockMatch[1].trim().slice(0, 500) : null;
  // 活跃事务（非 "not started"）
  const activeTrx = [];
  const trxRe = /---TRANSACTION\s+(\d+),\s+(?!not started)([^\n]+)\n([\s\S]*?)(?=---TRANSACTION|\nTRANSACTIONS|\n--END)/g;
  let m;
  while ((m = trxRe.exec(text)) !== null) {
    activeTrx.push({ id: m[1], state: m[2].trim(), detail: m[3].trim().slice(0, 200) });
    if (activeTrx.length >= 10) break;
  }
  result.activeTransactions = activeTrx;
  return result;
}

// ============== html 解析（用于 ibtmp1 精确大小） ==============
function parseHtml(filepath) {
  const content = fs.readFileSync(filepath, 'utf-8');
  const result = { _file: path.basename(filepath) };

  // 找到 ibtmp1 所在的 <tr>，列序按 innodb_sys_tablespaces 表头
  // 表头列出：FILE_ID, FILE_NAME, FILE_TYPE, TABLESPACE_NAME, ... DATA_FREE (倒数第几位)
  const ibtmpRow = content.match(/<tr>([^<]*<td>[^<]*<\/td>)*[^<]*<td>[^<]*ibtmp1[^<]*<\/td>([\s\S]*?)<\/tr>/);
  if (ibtmpRow) {
    const row = ibtmpRow[0];
    const cells = [...row.matchAll(/<td>([^<]*)<\/td>/g)].map(m => m[1]);
    // FILE_ID, FILE_NAME, FILE_TYPE, TABLESPACE_NAME, TABLE_CATALOG, TABLE_SCHEMA, TABLE_NAME,
    // LOGFILE_GROUP_NAME, LOGFILE_GROUP_NUMBER, ENGINE, FULLTEXT_KEYS, DELETED_ROWS,
    // UPDATE_COUNT, FREE_EXTENTS, TOTAL_EXTENTS, EXTENT_SIZE, INITIAL_SIZE, MAXIMUM_SIZE,
    // AUTOEXTEND_SIZE, CREATION_TIME, LAST_UPDATE_TIME, LAST_ACCESS_TIME, RECOVER_TIME,
    // TRANSACTION_COUNTER, VERSION, ROW_FORMAT, TABLE_ROWS, AVG_ROW_LENGTH, DATA_LENGTH,
    // MAX_DATA_LENGTH, INDEX_LENGTH, DATA_FREE, CREATE_TIME, UPDATE_TIME, CHECK_TIME, CHECKSUM, STATUS, EXTRA
    if (cells.length >= 32) {
      const totalExtents = Number(cells[14]) || 0;
      const extentSize = Number(cells[15]) || 0;
      const initialSize = Number(cells[16]) || 0;
      const autoExtendSize = Number(cells[18]) || 0;
      const dataFreeBytes = Number(cells[31]) || 0;
      // 实际文件大小 = total_extents × extent_size（更准确）
      const fileBytes = totalExtents && extentSize ? totalExtents * extentSize : dataFreeBytes;
      result.ibtmp1 = {
        sizeBytes: fileBytes,
        dataFreeBytes,
        sizeFormatted: fmtBytes(fileBytes),
        initialSize: fmtBytes(initialSize),
        autoExtendSize: fmtBytes(autoExtendSize),
        source: 'html:innodb_tablespaces',
      };
    }
  }
  return result;
}

// ============== 文件扫描与节点识别 ==============
function inferRole(filename) {
  return canonicalRole(filename);
}

function canonicalRole(value) {
  if (!value) return null;
  const lower = String(value).toLowerCase();
  if (/pri|master|primary/.test(lower)) return 'primary';
  // DR 灾备节点：hostname/文件名含 dr-/dr_/disaster/standby/backup-
  if (/^dr[-_]|[-_]dr[-_]|disaster|standby|backup[-_]?(mysql|db)/.test(lower)) return 'dr';
  if (/slave|replica/.test(lower)) return 'slave';
  return null;
}

// 判定节点是否为 DR 灾备角色（综合 hostname + 文件名）
function isDrNode(node) {
  if (node.role === 'dr') return true;
  const hint = (node.hostname || '') + ' ' + (node._file || '');
  return /\bdr[-_]|disaster|standby/i.test(hint);
}

// 评审反馈 #5/#17 (v4.4)：元数据查询识别（用于过滤 SQL 治理章节噪声）
// 这些查询来自 mysql 客户端 / Navicat / 监控工具，不是业务 SQL，
// 之前在 14.4「全表扫描」/14.5「使用临时表」TOP 列表里挤占了真实业务慢 SQL 的位置。
function isMetadataQuery(queryText, dbName) {
  if (!queryText) return false;
  const q = String(queryText).trim();
  // 1. SHOW / DESC / EXPLAIN 类元数据查询
  if (/^(SHOW|DESC|DESCRIBE|EXPLAIN)\s/i.test(q)) return true;
  // 2. 直接访问系统库（information_schema / performance_schema / mysql / sys）
  if (/\b(information_schema|performance_schema|mysql\.|sys\.)/i.test(q)) return true;
  // 3. DB 为 NULL 且查询是元数据探测（如 SELECT NOW(), SYSTEM_USER()）
  if ((dbName == null || dbName === 'NULL' || dbName === '') && /^SELECT\s+(NOW|SYSTEM_USER|VERSION|DATABASE|USER|CURRENT_USER|CONNECTION_ID)\s*\(/i.test(q)) return true;
  // 4. SET / USE 类会话控制语句
  if (/^(SET|USE|RESET)\s/i.test(q)) return true;
  // 5. 单独的事务控制语句
  if (/^(COMMIT|ROLLBACK|BEGIN|START\s+TRANSACTION)\s*$/i.test(q)) return true;
  return false;
}

// 评审反馈 #7 + #4 (v4.4)：临时 / 历史 / 备份 / 工具表识别（用于过滤无主键告警噪声）
// 评审 v4.4 #4 扩展：dd/pp/t_year 等被误判为业务表，需要识别为工具/字典表
function isTempOrHistoryTable(tableName) {
  if (!tableName) return false;
  const t = String(tableName);
  // 1. 极短可疑表名（≤3 字符，含 1-2 位数字后缀的，常见于测试残留：dd, pp, pp1, t, t1, t12, abc1）
  if (/^[a-z]{1,3}\d{0,2}$/i.test(t)) return true;
  // 1b. 单独的 test 表（pioneer_db.test 之类的）
  if (/^test\d*$/i.test(t)) return true;
  // 2. 日期 / 时间字典表（t_year/t_month/calendar 等业务工具表）
  if (/^t_(year|month|day|date|hour|minute|second|calendar|bit|byte)([_0-9]|$)/i.test(t)) return true;
  if (/^(calendar|dim_date|dim_time|date_dim|time_dim|nums|numbers|sequence)$/i.test(t)) return true;
  // 3. 临时表前后缀 / 中缀
  if (/^tmp[_0-9]|^temp[_0-9]|^test[_0-9]/i.test(t)) return true;
  if (/_tmp\d*$|_temp\d*$|_test\d*$/i.test(t)) return true;
  if (/_temp_|_tmp_|_test_/i.test(t)) return true;
  // 4. 备份表
  if (/_bak$|_bak[_0-9]|_backup$|_backup[_0-9]|_old$|_old[_0-9]/i.test(t)) return true;
  // 5. 日期后缀（_20230101 / _202301 / _2023-01）
  if (/_\d{8}$|_\d{6}$|_\d{4}-\d{2}/.test(t)) return true;
  // 6. gh-ost / pt-osc 中间表
  if (/^_gho_|^_ghc_|^_(gho|ghc|del)_/i.test(t)) return true;
  // 7. copy / new / old 副本
  if (/_(copy|copy\d+|new\d*|old\d*)$/i.test(t)) return true;
  return false;
}

// 评审反馈 #10：gh-ost / pt-osc 在线 DDL 残留 ghost 表识别
function isGhostTable(tableName) {
  if (!tableName) return false;
  const t = String(tableName);
  return /^_gho_|^_ghc_|^_(gho|ghc|del)_/i.test(t)                  // gh-ost 中间表
      || /^_.*_new$|^_.*_old$/i.test(t)                              // pt-osc 通用模式
      || (/^_[a-z]/i.test(t) && t.length > 4);                       // 任何以 _ 开头的表（保守识别 — render 时仅在大表中提醒）
}

function inferPrimaryFromConnections(node) {
  if ((node.replication?.slaveIps || []).length > 0) return true;
  if (Number(node.replication?.connectedSlaves || 0) > 0) return true;
  return (node.processlist || []).some((proc) => {
    const command = String(proc.command || '').toLowerCase();
    const user = String(proc.user || '').toLowerCase();
    return user === 'repl' && command.includes('binlog dump');
  });
}

// v4.5：standalone primary 兑底识别 — 用于单节点采集 / 主库无从库连接的场景
// 优先级（从强到弱）：
//   ① 有 Binlog Dump 线程（已被 inferPrimaryFromConnections 覆盖）
//   ② Slave_UUID 表非空（同上）
//   ③ self-referencing slave 残留（已 refineSelfReferencingSlave 标记）
//   ④ log_bin 启用 + 无远端 Master_Host + 不是 isSlave  → standalone primary
//   ⑤ read_only=0 + 无远端 Master_Host                  → standalone primary (无 binlog 也算)
//   ⑥ read_only=1 + 无远端 Master_Host + log_bin 启用  → standalone primary（只读主，加 needsConfirmation）
function inferStandalonePrimary(node) {
  if (node.replication?.isSlave) return null;   // 真从库直接退出
  const v = node.variables || {};
  const hasLogBin = !!(v.log_bin && v.log_bin !== 'OFF' && v.log_bin !== '0');
  const readOnly = String(v.read_only ?? v.super_read_only ?? '').trim();
  // ④ + ⑤
  if (readOnly === '0' || readOnly === 'OFF') return { role: 'primary', source: 'standalone_rw' };
  // ⑥ 只读但有 binlog → 只读主（zabbix/报表库典型）
  if ((readOnly === '1' || readOnly === 'ON') && hasLogBin) {
    return { role: 'primary', source: 'standalone_readonly', needsConfirmation: true };
  }
  // 其它情况让上层兜底
  return null;
}

function normalizeNodeRoles(nodes) {
  for (const node of nodes) {
    // 评审 #2 (v4.4)：优先识别 dr 灾备角色（基于 hostname / 文件名），
    // 否则后续的 isSlave 判断会把 dr 误标为 'slave'，导致第二章 / 第十二章渲染错误。
    if (isDrNode(node)) {
      node.role = 'dr';
      continue;
    }
    // v4.5：有 Binlog Dump / connected slaves / slaveIps 等强信号 → primary（即使存在 self-loop 残留）
    if (inferPrimaryFromConnections(node)) {
      node.role = 'primary';
      continue;
    }
    if (node.role && node.role !== 'unknown') {
      node.role = canonicalRole(node.role) || node.role;
      continue;
    }
    if (node.replication?.isSlave) {
      node.role = 'slave';
      continue;
    }
    const hostRole = inferRoleFromHostname(node.hostname);
    if (hostRole) {
      node.role = hostRole;
      continue;
    }
    // v4.5：兑底识别 standalone primary（read_only + log_bin 信号）
    const standalone = inferStandalonePrimary(node);
    if (standalone) {
      node.role = standalone.role;
      node.roleInference = {
        source: standalone.source,
        needsConfirmation: !!standalone.needsConfirmation,
      };
      continue;
    }
    node.role = 'unknown';
  }

  let primary = nodes.find((node) => node.role === 'primary');
  if (!primary) {
    primary = nodes.find((node) => !node.replication?.isSlave && inferPrimaryFromConnections(node));
    if (primary) primary.role = 'primary';
  }

  if (primary) {
    for (const node of nodes) {
      if (node !== primary && node.replication?.isSlave) {
        // 保留已识别的 dr 角色（评审 #2 v4.4），仅把未分类的 isSlave 节点标为 slave
        if (node.role !== 'dr') {
          node.role = 'slave';
        }
      }
    }
  }

  // v4.5：单节点采集场景，确保 role 不是 unknown（兜底为 primary 并标 needsConfirmation）
  if (nodes.length === 1 && nodes[0].role === 'unknown') {
    nodes[0].role = 'primary';
    nodes[0].roleInference = { source: 'single_node_fallback', needsConfirmation: true };
  }
}

function sortNodesPrimaryFirst(nodes) {
  nodes.sort((a, b) => {
    if (a.role === 'primary' && b.role !== 'primary') return -1;
    if (b.role === 'primary' && a.role !== 'primary') return 1;
    return ipSortKey(a.ip).localeCompare(ipSortKey(b.ip));
  });
}

function ipSortKey(ip) {
  return String(ip || '').split('.').map(p => String(Number(p) || 0).padStart(3, '0')).join('.');
}

function inferIpFromFilename(filename) {
  const m = filename.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
  return m ? m[1] : null;
}

function inferInspectionDate(filename) {
  // MySQLHealthCheck_172.16.7.2_202604301023.txt → 2026-04-30
  // 172.16.7.2_apple_pri-2026-04-30.html → 2026-04-30
  const m1 = filename.match(/_(\d{4})(\d{2})(\d{2})\d{4}\.txt$/);
  if (m1) return `${m1[1]}-${m1[2]}-${m1[3]}`;
  const m2 = filename.match(/(\d{4})-(\d{2})-(\d{2})\.html$/);
  if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
  return null;
}

function inferProjectFromFilename(filename) {
  // 172.16.7.2_apple_pri-2026-04-30.html → apple
  const m = filename.match(/\d+\.\d+\.\d+\.\d+_([^_-]+)[_-]/);
  return m ? m[1] : null;
}

// 主流程
function main() {
  const allFiles = fs.readdirSync(dataDir);
  const txtFiles = allFiles.filter(f => /^MySQLHealthCheck_.*\.txt$/i.test(f));
  const htmlFiles = allFiles.filter(f => /\.html$/i.test(f));

  if (txtFiles.length === 0) {
    console.error(`错误：${dataDir} 下未找到 MySQLHealthCheck_*.txt 文件`);
    process.exit(1);
  }

  // 推断项目名 / 日期
  let project = opts.project;
  let inspectionDate = null;
  for (const f of [...htmlFiles, ...txtFiles]) {
    if (!project) {
      const p = inferProjectFromFilename(f);
      if (p) project = p;
    }
    if (!inspectionDate) {
      const d = inferInspectionDate(f);
      if (d) inspectionDate = d;
    }
  }
  if (!project) project = '未命名项目';
  if (!inspectionDate) inspectionDate = new Date().toISOString().slice(0, 10);

  // 按 IP 聚合 txt + html
  const byIp = {};
  for (const f of txtFiles) {
    const ip = inferIpFromFilename(f);
    if (!ip) continue;
    byIp[ip] = byIp[ip] || { ip };
    byIp[ip].txt = path.join(dataDir, f);
  }
  for (const f of htmlFiles) {
    const ip = inferIpFromFilename(f);
    if (!ip) continue;
    byIp[ip] = byIp[ip] || { ip };
    byIp[ip].html = path.join(dataDir, f);
    byIp[ip].role = byIp[ip].role || inferRole(f);
  }

  // 解析每个节点
  const nodes = [];
  for (const ip of Object.keys(byIp).sort()) {
    const entry = byIp[ip];
    console.error(`解析节点 ${ip} ...`);
    const data = {
      ip,
      role: canonicalRole(entry.role || inferRole(entry.txt || '')) || 'unknown',
    };
    if (entry.txt) Object.assign(data, parseTxt(entry.txt));
    if (entry.html) Object.assign(data, parseHtml(entry.html));
    // v4.5：在 ip / hostname 都已知后，对 self-referencing slave 残留做后处理（必须在 normalizeNodeRoles 前）
    refineSelfReferencingSlave(data);
    data.role = canonicalRole(data.role) || inferRoleFromHostname(data.hostname) || data.role || 'unknown';
    nodes.push(data);
  }

  normalizeNodeRoles(nodes);
  sortNodesPrimaryFirst(nodes);

  // v4.9：计算每节点的磁盘归因（binlog / slow log / error log / relay log / ibtmp1 各占多少）
  // 用于「磁盘高位」类根因关联给出明确主因，而不是模糊地说「可能是 binlog」
  for (const n of nodes) {
    const parts = {};
    if (n.binlogDirSizeBytes) parts.binlog = n.binlogDirSizeBytes;
    if (n.slowLogSizeBytes) parts.slowLog = n.slowLogSizeBytes;
    if (n.errorLogSizeBytes) parts.errorLog = n.errorLogSizeBytes;
    if (n.relayLogDirSizeBytes) parts.relayLog = n.relayLogDirSizeBytes;
    if (n.ibtmp1?.sizeBytes) parts.ibtmp1 = n.ibtmp1.sizeBytes;
    if (n.datadirSizeBytes) parts.datadir = n.datadirSizeBytes;
    const total = Object.values(parts).reduce((s, v) => s + v, 0);
    n.diskAttribution = {
      parts,
      totalBytes: total,
      // 排序后的明细，便于 render 端直接展示
      top: Object.entries(parts)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => ({ kind: k, bytes: v, pct: total > 0 ? (v / total) : null })),
    };
  }

  // ============== 自动分析与问题清单 ==============
  let issues = analyzeIssues(nodes);
  const backupAssessment = assessBackup(nodes);
  const securityAssessment = assessSecurity(nodes);
  // 把备份评估 / 安全合规检查中的严重项升级到 issues[]（Codex #4）
  issues = promoteAssessmentIssues(issues, backupAssessment, securityAssessment, nodes.length);
  const correlations = deriveCorrelations(nodes, issues);
  const paramJudgments = deriveParamDiffJudgments(nodes);
  const healthScore = computeHealthScore(nodes, issues);

  // ============== 构造输出 ==============
  const out = {
    schemaVersion: 3,
    project,
    reportVersion: opts.reportVersion,
    inspectionDate,
    reportDate: new Date().toISOString().slice(0, 10),
    cluster: {
      name: project,
      topology: deriveTopology(nodes),
      nodeCount: nodes.length,
      ips: nodes.map(n => n.ip),
    },
    healthScore,
    overallAssessment: deriveOverallAssessment(issues, healthScore),
    issues,
    correlations,
    paramJudgments,
    backupAssessment,
    securityAssessment,
    nodes,
    recommendations: deriveRecommendations(nodes, issues),
    // v4.8：把合并后的阈值配置 + 已禁用规则透出，供 render 渲染附录 + 调试
    hcConfig: {
      thresholds: hcConfig.thresholds,
      priorities: hcConfig.priorities,
      disabledRules: hcConfig.disabledRules,
      sources: hcConfig._sources,
    },
    disabledRulesApplied: hcConfig.disabledRules,
  };

  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.error(`\n数据已写入 ${outPath}`);
  console.error(`  - 节点：${nodes.length} 个`);
  console.error(`  - 自动检出问题：${issues.length} 项 (P0:${issues.filter(i => i.priority === 'P0').length}, P1:${issues.filter(i => i.priority === 'P1').length}, P2:${issues.filter(i => i.priority === 'P2').length}, P3:${issues.filter(i => i.priority === 'P3').length})`);
  if (hcConfig._sources && hcConfig._sources.length > 1) {
    const overrides = hcConfig._sources.filter(s => s.source !== 'default').map(s => `${s.source}:${path.basename(s.path)}`).join(', ');
    console.error(`  - 阈值配置：${overrides} 已合并到默认值之上`);
  }
  if (hcConfig.disabledRules && hcConfig.disabledRules.length > 0) {
    console.error(`  - 已禁用规则：${hcConfig.disabledRules.join(', ')}`);
  }
  console.error(`\n下一步：必要时手工编辑 ${path.basename(outPath)}（补充项目名/重要问题判断），然后运行 render.js。`);
}

// ============== 拓扑推断 ==============
function deriveTopology(nodes) {
  const primary = nodes.find(n => n.role === 'primary');
  const slaves = nodes.filter(n => n.role !== 'primary');
  if (primary && slaves.length > 0) {
    return `一主${slaves.length}从（异步复制）`;
  }
  if (nodes.length === 1) return '单节点';
  return '集群';
}

// ============== 整体评价 ==============
function deriveOverallAssessment(issues, healthScore) {
  const p0 = issues.filter(i => i.priority === 'P0').length;
  const p1 = issues.filter(i => i.priority === 'P1').length;
  const scoreText = healthScore ? `（健康度评分 ${healthScore.total}/100）` : '';
  if (p0 > 0) return '存在紧急风险，需立即处理' + scoreText;
  if (p1 > 0) return '总体平稳，存在需短期处理的重点问题' + scoreText;
  if (issues.length > 0) return '运行平稳，存在建议优化项' + scoreText;
  return '运行平稳，未发现明显问题' + scoreText;
}

// ============== 健康度评分 ==============
// 6 维度：可用性、安全性、性能、数据规范、持久化、运维规范
function computeHealthScore(nodes, issues) {
  const dim = {
    availability: 100,   // 可用性（复制、磁盘、节点状态）
    security: 100,       // 安全（账号、加密、审计）
    performance: 100,    // 性能（命中率、慢查询、IO）
    dataDesign: 100,     // 数据规范（主键、字符集、索引）
    durability: 100,     // 持久化（sync_binlog、flush_log、GTID）
    operations: 100,     // 运维（备份、监控、变更）
  };

  for (const i of issues) {
    const penalty = { P0: 18, P1: 7, P2: 3, P3: 1 }[i.priority] || 0;
    // v4.8：优先用显式 dimension 字段；旧规则没设则回退到 type 正则映射（零行为变化）
    let dimKey = i.dimension;
    if (!dimKey) {
      const t = i.type || '';
      if (/disk|repl_thread|repl_delay|mem_high/.test(t)) dimKey = 'availability';
      else if (/wildcard|empty_password|old_auth|pwd_|tls_weak/.test(t)) dimKey = 'security';
      else if (/slow|bp_hit|long_query|sql_|hll|long_running_session/.test(t)) dimKey = 'performance';
      else if (/no_pk|non_utf8|heavy_frag|unused_index|redundant_index|lct_/.test(t)) dimKey = 'dataDesign';
      else if (/flush_log|sync_binlog|gtid|ibtmp1|swap|master_readonly|slave_writable|expire_logs/.test(t)) dimKey = 'durability';
      else if (/param_inconsistent|backup|slow_log_off|os_version/.test(t)) dimKey = 'operations';
    }
    if (dimKey && dim[dimKey] != null) {
      dim[dimKey] -= penalty;
    } else {
      dim.availability -= penalty / 2;
    }
  }

  // 备份维度：没备份 / 没备份工具 → 重扣
  const hasBackupTool = nodes.some(n => (n.backupTools || []).some(t => t.installed && /xtrabackup|mysqldump|mariabackup/.test(t.tool)));
  const hasBackupDir = nodes.some(n => (n.backupDirs || []).some(d => d.files && d.files.length > 0));
  if (!hasBackupTool) dim.operations -= 15;
  if (!hasBackupDir) dim.operations -= 15;
  const hasBackupCron = nodes.some(n => /mysql|backup|dump/i.test(n.mysqlCrontab || '') || /mysql|backup|dump/i.test(n.rootCrontab || '') || /mysql|backup|dump/i.test(n.systemCronBackup || ''));
  if (!hasBackupCron && (hasBackupDir || hasBackupTool)) dim.operations -= 5;

  // 安全维度：加密 / TLS / 审计 缺失各扣
  const hasEncryption = nodes.some(n => n.hasInnodbEncryption);
  const hasTls = nodes.some(n => n.tlsConfig?.have_ssl === 'YES');
  const hasAudit = nodes.some(n => n.hasAuditPlugin);
  if (!hasEncryption) dim.security -= 5;
  if (!hasTls) dim.security -= 5;
  if (!hasAudit) dim.security -= 3;

  // clamp 0-100
  for (const k of Object.keys(dim)) {
    dim[k] = Math.max(0, Math.min(100, Math.round(dim[k])));
  }

  // 总分：加权平均
  const weights = {
    availability: 0.25, security: 0.15, performance: 0.20,
    dataDesign: 0.10, durability: 0.20, operations: 0.10,
  };
  let total = 0;
  for (const k of Object.keys(dim)) total += dim[k] * weights[k];
  total = Math.round(total);

  return { total, dimensions: dim };
}

// ============== 备份能力评估 ==============
function assessBackup(nodes) {
  const items = [];
  const tools = new Map();
  for (const n of nodes) {
    for (const t of (n.backupTools || [])) {
      if (!tools.has(t.tool)) tools.set(t.tool, { tool: t.tool, installed: t.installed, detail: t.detail });
    }
  }
  const result = {
    tools: [...tools.values()],
    hasTool: [...tools.values()].some(t => t.installed && /xtrabackup|mysqldump|mariabackup/.test(t.tool)),
    crontabs: nodes.map(n => ({
      ip: n.ip,
      mysqlUser: n.mysqlCrontab || '',
      rootUser: (n.rootCrontab || '').slice(0, 500),
      system: (n.systemCronBackup || '').slice(0, 1000),
    })),
    dirs: [],
    latestBackup: null,
    binlogs: nodes.map(n => ({ ip: n.ip, info: n.binlogDirInfo || '' })),
    hintPaths: [],
  };
  let latestTime = 0;
  for (const n of nodes) {
    for (const d of (n.backupDirs || [])) {
      result.dirs.push({ ip: n.ip, ...d });
      for (const f of (d.files || [])) {
        const t = new Date(f.mtime.replace(' ', 'T')).getTime();
        if (t > latestTime) {
          latestTime = t;
          result.latestBackup = { ip: n.ip, path: f.path, mtime: f.mtime, sizeBytes: f.bytes };
        }
      }
    }
  }
  // 评估
  result.hasBackupArtifact = result.dirs.some(d => d.files && d.files.length > 0);
  result.hasScheduledBackup = result.crontabs.some(c =>
    /mysql|backup|dump|xtrabackup/i.test(c.mysqlUser) ||
    /mysql|backup|dump|xtrabackup/i.test(c.rootUser) ||
    /mysql|backup|dump|xtrabackup/i.test(c.system)
  );
  result.hintPaths = collectBackupHintPaths(nodes, result.dirs);

  // 给出综合评估
  if (!result.hasTool) {
    result.assessment = '未检测到 mysqldump / xtrabackup / mariabackup 等备份工具';
    result.severity = 'P0';
  } else if (!result.hasBackupArtifact && result.hasScheduledBackup) {
    result.assessment = '检测到备份调度，但在已扫描目录未发现备份产物，需核实施路径或远端存储';
    result.severity = 'P2';
  } else if (!result.hasBackupArtifact) {
    result.assessment = '检测到备份工具但未发现备份产物（指定路径下无备份文件）';
    result.severity = 'P1';
  } else if (!result.hasScheduledBackup) {
    result.assessment = '检测到备份产物，但未发现 cron 调度（可能是手工备份或调度在其它系统）';
    result.severity = 'P2';
  } else {
    const ageMs = latestTime ? Date.now() - latestTime : Infinity;
    const ageDays = Math.floor(ageMs / 86400000);
    if (ageDays <= 1) result.assessment = `最近备份在 ${ageDays} 天内，状态良好`;
    else if (ageDays <= 7) result.assessment = `最近备份在 ${ageDays} 天前，频率偏低`;
    else result.assessment = `最近备份已 ${ageDays} 天前，存在数据丢失风险`;
    result.severity = ageDays <= 1 ? 'OK' : ageDays <= 7 ? 'P2' : 'P0';
  }

  return result;
}

function collectBackupHintPaths(nodes, dirs) {
  const hints = new Set();
  for (const d of (dirs || [])) {
    if (d && d.path) hints.add(cleanBackupPath(d.path));
  }
  for (const n of nodes) {
    for (const text of [n.mysqlCrontab, n.rootCrontab, n.systemCronBackup]) {
      for (const p of extractBackupPathsFromText(text || '')) {
        hints.add(cleanBackupPath(p));
      }
    }
  }
  return [...hints]
    .filter(Boolean)
    .filter((p) => /backup|bak|dump|xtra|xbstream|maria/i.test(p))
    .sort((a, b) => a.localeCompare(b));
}

function cleanBackupPath(p) {
  return String(p || '').trim().replace(/[)"'`;,\s]+$/g, '').replace(/\/+$/g, '') || null;
}

function extractBackupPathsFromText(text) {
  const paths = new Set();
  const matches = text.match(/\/[A-Za-z0-9._\-\/]+/g) || [];
  for (const raw of matches) {
    const p = cleanBackupPath(raw);
    if (!p) continue;
    if (/backup\.sh$/i.test(p)) {
      const dir = path.dirname(p);
      if (dir && dir !== '/') paths.add(dir);
      continue;
    }
    if (/mysqlop\.py$/i.test(p)) {
      continue;
    }
    paths.add(p);
  }
  return [...paths];
}

// ============== 安全合规评估 ==============
// Codex #9：区分"未采集（UNKNOWN）"与"采集了但未启用（FAIL）"
// 老版本会把 V2 采集脚本未输出的字段当成 FAIL，造成误判。
// 现在：相关数据完全缺失 → UNKNOWN；数据存在但不合规 → FAIL；启用且合规 → PASS
function assessSecurity(nodes) {
  const primary = nodes.find(n => n.role === 'primary') || nodes[0];

  // 数据存在性检测（区分"采集了空"和"压根没采集"）
  const has = {
    passwordPolicy:    nodes.some(n => n.passwordPolicy != null),
    rootWildcardData:  nodes.some(n => Array.isArray(n.users) && n.users.length > 0),
    auditPlugin:       nodes.some(n => n.auditPlugin != null),
    tlsConfig:         nodes.some(n => n.tlsConfig != null && Object.keys(n.tlsConfig).length > 0),
    innodbEncryption:  nodes.some(n => n.encryptionStatus != null || n.keyringPlugin != null),
    emptyPasswordData: nodes.some(n => n.emptyPasswordUsers != null),
    oldAuthData:       nodes.some(n => n.oldAuthUsers != null),
    failedLoginData:   nodes.some(n => n.failedLogins != null),
  };

  const items = [
    mkItem('strong_password_policy', '强密码策略',
      has.passwordPolicy, primary?.hasPasswordPolicy,
      '已启用 validate_password', '未启用密码强度校验插件',
      '未采集 validate_password 配置（升级到 V3.0 采集脚本可获取）'),

    mkItem('no_wildcard_root', 'root 账号未开放 host=%',
      has.rootWildcardData,
      !nodes.some(n => (n.users || []).some(u => u.user === 'root' && u.host === '%')),
      '已限制 root 远程登录',
      'root@% 存在，远程入侵敞口',
      '未采集用户清单数据'),

    mkItem('audit_log', '审计日志已启用',
      has.auditPlugin, nodes.some(n => n.hasAuditPlugin),
      '检测到 audit 插件',
      '未启用 audit log 插件，无法满足等保合规',
      '未采集审计插件状态（V3.0 采集脚本会包含）'),

    // 评审反馈 #8：TLS 含 TLSv1 / TLSv1.1 弱协议时不应判 PASS
    tlsItem(has.tlsConfig, primary?.tlsConfig),

    mkItem('require_secure_transport', '强制 TLS 连接',
      has.tlsConfig, primary?.tlsConfig?.require_secure_transport === 'ON',
      '已强制 TLS', '未强制 TLS，允许明文连接',
      '未采集 require_secure_transport', 'WARN'),

    mkItem('innodb_encryption', '数据 at-rest 加密',
      has.innodbEncryption, nodes.some(n => n.hasInnodbEncryption),
      '已启用 InnoDB 表空间加密',
      '未启用透明数据加密',
      '未采集 InnoDB 加密状态', 'WARN'),

    mkItem('no_empty_password', '无空密码账号',
      has.emptyPasswordData,
      !nodes.some(n => (n.emptyPasswordUsers || []).length > 0),
      '所有账号均设置密码', '发现空密码账号',
      '未采集空密码检查'),

    mkItem('auth_plugin', '认证插件 (caching_sha2_password)',
      has.oldAuthData,
      !nodes.some(n => (n.oldAuthUsers || []).length > 0),
      '所有账号已用现代认证',
      '仍有账号使用 mysql_native_password',
      '未采集认证插件信息', 'WARN'),

    mkItem('failed_login_baseline', '登录失败异常监控',
      has.failedLoginData,
      !nodes.some(n => (n.failedLogins || []).some(f => Number(f.connectErrors) > 100)),
      '采集时未见高异常失败次数',
      '检测到高失败次数 IP',
      '未采集 performance_schema.host_cache', 'WARN'),
  ];

  const pass = items.filter(i => i.status === 'PASS').length;
  const fail = items.filter(i => i.status === 'FAIL').length;
  const warn = items.filter(i => i.status === 'WARN').length;
  const unknown = items.filter(i => i.status === 'UNKNOWN').length;
  // complianceLevel 计算：UNKNOWN 不参与（避免老 txt 误判为低合规）
  const effectiveTotal = items.length - unknown;
  const failRate = effectiveTotal > 0 ? fail / effectiveTotal : 0;
  let complianceLevel;
  if (unknown > items.length * 0.5) {
    complianceLevel = '数据不足（建议升级 V3.0 采集脚本）';
  } else if (fail === 0 && warn <= 1) {
    complianceLevel = '高';
  } else if (failRate <= 0.25) {
    complianceLevel = '中';
  } else {
    complianceLevel = '低';
  }
  return {
    items,
    pass, fail, warn, unknown,
    total: items.length,
    complianceLevel,
  };
}

// 工具函数：根据数据可用性决定 PASS/WARN/FAIL/UNKNOWN
function mkItem(id, label, dataAvailable, passCondition, passDetail, failDetail, unknownDetail, failLevel) {
  if (!dataAvailable) {
    return { id, label, status: 'UNKNOWN', detail: unknownDetail || '相关数据未采集' };
  }
  if (passCondition) {
    return { id, label, status: 'PASS', detail: passDetail };
  }
  return { id, label, status: failLevel || 'FAIL', detail: failDetail };
}

// 评审反馈 #8：TLS 检查智能判定（区分弱协议）
function tlsItem(dataAvailable, tlsConfig) {
  if (!dataAvailable) {
    return { id: 'tls_enabled', label: 'TLS 传输加密', status: 'UNKNOWN', detail: '未采集 TLS 配置' };
  }
  const haveSsl = tlsConfig?.have_ssl === 'YES';
  if (!haveSsl) {
    return { id: 'tls_enabled', label: 'TLS 传输加密', status: 'WARN', detail: '未开启 TLS' };
  }
  const versions = tlsConfig?.tls_version || '';
  const hasWeak = /TLSv1(?:[^.\d]|$)|TLSv1\.1/i.test(versions);
  const hasStrong = /TLSv1\.[23]/i.test(versions);
  if (hasWeak) {
    return {
      id: 'tls_enabled', label: 'TLS 传输加密',
      status: 'WARN',
      detail: `已支持 TLS 但含弱协议 TLSv1/1.1（${versions}）— NIST/RFC 已于 2021 年废弃，等保 2.0 三级要求禁用`,
    };
  }
  if (!hasStrong) {
    return {
      id: 'tls_enabled', label: 'TLS 传输加密',
      status: 'WARN',
      detail: `已开启 TLS 但版本异常（${versions || '未知'}）— 建议仅保留 TLSv1.2+`,
    };
  }
  return {
    id: 'tls_enabled', label: 'TLS 传输加密',
    status: 'PASS',
    detail: `已支持 TLS（${versions}）`,
  };
}

function tlsWeakProtocolDetail(tlsConfig) {
  const versions = tlsConfig?.tls_version || '';
  if (!versions) return null;
  return /TLSv1(?:[^.\d]|$)|TLSv1\.1/i.test(versions) ? versions : null;
}

function businessLongSessions(node) {
  const isSlaveThread = (p) => {
    if (p.user === 'system user') return true;
    const st = p.state || '';
    return /Waiting for master|Queueing master event|Slave has read all|Reading event from the relay log|Has read all relay log/i.test(st);
  };
  // v4.7.2：排除 MySQL 内部守护线程（event_scheduler / event scheduler），它们的 Time
  // 会等于 MySQL 进程 Uptime（数千万秒），但属于正常空闲守护，不是业务长事务。
  const isInternalDaemon = (p) => {
    const user = (p.user || '').toLowerCase();
    const state = (p.state || '').toLowerCase();
    if (user === 'event_scheduler' || /event[_\s]?scheduler/.test(user)) return true;
    if (/waiting on empty queue|waiting for next activation/.test(state)) return true;
    return false;
  };
  return (node.processlist || [])
    .filter(p => Number(p.time) >= 60)
    .filter(p => (p.command || '').toLowerCase() !== 'sleep')
    .filter(p => !/binlog/i.test(p.command || ''))
    .filter(p => !isSlaveThread(p))
    .filter(p => !isInternalDaemon(p))
    .sort((a, b) => Number(b.time) - Number(a.time));
}

// ============== 问题自动分析（节点级 → 集群级聚合）==============
function analyzeIssues(nodes) {
  const raw = [];
  // v4.8：push 统一接管 disabledRules 过滤 + priorities 覆盖。
  // 旧规则 push() 调用零改动，新行为自动生效。
  const push = (it) => {
    if (it && it.type && DISABLED_RULES.has(it.type)) return;
    if (it && it.type && PRIORITY_OVERRIDES[it.type]) {
      it.priority = PRIORITY_OVERRIDES[it.type];
    }
    raw.push({ status: '待处理', ...it });
  };
  const nodeLabel = (n) => `${n.ip}（${roleLabel(n.role)}）`;

  for (const n of nodes) {
    const v = n.variables || {};

    // ----- 资源类（节点级，groupKey 唯一）-----
    // v4.8：阈值改为读 cfg.thresholds.memory.high_pct
    if (n.memUsagePct && Number(n.memUsagePct) > (T.memory?.high_pct ?? 90)) {
      push({
        type: 'mem_high', priority: 'P1', groupKey: `mem_high:${n.ip}`,
        description: `内存使用率 ${n.memUsagePct}% 偏高`,
        node: nodeLabel(n), action: '关注业务负载与缓冲池配置，必要时扩容',
        scope: 'node',
      });
    }

    if (n.osEolStatus?.status === 'eol') {
      push({
        type: 'os_version_eol',
        priority: n.osEolStatus.priority || 'P2',
        groupKey: `os_version_eol:${n.osEolStatus.major}`,
        description: `操作系统版本已停止维护：${n.osEolStatus.major}（${n.osRelease || '-'}，EOL ${n.osEolStatus.eolDate}）`,
        node: nodeLabel(n),
        action: n.osEolStatus.action,
        scope: 'cluster',
      });
    }

    if (n.swapTotal && n.swapFree && n.swapTotal !== n.swapFree) {
      const sm = parseFloat((n.swapTotal.match(/[\d.]+/) || [])[0]);
      const sfm = parseFloat((n.swapFree.match(/[\d.]+/) || [])[0]);
      if (!isNaN(sm) && !isNaN(sfm) && sm > sfm + 0.1) {
        push({
          type: 'swap_used', priority: 'P1', groupKey: `swap:${n.ip}`,
          description: `Swap 已使用（Total ${n.swapTotal} / Free ${n.swapFree}）`,
          node: nodeLabel(n),
          action: '将 vm.swappiness 调至 1 或禁用 Swap；同时核查 innodb_buffer_pool_size 是否过大挤占内存',
          sql: 'sysctl -w vm.swappiness=1\necho "vm.swappiness=1" >> /etc/sysctl.conf\n# 或直接：swapoff -a（确认无 OOM 风险后）',
          scope: 'node',
        });
      }
    }

    // v4.8：HLL 阈值改为读 cfg.thresholds.innodb.hll_warn / .hll_p1
    const hll = Number(n.innodb?.historyListLength);
    const hllWarn = T.innodb?.hll_warn ?? 10000;
    const hllP1 = T.innodb?.hll_p1 ?? 50000;
    if (hll > hllWarn) {
      push({
        type: 'innodb_hll_high',
        priority: hll >= hllP1 ? 'P1' : 'P2',
        groupKey: `innodb_hll_high:${n.ip}`,
        description: `History List Length = ${hll.toLocaleString()}（超过 ${hllWarn.toLocaleString()} 预警线，undo 历史清理滞后）`,
        node: nodeLabel(n),
        action: '排查长事务/长查询和 purge 线程压力；优先确认 PROCESSLIST 与 INNODB TRX 中是否存在长期未提交事务',
        sql: 'SHOW ENGINE INNODB STATUS\\G\nSELECT * FROM information_schema.INNODB_TRX\\G\nSHOW FULL PROCESSLIST;',
        scope: 'node',
      });
    }

    // v4.8：长会话阈值改为读 cfg.thresholds.session.*
    const longSessions = businessLongSessions(n);
    const longSessP2 = T.session?.long_running_seconds_p2 ?? 600;
    if (longSessions.length > 0) {
      const top = longSessions[0];
      push({
        type: 'long_running_session',
        priority: Number(top.time) >= longSessP2 ? 'P2' : 'P3',
        groupKey: `long_running_session:${n.ip}`,
        description: `存在长时间运行会话：${top.user}@${top.host || '-'} ${top.time}s，状态 ${top.state || '-'}${top.db ? `，库 ${top.db}` : ''}`,
        node: nodeLabel(n),
        action: '先确认业务影响和 SQL 内容；若阻塞、消耗资源或确认异常，再由 DBA 执行 KILL CONNECTION',
        sql: `SHOW FULL PROCESSLIST;\n-- 确认异常后：KILL CONNECTION ${top.id};`,
        scope: 'node',
        needsConfirmation: true,
      });
    }

    // v4.8：磁盘阈值改为读 cfg.thresholds.disk.*
    const diskCriticalPct = T.disk?.critical_pct ?? 90;
    const diskHighPct = T.disk?.high_pct ?? 80;
    for (const d of (n.disks || [])) {
      const pct = parseInt((d.usePct || '0').replace('%', ''));
      if (pct >= diskCriticalPct) {
        push({
          type: 'disk_critical', priority: 'P0', groupKey: `disk:${n.ip}:${d.mount}`,
          description: `磁盘 ${d.mount} 使用率 ${d.usePct}（容量 ${d.total}，已用 ${d.used}）`,
          node: nodeLabel(n), action: '立即清理日志/历史数据 或 扩容',
          sql: `df -h ${d.mount}\nfind ${d.mount} -type f -size +1G -mtime +30 -exec ls -lh {} \\;`,
          scope: 'node',
        });
      } else if (pct >= diskHighPct) {
        push({
          type: 'disk_high', priority: 'P1', groupKey: `disk:${n.ip}:${d.mount}`,
          description: `磁盘 ${d.mount} 使用率 ${d.usePct}`,
          node: nodeLabel(n), action: '本周内规划清理或扩容',
          scope: 'node',
        });
      }
    }

    // ----- 复制类 ----- (v4.8：延迟阈值改为读 cfg.thresholds.replication.*)
    if (n.replication?.isSlave) {
      const s = n.replication.status || {};
      const ioR = s.slaveIoRunning, sqlR = s.slaveSqlRunning;
      const sbm = s.secondsBehindMaster;
      const delayP1 = T.replication?.delay_p1_seconds ?? 300;
      const delayP2 = T.replication?.delay_p2_seconds ?? 60;
      if (ioR !== 'Yes' || sqlR !== 'Yes') {
        push({
          type: 'repl_thread_down', priority: 'P0', groupKey: `repl_thread:${n.ip}`,
          description: `复制线程异常（IO=${ioR}, SQL=${sqlR}）`,
          node: nodeLabel(n),
          action: '查 Last_IO_Error / Last_SQL_Error；必要时 STOP SLAVE; 处理后 START SLAVE',
          sql: 'SHOW SLAVE STATUS\\G',
          scope: 'node',
        });
      } else if (sbm != null && Number(sbm) > delayP1) {
        push({
          type: 'repl_delay_high', priority: 'P1', groupKey: `repl_delay:${n.ip}`,
          description: `从库延迟 ${sbm} 秒`,
          node: nodeLabel(n), action: '排查 SQL 线程瓶颈/大事务；启用并行复制',
          scope: 'node',
        });
      } else if (sbm != null && Number(sbm) > delayP2) {
        push({
          type: 'repl_delay_low', priority: 'P2', groupKey: `repl_delay:${n.ip}`,
          description: `从库延迟 ${sbm} 秒`,
          node: nodeLabel(n), action: '持续关注延迟变化',
          scope: 'node',
        });
      }
    }

    // ----- 数据规范（节点级；同集群通常一致，会被聚合）-----
    // 评审反馈 #7：区分业务表和临时/历史表 — 临时表无主键不重要，业务表无主键才是问题
    if ((n.noPkTables || []).length > 0) {
      const businessNoPk = n.noPkTables.filter(t => !isTempOrHistoryTable(t.table));
      const tempNoPk = n.noPkTables.length - businessNoPk.length;
      if (businessNoPk.length > 0) {
        push({
          type: 'no_pk_tables', priority: 'P2', groupKey: `no_pk_tables`,
          description: `存在业务表无主键 ${businessNoPk.length} 张${tempNoPk > 0 ? `（另有 ${tempNoPk} 张临时/历史表已过滤）` : ''}，TOP：${businessNoPk.slice(0,3).map(t=>`${t.schema}.${t.table}`).join('、')}`,
          node: nodeLabel(n),
          action: '评估补充自增主键或唯一索引；ROW 复制下无主键表全表扫描匹配，且无法 MTS 并行复制',
          sql: `-- 示例：ALTER TABLE ${businessNoPk[0].schema}.${businessNoPk[0].table} ADD COLUMN id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST;`,
          scope: 'cluster',
        });
      } else if (tempNoPk > 0) {
        // 全部是临时表 — 降级为 P3
        push({
          type: 'no_pk_tables_temp_only', priority: 'P3', groupKey: 'no_pk_tables_temp_only',
          description: `存在无主键表 ${tempNoPk} 张，但均为临时/历史/备份表（tmp_/temp_/test_/_bak/_20YYMMDD 等），可忽略或随归档清理`,
          node: nodeLabel(n),
          action: '若临时表已无业务引用，建议 DROP 清理',
          scope: 'cluster',
        });
      }
    }

    // 评审反馈 #10：ghost 表（gh-ost / pt-osc 在线 DDL 残留）识别
    const ghostTables = (n.fragTables || []).filter(t => isGhostTable(t.table));
    const bigGhost = ghostTables.filter(t => Number(t.dataFree || 0) + Number(t.dataLength || 0) >= 1073741824);
    if (bigGhost.length > 0) {
      const totalGB = bigGhost.reduce((s, t) => s + (Number(t.dataLength || 0) + Number(t.dataFree || 0)) / 1073741824, 0);
      push({
        type: 'ghost_tables', priority: 'P2', groupKey: 'ghost_tables',
        description: `疑似在线 DDL 残留 ghost 表 ${bigGhost.length} 张，合计 ~${totalGB.toFixed(1)} GB（${bigGhost.slice(0,3).map(t=>`${t.schema}.${t.table}`).join('、')}）`,
        node: nodeLabel(n),
        action: 'gh-ost / pt-osc 操作未正常清理；确认无业务引用后可 DROP 直接释放空间',
        sql: `-- 先确认无引用：\nSELECT * FROM information_schema.statistics WHERE table_name = '${bigGhost[0].table}';\n-- 确认后执行：\nDROP TABLE ${bigGhost[0].schema}.${bigGhost[0].table};`,
        scope: 'cluster',
        needsConfirmation: true,
      });
    }

    if ((n.nonUtf8Tables || []).length > 0) {
      const t = n.nonUtf8Tables[0];
      push({
        type: 'non_utf8_tables', priority: 'P2', groupKey: 'non_utf8_tables',
        description: `存在非 utf8 表 ${n.nonUtf8Tables.length} 张（${n.nonUtf8Tables.slice(0,3).map(t=>`${t.schema}.${t.table}(${t.collation})`).join('、')}）`,
        node: nodeLabel(n),
        action: '评估转换为 utf8mb4 以支持完整字符集',
        sql: `-- 示例：ALTER TABLE ${t.schema}.${t.table} CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;`,
        scope: 'cluster',
      });
    }

    // 碎片表：只统计绝对值大的（v4.8 阈值改为读 cfg.thresholds.frag.*）
    const fragRate = T.frag?.rate ?? 0.7;
    const fragMinMB = T.frag?.min_mb ?? 100;
    const bigFrag = (n.fragTables || []).filter(t => {
      const fr = Number(t.fragRate);
      const free = Number(t.dataFree);
      return fr >= fragRate && free >= fragMinMB * 1024 * 1024;
    });
    if (bigFrag.length > 0) {
      const top = bigFrag
        .sort((a, b) => Number(b.dataFree) - Number(a.dataFree))
        .slice(0, 3)
        .map(t => `${t.table}(${(Number(t.dataFree)/1073741824).toFixed(1)}GB)`)
        .join('、');
      push({
        type: 'heavy_frag_tables', priority: 'P2', groupKey: 'heavy_frag_tables',
        description: `存在高碎片大表 ${bigFrag.length} 张（碎片率≥${(fragRate*100).toFixed(0)}% 且碎片≥${fragMinMB}MB；TOP：${top}）`,
        node: nodeLabel(n),
        action: '维护窗口期 OPTIMIZE TABLE 或 pt-online-schema-change 重建',
        sql: '-- 示例：OPTIMIZE TABLE pioneer_db.tbl_order_refund;\n-- 大表推荐：pt-online-schema-change --alter "ENGINE=InnoDB" D=pioneer_db,t=tbl_order_refund --execute',
        scope: 'cluster',
      });
    }

    // ----- 慢查询（按绝对值分级；v4.8 阈值改为读 cfg.thresholds.sql.*）-----
    if (n.slowQueries != null) {
      const slow = Number(n.slowQueries);
      const pct = n.questions ? (slow / Number(n.questions) * 100) : null;
      const slowHigh = T.sql?.slow_query_abs_high ?? 1000000;
      const slowMed = T.sql?.slow_query_abs_med ?? 100000;
      if (slow > slowHigh) {
        push({
          type: 'slow_query_abs_high', priority: 'P1', groupKey: `slow_abs:${n.ip}`,
          description: `累计慢查询 ${slow.toLocaleString()} 次${pct!=null?`（占总查询 ${pct.toFixed(4)}%）`:''}`,
          node: nodeLabel(n),
          action: '使用 pt-query-digest 输出 TOP10 SQL，优先优化全表扫描和高 IO 查询',
          sql: 'pt-query-digest /data/mysql/data/*-slow.log | head -200',
          scope: 'node',
        });
      } else if (slow > slowMed) {
        push({
          type: 'slow_query_abs_med', priority: 'P2', groupKey: `slow_abs:${n.ip}`,
          description: `累计慢查询 ${slow.toLocaleString()} 次`,
          node: nodeLabel(n), action: '定期 pt-query-digest 汇总分析',
          scope: 'node',
        });
      }
    }

    // slow_query_log 关闭
    if (v.slow_query_log === '0') {
      push({
        type: 'slow_log_off', priority: 'P2', groupKey: `slow_log_off:${n.ip}`,
        description: `slow_query_log = 0（慢日志未开启）`,
        node: nodeLabel(n),
        action: '建议开启慢日志，便于性能审计',
        sql: "SET GLOBAL slow_query_log = 1;\nSET GLOBAL long_query_time = 1;",
        scope: 'node',
      });
    }
    // v4.8：long_query_time 上限改为读 cfg.thresholds.sql.long_query_time_loose
    const longQtLoose = T.sql?.long_query_time_loose ?? 5;
    if (v.long_query_time && Number(v.long_query_time) >= longQtLoose) {
      push({
        type: 'long_query_time_loose', priority: 'P3', groupKey: `long_qt:${n.ip}`,
        description: `long_query_time = ${v.long_query_time}（阈值过宽，应 < ${longQtLoose}）`,
        node: nodeLabel(n), action: '建议设为 1 秒以更敏感地捕获慢 SQL',
        scope: 'node',
      });
    }

    // ----- ibtmp1 ----- (v4.8 阈值改为读 cfg.thresholds.innodb.ibtmp1_max_gb)
    const ibtmp1MaxGB = T.innodb?.ibtmp1_max_gb ?? 5;
    if (n.ibtmp1?.sizeBytes && n.ibtmp1.sizeBytes > ibtmp1MaxGB * 1073741824) {
      push({
        type: 'ibtmp1_oversize', priority: 'P2', groupKey: `ibtmp1:${n.ip}`,
        description: `ibtmp1 已增长至 ${n.ibtmp1.sizeFormatted}`,
        node: nodeLabel(n),
        action: '配置 innodb_temp_data_file_path 上限，维护窗口重启回收',
        sql: '-- my.cnf:\ninnodb_temp_data_file_path = ibtmp1:12M:autoextend:max:50G\n-- 重启 MySQL 后生效',
        scope: 'node',
      });
    }

    const weakTls = tlsWeakProtocolDetail(n.tlsConfig);
    if (weakTls) {
      push({
        type: 'tls_weak_protocol',
        priority: 'P2',
        groupKey: 'tls_weak_protocol',
        description: `TLS 配置包含已废弃协议：${weakTls}`,
        node: nodeLabel(n),
        action: '禁用 TLSv1/TLSv1.1，仅保留 TLSv1.2+；同时确认业务客户端驱动版本兼容',
        scope: 'cluster',
      });
    }

    // ibtmp1 配置未设 :max:（集群级聚合）
    if (v.innodb_temp_data_file_path && !/:max:/i.test(v.innodb_temp_data_file_path)) {
      push({
        type: 'ibtmp1_no_max', priority: 'P2', groupKey: 'ibtmp1_no_max',
        description: `innodb_temp_data_file_path 未配置 :max: 上限（${v.innodb_temp_data_file_path}）`,
        node: nodeLabel(n),
        action: '建议加 :max:50G 上限，避免临时表无限增长打爆磁盘',
        sql: '-- my.cnf:\ninnodb_temp_data_file_path = ibtmp1:12M:autoextend:max:50G',
        scope: 'cluster',
      });
    }

    // ----- 持久化（措辞不再写"若为主库"，因为从库升主或半同步都需要）-----
    if (v.innodb_flush_log_at_trx_commit === '0') {
      push({
        type: 'flush_log_weak', priority: 'P1', groupKey: 'flush_log_weak',
        description: `innodb_flush_log_at_trx_commit = 0（每秒一次刷盘，断电最多丢 1 秒事务）`,
        node: nodeLabel(n),
        action: '生产环境建议改为 1；如对写性能敏感可设为 2（重启不丢，断电可能丢）',
        sql: "SET GLOBAL innodb_flush_log_at_trx_commit = 1;\n-- 同时改 my.cnf 持久化",
        scope: 'cluster',
      });
    }
    if (v.sync_binlog === '0') {
      push({
        type: 'sync_binlog_weak', priority: 'P1', groupKey: 'sync_binlog_weak',
        description: `sync_binlog = 0（binlog 依赖 OS 刷盘，可能丢失事件）`,
        node: nodeLabel(n),
        action: '主库建议设为 1（每事务刷盘）；高并发可考虑 100（每 100 事务）',
        sql: "SET GLOBAL sync_binlog = 1;\n-- 同时改 my.cnf 持久化",
        scope: 'cluster',
      });
    }
    if (v.gtid_mode === 'OFF') {
      push({
        type: 'gtid_off', priority: 'P2', groupKey: 'gtid_off',
        description: `gtid_mode = OFF（未启用 GTID）`,
        node: nodeLabel(n),
        action: '建议规划升级到 GTID，简化故障切换与主从迁移',
        sql: `-- GTID 启用需顺序在所有节点滚动执行（不能同时）：
-- 1) SET GLOBAL gtid_mode = OFF_PERMISSIVE;
-- 2) SET GLOBAL enforce_gtid_consistency = WARN;
-- 3) SET GLOBAL enforce_gtid_consistency = ON;
-- 4) SET GLOBAL gtid_mode = ON_PERMISSIVE;
-- 5) 等所有节点 @@global.gtid_owned 为空
-- 6) SET GLOBAL gtid_mode = ON;
-- 7) my.cnf 加 gtid_mode=ON / enforce_gtid_consistency=ON`,
        scope: 'cluster',
      });
    }

    // 角色一致性 — v4.5：standalone_readonly 推断的主库降级为 P3 + needsConfirmation
    // （常见于 zabbix 监控库 / 报表只读库 / 备机配置等"deliberate read-only primary"场景）
    if (n.role === 'primary' && v.read_only === '1') {
      const inferredReadOnly = n.roleInference?.source === 'standalone_readonly';
      push({
        type: 'master_readonly',
        priority: inferredReadOnly ? 'P3' : 'P1',
        groupKey: `master_readonly:${n.ip}`,
        description: inferredReadOnly
          ? `节点 ${n.ip} 被推断为「只读主库」（read_only = 1 + log_bin 启用，常见于 zabbix/监控/报表/备机场景）`
          : `主库 read_only = 1（无法写入）`,
        node: nodeLabel(n),
        action: inferredReadOnly
          ? '若属设计预留（zabbix / 报表只读库 / 备机），请确认并文档化；如非预期，关闭 read_only'
          : '核实是否被错误置为只读',
        sql: 'SET GLOBAL read_only = 0; SET GLOBAL super_read_only = 0;',
        scope: 'node',
        needsConfirmation: inferredReadOnly,
      });
    }
    if (n.role !== 'primary' && n.replication?.isSlave && v.read_only === '0') {
      // 评审反馈 #5：DR 灾备节点 read_only=0 可能是切换设计预留，降级提示
      const isDr = isDrNode(n);
      push({
        type: isDr ? 'dr_writable' : 'slave_writable',
        priority: isDr ? 'P3' : 'P1',
        groupKey: `slave_writable:${n.ip}`,
        description: isDr
          ? `灾备节点 ${n.hostname || n.ip} read_only = 0（疑似 DR 切换设计预留）`
          : `从库 read_only = 0（可写入，存在数据漂移风险）`,
        node: nodeLabel(n),
        action: isDr
          ? '若属灾备快切设计，请确认并文档化该例外；常态下仍建议 read_only=1，切换时再放开'
          : '从库应设为只读',
        sql: isDr ? null : 'SET GLOBAL read_only = 1; SET GLOBAL super_read_only = 1;',
        scope: 'node',
        needsConfirmation: isDr,
      });
    }

    // v4.5：self-referencing slave 残留（Master_Host = 本机）— 提示清理
    if (n.replication?.selfReferencingSlaveResidue) {
      const residue = n.replication.selfReferencingSlaveResidue;
      push({
        type: 'self_ref_slave_residue',
        priority: 'P2',
        groupKey: `self_ref_slave_residue:${n.ip}`,
        description: `节点 ${n.ip} 存在 SHOW SLAVE STATUS 残留（Master_Host 指向自身 ${residue.masterHost}），通常是历史从库被提升为主后未执行 RESET SLAVE ALL`,
        node: nodeLabel(n),
        action: '执行 STOP SLAVE; RESET SLAVE ALL; 清理残留复制元数据，避免 SHOW SLAVE STATUS 输出误导监控/巡检工具',
        sql: 'STOP SLAVE;\nRESET SLAVE ALL;',
        scope: 'node',
      });
    }

    // expire_logs_days
    if (v.expire_logs_days === '0') {
      push({
        type: 'expire_logs_zero', priority: 'P1', groupKey: `expire_logs_zero:${n.ip}`,
        description: `expire_logs_days = 0（binlog 永不过期，存在磁盘打爆风险）`,
        node: nodeLabel(n),
        action: '建议改为 7-15 天；并立即手工清理冗余 binlog',
        sql: "SET GLOBAL expire_logs_days = 7;\nPURGE BINARY LOGS BEFORE NOW() - INTERVAL 7 DAY;",
        scope: 'node',
      });
    } else {
      // v4.8：expire_logs_long 阈值改为读 cfg.thresholds.binlog.expire_logs_max_days
      const expireLogsMax = T.binlog?.expire_logs_max_days ?? 30;
      if (v.expire_logs_days && Number(v.expire_logs_days) > expireLogsMax) {
        push({
          type: 'expire_logs_long', priority: 'P3', groupKey: `expire_logs_long:${n.ip}`,
          description: `expire_logs_days = ${v.expire_logs_days}（保留过长，> ${expireLogsMax} 天）`,
          node: nodeLabel(n), action: '评估磁盘成本与回滚需求',
          scope: 'node',
        });
      }
    }

    // ----- Buffer Pool 命中率（v4.8 阈值改为读 cfg.thresholds.innodb.bp_hit_*） -----
    if (n.innodb?.bufferPoolHitRate) {
      const [hit, total] = n.innodb.bufferPoolHitRate.split('/').map(s => Number(s.trim()));
      if (hit && total) {
        const rate = hit / total;
        const bpHitLowPct = T.innodb?.bp_hit_low_pct ?? 95;
        const bpHitWarnPct = T.innodb?.bp_hit_warn_pct ?? 99;
        if (rate * 100 < bpHitLowPct) {
          push({
            type: 'bp_hit_low', priority: 'P1', groupKey: `bp_hit:${n.ip}`,
            description: `Buffer Pool 命中率 ${(rate*100).toFixed(1)}%（${hit}/${total}），低于 ${bpHitLowPct}% 阈值`,
            node: nodeLabel(n), action: '评估扩大 innodb_buffer_pool_size 至内存的 50-70%',
            scope: 'node',
          });
        } else if (rate * 100 < bpHitWarnPct) {
          push({
            type: 'bp_hit_sub99', priority: 'P3', groupKey: `bp_hit:${n.ip}`,
            description: `Buffer Pool 命中率 ${(rate*100).toFixed(1)}%（${hit}/${total}），未达 ${bpHitWarnPct}% 推荐线`,
            node: nodeLabel(n), action: '观察是否随业务增长继续下降；若持续偏低评估扩容',
            scope: 'node',
          });
        }
      }
    }

    // ============== v4.8 senior-DBA 参数推荐规则（12 条）==============
    // 每条规则带 currentValue / recommendedValue / dimension，render 端会展示彩色对照

    // #1 bp_too_small — innodb_buffer_pool_size 占 RAM 比例过低
    {
      const memGB = memTotalGB(n);
      const bpMB = mb(n, 'innodb_buffer_pool_size_in_mb');
      const Ti = T.innodb || {};
      const minMemGB = Ti.bp_too_small_min_mem_gb ?? 4;
      const warnRatio = Ti.bp_too_small_ratio ?? 0.4;
      const p1Ratio = Ti.bp_too_small_p1_ratio ?? 0.2;
      if (memGB && bpMB && memGB >= minMemGB) {
        const ratio = (bpMB / 1024) / memGB;
        if (ratio < warnRatio) {
          const rec = recommendBufferPoolMB(memGB);
          const pct = (ratio * 100).toFixed(0);
          push({
            type: 'bp_too_small',
            priority: ratio < p1Ratio ? 'P1' : 'P2',
            groupKey: `bp_too_small:${n.ip}`,
            dimension: 'performance',
            description: `innodb_buffer_pool_size = ${formatMB(bpMB)}，仅占 RAM ${memGB.toFixed(0)} GB 的 ${pct}%，远低于 50-70% 推荐区间`,
            currentValue: `${formatMB(bpMB)}（占 RAM ${memGB.toFixed(0)} GB 的 ${pct}%）`,
            recommendedValue: `${formatMB(rec)}（~60% RAM，保留 OS/连接/临时表余量）`,
            action: `调大 innodb_buffer_pool_size 至 ~${formatMB(rec)}；> 1GB 时建议 buffer_pool_instances=8`,
            sql: [
              `SET GLOBAL innodb_buffer_pool_size = ${rec * 1024 * 1024};`,
              '-- my.cnf:',
              `innodb_buffer_pool_size = ${formatMB(rec).replace(' ', '')}`,
              'innodb_buffer_pool_instances = 8',
            ].join('\n'),
            node: nodeLabel(n),
            scope: 'node',
          });
        } else if (ratio > (Ti.bp_too_large_ratio ?? 0.8)) {
          // #2 bp_too_large — 缓冲池 > 80% RAM，OOM 风险
          const rec = recommendBufferPoolMB(memGB);
          const pct = (ratio * 100).toFixed(0);
          push({
            type: 'bp_too_large',
            priority: 'P1',
            groupKey: `bp_too_large:${n.ip}`,
            dimension: 'availability',
            description: `innodb_buffer_pool_size = ${formatMB(bpMB)} 已占 RAM ${memGB.toFixed(0)} GB 的 ${pct}%，OS/连接/临时表无足够余量，可能触发 OOM 或 Swap`,
            currentValue: `${formatMB(bpMB)}（占 RAM ${memGB.toFixed(0)} GB 的 ${pct}%）`,
            recommendedValue: `${formatMB(rec)}（~60% RAM）`,
            action: `下调 innodb_buffer_pool_size 至 ~${formatMB(rec)}；同时检查 Swap 是否已启用，必要时降低 max_connections`,
            sql: [
              `SET GLOBAL innodb_buffer_pool_size = ${rec * 1024 * 1024};`,
              '-- my.cnf:',
              `innodb_buffer_pool_size = ${formatMB(rec).replace(' ', '')}`,
            ].join('\n'),
            node: nodeLabel(n),
            scope: 'node',
          });
        }
      }
    }

    // #3 redo_log_too_small — InnoDB redo log file 偏小，频繁切换会拉低写吞吐 + 放大恢复时间
    {
      const logMB = mb(n, 'innodb_log_file_size_in_mb');
      const dbGB = Number(n.dbTotalSizeGB || 0);
      const Ti = T.innodb || {};
      const minMB = Ti.redo_log_min_mb ?? 512;
      const busyGB = Ti.redo_log_db_gb_busy ?? 50;
      const heavyGB = Ti.redo_log_db_gb_heavy ?? 200;
      if (logMB != null && logMB < minMB && (dbGB >= busyGB || Number(n.qps || 0) > 200)) {
        const targetMB = dbGB >= heavyGB ? 2048 : dbGB >= busyGB ? 1024 : 512;
        push({
          type: 'redo_log_too_small',
          priority: logMB < 128 ? 'P1' : 'P2',
          groupKey: `redo_log_small:${n.ip}`,
          dimension: 'performance',
          description: `innodb_log_file_size = ${formatMB(logMB)}（库数据量 ${dbGB.toFixed(0)} GB），redo 频繁切换会拉低写吞吐并放大故障恢复时间`,
          currentValue: formatMB(logMB),
          recommendedValue: `${formatMB(targetMB)}（依据库大小 ${dbGB.toFixed(0)} GB）`,
          action: 'MySQL 8.0 可动态调整；5.7 需停机改 my.cnf 后重启',
          sql: [
            '-- MySQL 8.0+ 动态：',
            `SET GLOBAL innodb_redo_log_capacity = ${targetMB * 2 * 1024 * 1024};`,
            '-- MySQL 5.7 需重启：',
            '-- my.cnf:',
            `innodb_log_file_size = ${targetMB}M`,
            'innodb_log_files_in_group = 2',
          ].join('\n'),
          node: nodeLabel(n),
          scope: 'node',
        });
      }
    }

    // #4 flush_method_not_o_direct — Linux 上 flush_method ≠ O_DIRECT 造成 OS+buffer pool 双重缓存
    {
      const fm = v.innodb_flush_method;
      const isLinux = /linux|el|centos|ubuntu|debian/i.test(n.osKernel || (n.osRelease?.name || ''));
      if (isLinux && fm && fm !== 'O_DIRECT' && fm !== 'O_DIRECT_NO_FSYNC') {
        push({
          type: 'flush_method_not_o_direct',
          priority: 'P2',
          groupKey: 'flush_method_default',
          dimension: 'performance',
          description: `innodb_flush_method = ${fm} — Linux 下默认 fsync 会同时占用 OS page cache 与 buffer pool（双重缓存），浪费内存并增加冗余 IO`,
          currentValue: fm,
          recommendedValue: 'O_DIRECT',
          action: 'Linux 推荐 O_DIRECT；该参数不可动态修改，需重启 MySQL',
          sql: '-- my.cnf:\ninnodb_flush_method = O_DIRECT\n# 重启 MySQL 生效',
          node: nodeLabel(n),
          scope: 'node',
        });
      }
    }

    // #5 doublewrite_off — innodb_doublewrite=OFF 半页写崩溃风险
    if (v.innodb_doublewrite === 'OFF' || v.innodb_doublewrite === '0') {
      push({
        type: 'doublewrite_off',
        priority: 'P1',
        groupKey: 'doublewrite_off',
        dimension: 'durability',
        description: 'innodb_doublewrite = OFF — 半页写崩溃会导致页损坏且不可恢复（torn page），性能收益 < 5% 但风险远大于收益',
        currentValue: 'OFF',
        recommendedValue: 'ON',
        action: '立即开启；仅在使用 ZFS 或支持原子写的存储（FusionIO 等）时才可关闭',
        sql: 'SET GLOBAL innodb_doublewrite = ON;\n-- my.cnf:\ninnodb_doublewrite = 1',
        node: nodeLabel(n),
        scope: 'node',
      });
    }

    // #6 charset_not_utf8mb4 — character_set_server 非 utf8mb4
    {
      const cs = v.character_set_server;
      if (cs && !/utf8mb4/i.test(cs)) {
        push({
          type: 'charset_not_utf8mb4',
          priority: 'P2',
          groupKey: 'charset_server_not_utf8mb4',
          dimension: 'dataDesign',
          description: `character_set_server = ${cs}，无法存储 emoji / 4 字节字符；utf8 实际是 utf8mb3，已被 MySQL 标记为 deprecated`,
          currentValue: cs,
          recommendedValue: 'utf8mb4',
          action: '服务端 + 库 + 表 + 列四级都需要改；新建表前先改服务端默认，存量表用 CONVERT TO',
          sql: [
            '-- my.cnf:',
            'character_set_server = utf8mb4',
            'collation_server = utf8mb4_0900_ai_ci  # MySQL 8.0',
            '# collation_server = utf8mb4_general_ci  # MySQL 5.7',
            '-- 库级转换：',
            'ALTER DATABASE <dbname> CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;',
          ].join('\n'),
          node: nodeLabel(n),
          scope: 'node',
        });
      }
    }

    // #7 sql_mode_missing_strict — sql_mode 缺少 STRICT_TRANS_TABLES
    {
      const modes = parseSqlMode(n.sqlMode || v.sql_mode);
      if (modes.size > 0 && !modes.has('STRICT_TRANS_TABLES') && !modes.has('STRICT_ALL_TABLES')) {
        push({
          type: 'sql_mode_missing_strict',
          priority: 'P2',
          groupKey: 'sql_mode_no_strict',
          dimension: 'dataDesign',
          description: 'sql_mode 未包含 STRICT_TRANS_TABLES — 错误数据会被静默截断（INT 越界写 0、字符串超长被裁），存在数据完整性风险',
          currentValue: [...modes].join(',') || '(空)',
          recommendedValue: '加上 STRICT_TRANS_TABLES + NO_ENGINE_SUBSTITUTION',
          action: '评估业务影响（旧应用可能依赖宽松模式静默成功）后再切换；建议先在测试环境验证',
          sql: [
            "SET GLOBAL sql_mode = CONCAT(@@sql_mode, ',STRICT_TRANS_TABLES');",
            '-- 评估后持久化到 my.cnf:',
            'sql_mode = STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO',
          ].join('\n'),
          node: nodeLabel(n),
          scope: 'node',
        });
      }
    }

    // #8 auth_plugin_native_on_80 — MySQL 8.0+ 默认 mysql_native_password 已废弃
    if (isMysql80Plus(n.mysqlVersion) && v.default_authentication_plugin === 'mysql_native_password') {
      push({
        type: 'auth_plugin_native_on_80',
        priority: 'P2',
        groupKey: 'auth_plugin_native_on_80',
        dimension: 'security',
        description: 'MySQL 8.0+ 默认认证插件仍为 mysql_native_password — 该插件派生 SHA1，已被弃用；8.4 起 mysql_native_password 默认 disabled',
        currentValue: 'mysql_native_password',
        recommendedValue: 'caching_sha2_password',
        action: '新账号默认走 caching_sha2_password；存量账号灰度迁移；客户端驱动需 ≥ Connector/J 8.0、PyMySQL 1.0+',
        sql: [
          '-- my.cnf:',
          'default_authentication_plugin = caching_sha2_password',
          '-- 单账号迁移：',
          "ALTER USER 'app'@'10.%' IDENTIFIED WITH caching_sha2_password BY '<pwd>';",
        ].join('\n'),
        node: nodeLabel(n),
        scope: 'node',
      });
    }

    // #9 performance_schema_off — P_S 关闭，失去 TOP SQL 与监控指标
    if (v.performance_schema === 'OFF') {
      push({
        type: 'performance_schema_off',
        priority: 'P2',
        groupKey: 'performance_schema_off',
        dimension: 'operations',
        description: 'performance_schema = OFF — 无法使用 sys.statement_analysis / events_statements_summary_by_digest 等做 TOP SQL；监控工具（PMM / Prometheus mysqld_exporter）会缺核心指标',
        currentValue: 'OFF',
        recommendedValue: 'ON',
        action: '开启 P_S；约占 400-600 MB 内存，对 OLTP 影响 < 5%',
        sql: '-- my.cnf:\nperformance_schema = ON\n# 重启 MySQL 生效',
        node: nodeLabel(n),
        scope: 'node',
      });
    }

    // #10 max_connections_vs_memory — max_connections × 单连接峰值 vs RAM
    {
      const memGB = memTotalGB(n);
      const maxConn = Number(v.max_connections || 0);
      const Tmc = T.max_connections || {};
      const warnRatio = Tmc.peak_memory_ratio_warn ?? 0.3;
      const p1Ratio = Tmc.peak_memory_ratio_p1 ?? 0.5;
      if (memGB && maxConn > 0) {
        const perConnMB =
          (kb(n, 'sort_buffer_size_in_kb') || 0) / 1024 +
          (kb(n, 'join_buffer_size_in_kb') || 0) / 1024 +
          (kb(n, 'read_buffer_size_in_kb') || 0) / 1024 +
          (kb(n, 'read_rnd_buffer_size_in_kb') || 0) / 1024 +
          (mb(n, 'tmp_table_size_in_mb') || 0);
        const peakMB = perConnMB * maxConn;
        const peakRatio = peakMB / (memGB * 1024);
        if (peakRatio > warnRatio) {
          const targetMaxConn = Math.floor(memGB * 1024 * warnRatio / Math.max(perConnMB, 1));
          push({
            type: 'max_connections_vs_memory',
            priority: peakRatio > p1Ratio ? 'P1' : 'P2',
            groupKey: `max_conn_mem:${n.ip}`,
            dimension: 'availability',
            description: `max_connections=${maxConn} × 单连接峰值 ~${formatMB(perConnMB)} = 总峰值 ~${formatMB(peakMB)}，约占 RAM ${memGB.toFixed(0)} GB 的 ${(peakRatio*100).toFixed(0)}%（仅估算，实际并发不会全用满 buffer）`,
            currentValue: `max_connections=${maxConn}（每连接 ~${formatMB(perConnMB)}，理论峰值 ${(peakRatio*100).toFixed(0)}% RAM）`,
            recommendedValue: `max_connections=${targetMaxConn} 或缩减 sort_buffer / join_buffer / read_buffer（通常 256KB-2MB 即可）`,
            action: '下调 max_connections，或缩减单连接 buffer；中长期改用连接池（ProxySQL / HAProxy）',
            sql: `SET GLOBAL max_connections = ${targetMaxConn};`,
            node: nodeLabel(n),
            scope: 'node',
          });
        }
      }
    }

    // #11 slave_skip_errors_set — 静默吞下复制错误（P0 数据漂移）
    {
      const sse = v.slave_skip_errors || v.replica_skip_errors;
      if (sse && sse !== 'OFF' && sse !== '' && sse !== 'NONE' && sse !== 'off') {
        push({
          type: 'slave_skip_errors_set',
          priority: 'P0',
          groupKey: `slave_skip_errors:${n.ip}`,
          dimension: 'durability',
          description: `slave_skip_errors = ${sse} — 复制错误被强制跳过，从库已经/将会与主库数据不一致；任何 binlog 错误都不会再暴露`,
          currentValue: sse,
          recommendedValue: 'OFF',
          action: '立即关闭；用 pt-table-checksum / pt-table-sync 校验现有数据一致性',
          sql: [
            '# slave_skip_errors 不能动态改，必须修改 my.cnf:',
            '# 删除该行或改为：',
            'slave_skip_errors = OFF',
            '# 重启 slave 后校验数据：',
            'pt-table-checksum --replicate=percona.checksums h=<primary>,u=<user>,p=<pwd>',
          ].join('\n'),
          node: nodeLabel(n),
          scope: 'node',
        });
      }
    }

    // #12 auto_increment_exhausting — 自增列接近耗尽
    {
      const critical = (n.autoIncrementUsage || []).filter(x => Number(x.rate || 0) >= (T.auto_increment?.rate_p2 ?? 0.7));
      if (critical.length > 0) {
        critical.sort((a, b) => Number(b.rate) - Number(a.rate));
        const top = critical[0];
        const maxRate = Number(top.rate);
        const ratePri = (r) => r >= (T.auto_increment?.rate_p0 ?? 0.9) ? 'P0' : r >= (T.auto_increment?.rate_p1 ?? 0.8) ? 'P1' : 'P2';
        const top3Display = critical.slice(0, 3).map(x => `${x.schema}.${x.table}.${x.column}=${(Number(x.rate)*100).toFixed(0)}%`).join('、');
        push({
          type: 'auto_increment_exhausting',
          priority: ratePri(maxRate),
          groupKey: 'auto_increment_exhausting',
          dimension: 'dataDesign',
          description: `自增列接近耗尽 — TOP ${Math.min(3, critical.length)}：${top3Display}；耗尽后 INSERT 会报 ER_AUTOINC_READ_FAILED`,
          currentValue: `最高 ${(maxRate*100).toFixed(0)}%（${top.schema}.${top.table}.${top.column}）`,
          recommendedValue: '升级该列为 BIGINT UNSIGNED（增至 ~1.8×10^19 上限）',
          action: 'pt-online-schema-change 在线改大表；小表直接 ALTER TABLE 即可',
          sql: [
            '-- pt-osc 在线变更（推荐，大表）：',
            `pt-online-schema-change --alter "MODIFY COLUMN ${top.column} BIGINT UNSIGNED NOT NULL AUTO_INCREMENT" \\`,
            `  D=${top.schema},t=${top.table},u=<user>,p=<pwd> --execute`,
            '-- 小表直接 ALTER：',
            `ALTER TABLE ${top.schema}.${top.table} MODIFY COLUMN ${top.column} BIGINT UNSIGNED NOT NULL AUTO_INCREMENT;`,
          ].join('\n'),
          node: nodeLabel(n),
          scope: 'node',
        });
      }
    }

    // 数据量 vs 内存（也属于参数推荐范畴）
    {
      const memGB = memTotalGB(n);
      const dbGB = Number(n.dbTotalSizeGB || 0);
      const Tdm = T.data_memory || {};
      const warnRatio = Tdm.ratio_warn ?? 10;
      const p1Ratio = Tdm.ratio_p1 ?? 50;
      if (memGB && dbGB > 0) {
        const ratio = dbGB / memGB;
        if (ratio > warnRatio) {
          push({
            type: 'data_to_memory_ratio_high',
            priority: ratio > p1Ratio ? 'P1' : 'P2',
            groupKey: `data_memory_ratio:${n.ip}`,
            dimension: 'performance',
            description: `数据集 ${dbGB.toFixed(0)} GB 是 RAM ${memGB.toFixed(0)} GB 的 ${ratio.toFixed(1)} 倍 — 工作集大概率无法常驻 buffer pool，会持续磁盘 IO`,
            currentValue: `${dbGB.toFixed(0)} GB 数据 / ${memGB.toFixed(0)} GB RAM = ${ratio.toFixed(1)}x`,
            recommendedValue: `扩容 RAM 到 ${Math.ceil(dbGB / 5)} GB（数据 / 5），或冷热分离 / 归档 / 分库`,
            action: '架构层调整（不是 SET GLOBAL 能改的）；评估扩容 / 冷数据归档 / 业务分表',
            sql: null,
            node: nodeLabel(n),
            scope: 'node',
          });
        }
      }
    }

    // ============== /v4.8 senior-DBA 规则 ==============

    // ----- 用户安全：host=% 按危险等级（v4.6：每级聚合，避免相同告警挤占报告）-----
    const wildcards = (n.users || []).filter(u => u.host === '%');
    const byLevel = { critical: [], high: [], medium: [] };
    for (const u of wildcards) {
      const cat = classifyWildcardUser(u.user);
      if (byLevel[cat.level]) byLevel[cat.level].push({ user: u.user, reason: cat.reason });
    }
    const userList = (arr) => arr.map(x => x.user).join('、');
    const sampleReason = (arr) => arr[0]?.reason || '';

    if (byLevel.critical.length > 0) {
      const list = byLevel.critical;
      // root 类账号通常只有 1 个，但保留聚合格式以备多账号场景
      const desc = list.length === 1
        ? `存在 host=% 的最高危用户：${list[0].user}（${list[0].reason}）`
        : `存在 host=% 的最高危用户 ${list.length} 个：${userList(list)}（${sampleReason(list)}）`;
      push({
        type: 'wildcard_critical',
        priority: 'P0',
        groupKey: `wildcard_critical:${n.ip}`,
        description: desc,
        node: nodeLabel(n),
        action: '立即收紧：限制为内网网段或固定 IP；至少删除 \'@\'%\' 项',
        sql: list.map(x => `DROP USER '${x.user}'@'%';\nCREATE USER '${x.user}'@'10.0.0.0/255.0.0.0' IDENTIFIED BY '<原密码>';\nGRANT <原权限> ON *.* TO '${x.user}'@'10.0.0.0/255.0.0.0';`).join('\n-- ----\n'),
        scope: 'cluster',
        affectedUsers: list.map(x => x.user),
      });
    }
    if (byLevel.high.length > 0) {
      const list = byLevel.high;
      const desc = list.length === 1
        ? `存在 host=% 的高风险用户：${list[0].user}（${list[0].reason}）`
        : `存在 host=% 的高风险用户 ${list.length} 个：${userList(list)}（${sampleReason(list)}）`;
      push({
        type: 'wildcard_high',
        priority: 'P1',
        groupKey: `wildcard_high:${n.ip}`,
        description: desc,
        node: nodeLabel(n),
        action: '限制到必要的主机/网段',
        scope: 'cluster',
        affectedUsers: list.map(x => x.user),
      });
    }
    if (byLevel.medium.length > 0) {
      const list = byLevel.medium;
      const desc = list.length === 1
        ? `存在 host=% 的业务用户：${list[0].user}（${list[0].reason}）`
        : `存在 host=% 的业务用户 ${list.length} 个：${userList(list)}（${sampleReason(list)}）`;
      push({
        type: 'wildcard_medium',
        priority: 'P2',
        groupKey: `wildcard_medium:${n.ip}`,
        description: desc,
        node: nodeLabel(n),
        action: '若业务来源固定，建议限制到具体网段以缩小攻击面',
        scope: 'cluster',
        affectedUsers: list.map(x => x.user),
      });
    }

    // ----- lower_case_table_names = 0 on Linux -----
    if (v.lower_case_table_names === '0' && /linux|el|centos|ubuntu|debian/i.test(n.osKernel || '')) {
      push({
        type: 'lct_zero_linux', priority: 'P3', groupKey: 'lct_zero_linux',
        description: `lower_case_table_names = 0（Linux 下大小写敏感，存在跨平台迁移风险）`,
        node: nodeLabel(n),
        action: '若需 Windows/macOS 兼容，建议设为 1（注意：MySQL 8.0 只能在 initdb 时设置）',
        scope: 'cluster',
      });
    }

    // ----- 从库并行复制未启用（评审反馈 #1；v4.8 阈值改为读 cfg.thresholds.replication.parallel_workers_data_gb_*）-----
    // 大数据量集群必须启用并行复制，否则单线程应用 binlog 在大事务下会延迟积压
    if (n.role !== 'primary' && n.replication?.isSlave) {
      const parW = Number(v.slave_parallel_workers || 0);
      const primary = nodes.find(nn => nn.role === 'primary');
      const dataSizeGB = Number(primary?.dbTotalSizeGB || n.dbTotalSizeGB || 0);
      const parP2Gb = T.replication?.parallel_workers_data_gb_p2 ?? 100;
      const parP1Gb = T.replication?.parallel_workers_data_gb_p1 ?? 500;
      if (parW === 0 && dataSizeGB >= parP2Gb) {
        const priority = dataSizeGB >= parP1Gb ? 'P1' : 'P2';
        push({
          type: 'slave_parallel_workers_zero',
          priority,
          groupKey: 'slave_parallel_workers_zero',
          description: `slave_parallel_workers = 0（并行复制未启用，集群数据量约 ${dataSizeGB.toFixed(0)} GB，大事务可能导致从库延迟积压）`,
          node: nodeLabel(n),
          action: '建议设为 8-16 + slave_parallel_type = LOGICAL_CLOCK（需 binlog_format=ROW，已满足）',
          sql: 'SET GLOBAL slave_parallel_type = LOGICAL_CLOCK;\nSET GLOBAL slave_parallel_workers = 16;\n# 然后 STOP SLAVE; START SLAVE; 生效',
          scope: 'cluster',
        });
      }
    }

    // ----- MySQL 版本 EOL 告警（评审反馈 #11）-----
    const eolInfo = mysqlVersionEolStatus(n.mysqlVersion);
    if (eolInfo && eolInfo.status !== 'supported') {
      push({
        type: `mysql_version_${eolInfo.status}`,
        priority: eolInfo.priority,
        groupKey: `mysql_version_${eolInfo.major}`,
        description: `MySQL ${eolInfo.major} 已${eolInfo.statusLabel}（${eolInfo.eolDate}）— 当前实例 ${n.mysqlVersion}`,
        node: nodeLabel(n),
        action: eolInfo.action,
        sql: eolInfo.status === 'eol'
          ? '# 升级路径示例（5.7 → 8.0）：\n# 1. 备份全量数据\n# 2. 用 mysql_upgrade_checker 检查兼容性\n# 3. 滚动升级从库 → 主从切换 → 升级旧主库'
          : null,
        scope: 'cluster',
      });
    }
  }

  // ----- 集群级：参数一致性 -----
  if (nodes.length > 1) {
    const keys = ['innodb_buffer_pool_size_in_mb', 'innodb_log_file_size_in_mb',
                  'max_connections', 'binlog_format', 'expire_logs_days',
                  'long_query_time', 'slow_query_log', 'wait_timeout'];
    for (const k of keys) {
      const vals = new Set(nodes.map(n => n.variables?.[k]).filter(v => v != null));
      if (vals.size > 1) {
        raw.push({
          type: 'param_inconsistent', priority: 'P2', groupKey: `param_inconsistent:${k}`,
          description: `节点间参数 ${k} 不一致：${[...vals].join(' / ')}`,
          node: '全部节点',
          action: '评估是否需要统一（部分参数允许节点差异）',
          status: '待处理', scope: 'cluster',
        });
      }
    }
  }

  return aggregateIssues(raw, nodes.length);
}

// ============== 把备份评估 / 安全合规结论提升为 issues ==============
// Codex #4：当前 assessBackup() / assessSecurity() 的严重项只出现在
// 第十五/十六章独立段，不进 issues[]，导致第一章问题汇总和第十七章行动
// 计划看不到「备份缺失」这类 P0。本函数把这两类评估的严重项注入 issues。
function promoteAssessmentIssues(issues, backup, security, totalNodes) {
  const extras = [];
  const nextSeq = issues.length;
  // v4.8：extras 也走 disabledRules / priorities 接管
  const pushExtra = (it) => {
    if (it && it.type && DISABLED_RULES.has(it.type)) return;
    if (it && it.type && PRIORITY_OVERRIDES[it.type]) {
      it.priority = PRIORITY_OVERRIDES[it.type];
    }
    extras.push(it);
  };

  // --- 备份评估 ---
  if (backup && backup.severity && backup.severity !== 'OK') {
    pushExtra({
      type: 'backup_capability',
      priority: backup.severity,   // P0 / P1 / P2
      groupKey: 'backup_capability',
      description: `备份能力评估：${backup.assessment}`,
      node: '全部节点',
      action: backup.hasTool
        ? '完善备份调度 / 制定备份策略 / 定期恢复演练'
        : '立即安装 xtrabackup（推荐）或 mariabackup；建立全量+增量+binlog 备份策略；异地保存',
      sql: backup.hasTool ? null : '# 安装 xtrabackup 示例\nyum install percona-xtrabackup-80 -y\n# 或: apt install xtrabackup',
      status: '待处理',
      scope: 'cluster',
      source: 'backup_assessment',
    });
  }

  // v4.7.2：第十六章「安全合规审计」已从报告移除，不再把 compliance_fail_* 提升到
  // issues[]，避免它们污染第一章问题汇总 / 第十六章行动计划。
  // 真正的安全风险（root@%、弱口令、复制账号 wildcard）依然由 wildcard_critical /
  // wildcard_high / wildcard_medium 等规则独立捕获，不会因此遗漏。
  // 如需重新启用合规审计章节，把这段还原 + render.js 取消 chapterSecurityCompliance 注释。
  /* (legacy: 提升 securityAssessment FAIL 到 issues)
  for (const item of (security?.items || [])) {
    if (item.status === 'FAIL') {
      const priority = item.id === 'no_wildcard_root' || item.id === 'no_empty_password'
        ? 'P0'
        : 'P1';
      extras.push({
        type: `compliance_fail_${item.id}`,
        priority,
        groupKey: `compliance_fail:${item.id}`,
        description: complianceFailureDescription(item),
        node: '全部节点',
        action: complianceAction(item.id),
        status: '待处理',
        scope: 'cluster',
        source: 'security_assessment',
      });
    }
  }
  */

  if (extras.length === 0) return issues;

  // 评审反馈 #6：root@% 在 wildcard_critical 和 compliance_fail_no_wildcard_root 中重复触发，
  // 同一问题两条 P0 会让客户误以为是独立两个问题。合并为单条 P0，标注双维度命中。
  let all = mergeDuplicateRootWildcard([...issues, ...extras]);

  // 重新排序 + 编号
  const ord = { P0: 0, P1: 1, P2: 2, P3: 3 };
  all.sort((a, b) => (ord[a.priority] - ord[b.priority]) || a.type.localeCompare(b.type));
  all.forEach((i, idx) => { i.seq = idx + 1; });
  return all;
}

// 合并 root@% 的双触发（评审反馈 #6）
function mergeDuplicateRootWildcard(items) {
  const wildcard = items.find(i => i.type === 'wildcard_critical' && /root/i.test(i.description || ''));
  const compliance = items.find(i => i.type === 'compliance_fail_no_wildcard_root');
  if (!wildcard || !compliance) return items;
  // 用 wildcard_critical 作为主条目（更具体），补充合规维度信息
  wildcard.description = `存在 host=% 的最高危用户 root（合规 + 安全双维度均触发：远程入侵敞口）`;
  wildcard.action = `${wildcard.action}\n（同时触发等保合规检查项：root 账号未限制 host=%）`;
  wildcard.dualTrigger = ['security_assessment', 'wildcard_user_check'];
  return items.filter(i => i !== compliance);
}

function complianceFailureDescription(item) {
  return `合规失败：${item.detail}`;
}

function complianceAction(id) {
  return ({
    strong_password_policy: '启用 validate_password 插件，强制密码复杂度与定期改密',
    no_wildcard_root: "立即执行：DROP USER 'root'@'%';（先确保有 root@localhost 等可用入口）",
    audit_log: '加载 audit log 插件（如 server_audit / Audit Log 商业版）',
    tls_enabled: '配置 ssl_cert/ssl_key/ssl_ca 启用 TLS',
    require_secure_transport: 'SET GLOBAL require_secure_transport = ON;（确认所有客户端支持 TLS 后再开）',
    innodb_encryption: '启用 InnoDB 透明加密（需 keyring 插件 + 重建表）',
    no_empty_password: "ALTER USER '<user>'@'<host>' IDENTIFIED BY '<strong_password>';",
    auth_plugin: "ALTER USER '<user>'@'<host>' IDENTIFIED WITH caching_sha2_password BY '<pwd>';",
    failed_login_baseline: '排查高失败 IP 是否为暴力破解；考虑接入 fail2ban',
  })[id] || '按合规框架要求整改';
}

// ============== 集群级聚合 ==============
// 同 groupKey 的多个 issue 合并为一条，节点列改成「全部节点」或具体 IP 列表
function aggregateIssues(raw, totalNodes) {
  const groups = new Map();
  for (const i of raw) {
    if (!groups.has(i.groupKey)) groups.set(i.groupKey, []);
    groups.get(i.groupKey).push(i);
  }
  const out = [];
  for (const items of groups.values()) {
    if (items.length === 1) {
      const it = { ...items[0] };
      delete it.groupKey;
      out.push(it);
      continue;
    }
    // 多节点合并
    const ips = items
      .map(i => (i.node.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/) || [])[1])
      .filter(Boolean);
    let nodeText;
    if (items.length >= totalNodes) {
      nodeText = '全部节点';
    } else if (items.length === 1) {
      nodeText = items[0].node;
    } else {
      nodeText = `${items.length}/${totalNodes} 节点：${ips.join('、')}`;
    }
    // 节点级 issue 描述可能含数字差异（如「30 张无主键表」 vs 「55 张」），合并时取最大值
    let desc = items[0].description;
    const counts = items.map(i => (i.description.match(/(\d+)\s*张/) || [])[1]).filter(Boolean).map(Number);
    if (counts.length > 1) {
      const max = Math.max(...counts);
      desc = items[0].description.replace(/\d+\s*张/, `${max} 张`);
    }
    const it = { ...items[0], description: desc, node: nodeText };
    delete it.groupKey;
    out.push(it);
  }
  // 排序 + 编号
  const ord = { P0: 0, P1: 1, P2: 2, P3: 3 };
  out.sort((a, b) => (ord[a.priority] - ord[b.priority]) || a.type.localeCompare(b.type));
  out.forEach((i, idx) => { i.seq = idx + 1; });
  return out;
}

// ============== 危险等级分类 ==============
function classifyWildcardUser(user) {
  const u = (user || '').toLowerCase();
  if (u === 'root' || /admin|dba|super/.test(u)) {
    return { level: 'critical', reason: 'root / 管理员账号，远程开放等同绑死全部权限' };
  }
  if (u === 'repl' || /replic/.test(u)) {
    return { level: 'high', reason: '复制账号，应限制为复制源节点 IP' };
  }
  if (/backup|dump/.test(u)) {
    return { level: 'high', reason: '备份账号，权限较广，建议限制到备份服务器' };
  }
  if (/zabbix|prometheus|nagios|monitor|exporter/.test(u)) {
    return { level: 'low', reason: '监控只读账号' };
  }
  if (/^ro|readonly/.test(u)) {
    return { level: 'low', reason: '只读账号' };
  }
  return { level: 'medium', reason: '业务账号，可能需要 host=%，但仍建议缩小为内网网段' };
}

// ============== 参数差异判断 ==============
function deriveParamDiffJudgments(nodes) {
  if (nodes.length < 2) return [];
  const out = [];
  const judge = (key, vals, primary, slaves) => {
    if (key === 'server_id') return { ok: true, reason: '正常（各节点必须唯一）' };
    if (key === 'read_only') {
      const primaryNodes = nodes.filter(n => n.role === 'primary');
      const replicaNodes = nodes.filter(n => n.role !== 'primary');
      const primaryReadonly = primaryNodes.filter(n => n.variables?.read_only !== '0');
      const writableReplicas = replicaNodes.filter(n => n.variables?.read_only !== '1');
      if (primaryReadonly.length === 0 && writableReplicas.length === 0) {
        return { ok: true, reason: '正常（主库 read_only=0 / 从库 read_only=1，主从取值不同是预期行为）' };
      }
      const details = [];
      if (primaryReadonly.length > 0) {
        details.push(`主库异常只读：${primaryReadonly.map(n => `${n.ip}=${n.variables?.read_only ?? '-'}`).join('、')}`);
      }
      if (writableReplicas.length > 0) {
        details.push(`从库未只读：${writableReplicas.map(n => `${n.ip}=${n.variables?.read_only ?? '-'}`).join('、')}`);
      }
      return details.length === 0
        ? { ok: true, reason: '正常（主写 0 / 从读 1）' }
        : { ok: false, reason: `异常：${details.join('；')}。主库 read_only=0、从库 read_only=1 才符合常规复制安全基线` };
    }
    if (key === 'expire_logs_days') {
      // 评审反馈 #3：从库保留更长 binlog 是合理的 PITR 设计，不应一律报异常
      const numeric = vals.map(v => Number(v)).filter(v => !isNaN(v));
      const primaryVal = Number(primary?.variables?.expire_logs_days);
      const slaveVals = (slaves || []).map(n => Number(n.variables?.expire_logs_days)).filter(v => !isNaN(v));
      const anyZero = numeric.includes(0);
      if (anyZero) {
        return { ok: false, reason: '异常：存在节点 expire_logs_days=0（永不过期），binlog 持续累积有打爆磁盘风险' };
      }
      // 从库均 ≥ 主库 → 合理 PITR 设计
      if (slaveVals.length > 0 && !isNaN(primaryVal)
          && slaveVals.every(v => v >= primaryVal)
          && (Math.max(...slaveVals) - primaryVal) <= 30) {
        return { ok: true, reason: `合理：主库 ${primaryVal} 天，从库保留更长（${Math.max(...slaveVals)} 天）可支持 PITR 回溯，若属设计意图可忽略` };
      }
      return { ok: false, reason: '异常：节点间 binlog 保留策略不一致，影响 PITR 一致性' };
    }
    if (key === 'long_query_time') return { ok: false, reason: '异常：慢日志阈值不一致，影响 SQL 治理基准' };
    if (key === 'slow_query_log') return { ok: false, reason: '异常：部分节点未开启慢日志' };
    if (['innodb_buffer_pool_size_in_mb', 'max_connections', 'innodb_log_file_size_in_mb'].includes(key)) {
      return { ok: false, reason: '异常：节点间核心参数不一致，建议统一' };
    }
    if (key === 'binlog_format') return { ok: false, reason: '异常：复制对端必须使用同一 binlog_format' };
    return { ok: false, reason: '建议统一' };
  };
  const allKeys = new Set();
  for (const n of nodes) {
    for (const k of Object.keys(n.variables || {})) allKeys.add(k);
  }
  // 只列那些"有差异的"
  const focusKeys = ['MySQL 版本', 'server_id', 'innodb_buffer_pool_size_in_mb',
                     'innodb_log_file_size_in_mb', 'max_connections',
                     'binlog_format', 'gtid_mode', 'read_only',
                     'expire_logs_days', 'long_query_time', 'slow_query_log',
                     'sync_binlog', 'innodb_flush_log_at_trx_commit',
                     'transaction_isolation', 'wait_timeout'];
  for (const k of focusKeys) {
    let vals;
    if (k === 'MySQL 版本') {
      vals = nodes.map(n => n.mysqlVersion);
    } else {
      vals = nodes.map(n => n.variables?.[k]);
    }
    const uniq = [...new Set(vals.filter(v => v != null))];
    if (uniq.length > 1) {
      const j = judge(k, vals, nodes.find(n=>n.role==='primary'), nodes.filter(n=>n.role!=='primary'));
      const valueMap = nodes
        .map((n, idx) => `${n.ip}（${roleLabel(n.role)}）=${vals[idx] == null ? '-' : vals[idx]}`)
        .join('；');
      out.push({ key: k, values: vals, unique: uniq, valueMap, ...j });
    }
  }
  return out;
}

// ============== 根因关联分析 ==============
// v4.9 重写：根因关联以「数据交叉验证」为原则。每条关联：
//   1) 引用具体数值（uptime XX 天 / qps YY / 磁盘 Z%）让客户看了不必猜
//   2) 模糊措辞「可能/疑似」改为「已确认 / 数据不足以判定 / 需进一步排查」
//   3) 能给出排除项的就列出（例如「已排除 A、B 因素」）
function deriveCorrelations(nodes, issues) {
  const corrs = [];
  const findIssue = (type) => issues.find(i => i.type === type);
  const primary = nodes.find(n => n.role === 'primary');
  const fmtBytesShort = (b) => {
    if (b == null) return '-';
    if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB';
    if (b >= 1048576) return (b / 1048576).toFixed(0) + ' MB';
    if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
    return b + ' B';
  };

  // ====================================================================
  // C1. 节点磁盘高位 — 用 diskAttribution 拆出主因（binlog / slowLog / errorLog / relayLog / ibtmp1）
  // ====================================================================
  for (const n of nodes) {
    const v = n.variables || {};
    const highDiskDisk = (n.disks || []).find(d => parseInt((d.usePct||'0').replace('%',''))>=80);
    if (!highDiskDisk) continue;
    const attr = n.diskAttribution;
    if (!attr || attr.totalBytes === 0) {
      // 老 collector 数据未采集到子目录大小，退化为旧文案
      if (v.expire_logs_days === '0' || Number(v.expire_logs_days||0) > 30) {
        corrs.push({
          title: `节点 ${n.ip} 磁盘高位（${highDiskDisk.usePct}），binlog 保留策略可能是主因`,
          detail: `该节点 expire_logs_days = ${v.expire_logs_days}（${v.expire_logs_days==='0'?'永不过期':'保留过长'}），但本次采集未获得 binlog/slow_log/error_log 子目录大小，无法定量归因。`,
          suggestion: `升级 collector 到 v3.1+（已包含 Datadir size / Relay log directory 段）重新采集，或手工 du -sh 各日志目录后重新评估。`,
        });
      }
      continue;
    }
    // 有 diskAttribution：明确指出主因
    const top1 = attr.top[0];
    const top2 = attr.top[1];
    const topKindCN = { binlog: 'binlog 文件', slowLog: '慢日志', errorLog: '错误日志', relayLog: 'relay log', ibtmp1: 'ibtmp1 临时表空间', datadir: 'datadir 整体' }[top1.kind] || top1.kind;
    const top1Pct = top1.pct != null ? (top1.pct * 100).toFixed(0) + '%' : '?';
    const detail = [
      `节点 ${n.ip} 磁盘 ${highDiskDisk.mount} 使用率 ${highDiskDisk.usePct}（已用 ${highDiskDisk.used} / ${highDiskDisk.total}）。`,
      `已采集子目录归因（合计 ${fmtBytesShort(attr.totalBytes)}）：`,
      attr.top.map(t => `  · ${({ binlog:'binlog', slowLog:'慢日志', errorLog:'错误日志', relayLog:'relay log', ibtmp1:'ibtmp1', datadir:'datadir' }[t.kind] || t.kind)} ${fmtBytesShort(t.bytes)} (${(t.pct*100).toFixed(0)}%)`).join('\n'),
      `主因明确：${topKindCN} 占 ${top1Pct}（${fmtBytesShort(top1.bytes)}）${top2 ? `；次因：${({binlog:'binlog',slowLog:'慢日志',errorLog:'错误日志',relayLog:'relay log',ibtmp1:'ibtmp1',datadir:'datadir'}[top2.kind] || top2.kind)} ${(top2.pct*100).toFixed(0)}%` : ''}。`,
    ].join('\n');
    // 给出针对性 SQL
    let suggestion;
    if (top1.kind === 'binlog') {
      const cur = v.expire_logs_days;
      suggestion = `binlog 是主因（${top1Pct}）。检查并下调保留：\n  SET GLOBAL expire_logs_days = 7;\n  PURGE BINARY LOGS BEFORE NOW() - INTERVAL 7 DAY;\n当前 expire_logs_days=${cur}${cur==='0'?'（永不过期，问题已确认）':cur>30?'（保留 '+cur+' 天偏长）':''}。`;
    } else if (top1.kind === 'slowLog') {
      suggestion = `慢日志是主因（${top1Pct}）。回收：\n  mv slow.log slow.log.$(date +%F)  &&  FLUSH SLOW LOGS;\n并核查 log_queries_not_using_indexes 是否误开（=ON 时所有无索引查询都会进慢日志）。`;
    } else if (top1.kind === 'errorLog') {
      suggestion = `错误日志是主因（${top1Pct}）。回收：\n  mv mysqld.log mysqld.log.$(date +%F)  &&  FLUSH ERROR LOGS;\n并 tail -200 排查 ${n.errorLogAnalysis?.errorCount > 0 ? `已采集到 ${n.errorLogAnalysis.errorCount} 条错误，建议复盘` : '是否有频繁告警刷盘'}。`;
    } else if (top1.kind === 'relayLog') {
      suggestion = `relay log 是主因（${top1Pct}）— 通常意味着从库 SQL 线程跟不上 IO 线程。检查 Seconds_Behind_Master 与 parallel_workers 配置。`;
    } else if (top1.kind === 'ibtmp1') {
      suggestion = `ibtmp1 是主因（${top1Pct}）。配置 :max: 上限后重启回收：\n  innodb_temp_data_file_path = ibtmp1:12M:autoextend:max:50G\n并追查触发磁盘临时表的 SQL（filesort / Using temporary）。`;
    } else {
      suggestion = `主因是 ${topKindCN}，详细排查方向请见对应章节。`;
    }
    corrs.push({
      title: `节点 ${n.ip} 磁盘高位（${highDiskDisk.usePct}）— 主因：${topKindCN}（${top1Pct}）`,
      detail,
      suggestion,
    });
  }

  // ====================================================================
  // C2. 全集群持久化偏弱（已是明确判定，措辞 OK）
  // ====================================================================
  const allWeakFlush = nodes.every(n => n.variables?.innodb_flush_log_at_trx_commit === '0');
  const allWeakSync = nodes.every(n => n.variables?.sync_binlog === '0');
  if (allWeakFlush && allWeakSync && nodes.length > 1) {
    corrs.push({
      title: '全集群持久化强度偏低（已确认）',
      detail: `${nodes.length} 个节点全部 innodb_flush_log_at_trx_commit=0 + sync_binlog=0。MySQL 性能最高、可靠性最低的组合。RPO 估算：断电将丢失最近 1 秒事务（最多）+ 1 秒未 fsync 的 binlog 事件。`,
      suggestion: `生产主库强烈推荐 (1, 1)。若对写性能极敏感，可降级为 (2, 100)，但不应同时为 (0, 0)。`,
    });
  }

  // ====================================================================
  // C3. 主库慢查询累积 ↔ ibtmp1 偏大（用比率精确判定）
  // ====================================================================
  if (primary && Number(primary.slowQueries||0) > 1000000 && primary.ibtmp1?.sizeBytes > 5 * 1073741824) {
    const slowPct = primary.questions ? (Number(primary.slowQueries) / Number(primary.questions) * 100).toFixed(3) : '?';
    corrs.push({
      title: `主库慢查询累积与 ibtmp1 增长强相关`,
      detail: `主库 ${primary.ip}：累计慢查询 ${Number(primary.slowQueries).toLocaleString()} 次（占总查询 ${slowPct}%）+ ibtmp1 已达 ${primary.ibtmp1.sizeFormatted}。业务中存在大量复杂查询（GROUP BY / ORDER BY / 多表 JOIN）触发磁盘临时表，已基本确认。`,
      suggestion: `pt-query-digest /path/to/slow.log | head -200  ↓\n重点排查 Using filesort / Using temporary 的 SQL，加索引或改写。修复后可显著降低 ibtmp1 增长速度。`,
    });
  }

  // ====================================================================
  // C4. 从库间 ibtmp1 大小差异 — 用 uptime 与 qps 交叉验证主因
  // v4.9 重大改写：之前默认说「重启时间不同」是猜测；现在基于实际 uptimeSec 判定
  // ====================================================================
  const slaveIbtmps = nodes.filter(n => n.role !== 'primary' && n.ibtmp1?.sizeBytes != null);
  if (slaveIbtmps.length >= 2) {
    const sizes = slaveIbtmps.map(n => n.ibtmp1.sizeBytes);
    const max = Math.max(...sizes), min = Math.min(...sizes);
    if (max > min * 4 && max > 1073741824) {
      const maxN = slaveIbtmps[sizes.indexOf(max)];
      const minN = slaveIbtmps[sizes.indexOf(min)];
      // 三种情形分别判定
      const haveUptime = slaveIbtmps.every(n => n.uptimeSec);
      const uptimeMax = haveUptime ? Math.max(...slaveIbtmps.map(n => n.uptimeSec)) : null;
      const uptimeMin = haveUptime ? Math.min(...slaveIbtmps.map(n => n.uptimeSec)) : null;
      const uptimeDiffDays = haveUptime ? (uptimeMax - uptimeMin) / 86400 : null;
      // 重启时间差超过 7 天才视为「重启时间不同」是有效因素
      const uptimeDiffSignificant = uptimeDiffDays && uptimeDiffDays > 7;
      // qps 差异：从库间 qps 差异 > 2 倍说明读业务不同
      const qpsAll = slaveIbtmps.map(n => Number(n.qps || 0)).filter(q => q > 0);
      const qpsDiffSignificant = qpsAll.length >= 2 && Math.max(...qpsAll) > Math.min(...qpsAll) * 2;

      let detailLines = [
        `各从库 ibtmp1 占用差异显著：最小 ${minN.ibtmp1.sizeFormatted}（${minN.ip}，uptime ${formatUptimeShort(minN.uptimeSec)}） · 最大 ${maxN.ibtmp1.sizeFormatted}（${maxN.ip}，uptime ${formatUptimeShort(maxN.uptimeSec)}），相差 ${(max/min).toFixed(1)}× 。`,
      ];
      let causes = [];
      if (uptimeDiffSignificant) {
        causes.push(`【已确认】节点间重启时间差 ${uptimeDiffDays.toFixed(0)} 天（ibtmp1 重启会重置归零，长 uptime 节点累积更多）`);
      } else if (haveUptime) {
        causes.push(`【已排除】重启时间相近（差异仅 ${uptimeDiffDays.toFixed(1)} 天，不足以解释 ibtmp1 ${(max/min).toFixed(1)}× 差异）`);
      }
      if (qpsDiffSignificant) {
        causes.push(`【已确认】从库间 qps 差异显著（最小 ${Math.min(...qpsAll).toFixed(0)} / 最大 ${Math.max(...qpsAll).toFixed(0)}，相差 ${(Math.max(...qpsAll)/Math.min(...qpsAll)).toFixed(1)}× ，读业务不均衡是因素之一）`);
      } else if (qpsAll.length >= 2) {
        causes.push(`【已排除】从库间 qps 接近（${Math.min(...qpsAll).toFixed(0)} ~ ${Math.max(...qpsAll).toFixed(0)}，读业务相对均衡）`);
      }
      if (causes.length === 0) {
        causes.push(`【需进一步排查】未采集到充分的 uptime / qps 数据，建议手工对比节点重启时间与读 SQL 分布`);
      }
      detailLines.push('交叉验证：');
      causes.forEach(c => detailLines.push('  · ' + c));

      corrs.push({
        title: '从库间 ibtmp1 大小差异显著',
        detail: detailLines.join('\n'),
        suggestion: uptimeDiffSignificant
          ? '本身不需处理（重启时间不同是已知原因）；如要统一，配置 :max: 上限后逐个重启回收即可。'
          : qpsDiffSignificant
            ? '检查从库读流量分配（例如代理层 / 应用层 ReadOnly 路由），看是否需要调整流量均衡。'
            : '建议手工对比节点 uptime 与读 SQL 模式，确定主因后再制定统一回收方案。',
      });
    }
  }

  // ====================================================================
  // C5. 全集群 root@% 风险（已是明确判定）
  // ====================================================================
  const allRootWildcard = nodes.every(n =>
    (n.users || []).some(u => u.user === 'root' && u.host === '%')
  );
  if (allRootWildcard && nodes.length > 1) {
    corrs.push({
      title: '集群所有节点均存在 root@% 账号（已确认）',
      detail: `任意可达 3306 端口的网络位置都可尝试 root 登录。最高级别的远程入侵敞口；密码弱 / 泄漏即可拿到完整数据库控制权。`,
      suggestion: `立即在所有节点执行：DROP USER 'root'@'%';   只保留 root@localhost / 127.0.0.1 / ::1。`,
    });
  }

  // ====================================================================
  // C6. 灾备/从库内存利用率低 — 用 uptime 区分「冷重启未预热」vs「工作集 cold」
  // v4.9 重大改写：以前的「可能未预热」是猜测；现在用 uptimeSec 量化判定
  // ====================================================================
  if (primary && primary.memUsagePct) {
    const lowMemNodes = nodes.filter(n => n.role !== 'primary' && Number(n.memUsagePct||0) < Number(primary.memUsagePct) - 30);
    if (lowMemNodes.length > 0) {
      const lines = [];
      lines.push(`主库 ${primary.ip} 内存使用率 ${primary.memUsagePct}%，uptime ${formatUptimeShort(primary.uptimeSec)}。`);
      for (const dn of lowMemNodes) {
        const upDays = dn.uptimeSec ? (dn.uptimeSec / 86400).toFixed(0) : '?';
        const cause = !dn.uptimeSec
          ? '【未采集 uptime，需进一步排查】'
          : dn.uptimeSec < 7 * 86400
            ? '【已确认】最近 7 天内重启过，buffer pool 未预热（暖期通常 1-3 天）'
            : dn.uptimeSec < 30 * 86400
              ? `【已确认】uptime 仅 ${upDays} 天，仍处于工作集预热中期`
              : '【已排除冷启动】uptime 已 ' + upDays + ' 天足够预热；低内存使用率反映读负载本就轻 / 工作集偏小，资源配置存在浪费';
        lines.push(`  · ${dn.ip}（${dn.role}）：内存 ${dn.memUsagePct}% / uptime ${formatUptimeShort(dn.uptimeSec)} → ${cause}`);
      }
      const allWarm = lowMemNodes.every(n => n.uptimeSec && n.uptimeSec >= 30 * 86400);
      corrs.push({
        title: allWarm
          ? '部分节点内存利用率显著低于主库 — 工作集偏小或资源浪费（已确认）'
          : '部分节点内存利用率显著低于主库 — 含未预热节点',
        detail: lines.join('\n'),
        suggestion: allWarm
          ? '该节点上的读负载或 working set 较小，buffer_pool_size 可下调；若准备承接主库切换，需先预热 buffer pool。'
          : '启用 innodb_buffer_pool_dump_at_shutdown=ON + innodb_buffer_pool_load_at_startup=ON，重启后会自动加载上一次的 buffer pool 内容加速预热。',
      });
    }
  }

  // ====================================================================
  // 以下为 v4.9 新增 10 条 senior-DBA 根因关联
  // ====================================================================

  // C7. 复制延迟根因拆解：parallel_workers / 大事务 / 主从 qps 差异
  const laggySlaves = nodes.filter(n => {
    const sbm = Number(n.replication?.status?.secondsBehindMaster || 0);
    return n.replication?.isSlave && sbm > 60;
  });
  if (laggySlaves.length > 0 && primary) {
    const worst = laggySlaves.sort((a, b) => Number(b.replication.status.secondsBehindMaster) - Number(a.replication.status.secondsBehindMaster))[0];
    const sbm = Number(worst.replication.status.secondsBehindMaster);
    const parW = Number(worst.variables?.slave_parallel_workers || 0);
    const primQps = Number(primary.qps || 0);
    const slaveQps = Number(worst.qps || 0);
    const causes = [];
    if (parW === 0) causes.push(`【已确认】slave_parallel_workers = 0（单线程应用 binlog，无法跟上主库写入）`);
    if (primQps > 1000 && parW === 0) causes.push(`【已确认】主库 qps ${primQps.toFixed(0)} 较高，需要并行复制才能跟上`);
    if (slaveQps > primQps) causes.push(`【已确认】从库 qps ${slaveQps.toFixed(0)} > 主库 ${primQps.toFixed(0)}，从库被读负载挤占复制线程资源`);
    if (worst.variables?.binlog_format !== 'ROW') causes.push(`【已确认】binlog_format = ${worst.variables?.binlog_format}，并行复制需 ROW 格式`);
    if (causes.length > 0) {
      corrs.push({
        title: `从库 ${worst.ip} 复制延迟 ${sbm} 秒 — 已定位根因`,
        detail: causes.join('\n'),
        suggestion: parW === 0
          ? `SET GLOBAL slave_parallel_type = LOGICAL_CLOCK;\nSET GLOBAL slave_parallel_workers = 16;\nSTOP SLAVE; START SLAVE;\n（需 binlog_format=ROW，目前${worst.variables?.binlog_format === 'ROW' ? '已满足' : '不满足，需先改'}）`
          : `已启用并行复制（workers=${parW}）。排查方向：主库大事务、从库 IO 能力、binlog 行变更密度。pt-stalk + SHOW PROCESSLIST 抓现场。`,
      });
    }
  }

  // C8. Swap 压力级联：swap_used + qps + bp_size vs RAM
  for (const n of nodes) {
    const swapUsedPct = Number(n.swapUsagePct || 0);
    if (swapUsedPct <= 0) continue;
    const memGB = memTotalGB(n);
    const bpMB = mb(n, 'innodb_buffer_pool_size_in_mb');
    const qps = Number(n.qps || 0);
    if (!memGB || !bpMB) continue;
    const bpRatio = (bpMB / 1024) / memGB;
    const causes = [];
    if (bpRatio > 0.7) causes.push(`【已确认】innodb_buffer_pool ${(bpMB/1024).toFixed(1)} GB 占 RAM ${memGB.toFixed(0)} GB 的 ${(bpRatio*100).toFixed(0)}%，与 OS / 连接 / 其它进程内存竞争`);
    if (qps > 500) causes.push(`【已确认】qps ${qps.toFixed(0)} 工作负载活跃，内存压力下 Swap 会持续被使用`);
    if (Number(n.variables?.max_connections || 0) > 1000) causes.push(`【已确认】max_connections=${n.variables.max_connections}，单连接 buffer 累积放大内存压力`);
    if (causes.length > 0) {
      corrs.push({
        title: `节点 ${n.ip} Swap 已使用 ${n.swapUsed}（${swapUsedPct}%）— 内存压力链路`,
        detail: causes.join('\n'),
        suggestion: `三项处置：① 下调 innodb_buffer_pool_size 至 RAM 60%（当前 ${(bpRatio*100).toFixed(0)}%）；② sysctl -w vm.swappiness=1；③ 评估扩容内存到 ${Math.ceil(memGB * 1.5)} GB。\n参考：v4.8 新增 bp_too_large / max_connections_vs_memory 规则。`,
      });
      break;  // 同集群通常配置一致，只展示一个代表节点
    }
  }

  // C9. OS EOL + MySQL EOL 双重生命周期风险
  const eolNodes = nodes.filter(n => n.osEolStatus?.status === 'eol');
  const mysqlEolPrimary = primary?.mysqlVersion && /^(5\.5|5\.6|5\.7)/.test(primary.mysqlVersion);
  if (eolNodes.length > 0 && mysqlEolPrimary) {
    const osMajor = eolNodes[0].osEolStatus.major;
    corrs.push({
      title: 'OS 与 MySQL 同时进入 EOL 状态（双重风险）',
      detail: `操作系统：${osMajor}（${eolNodes[0].osEolStatus.eolDate}） · MySQL：${primary.mysqlVersion}\n两者都已停止官方安全更新，0-day 漏洞与补丁来源都缺失。任何安全审计/合规检查会重点指出此项。`,
      suggestion: `规划「OS 升级 + MySQL 升级」联合迁移：①​ 备份 + 演练 ②​ 准备新版本备机 ③​ 应用兼容性测试（mysql_upgrade_checker） ④​ 切换主备并验证 ⑤​ 旧节点降级为只读后下线。整体周期 1-3 个月。`,
    });
  }

  // C10. 慢日志膨胀：slowLogSizeBytes 大 + log_queries_not_using_indexes 误开
  for (const n of nodes) {
    if (!n.slowLogSizeBytes || n.slowLogSizeBytes < 1024 * 1024 * 1024) continue;  // 1 GB 起算
    const slowLogGB = (n.slowLogSizeBytes / 1073741824).toFixed(1);
    const v = n.variables || {};
    const lqnui = v.log_queries_not_using_indexes;
    const lqt = Number(v.long_query_time || 0);
    const causes = [];
    if (lqnui === 'ON' || lqnui === '1') causes.push(`【已确认】log_queries_not_using_indexes = ON（所有无索引查询都会写入慢日志，是膨胀首要因素）`);
    if (lqt > 0 && lqt < 1) causes.push(`【已确认】long_query_time = ${lqt}（阈值过低，正常 SQL 也会被记录）`);
    if (Number(n.slowQueries || 0) > 1_000_000) causes.push(`【已确认】累计慢查询 ${Number(n.slowQueries).toLocaleString()} 次（业务存在大量真实慢 SQL）`);
    if (causes.length > 0) {
      corrs.push({
        title: `节点 ${n.ip} 慢日志已 ${slowLogGB} GB — 已定位膨胀因素`,
        detail: causes.join('\n'),
        suggestion: `① 关闭 log_queries_not_using_indexes（如非排查期）：SET GLOBAL log_queries_not_using_indexes = OFF；\n② 调整 long_query_time = 1（标准生产值）：SET GLOBAL long_query_time = 1;\n③ 回滚日志：mv slow.log slow.log.archive && FLUSH SLOW LOGS；\n④ 用 pt-query-digest 分析归档慢日志归类 TOP SQL 后再优化。`,
      });
      break;
    }
  }

  // C11. 错误日志暴涨：errorLogSizeBytes 大 + errorLogAnalysis 错误条数高
  for (const n of nodes) {
    if (!n.errorLogSizeBytes || n.errorLogSizeBytes < 100 * 1024 * 1024) continue;  // 100 MB 起算
    const errLogMB = (n.errorLogSizeBytes / 1048576).toFixed(0);
    const errCount = Number(n.errorLogAnalysis?.errorCount || 0);
    const warnCount = Number(n.errorLogAnalysis?.warningCount || 0);
    if (errCount + warnCount > 100) {
      corrs.push({
        title: `节点 ${n.ip} 错误日志 ${errLogMB} MB — 错误/告警频繁`,
        detail: `已采集错误日志 tail 中包含：错误 ${errCount} 条 + 警告 ${warnCount} 条（错误日志 ${errLogMB} MB 远超正常水平）。\n常见原因：复制中断后重连、PROCESSLIST 异常、磁盘 / IO 错误、参数告警等。`,
        suggestion: `tail -500 \$ERROR_LOG | grep -iE "ERROR|warning" | sort | uniq -c | sort -rn | head -20  → 找到 TOP 错误后逐一处置。处置后 mv 归档释放空间。`,
      });
      break;
    }
  }

  // C12. 持久化弱 + 高复制延迟 → 数据丢失风险窗口扩大
  if (allWeakFlush && allWeakSync && laggySlaves.length > 0 && primary) {
    const worstSbm = Math.max(...laggySlaves.map(n => Number(n.replication.status.secondsBehindMaster || 0)));
    corrs.push({
      title: '持久化偏弱 + 复制延迟同时存在 — RPO 风险窗口被放大',
      detail: `主库持久化（commit=0 + sync_binlog=0）+ 最大从库延迟 ${worstSbm} 秒。\n若主库宕机：① 主库本地丢失最近 ~1 秒事务；② 由于从库还有 ${worstSbm} 秒延迟，故障切换到从库后还会"丢失" ${worstSbm} 秒未来得及复制的事务。RPO ≈ ${worstSbm + 1} 秒（可见数据丢失）。`,
      suggestion: `两件事并行：① 主库立即改 sync_binlog=1 + innodb_flush_log_at_trx_commit=1（性能下降但可控）；② 开并行复制（slave_parallel_workers=16 + LOGICAL_CLOCK）把延迟压到 < 5 秒。`,
    });
  }

  // C13. 从库可写 + 复制延迟 → 数据漂移加剧
  const writableLaggyNodes = laggySlaves.filter(n => n.variables?.read_only === '0' || n.variables?.read_only === 'OFF');
  if (writableLaggyNodes.length > 0) {
    for (const wn of writableLaggyNodes) {
      const sbm = Number(wn.replication.status.secondsBehindMaster);
      corrs.push({
        title: `从库 ${wn.ip} 可写 + 延迟 ${sbm} 秒 — 数据漂移风险加剧`,
        detail: `节点 read_only=0（允许写入）且 Seconds_Behind_Master=${sbm}。任意误写都会与主库永久不同步；延迟越大窗口越宽。`,
        suggestion: `SET GLOBAL read_only = 1; SET GLOBAL super_read_only = 1;\n如果是 DR 切换设计预留的可写，文档化该例外并设监控告警。`,
      });
    }
  }

  // C14. 自增列耗尽 + 慢查询堆积：主键热点查询不利
  if (primary && (primary.autoIncrementUsage || []).some(x => Number(x.rate || 0) >= 0.7) && Number(primary.slowQueries || 0) > 100000) {
    const top = primary.autoIncrementUsage.sort((a, b) => Number(b.rate) - Number(a.rate))[0];
    corrs.push({
      title: `主键即将耗尽叠加慢查询累积 — 故障窗口正在临近`,
      detail: `主库 ${primary.ip}：${top.schema}.${top.table}.${top.column} 已使用 ${(top.rate*100).toFixed(0)}% + 累计慢查询 ${Number(primary.slowQueries).toLocaleString()} 次。\n业务规模增长 + 主键剩余空间不足 + 查询性能下滑，三者形成「故障窗口正在临近」的复合风险。`,
      suggestion: `优先级最高：pt-online-schema-change 把 ${top.table}.${top.column} 改为 BIGINT UNSIGNED（彻底解决主键耗尽）。同期跑 pt-query-digest 治理慢查询。两件事并行，避免主键耗尽前故障。`,
    });
  }

  // C15. 多节点 binlog 累积速率异常：同集群 binlog 大小差异显著
  if (nodes.length > 1) {
    const withBinlog = nodes.filter(n => n.binlogDirSizeBytes && n.uptimeSec);
    if (withBinlog.length >= 2) {
      const rates = withBinlog.map(n => ({ ip: n.ip, role: n.role, perDay: n.binlogDirSizeBytes / (n.uptimeSec / 86400) }));
      const maxR = Math.max(...rates.map(r => r.perDay));
      const minR = Math.min(...rates.map(r => r.perDay));
      if (maxR > minR * 5 && maxR > 1073741824) {  // 至少 1 GB/day
        const maxNode = rates.find(r => r.perDay === maxR);
        const minNode = rates.find(r => r.perDay === minR);
        corrs.push({
          title: `节点间 binlog 增长速率差异显著（${(maxR/minR).toFixed(0)}× ）`,
          detail: `${maxNode.ip}（${maxNode.role}）binlog ${fmtBytesShort(maxR)}/天 vs ${minNode.ip}（${minNode.role}）${fmtBytesShort(minR)}/天。\n如果是主从架构，主库 binlog 增量应近似（仅主库产生 binlog，从库 relay log 是接收）— 差异大暗示参数不一致或采集时点偏差。`,
          suggestion: `比对 max_binlog_size / binlog_row_image / log_slave_updates 等参数。从库通常 binlog_row_image=MINIMAL 可显著降低增量。`,
        });
      }
    }
  }

  return corrs;
}

// ============== 建议推导（去重去冗）==============
function deriveRecommendations(nodes, issues) {
  const dedupe = (arr) => {
    const seen = new Set();
    return arr.filter(x => seen.has(x) ? false : seen.add(x));
  };
  const fmt = (i) => `${i.description}：${i.action}`;
  const p0 = issues.filter(i => i.priority === 'P0').map(fmt);
  const p1 = issues.filter(i => i.priority === 'P1').map(fmt);
  const p2 = issues.filter(i => i.priority === 'P2').map(fmt);
  const recs = {
    immediate: dedupe(p0),
    shortTerm: dedupe(p1),
    midTerm: dedupe(p2),
    longTerm: [],
  };
  if (nodes.length >= 3) {
    recs.longTerm.push('启用半同步复制 + 故障自动切换（如 MHA / Orchestrator / MGR），提升 RPO/RTO');
  }
  recs.longTerm.push('建立慢查询日报机制（pt-query-digest），固化 SQL 治理流程');
  recs.longTerm.push('完善备份恢复演练制度，每季度执行一次恢复测试');
  recs.longTerm.push('建立监控告警体系（Zabbix / Prometheus + 钉钉/企微）覆盖：磁盘、延迟、QPS、连接数、慢查询、binlog 累积');
  return recs;
}

function roleLabel(role) {
  if (!role) return '未知';
  if (role === 'primary') return '主库';
  if (role === 'dr') return '灾备';
  if (/^slave/.test(role)) return '从库';
  return role;
}

// ============== MySQL 版本 EOL 状态表（评审反馈 #11）==============
// 数据来源：https://endoflife.date/mysql / Oracle / MariaDB 官方公告
const MYSQL_EOL_TABLE = [
  { match: /^5\.5/,           major: '5.5',  status: 'eol',        eolDate: '2018-12 EOL',          priority: 'P0' },
  { match: /^5\.6/,           major: '5.6',  status: 'eol',        eolDate: '2021-02 EOL',          priority: 'P0' },
  { match: /^5\.7/,           major: '5.7',  status: 'eol',        eolDate: '2023-10 EOL',          priority: 'P1' },
  { match: /^8\.0/,           major: '8.0',  status: 'security',   eolDate: '2026-04 仅安全更新',    priority: 'P3' },
  { match: /^8\.4/,           major: '8.4',  status: 'supported',  eolDate: '至 2032-04（LTS）',      priority: null },
  { match: /^9\./,            major: '9.x',  status: 'supported',  eolDate: '创新版（短期支持）',      priority: null },
  { match: /^10\.\d/,         major: 'MariaDB 10.x', status: 'eol', eolDate: '具体子版本另查',         priority: 'P2' },
  { match: /^11\.[0-3]/,      major: 'MariaDB 11.0-11.3', status: 'eol', eolDate: '具体子版本另查',    priority: 'P2' },
];

function mysqlVersionEolStatus(versionStr) {
  if (!versionStr) return null;
  // 提取 major.minor.patch 前缀
  const m = versionStr.match(/(\d+\.\d+\.\d+)/);
  if (!m) return null;
  const ver = m[1];
  for (const row of MYSQL_EOL_TABLE) {
    if (row.match.test(ver)) {
      const statusLabel = row.status === 'eol' ? 'EOL（不再提供安全更新）'
        : row.status === 'security' ? '进入仅安全更新阶段'
        : '在支持期内';
      const action = row.status === 'eol'
        ? `规划升级到 8.0 或 8.4 LTS（${row.major} 不再发布安全补丁，无法满足等保合规对供应商支持的要求）`
        : row.status === 'security'
          ? '关注 EOL 时间点，提前规划升级到 8.4 LTS'
          : '保持持续小版本升级';
      return { major: row.major, status: row.status, statusLabel, eolDate: row.eolDate, priority: row.priority, action };
    }
  }
  return null;
}

main();

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
const { createEngine: createRuleEngine } = require('./rule-engine.js');
const ruleHelpers = require('./rule-helpers');

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

// v4.9.x：尝试多个段名别名（V3 新名 + V2/V1 老名），返回首个命中的内容
function getSectionAny(content, ...names) {
  for (const n of names) {
    const s = getSection(content, n);
    if (s) return s;
  }
  return '';
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
  // v4.9.5：之前的 regex `ibtmp1:([^:]+)` 会越过 ; 边界
  //         例如 `ibtmp1:500M;ibtmp2:500M:autoextend:max:5120M` 解出 `500M;ibtmp2`
  //         多 datafile 之间用 ; 分隔，这里把 ; 也加入终止符
  const cfgInitial = (cfg.match(/ibtmp1:([^:;]+)(?:[:;]|$)/i) || [])[1];
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
  // v4.9.x：兼容 V2/V1 老 collector 段名（db version / variables / replication / db size 等）
  const mysqlVer = getSectionAny(content, 'MySQL Database Version', 'db version');
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
  const variables = getSectionAny(content, 'MySQL Variables', 'variables');
  node.variables = parseVariables(variables);

  // -------- 补充变量段（VARIABLE_NAME/VARIABLE_VALUE 管道表格格式）--------
  const suppVars = getSection(content, 'Supplementary variables');
  if (suppVars) {
    parseMysqlTable(suppVars).rows.forEach(r => {
      if (r[0] && r[1] !== undefined) {
        const key = r[0].toLowerCase();
        if (!node.variables[key]) node.variables[key] = normalizeVarValue(r[1]);
      }
    });
  }

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
  const replSec = getSectionAny(content, 'MySQL Replication Info', 'replication');
  node.replication = parseReplication(replSec);

  // -------- 数据库清单（含字符集）--------
  const dbCharSec = getSection(content, 'database CHARACTER');
  node.databases = parseMysqlTable(dbCharSec).rows.map(r => ({
    name: r[0], charset: r[1], collation: r[2],
  }));

  // -------- 数据库总大小（过滤聚合行）--------
  const dbSize = getSectionAny(content, 'DB TOTAL SIZE', 'db size');
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
  const utf8Sec = getSectionAny(content, 'Not utf8 table', 'not utf8 table');
  node.nonUtf8Tables = parseMysqlTable(utf8Sec).rows.map(r => ({
    schema: r[0], table: r[1], collation: r[2],
  }));

  // -------- 无主键表 --------
  const noPkSec = getSectionAny(content, 'NO PRIMARY KEY TABLES', 'no primary key');
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

  // -------- Engine innodb status --------（V1/V2: "engine innodb status"; V3: "Engine innodb status"）
  const innodb = getSectionAny(content, 'Engine innodb status', 'engine innodb status');
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
  const weakPwdSec = getSection(content, 'Users with weak password');
  if (weakPwdSec || hasSection(content, 'Users with weak password')) {
    node.weakPasswordUsers = parseMysqlTable(weakPwdSec).rows.map(r => ({ user: r[0], host: r[1] }));
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
// v4.9.6 重写：
//  - 解析时间戳（ISO 8.0 / 5.7 老格式 / 5.6 老格式三种），计算距今天数
//  - 把内容按"模式签名"去重（同一个 [MY-011068] deprecated 警告打印 100 次只算一类）
//  - 把 MySQL 8.0 deprecation 警告（MY-011068 / MY-011069）单独归类
//    — 这类不是"错误"，是升级提示，全集群打印千百次仍然是 1 条信息量
//  - 区分"近 90 天内"vs"历史"（默认）
function analyzeErrorLog(text, opts = {}) {
  if (!text || text.trim().length === 0 || /不可读|未启用/.test(text)) {
    return { available: false, reason: '错误日志不可读' };
  }
  const recentDays = opts.recentDays || 90;
  const now = Date.now();
  const cutoff = now - recentDays * 86400 * 1000;
  const lines = text.split(/\r?\n/);

  const parseLineTs = (line) => {
    // 8.0 ISO 8601: 2022-12-07T14:50:40.341511+08:00
    let m = line.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
    if (m) return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
    // 5.7 vendor: 2018-07-30 11:12:13
    m = line.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (m) return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
    // 5.6 老格式：180730 11:12:13
    m = line.match(/^(\d{2})(\d{2})(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})/);
    if (m) {
      const yr = Number(m[1]) > 70 ? 1900 + Number(m[1]) : 2000 + Number(m[1]);
      return Date.parse(`${yr}-${m[2]}-${m[3]}T${String(m[4]).padStart(2,'0')}:${m[5]}:${m[6]}Z`);
    }
    return null;
  };

  // 内容签名：把数字、IP、路径、时间替换成占位符做去重
  const sig = (line) =>
    line.replace(/\d{4}-\d{2}-\d{2}T?\s*[\d:.+-Z]+/g, '<TS>')
        .replace(/\d+\.\d+\.\d+\.\d+/g, '<IP>')
        .replace(/\b\d{4,}\b/g, '<N>')
        .replace(/'[^']+'/g, "'<X>'")
        .replace(/`[^`]+`/g, '`<X>`')
        .replace(/\/[\w./-]+/g, '<PATH>')
        .replace(/\s+/g, ' ').trim().slice(0, 240);

  const buckets = {
    deprecated: new Map(),   // MySQL 8.0 deprecation 警告（去重）
    error: new Map(),
    warning: new Map(),
  };
  const startupEvents = [];
  let firstTs = null, lastTs = null;
  let recentErrors = 0, historicalErrors = 0;
  let recentWarnings = 0, historicalWarnings = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    const ts = parseLineTs(line);
    if (ts) {
      if (firstTs == null || ts < firstTs) firstTs = ts;
      if (lastTs == null || ts > lastTs) lastTs = ts;
    }
    const isRecent = ts != null ? ts >= cutoff : true;   // 无时间戳的行按"近期"算（兼容老格式）

    const isErr = /\[ERROR\]/.test(line) || (/\bERROR\b/.test(line) && !/\[Note\]/i.test(line));
    const isWarn = /\[Warning\]/i.test(line) || (/\bWarning\b/.test(line) && !/\[Note\]/i.test(line));
    // MY-011068 / MY-011069 是 8.0 重命名相关的 deprecation 通知（log_slave_updates / log_replica_updates 等）
    const isDeprecated = isWarn && /MY-01106[89]|deprecated/i.test(line);

    if (isDeprecated) {
      const k = sig(line);
      const bucket = buckets.deprecated.get(k) || { count: 0, sample: line, ts: ts };
      bucket.count++;
      bucket.ts = ts || bucket.ts;
      buckets.deprecated.set(k, bucket);
    } else if (isErr) {
      const k = sig(line);
      const bucket = buckets.error.get(k) || { count: 0, sample: line, ts: ts, recentCount: 0 };
      bucket.count++;
      if (isRecent) { bucket.recentCount++; recentErrors++; } else { historicalErrors++; }
      bucket.ts = ts || bucket.ts;
      buckets.error.set(k, bucket);
    } else if (isWarn) {
      const k = sig(line);
      const bucket = buckets.warning.get(k) || { count: 0, sample: line, ts: ts, recentCount: 0 };
      bucket.count++;
      if (isRecent) { bucket.recentCount++; recentWarnings++; } else { historicalWarnings++; }
      bucket.ts = ts || bucket.ts;
      buckets.warning.set(k, bucket);
    } else if (/ready for connections|shutdown|starting|aborted|crash/i.test(line)) {
      startupEvents.push(line);
    }
  }

  const fmtIso = (ts) => ts ? new Date(ts).toISOString().slice(0, 19).replace('T', ' ') : null;
  const ageDays = lastTs ? Math.floor((now - lastTs) / 86400 / 1000) : null;
  const spanDays = (firstTs && lastTs) ? Math.floor((lastTs - firstTs) / 86400 / 1000) : null;

  // 把 buckets 转换为按次数排序的数组
  const toTopArr = (m, limit = 5) => [...m.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map(x => ({ count: x.count, recentCount: x.recentCount, lastTs: fmtIso(x.ts), sample: x.sample.slice(0, 280) }));

  // 错误数 / 警告数：还是按"原始行数"返回（兼容老 issue 规则 errorCount 字段）
  const errorCount = [...buckets.error.values()].reduce((s, x) => s + x.count, 0);
  const warningCount = [...buckets.warning.values()].reduce((s, x) => s + x.count, 0);
  const deprecatedCount = [...buckets.deprecated.values()].reduce((s, x) => s + x.count, 0);

  return {
    available: true,
    totalLines: lines.length,
    firstTs: fmtIso(firstTs),
    lastTs: fmtIso(lastTs),
    ageDays,                          // 距今多少天（最后一条相对 now）
    spanDays,                         // 时间跨度
    recentDaysWindow: recentDays,
    errorCount, warningCount,
    deprecatedCount,                  // 8.0 deprecation 警告，独立计数
    recentErrors, historicalErrors,
    recentWarnings, historicalWarnings,
    topErrors: toTopArr(buckets.error, 5),
    topWarnings: toTopArr(buckets.warning, 5),
    deprecatedTop: toTopArr(buckets.deprecated, 5),
    startupEvents: startupEvents.slice(-20),
    // v4.9.6：兼容旧版字段（render 与 correlation 用过）
    errors: [...buckets.error.values()].slice(-20).map(x => x.sample),
    warnings: [...buckets.warning.values()].slice(-10).map(x => x.sample),
  };
}

// ============== 备份目录解析 ==============
// 评审 #9 (v4.4) 修复：原逻辑遇到 "[--] /path 不存在" 时会**覆盖** current 指针，
// 导致前一个正在累积的目录（含真实备份文件）被丢弃。
// 实测影响：10.10.10.4 节点 /data/backup 下有 93GB 真实备份产物
// （tbl_a_20240729.sql 48GB / tbl_b_20240724.sql 13GB /
// tbl_c_20240718.sql 36GB），但报告显示"未发现备份产物"。
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

// v4.9.x：识别光盘 / 可移动介质 / 系统伪文件系统，避免它们的 100% 占用被误报为 P0。
// 用户案例：/dev/sr0 挂载于 /run/media/root/RHEL-7.6 Server.x86_64，
// 这是 GUI 自动挂载的安装 ISO，100% 占用是设计如此，不需要清理或扩容。
//
// 返回值：'optical' / 'removable' / 'install-iso' / 'pseudo-fs' / null（真实磁盘）
function classifyDiskSpecial(d) {
  const dev = String(d.filesystem || '').toLowerCase();
  const mount = String(d.mount || '');
  // 1. 设备路径 → 光驱
  if (/^\/dev\/sr\d+/.test(dev) || /^\/dev\/cdrom/.test(dev) || /^\/dev\/dvd/.test(dev) || /^\/dev\/scd\d+/.test(dev)) {
    return 'optical';
  }
  // 2. 挂载路径 → 光驱 / 安装 ISO
  if (/^\/(mnt|media)\/(cdrom|dvd|cd-rom)/.test(mount.toLowerCase()) || /^\/(cdrom|dvd)\//.test(mount)) {
    return 'optical';
  }
  // 3. RHEL / CentOS / Ubuntu / Debian 安装 ISO 自动挂载标签
  //    （/run/media/<user>/<ISO-label> 是 systemd-udev 自动挂载点）
  if (/^\/run\/media\//.test(mount)) {
    if (/(RHEL|CentOS|Ubuntu|Debian|Fedora|SLES|openSUSE|Rocky|Alma)[-_ ]?\d/.test(mount)) {
      return 'install-iso';
    }
    return 'removable';   // 其它 /run/media/ 自动挂载（USB 等）
  }
  // 4. 系统伪文件系统（理论上 90% 阈值难触发，但保持显式排除）
  if (dev === 'tmpfs' || dev === 'devtmpfs' || dev === 'overlay' || dev === 'squashfs') {
    return 'pseudo-fs';
  }
  return null;
}

const DISK_SPECIAL_LABEL = {
  optical: '光驱（CD/DVD-ROM）',
  'install-iso': '安装 ISO 镜像（自动挂载）',
  removable: '可移动介质（USB / 移动硬盘）',
  'pseudo-fs': '系统伪文件系统',
};

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
    // V3 竖向 \G 格式：「  @@global.xxx: value」或「  xxx: value」
    let m = line.match(/^\s*(@@global\.)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/);
    if (m) {
      result[m[2]] = normalizeVarValue(m[3].trim());
      return;
    }
    // v4.9.x：V1/V2 SHOW VARIABLES 表格格式：「Variable_name<TAB>Value」
    m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\t(.+)$/);
    if (m && m[1] !== 'Variable_name') {
      result[m[1]] = normalizeVarValue(m[2].trim());
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
  // 支持的命名模式：dr-mysql / dr_db / drdb01 / dr01db / disaster / standby
  return /\bdr[-_]|\bdr\d*db|\bdrdb|disaster|standby/i.test(hint);
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
  // 1b. 单独的 test 表（demo_db.test 之类的）
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

// v4.9.x：当文件名不含 IP（老 collector 文件名只有日期，如 MySQL_Check2021-03-15_xx.txt），
// 退而求其次从「ip info」段（或文件开头 8 KB 任意 inet 行）抠出真实 IP。
// 跳过 loopback / link-local / docker 默认网段。
function inferIpFromContent(content) {
  const ipExclude = ip => ip === '127.0.0.1' || ip.startsWith('169.254.') ||
                          ip.startsWith('0.0.0.') || ip.startsWith('172.17.') /* docker0 */;
  // 优先 ip info 段
  const sec = getSection(content, 'ip info');
  if (sec) {
    for (const m of sec.matchAll(/inet\s+(\d+\.\d+\.\d+\.\d+)/g)) {
      if (!ipExclude(m[1])) return m[1];
    }
  }
  // 兜底：扫开头 8 KB（早期 collector 没 ip info 段，IP 在「IP:」标签下）
  const head = content.slice(0, 8192);
  for (const m of head.matchAll(/inet\s+(\d+\.\d+\.\d+\.\d+)/g)) {
    if (!ipExclude(m[1])) return m[1];
  }
  return null;
}

function inferInspectionDate(filename) {
  // MySQLHealthCheck_10.10.10.2_202604301023.txt → 2026-04-30
  // 10.10.10.2_apple_pri-2026-04-30.html → 2026-04-30
  const m1 = filename.match(/_(\d{4})(\d{2})(\d{2})\d{4}\.txt$/);
  if (m1) return `${m1[1]}-${m1[2]}-${m1[3]}`;
  const m2 = filename.match(/(\d{4})-(\d{2})-(\d{2})\.html$/);
  if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
  return null;
}

function inferProjectFromFilename(filename) {
  // 10.10.10.2_apple_pri-2026-04-30.html → apple
  const m = filename.match(/\d+\.\d+\.\d+\.\d+_([^_-]+)[_-]/);
  return m ? m[1] : null;
}

// 主流程
function main() {
  const allFiles = fs.readdirSync(dataDir);
  // v4.9.x：放宽文件名匹配以支持老版本 collector：
  // - 新版（V3）：MySQLHealthCheck_<IP>_<timestamp>.txt
  // - V2/V1 ：  MySQLHealthCheck_<date>.txt（无 IP）
  // - 早期变种：MySQL_Check_<date>.txt / MySQL_HealthCheck_*.txt
  // - 兜底：任意 .txt 内容含 "----->>>---->>>" 段标记
  const sectionMarker = '----->>>---->>>';
  const txtFiles = allFiles.filter(f => {
    if (!/\.txt$/i.test(f)) return false;
    if (/^(MySQLHealthCheck|MySQL_HealthCheck|MySQL_Check)/i.test(f)) return true;
    // 内容 sniff：开头 4 KB 含段标记则视为 collector 输出
    try {
      const head = fs.readFileSync(path.join(dataDir, f), 'utf-8').slice(0, 4096);
      return head.includes(sectionMarker);
    } catch (_) { return false; }
  });
  const htmlFiles = allFiles.filter(f => /\.html$/i.test(f));

  if (txtFiles.length === 0) {
    console.error(`错误：${dataDir} 下未找到任何巡检 txt 文件（接受文件名：MySQLHealthCheck_*.txt / MySQL_Check_*.txt / 内容含「----->>>---->>>」段标记）`);
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
  // v4.9.x：filename 没 IP 时退而读 ip info 段内容；都拿不到则用文件名兜底
  const byIp = {};
  for (const f of txtFiles) {
    let ip = inferIpFromFilename(f);
    if (!ip) {
      try {
        const content = fs.readFileSync(path.join(dataDir, f), 'utf-8');
        ip = inferIpFromContent(content);
      } catch (_) {}
    }
    if (!ip) ip = 'unknown-' + path.basename(f).replace(/\.txt$/i, '').slice(0, 20);
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
  // v4.9.3：措辞改为咨询性 — 数据库实际在正常运行，避免"紧急/立即"等
  //         alarmist 词汇把客户吓到。保留风险等级但用建议性语气。
  if (p0 > 0) return '运行整体稳定，识别出关键风险点，建议优先关注与处置' + scoreText;
  if (p1 > 0) return '运行整体稳定，存在若干重要风险点，建议近期规划处置' + scoreText;
  if (issues.length > 0) return '运行平稳，存在可优化项，建议持续完善' + scoreText;
  return '运行平稳，未发现明显风险' + scoreText;
}

// ============== 健康度评分 ==============
// 6 维度：可用性、安全性、性能、数据规范、持久化、运维规范
function computeHealthScore(nodes, issues) {
  // v4.9.3：评分模型重写 — 客户反馈「不能出现零分和很低的分数」。
  // 新模型：
  //   1) 单条规则惩罚减半（P0: 18→8, P1: 7→3, P2: 3→1.5, P3: 1→0.5）
  //   2) 同维度同优先级多条 issue 用递减惩罚，避免线性堆叠（第 1 条 100%，
  //      第 2 条 60%，第 3 条 40%，第 4 条 25%，第 5+ 条 15%）
  //   3) 每个维度有 50 分的下限（数据库在跑，最低也能反映"操作中但需关注"）
  //   4) 总分有 55 分下限，避免吓到客户
  //   5) backup / security 二次惩罚同步减半，因为已通过 issues 扣过分
  const dim = {
    availability: 100,
    security: 100,
    performance: 100,
    dataDesign: 100,
    durability: 100,
    operations: 100,
  };

  const BASE_PENALTY = { P0: 8, P1: 3, P2: 1.5, P3: 0.5 };
  const DIMINISH = [1.0, 0.6, 0.4, 0.25, 0.15];   // 同 (priority, dim) 第 1/2/3/4/5+ 条的倍率

  // 把 issue 按 (priority, dimension) 分桶以便递减计算
  const ordinalCounter = new Map();
  for (const i of issues) {
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
    if (!dimKey || dim[dimKey] == null) dimKey = 'availability';

    const key = `${i.priority}:${dimKey}`;
    const ord = (ordinalCounter.get(key) || 0) + 1;
    ordinalCounter.set(key, ord);
    const base = BASE_PENALTY[i.priority] || 0;
    const mult = DIMINISH[Math.min(ord - 1, DIMINISH.length - 1)];
    dim[dimKey] -= base * mult;
  }

  // 备份维度：没备份 / 没备份工具 → 二次扣分（已通过 issues 扣过一次，这里只补少量）
  const hasBackupTool = nodes.some(n => (n.backupTools || []).some(t => t.installed && /xtrabackup|mysqldump|mariabackup/.test(t.tool)));
  const hasBackupDir = nodes.some(n => (n.backupDirs || []).some(d => d.files && d.files.length > 0));
  if (!hasBackupTool) dim.operations -= 4;
  if (!hasBackupDir) dim.operations -= 4;
  const hasBackupCron = nodes.some(n => /mysql|backup|dump/i.test(n.mysqlCrontab || '') || /mysql|backup|dump/i.test(n.rootCrontab || '') || /mysql|backup|dump/i.test(n.systemCronBackup || ''));
  if (!hasBackupCron && (hasBackupDir || hasBackupTool)) dim.operations -= 2;

  // 安全维度：加密 / TLS / 审计 缺失各扣（同样减半）
  const hasEncryption = nodes.some(n => n.hasInnodbEncryption);
  const hasTls = nodes.some(n => n.tlsConfig?.have_ssl === 'YES');
  const hasAudit = nodes.some(n => n.hasAuditPlugin);
  if (!hasEncryption) dim.security -= 2;
  if (!hasTls) dim.security -= 2;
  if (!hasAudit) dim.security -= 1;

  // 每维度下限 50，上限 100（"数据库在跑，最差也是中等待改进"）
  for (const k of Object.keys(dim)) {
    dim[k] = Math.max(50, Math.min(100, Math.round(dim[k])));
  }

  // 总分：加权平均
  const weights = {
    availability: 0.25, security: 0.15, performance: 0.20,
    dataDesign: 0.10, durability: 0.20, operations: 0.10,
  };
  let total = 0;
  for (const k of Object.keys(dim)) total += dim[k] * weights[k];
  total = Math.round(total);
  // 总分下限 55（数据库正常运行的事实，应反映在评分里）
  total = Math.max(55, Math.min(100, total));

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
    else result.assessment = `最近备份已 ${ageDays} 天前，建议尽快重新执行全量备份并核实异地保存`;
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
    weakPasswordData:  nodes.some(n => n.weakPasswordUsers != null),
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

    mkItem('no_weak_password', '无弱密码账号',
      has.weakPasswordData,
      !nodes.some(n => (n.weakPasswordUsers || []).length > 0),
      'mysql_native_password 账号未发现常见弱密码',
      '发现使用常见弱密码的账号',
      '未采集弱密码检测（需 V3.0+ 采集脚本）'),

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
  const nodeLabel = (n) => `${n.ip}（${roleLabel(n.role)}）`;

  // ============== v5.0 GA：全规则走声明式引擎 ==============
  // 所有节点级 / 集群级规则定义在 scripts/rules/<dim>/*.json，
  // 复杂规则通过 scripts/rule-helpers/index.js 注册的 handler 计算，
  // 引擎自身在 scripts/rule-engine.js（零 eval，迷你 AST 求值器）。
  //
  // 备份评估 / 安全合规走 promoteAssessmentIssues 独立路径，不走引擎。
  // 节点预处理：补齐 handler / JSON 表达式所需的派生字段
  for (const n of nodes) {
    preprocessNode(n);
  }
  const engineIssues = createRuleEngine({
    rulesDir: path.join(__dirname, 'rules'),
    helpers: ruleHelpers,
  }).run({ nodes, cfg: hcConfig });
  for (const it of engineIssues) {
    raw.push({ status: '待处理', ...it });
  }

  function preprocessNode(n) {
    const v = n.variables || {};
    // 节点标签（{ip}（{role}）格式，与原 nodeLabel(n) 一致）
    n.label = nodeLabel(n);
    // 内存 / BP（数值，方便 handler 直接读）
    n.memGB = memTotalGB(n);
    n.bpMB = mb(n, 'innodb_buffer_pool_size_in_mb');
    // Swap 已使用判定（沿用原始 parseFloat 逻辑）
    if (n.swapTotal && n.swapFree && n.swapTotal !== n.swapFree) {
      const sm = parseFloat((n.swapTotal.match(/[\d.]+/) || [])[0]);
      const sfm = parseFloat((n.swapFree.match(/[\d.]+/) || [])[0]);
      n.swapUsed = !isNaN(sm) && !isNaN(sfm) && sm > sfm + 0.1;
    } else {
      n.swapUsed = false;
    }
    // TLS 弱协议（字符串或 null）
    n.tlsWeakDetail = tlsWeakProtocolDetail(n.tlsConfig);
    // ibtmp1 :max: 缺失
    const ibtmpPath = v.innodb_temp_data_file_path;
    n.ibtmp1NoMax = !!(ibtmpPath && !/:max:/i.test(ibtmpPath));
    // OS / MySQL 版本
    n.isLinux = /linux|el|centos|ubuntu|debian/i.test(n.osKernel || n.osRelease?.name || '');
    n.is80Plus = isMysql80Plus(n.mysqlVersion);
    n.osEolStatus = n.osEolStatus || null; // 已由前面 OS 解析填充
    n.mysqlEolStatus = mysqlVersionEolStatus(n.mysqlVersion);
    // sql_mode 严格模式缺失
    const modes = parseSqlMode(n.sqlMode || v.sql_mode);
    n.sqlModeMissingStrict = modes.size > 0
      && !modes.has('STRICT_TRANS_TABLES')
      && !modes.has('STRICT_ALL_TABLES');
    n.sqlModeStr = [...modes].join(',') || '(空)';
    // BP 命中率
    if (n.innodb?.bufferPoolHitRate) {
      const [hit, total] = n.innodb.bufferPoolHitRate.split('/').map(s => Number(s.trim()));
      if (hit && total) {
        n.bpHitPct = hit / total * 100;
        n.bpHitDisplay = `${hit}/${total}`;
      }
    }
    // 长会话 top
    const ls = businessLongSessions(n);
    if (ls.length > 0) {
      n.longSessTop = ls[0];
    }
    // 角色相关
    n.isDrNode = isDrNode(n);
    n.selfRefSlaveHost = n.replication?.selfReferencingSlaveResidue?.masterHost || null;
    // Linux + lct=0
    n.lctZeroLinux = v.lower_case_table_names === '0' && n.isLinux;
    // charset 非 utf8mb4
    const cs = v.character_set_server;
    n.charsetNotUtf8mb4 = !!(cs && !/utf8mb4/i.test(cs));
    // flush_method 非 O_DIRECT (Linux)
    const fm = v.innodb_flush_method;
    n.flushMethodNotODirect = !!(n.isLinux && fm && fm !== 'O_DIRECT' && fm !== 'O_DIRECT_NO_FSYNC');
    // auth plugin 8.0+ 仍 native
    n.authPluginNativeOn80 = !!(n.is80Plus && v.default_authentication_plugin === 'mysql_native_password');
    // slave_skip_errors（不能用 "" / null / "OFF" / "NONE" 直接表达，预算 boolean）
    const sse = v.slave_skip_errors || v.replica_skip_errors;
    n.slaveSkipErrorsValue = sse || '';
    n.slaveSkipErrorsSet = !!(sse && sse !== 'OFF' && sse !== '' && sse !== 'NONE' && sse !== 'off');
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
        : '建议优先安装 xtrabackup（推荐）或 mariabackup；建立全量+增量+binlog 备份策略；异地保存',
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
    no_wildcard_root: "建议优先执行：DROP USER 'root'@'%';（先确保有 root@localhost 等可用入口）",
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
    // v4.9.x：跳过光驱 / 安装 ISO / 可移动介质，避免它们的 100% 触发误关联
    const highDiskDisk = (n.disks || []).find(d =>
      parseInt((d.usePct || '0').replace('%', '')) >= 80 && !classifyDiskSpecial(d)
    );
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
      suggestion: `建议优先在所有节点执行：DROP USER 'root'@'%';   只保留 root@localhost / 127.0.0.1 / ::1。`,
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
      suggestion: `两件事并行：① 主库建议改 sync_binlog=1 + innodb_flush_log_at_trx_commit=1（性能下降但可控）；② 开并行复制（slave_parallel_workers=16 + LOGICAL_CLOCK）把延迟压到 < 5 秒。`,
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

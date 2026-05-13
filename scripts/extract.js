#!/usr/bin/env node
/**
 * MySQL 巡检数据提取器
 *
 * 用法：
 *   node extract.js <数据目录> [--project "项目名"] [--out data.json]
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
  console.error('用法: node extract.js <数据目录> [--project "项目名"] [--out data.json]');
  process.exit(1);
}
const dataDir = path.resolve(args[0]);
const opts = { project: null, out: null };
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--project') opts.project = args[++i];
  else if (args[i] === '--out') opts.out = args[++i];
}

if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
  console.error(`错误：目录不存在或不是目录：${dataDir}`);
  process.exit(1);
}

const outPath = opts.out
  ? path.resolve(opts.out)
  : path.join(dataDir, 'data.json');

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
      const after = line.split(marker)[1].trim();
      const matches = caseInsensitive
        ? after.toLowerCase().startsWith(sectionName.toLowerCase())
        : after.startsWith(sectionName);
      if (matches) {
        inSec = true;
        continue;
      }
      if (inSec) break; // 下一个段开始就停
    } else if (inSec) {
      result.push(line);
    }
  }
  return result.join('\n');
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

// ============== txt 解析器 ==============
function parseTxt(filepath) {
  const content = fs.readFileSync(filepath, 'utf-8');
  const node = { _file: path.basename(filepath) };

  // -------- 基础信息 --------
  const hostnameSec = getSection(content, 'hostname');
  node.hostname = hostnameSec.trim().split('\n')[0] || '';

  const kernel = getSection(content, 'os kernal') || getSection(content, 'os kernel');
  node.osKernel = (kernel.trim().split('\n')[0] || '').trim();

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
    node.swapTotal = fmtKB(Number(swapTotalMatch[1]));
    node.swapFree = swapFreeMatch ? fmtKB(Number(swapFreeMatch[1])) : '-';
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

  // resource limit
  const resLimit = getSection(content, 'resource limit');
  const openFilesMatch = resLimit.match(/open files\s+\([^)]+\)\s+(\d+)/i);
  node.openFilesLimit = openFilesMatch ? Number(openFilesMatch[1]) : null;

  // -------- MySQL 版本 / Uptime --------
  const mysqlVer = getSection(content, 'MySQL Database Version');
  const serverVerMatch = mysqlVer.match(/Server version:\s*(.+)/);
  node.mysqlVersion = serverVerMatch ? serverVerMatch[1].trim() : '-';
  const uptimeMatch = mysqlVer.match(/Uptime:\s*(.+)$/m);
  node.uptimeText = uptimeMatch ? uptimeMatch[1].trim() : '-';
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
  node.blobColumns = parseMysqlTable(blobSec).rows.length;

  // -------- Partitions --------
  const partSec = getSection(content, 'PARTITIONS table');
  node.partitionTables = parseMysqlTable(partSec).rows.length;

  // -------- Routines --------
  const routinesSec = getSection(content, 'ROUTINES OBJECTS');
  node.routines = parseMysqlTable(routinesSec).rows.map(r => ({
    schema: r[0], name: r[1], type: r[2], definer: r[3],
  }));

  return node;
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
      };
    }
  }
  return result;
}

// ============== 文件扫描与节点识别 ==============
function inferRole(filename) {
  const lower = filename.toLowerCase();
  if (/pri|master|primary/.test(lower)) return 'primary';
  if (/slave3/.test(lower)) return 'slave3';
  if (/slave2/.test(lower)) return 'slave2';
  if (/slave1/.test(lower)) return 'slave1';
  if (/slave|replica|standby/.test(lower)) return 'slave';
  return null;
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
      role: entry.role || inferRole(entry.txt || '') || 'unknown',
    };
    if (entry.txt) Object.assign(data, parseTxt(entry.txt));
    if (entry.html) Object.assign(data, parseHtml(entry.html));
    nodes.push(data);
  }

  // 自动识别主库（含 Slave_UUID 表，或文件名含 pri/master）
  let hasPrimary = nodes.some(n => n.role === 'primary');
  if (!hasPrimary) {
    const candidate = nodes.find(n => !n.replication?.isSlave && n.replication?.slaveIps);
    if (candidate) candidate.role = 'primary';
  }

  // ============== 自动分析与问题清单 ==============
  const issues = analyzeIssues(nodes);
  const correlations = deriveCorrelations(nodes, issues);
  const paramJudgments = deriveParamDiffJudgments(nodes);

  // ============== 构造输出 ==============
  const out = {
    schemaVersion: 2,
    project,
    inspectionDate,
    reportDate: new Date().toISOString().slice(0, 10),
    cluster: {
      name: project,
      topology: deriveTopology(nodes),
      nodeCount: nodes.length,
      ips: nodes.map(n => n.ip),
    },
    overallAssessment: deriveOverallAssessment(issues),
    issues,
    correlations,
    paramJudgments,
    nodes,
    recommendations: deriveRecommendations(nodes, issues),
  };

  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.error(`\n数据已写入 ${outPath}`);
  console.error(`  - 节点：${nodes.length} 个`);
  console.error(`  - 自动检出问题：${issues.length} 项 (P0:${issues.filter(i => i.priority === 'P0').length}, P1:${issues.filter(i => i.priority === 'P1').length}, P2:${issues.filter(i => i.priority === 'P2').length}, P3:${issues.filter(i => i.priority === 'P3').length})`);
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
function deriveOverallAssessment(issues) {
  const p0 = issues.filter(i => i.priority === 'P0').length;
  const p1 = issues.filter(i => i.priority === 'P1').length;
  if (p0 > 0) return '存在紧急风险，需立即处理';
  if (p1 > 0) return '总体平稳，存在需短期处理的重点问题';
  if (issues.length > 0) return '运行平稳，存在建议优化项';
  return '运行平稳，未发现明显问题';
}

// ============== 问题自动分析（节点级 → 集群级聚合）==============
function analyzeIssues(nodes) {
  const raw = [];
  const push = (it) => raw.push({ status: '待处理', ...it });
  const nodeLabel = (n) => `${n.ip}（${roleLabel(n.role)}）`;

  for (const n of nodes) {
    const v = n.variables || {};

    // ----- 资源类（节点级，groupKey 唯一）-----
    if (n.memUsagePct && Number(n.memUsagePct) > 90) {
      push({
        type: 'mem_high', priority: 'P1', groupKey: `mem_high:${n.ip}`,
        description: `内存使用率 ${n.memUsagePct}% 偏高`,
        node: nodeLabel(n), action: '关注业务负载与缓冲池配置，必要时扩容',
        scope: 'node',
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

    for (const d of (n.disks || [])) {
      const pct = parseInt((d.usePct || '0').replace('%', ''));
      if (pct >= 90) {
        push({
          type: 'disk_critical', priority: 'P0', groupKey: `disk:${n.ip}:${d.mount}`,
          description: `磁盘 ${d.mount} 使用率 ${d.usePct}（容量 ${d.total}，已用 ${d.used}）`,
          node: nodeLabel(n), action: '立即清理日志/历史数据 或 扩容',
          sql: `df -h ${d.mount}\nfind ${d.mount} -type f -size +1G -mtime +30 -exec ls -lh {} \\;`,
          scope: 'node',
        });
      } else if (pct >= 80) {
        push({
          type: 'disk_high', priority: 'P1', groupKey: `disk:${n.ip}:${d.mount}`,
          description: `磁盘 ${d.mount} 使用率 ${d.usePct}`,
          node: nodeLabel(n), action: '本周内规划清理或扩容',
          scope: 'node',
        });
      }
    }

    // ----- 复制类 -----
    if (n.replication?.isSlave) {
      const s = n.replication.status || {};
      const ioR = s.slaveIoRunning, sqlR = s.slaveSqlRunning;
      const sbm = s.secondsBehindMaster;
      if (ioR !== 'Yes' || sqlR !== 'Yes') {
        push({
          type: 'repl_thread_down', priority: 'P0', groupKey: `repl_thread:${n.ip}`,
          description: `复制线程异常（IO=${ioR}, SQL=${sqlR}）`,
          node: nodeLabel(n),
          action: '查 Last_IO_Error / Last_SQL_Error；必要时 STOP SLAVE; 处理后 START SLAVE',
          sql: 'SHOW SLAVE STATUS\\G',
          scope: 'node',
        });
      } else if (sbm != null && Number(sbm) > 300) {
        push({
          type: 'repl_delay_high', priority: 'P1', groupKey: `repl_delay:${n.ip}`,
          description: `从库延迟 ${sbm} 秒`,
          node: nodeLabel(n), action: '排查 SQL 线程瓶颈/大事务；启用并行复制',
          scope: 'node',
        });
      } else if (sbm != null && Number(sbm) > 60) {
        push({
          type: 'repl_delay_low', priority: 'P2', groupKey: `repl_delay:${n.ip}`,
          description: `从库延迟 ${sbm} 秒`,
          node: nodeLabel(n), action: '持续关注延迟变化',
          scope: 'node',
        });
      }
    }

    // ----- 数据规范（节点级；同集群通常一致，会被聚合）-----
    if ((n.noPkTables || []).length > 0) {
      push({
        type: 'no_pk_tables', priority: 'P2', groupKey: `no_pk_tables`,
        description: `存在无主键表（最多节点 ${n.noPkTables.length} 张，TOP：${n.noPkTables.slice(0,3).map(t=>`${t.schema}.${t.table}`).join('、')}）`,
        node: nodeLabel(n),
        action: '评估补充自增主键或唯一索引；ROW 复制下无主键表会全表扫描匹配行',
        sql: "-- 示例：ALTER TABLE pioneer_db.calendar ADD COLUMN id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST;",
        scope: 'cluster',
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

    // 碎片表：只统计绝对值大的（≥100MB），避免噪声
    const bigFrag = (n.fragTables || []).filter(t => {
      const fr = Number(t.fragRate);
      const free = Number(t.dataFree);
      return fr >= 0.7 && free >= 100 * 1024 * 1024;
    });
    if (bigFrag.length > 0) {
      const top = bigFrag
        .sort((a, b) => Number(b.dataFree) - Number(a.dataFree))
        .slice(0, 3)
        .map(t => `${t.table}(${(Number(t.dataFree)/1073741824).toFixed(1)}GB)`)
        .join('、');
      push({
        type: 'heavy_frag_tables', priority: 'P2', groupKey: 'heavy_frag_tables',
        description: `存在高碎片大表 ${bigFrag.length} 张（碎片率≥70% 且碎片≥100MB；TOP：${top}）`,
        node: nodeLabel(n),
        action: '维护窗口期 OPTIMIZE TABLE 或 pt-online-schema-change 重建',
        sql: '-- 示例：OPTIMIZE TABLE pioneer_db.tbl_order_refund;\n-- 大表推荐：pt-online-schema-change --alter "ENGINE=InnoDB" D=pioneer_db,t=tbl_order_refund --execute',
        scope: 'cluster',
      });
    }

    // ----- 慢查询（按绝对值分级）-----
    if (n.slowQueries != null) {
      const slow = Number(n.slowQueries);
      const pct = n.questions ? (slow / Number(n.questions) * 100) : null;
      if (slow > 1000000) {
        push({
          type: 'slow_query_abs_high', priority: 'P1', groupKey: `slow_abs:${n.ip}`,
          description: `累计慢查询 ${slow.toLocaleString()} 次${pct!=null?`（占总查询 ${pct.toFixed(4)}%）`:''}`,
          node: nodeLabel(n),
          action: '使用 pt-query-digest 输出 TOP10 SQL，优先优化全表扫描和高 IO 查询',
          sql: 'pt-query-digest /data/mysql/data/*-slow.log | head -200',
          scope: 'node',
        });
      } else if (slow > 100000) {
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
    if (v.long_query_time && Number(v.long_query_time) >= 5) {
      push({
        type: 'long_query_time_loose', priority: 'P3', groupKey: `long_qt:${n.ip}`,
        description: `long_query_time = ${v.long_query_time}（阈值过宽）`,
        node: nodeLabel(n), action: '建议设为 1 秒以更敏感地捕获慢 SQL',
        scope: 'node',
      });
    }

    // ----- ibtmp1 -----
    if (n.ibtmp1?.sizeBytes && n.ibtmp1.sizeBytes > 5 * 1073741824) {
      push({
        type: 'ibtmp1_oversize', priority: 'P2', groupKey: `ibtmp1:${n.ip}`,
        description: `ibtmp1 已增长至 ${n.ibtmp1.sizeFormatted}`,
        node: nodeLabel(n),
        action: '配置 innodb_temp_data_file_path 上限，维护窗口重启回收',
        sql: '-- my.cnf:\ninnodb_temp_data_file_path = ibtmp1:12M:autoextend:max:50G\n-- 重启 MySQL 后生效',
        scope: 'node',
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

    // 角色一致性
    if (n.role === 'primary' && v.read_only === '1') {
      push({
        type: 'master_readonly', priority: 'P1', groupKey: `master_readonly:${n.ip}`,
        description: `主库 read_only = 1（无法写入）`,
        node: nodeLabel(n), action: '核实是否被错误置为只读',
        sql: 'SET GLOBAL read_only = 0; SET GLOBAL super_read_only = 0;',
        scope: 'node',
      });
    }
    if (n.role !== 'primary' && n.replication?.isSlave && v.read_only === '0') {
      push({
        type: 'slave_writable', priority: 'P1', groupKey: `slave_writable:${n.ip}`,
        description: `从库 read_only = 0（可写入，存在数据漂移风险）`,
        node: nodeLabel(n), action: '从库应设为只读',
        sql: 'SET GLOBAL read_only = 1; SET GLOBAL super_read_only = 1;',
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
    } else if (v.expire_logs_days && Number(v.expire_logs_days) > 30) {
      push({
        type: 'expire_logs_long', priority: 'P3', groupKey: `expire_logs_long:${n.ip}`,
        description: `expire_logs_days = ${v.expire_logs_days}（保留过长）`,
        node: nodeLabel(n), action: '评估磁盘成本与回滚需求',
        scope: 'node',
      });
    }

    // ----- Buffer Pool 命中率（与说明文字阈值对齐：<99% → P2）-----
    if (n.innodb?.bufferPoolHitRate) {
      const [hit, total] = n.innodb.bufferPoolHitRate.split('/').map(s => Number(s.trim()));
      if (hit && total) {
        const rate = hit / total;
        if (rate < 0.95) {
          push({
            type: 'bp_hit_low', priority: 'P1', groupKey: `bp_hit:${n.ip}`,
            description: `Buffer Pool 命中率 ${(rate*100).toFixed(1)}%（${hit}/${total}）`,
            node: nodeLabel(n), action: '评估扩大 innodb_buffer_pool_size 至内存的 50-70%',
            scope: 'node',
          });
        } else if (rate < 0.99) {
          push({
            type: 'bp_hit_sub99', priority: 'P3', groupKey: `bp_hit:${n.ip}`,
            description: `Buffer Pool 命中率 ${(rate*100).toFixed(1)}%（${hit}/${total}），未达 99% 推荐线`,
            node: nodeLabel(n), action: '观察是否随业务增长继续下降；若持续 <97% 评估扩容',
            scope: 'node',
          });
        }
      }
    }

    // ----- 用户安全：host=% 按危险等级 -----
    const wildcards = (n.users || []).filter(u => u.host === '%');
    for (const u of wildcards) {
      const cat = classifyWildcardUser(u.user);
      if (cat.level === 'critical') {
        push({
          type: 'wildcard_critical', priority: 'P0', groupKey: `wildcard_user:${u.user}`,
          description: `存在 host=% 的最高危用户：${u.user}（${cat.reason}）`,
          node: nodeLabel(n),
          action: '立即收紧：限制为内网网段或固定 IP；至少删除 \'@\'%\' 项',
          sql: `-- 示例：\n-- 仅保留 localhost / 内网\nDROP USER '${u.user}'@'%';\nCREATE USER '${u.user}'@'10.0.0.0/255.0.0.0' IDENTIFIED BY '<原密码>';\nGRANT <原权限> ON *.* TO '${u.user}'@'10.0.0.0/255.0.0.0';`,
          scope: 'cluster',
        });
      } else if (cat.level === 'high') {
        push({
          type: 'wildcard_high', priority: 'P1', groupKey: `wildcard_user:${u.user}`,
          description: `存在 host=% 的高风险用户：${u.user}（${cat.reason}）`,
          node: nodeLabel(n),
          action: '限制到必要的主机/网段',
          scope: 'cluster',
        });
      } else if (cat.level === 'medium') {
        push({
          type: 'wildcard_medium', priority: 'P2', groupKey: `wildcard_user:${u.user}`,
          description: `存在 host=% 的业务用户：${u.user}（${cat.reason}）`,
          node: nodeLabel(n),
          action: '若业务来源固定，建议限制到具体网段以缩小攻击面',
          scope: 'cluster',
        });
      }
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
      const ro = nodes.map(n => ({ role: n.role, v: n.variables?.read_only }));
      const masterOk = ro.find(x => x.role === 'primary')?.v === '0';
      const slavesOk = ro.filter(x => x.role !== 'primary').every(x => x.v === '1');
      return masterOk && slavesOk
        ? { ok: true, reason: '正常（主写 0 / 从读 1）' }
        : { ok: false, reason: '异常：主从角色与 read_only 不匹配' };
    }
    if (key === 'expire_logs_days') return { ok: false, reason: '异常：节点间 binlog 保留策略不一致，影响 PITR 一致性' };
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
      out.push({ key: k, values: vals, unique: uniq, ...j });
    }
  }
  return out;
}

// ============== 根因关联分析 ==============
function deriveCorrelations(nodes, issues) {
  const corrs = [];
  const findIssue = (type) => issues.find(i => i.type === type);

  // 1. DR/灾备节点磁盘高位 + binlog 永不过期
  for (const n of nodes) {
    const v = n.variables || {};
    const highDisk = (n.disks || []).some(d => parseInt((d.usePct||'0').replace('%',''))>=80);
    if (highDisk && (v.expire_logs_days === '0' || Number(v.expire_logs_days||0) > 30)) {
      corrs.push({
        title: `节点 ${n.ip} 磁盘高位与 binlog 保留策略相关`,
        detail: `该节点 expire_logs_days = ${v.expire_logs_days}，binlog 长期不清理，是磁盘使用率升高的可能主因。`,
        suggestion: `优先调整 expire_logs_days 至 7-15 天，并立即手工 PURGE 历史 binlog；可即时释放数十/上百 GB 空间。`,
      });
    }
  }

  // 2. 全集群持久化偏弱
  const allWeakFlush = nodes.every(n => n.variables?.innodb_flush_log_at_trx_commit === '0');
  const allWeakSync = nodes.every(n => n.variables?.sync_binlog === '0');
  if (allWeakFlush && allWeakSync && nodes.length > 1) {
    corrs.push({
      title: '全集群持久化强度偏低',
      detail: `所有 ${nodes.length} 个节点同时设置 innodb_flush_log_at_trx_commit=0 + sync_binlog=0。这是 MySQL 性能最高、可靠性最低的组合，最坏情况下断电会丢失最近 1 秒事务和 binlog 事件。`,
      suggestion: `生产主库强烈推荐 (1, 1)。若对写性能极敏感，可降级为 (2, 100)，但不应同时为 (0, 0)。`,
    });
  }

  // 3. 主库慢查询累计高 + ibtmp1 偏大
  const primary = nodes.find(n => n.role === 'primary');
  if (primary && Number(primary.slowQueries||0) > 1000000 && primary.ibtmp1?.sizeBytes > 5 * 1073741824) {
    corrs.push({
      title: `主库慢查询累积与 ibtmp1 增长存在关联`,
      detail: `主库 ${primary.ip} 累计慢查询 ${Number(primary.slowQueries).toLocaleString()} 次，且 ibtmp1 已达 ${primary.ibtmp1.sizeFormatted}。提示业务中存在大量复杂查询（GROUP BY / ORDER BY / 多表 JOIN）触发了磁盘临时表。`,
      suggestion: `用 pt-query-digest 分析慢日志，重点排查使用 filesort、Using temporary 的 SQL，通过索引优化或查询改写降低临时表频率。`,
    });
  }

  // 4. 从库间 ibtmp1 不一致提示重启时间差异
  const slaveIbtmps = nodes.filter(n => n.role !== 'primary' && n.ibtmp1?.sizeBytes != null);
  if (slaveIbtmps.length >= 2) {
    const sizes = slaveIbtmps.map(n => n.ibtmp1.sizeBytes);
    const max = Math.max(...sizes), min = Math.min(...sizes);
    if (max > min * 4 && max > 1073741824) {
      corrs.push({
        title: '从库间 ibtmp1 大小差异显著',
        detail: `各从库 ibtmp1 占用差异较大（最小 ${slaveIbtmps[sizes.indexOf(min)].ibtmp1.sizeFormatted}，最大 ${slaveIbtmps[sizes.indexOf(max)].ibtmp1.sizeFormatted}）。差异通常源于节点重启时间不同，ibtmp1 在重启时会重建。`,
        suggestion: `本身不需处理；如统一处置建议同步配置 :max: 上限后逐个重启回收。`,
      });
    }
  }

  // 5. 全集群 host=% root 风险
  const allRootWildcard = nodes.every(n =>
    (n.users || []).some(u => u.user === 'root' && u.host === '%')
  );
  if (allRootWildcard && nodes.length > 1) {
    corrs.push({
      title: '集群所有节点均存在 root@% 账号',
      detail: `任意可达 3306 端口的网络位置都可尝试 root 登录。这是最高级别的远程入侵敞口，结合密码强度低/泄漏即可拿到完整数据库控制权。`,
      suggestion: `立即在所有节点执行：DROP USER 'root'@'%';   只保留 root@localhost / 127.0.0.1 / ::1。`,
    });
  }

  // 6. 灾备节点资源更大但被严重低估利用（如内存使用率远低于主库）
  if (primary && primary.memUsagePct) {
    const drNodes = nodes.filter(n => n.role !== 'primary' && Number(n.memUsagePct||0) < Number(primary.memUsagePct) - 30);
    if (drNodes.length > 0) {
      corrs.push({
        title: '灾备/部分从库内存利用率显著低于主库',
        detail: `节点 ${drNodes.map(n=>`${n.ip}(${n.memUsagePct}%)`).join('、')} 内存使用率显著低于主库 (${primary.memUsagePct}%)。可能是 buffer pool 未充分预热或资源未对齐。`,
        suggestion: `若该节点可能升级为主库，建议预热 buffer pool（启用 innodb_buffer_pool_dump_at_shutdown=ON）。`,
      });
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
  if (/^slave/.test(role)) return '从库';
  return role;
}

main();

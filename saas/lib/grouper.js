// 集群自动发现：从一组 MySQLHealthCheck_*.txt 中按复制拓扑分组。
//
// 算法：
//   1. 对每个 txt 做轻量解析，仅抓 ip / hostname / masterHost / slaveIps / serverId
//   2. self-reference（masterHost === 本机 IP/hostname）视作非真从库（参考 v4.5 逻辑）
//   3. 用 union-find 把节点连通起来：
//        - A.isSlave 且 A.masterHost === B.ip 或 hostname → A、B 同一簇
//        - A.slaveIps 含 B.ip → A、B 同一簇
//   4. 每个连通分量 = 一个集群。单点（无连边）= 单节点集群
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 从文件名提取 IP：MySQLHealthCheck_<IP>_<timestamp>.txt
 */
function inferIpFromFilename(filename) {
  const m = String(filename).match(/MySQLHealthCheck_(\d+\.\d+\.\d+\.\d+)_/);
  return m ? m[1] : null;
}

/**
 * 轻量解析：只读必要的几个段，避免重复完整 extract。
 * 返回 { ip, hostname, isSlave, masterHost, slaveIps, serverId, role }
 */
function parseReplicationLight(content, fallbackIp) {
  const result = {
    ip: fallbackIp,
    hostname: null,
    isSlave: false,
    masterHost: null,
    slaveIps: [],
    serverId: null,
    role: 'unknown',
    selfRefResidue: false,
  };

  // hostname：「----->>>---->>>  [01] hostname」或「----->>>---->>>  hostname」之后一行
  const hostMatch = content.match(/----->>>----+>>>\s*(?:\[\d+\]\s*)?hostname\s*\n([^\n]+)/i);
  if (hostMatch) {
    const h = hostMatch[1].trim();
    if (h && h !== 'localhost') result.hostname = h;
  }

  // server_id：variables 段或 my.cnf 段
  const sidMatch = content.match(/^\s*server[_-]?id\s*[=:]\s*(\d+)/im);
  if (sidMatch) result.serverId = sidMatch[1];

  // ip info 段 fallback（如果文件名没带 IP）
  if (!result.ip) {
    const ipMatch = content.match(/inet\s+(\d+\.\d+\.\d+\.\d+)\/\d+/);
    if (ipMatch && ipMatch[1] !== '127.0.0.1') result.ip = ipMatch[1];
  }

  // SHOW SLAVE STATUS \G 输出
  const ssBlock = content.match(/Slave_IO_State:[\s\S]*?Master_Server_Id:\s*\d+/);
  if (ssBlock) {
    result.isSlave = true;
    const mh = ssBlock[0].match(/Master_Host:\s*(\S+)/);
    if (mh) result.masterHost = mh[1];
  }

  // slave IP is: ... 行（主库视角列出其从库）
  const slaveIpMatch = content.match(/slave IP is\s*:\s*([\d.\s]+)/);
  if (slaveIpMatch) {
    result.slaveIps = slaveIpMatch[1].trim().split(/\s+/).filter(s => /\d+\.\d+\.\d+\.\d+/.test(s));
  }

  // self-reference 检测：Master_Host 指向自己 → v4.5 逻辑：不是真从库
  if (result.isSlave && result.masterHost) {
    const mh = result.masterHost.toLowerCase();
    const selfIp = (result.ip || '').toLowerCase();
    const selfHost = (result.hostname || '').toLowerCase();
    if (mh === selfIp ||
        (selfHost && (mh === selfHost || mh === selfHost.split('.')[0])) ||
        mh === 'localhost' || mh === '127.0.0.1' || mh === '::1') {
      result.isSlave = false;
      result.selfRefResidue = true;
      result.masterHost = null;
    }
  }

  // 角色推断（grouper 内部用，最终以 extract.js 输出为准）
  if (result.isSlave && result.masterHost) {
    result.role = 'slave';
  } else if (result.slaveIps.length > 0 || result.selfRefResidue) {
    result.role = 'primary';
  } else {
    // 无主从信号 → 大概率 standalone primary，但 grouper 不影响最终判定
    result.role = 'standalone';
  }

  return result;
}

/**
 * Union-Find 数据结构（按需简化版）
 */
class UF {
  constructor(n) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x) {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a, b) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

/**
 * 输入：[{path, originalName}, ...]
 * 输出：[{ nodes: [{ ip, hostname, role, file, ... }], topology, label, primaryIp, files }, ...]
 *
 * topology 例：'单节点' / '一主1从（异步复制）' / '一主3从（异步复制）' / '集群(N 节点)'
 * label    例：'10.0.0.1（单节点）' / '10.0.0.1 集群（一主2从）'
 */
function groupIntoClusters(files) {
  const nodes = files.map(f => {
    const content = fs.readFileSync(f.path, 'utf-8');
    const ip = inferIpFromFilename(f.originalName) || inferIpFromFilename(path.basename(f.path));
    const info = parseReplicationLight(content, ip);
    return { ...info, file: f };
  });

  // 建立 ip -> index 映射（同时考虑 hostname 兜底）
  const ipIndex = new Map();
  nodes.forEach((n, i) => {
    if (n.ip) ipIndex.set(n.ip, i);
    if (n.hostname) ipIndex.set(n.hostname.toLowerCase(), i);
  });

  // Union-find 连接
  const uf = new UF(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    // (1) A 是从库，Master_Host 指向集合中的另一个节点
    if (a.isSlave && a.masterHost) {
      const j = ipIndex.get(a.masterHost) ?? ipIndex.get(a.masterHost.toLowerCase());
      if (j != null && j !== i) uf.union(i, j);
    }
    // (2) A 是主库，slaveIps 列出集合中的某个节点
    for (const sip of a.slaveIps || []) {
      const j = ipIndex.get(sip);
      if (j != null && j !== i) uf.union(i, j);
    }
  }

  // 收集连通分量
  const groupsMap = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const root = uf.find(i);
    if (!groupsMap.has(root)) groupsMap.set(root, []);
    groupsMap.get(root).push(nodes[i]);
  }

  // 生成最终结构
  const groups = [];
  for (const [_, groupNodes] of groupsMap) {
    // 在组内推断主库（优先 role=primary；其次有 slaveIps；最后第一个）
    const primary = groupNodes.find(n => n.role === 'primary') ||
                    groupNodes.find(n => n.slaveIps?.length > 0) ||
                    groupNodes[0];
    const slaves = groupNodes.filter(n => n !== primary);
    const isSingle = groupNodes.length === 1;
    let topology, label;
    if (isSingle) {
      topology = '单节点';
      label = `${primary.ip || primary.hostname || '?'}（单节点）`;
    } else {
      const slaveCount = slaves.length;
      topology = `一主${slaveCount}从（异步复制）`;
      label = `${primary.ip || primary.hostname || '?'} 集群（${topology}）`;
    }
    groups.push({
      nodes: groupNodes,
      topology,
      label,
      primaryIp: primary.ip || null,
      files: groupNodes.map(n => n.file),
      // 元信息便于排查
      hasOrphanSlave: slaves.some(s => s.isSlave && s.masterHost && !ipIndex.has(s.masterHost)),
      selfRefNodes: groupNodes.filter(n => n.selfRefResidue).map(n => n.ip),
    });
  }

  // 排序：单节点放后面、主从集群放前面；每组按主库 IP 字典序
  groups.sort((a, b) => {
    if (a.nodes.length !== b.nodes.length) return b.nodes.length - a.nodes.length;
    return String(a.primaryIp || '').localeCompare(String(b.primaryIp || ''));
  });

  return groups;
}

module.exports = { groupIntoClusters, parseReplicationLight, inferIpFromFilename };

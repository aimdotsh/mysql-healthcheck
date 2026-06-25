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
 * 从文件名提取 IP：
 * - V3 新格式：MySQLHealthCheck_<IP>_<timestamp>.txt
 * - V1/V2 老格式：MySQLHealthCheck_<date>.txt / MySQL_Check_<date>.txt （无 IP）
 */
function inferIpFromFilename(filename) {
  const m = String(filename).match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
  return m ? m[1] : null;
}

/**
 * v4.9.x：从 ip info 段或文件开头扫真实 IP（用于老 collector 文件名无 IP 的场景）
 * 跳过 loopback / link-local / docker 默认网段。
 */
function inferIpFromContent(content) {
  const ipExclude = ip => ip === '127.0.0.1' || ip.startsWith('169.254.') ||
                          ip.startsWith('0.0.0.') || ip.startsWith('172.17.');
  // 优先 ip info 段
  const sec = content.match(/----->>>----+>>>\s*(?:\[\d+\]\s*)?ip info[\s\S]{0,4000}/i);
  if (sec) {
    for (const m of sec[0].matchAll(/inet\s+(\d+\.\d+\.\d+\.\d+)/g)) {
      if (!ipExclude(m[1])) return m[1];
    }
  }
  // 兜底：开头 8 KB 任意 inet 行
  const head = content.slice(0, 8192);
  for (const m of head.matchAll(/inet\s+(\d+\.\d+\.\d+\.\d+)/g)) {
    if (!ipExclude(m[1])) return m[1];
  }
  return null;
}

/**
 * 轻量解析：只读必要的几个段，避免重复完整 extract。
 * 返回 { ip, hostname, isSlave, masterHost, slaveIps, serverId, masterServerId, role }
 *
 * v5.0.2：去除「按 hostname 判 self-ref」的逻辑 — 在脱敏场景下（多节点 hostname
 * 都被替换成同一个占位字符串，如 "masked-hostname"），hostname 自指会被误判为
 * 「自身指自身」从而 isSlave=false，导致集群拓扑识别失败。改为仅按 IP 比对（IP
 * 在文件名层面唯一可靠）；hostname 维度的 self-ref 判定挪到 groupIntoClusters
 * 二阶段去做（在那里能见到批次内所有节点，可识别脱敏）。
 */
function parseReplicationLight(content, fallbackIp) {
  const result = {
    ip: fallbackIp,
    hostname: null,
    isSlave: false,
    masterHost: null,
    slaveIps: [],
    serverId: null,
    masterServerId: null,
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
    const msid = ssBlock[0].match(/Master_Server_Id:\s*(\d+)/);
    if (msid) result.masterServerId = msid[1];
  }

  // slave IP is: ... 行（主库视角列出其从库）
  const slaveIpMatch = content.match(/slave IP is\s*:\s*([\d.\s]+)/);
  if (slaveIpMatch) {
    result.slaveIps = slaveIpMatch[1].trim().split(/\s+/).filter(s => /\d+\.\d+\.\d+\.\d+/.test(s));
  }

  // self-reference 检测（仅 IP 维度可靠；hostname 维度延后到 groupIntoClusters）：
  // Master_Host 指向 IP 自身或本地回环 → v4.5 逻辑：不是真从库
  if (result.isSlave && result.masterHost) {
    const mh = result.masterHost.toLowerCase();
    const selfIp = (result.ip || '').toLowerCase();
    if (mh === selfIp || mh === 'localhost' || mh === '127.0.0.1' || mh === '::1') {
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
    // v4.9.x：filename 没 IP → 退而从 ip info 段抠 IP（老 collector 兼容）
    let ip = inferIpFromFilename(f.originalName) || inferIpFromFilename(path.basename(f.path));
    if (!ip) ip = inferIpFromContent(content);
    if (!ip) ip = 'unknown-' + path.basename(f.originalName).replace(/\.txt$/i, '').slice(0, 16);
    const info = parseReplicationLight(content, ip);
    return { ...info, file: f };
  });

  // v5.0.2：hostname 冲突感知 — 如果多个节点 hostname 相同（典型脱敏场景，
  // 所有 hostname 都被替换成 "masked-hostname"），则 hostname 不能作为身份键。
  // 仅 IP 是可靠的唯一标识；冲突 hostname 跳过，由 Phase 2 server_id 匹配兜底。
  const hostnameCount = new Map();
  for (const n of nodes) {
    if (!n.hostname) continue;
    const h = n.hostname.toLowerCase();
    hostnameCount.set(h, (hostnameCount.get(h) || 0) + 1);
  }
  const collidedHostnames = new Set(
    [...hostnameCount.entries()].filter(([, c]) => c > 1).map(([h]) => h)
  );

  const ipIndex = new Map();
  nodes.forEach((n, i) => {
    if (n.ip) ipIndex.set(n.ip, i);
    if (n.hostname) {
      const h = n.hostname.toLowerCase();
      if (!collidedHostnames.has(h)) ipIndex.set(h, i);
    }
  });

  // hostname 维度的 self-ref 后修正：批次内 hostname 唯一时，masterHost == 自己
  // hostname 才视作真正的 self-ref residue（v4.5 旧逻辑）；hostname 冲突时跳过。
  for (const n of nodes) {
    if (!n.isSlave || !n.masterHost || !n.hostname) continue;
    const mh = n.masterHost.toLowerCase();
    const sh = n.hostname.toLowerCase();
    if (collidedHostnames.has(sh)) continue; // 脱敏场景，不修正
    if (mh === sh || mh === sh.split('.')[0]) {
      n.isSlave = false;
      n.selfRefResidue = true;
      n.masterHost = null;
      if (n.role === 'slave') n.role = 'primary';
    }
  }

  // ===== Phase 1: 基于 ip/hostname 的 union-find =====
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

  // ===== Phase 2: server_id 匹配兜底（脱敏 / hostname-only 复制场景）=====
  // 现象：多个 slave 的 Master_Host 是同一个占位字符串（脱敏）或纯 hostname
  // （无法解析为本批次中的某个 IP）。它们的 Master_Server_Id 与某个非从库节点的
  // server_id 匹配 → 那个就是真正的主库。
  //
  // 步骤：
  //   (a) 把同一 masterHost 字符串的 orphan slaves 先连成一组
  //   (b) 找 server_id == Master_Server_Id 的非从库候选；唯一时 union 进来
  //   (c) 候选不唯一（如多个 cluster 都用默认 server_id=1）→ 保留 slaves 同组，
  //       但不强行 union 主库，避免跨集群污染
  const orphanSlavesByMh = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    if (!a.isSlave || !a.masterHost) continue;
    const mh = a.masterHost.toLowerCase();
    if (ipIndex.has(a.masterHost) || ipIndex.has(mh)) continue; // 已经能解析
    if (!orphanSlavesByMh.has(mh)) orphanSlavesByMh.set(mh, []);
    orphanSlavesByMh.get(mh).push(i);
  }
  for (const [, idxs] of orphanSlavesByMh) {
    // (a) 同 masterHost 的所有 slave union 在一起
    for (let k = 1; k < idxs.length; k++) uf.union(idxs[0], idxs[k]);

    // (b) 找候选主库：非 slave + server_id 与 Master_Server_Id 匹配
    const msid = nodes[idxs[0]].masterServerId;
    if (!msid) continue;
    const candidates = [];
    for (let j = 0; j < nodes.length; j++) {
      if (idxs.includes(j)) continue;
      if (nodes[j].isSlave) continue;
      if (!nodes[j].serverId) continue;
      if (nodes[j].serverId === msid) candidates.push(j);
    }
    if (candidates.length === 1) {
      uf.union(idxs[0], candidates[0]);
      // 标记此节点的 role 升级为 primary（之前可能是 standalone）
      if (nodes[candidates[0]].role !== 'primary') nodes[candidates[0]].role = 'primary';
      nodes[candidates[0]]._inferredViaServerIdMatch = true;
    }
    // candidates.length === 0 或 > 1 → 留作 headless slave 组，UI 端可显眼提示
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
    // 在组内推断主库（v5.0.2 顺序调整）：
    //   1) 非 slave 且 server_id 与组内 slave 的 Master_Server_Id 匹配（强信号）
    //   2) role=primary 且不是 slave
    //   3) 有 slaveIps（主库视角列出过 slaves）
    //   4) 兜底：唯一的非 slave 节点
    //   5) 最后 fallback：第一个节点
    const slaveOfThisGroup = groupNodes.find(n => n.isSlave && n.masterServerId);
    const matchedByServerId = slaveOfThisGroup
      ? groupNodes.find(n => !n.isSlave && n.serverId === slaveOfThisGroup.masterServerId)
      : null;
    const nonSlaveOnes = groupNodes.filter(n => !n.isSlave);
    const primary = matchedByServerId
                 || groupNodes.find(n => n.role === 'primary' && !n.isSlave)
                 || groupNodes.find(n => n.slaveIps?.length > 0)
                 || (nonSlaveOnes.length === 1 ? nonSlaveOnes[0] : null)
                 || groupNodes[0];
    const slaves = groupNodes.filter(n => n !== primary);
    const isSingle = groupNodes.length === 1;

    // 双主检测：所有节点互为主从（各自 masterHost 都指向组内另一节点）
    const isDualMaster = groupNodes.length >= 2 &&
      groupNodes.every(n => n.isSlave) &&
      groupNodes.every(n => {
        const mh = (n.masterHost || '').toLowerCase();
        if (!mh) return false;
        return groupNodes.some(p => p !== n && (
          (p.ip || '').toLowerCase() === mh ||
          (p.hostname || '').toLowerCase() === mh ||
          ((p.hostname || '').split('.')[0] || '').toLowerCase() === mh
        ));
      });

    let topology, label;
    if (isSingle) {
      topology = '单节点';
      label = `${primary.ip || primary.hostname || '?'}（单节点）`;
    } else if (isDualMaster) {
      topology = '双主（互为主从）';
      const ips = groupNodes.map(n => n.ip || n.hostname || '?').join('/');
      label = `${ips} 双主（互为主从）`;
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

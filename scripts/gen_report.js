const { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun, HeadingLevel, AlignmentType, WidthType, BorderStyle, ShadingType, TableLayoutType, Header, Footer, PageNumber, NumberFormat, PageBreak, ImageRun } = require('/tmp/node_modules/docx');
const fs = require('fs');
const path = require('path');

// Logo 图片路径
const logoPath = path.join(__dirname, 'assets', 'logo.png');
const logoImage = fs.existsSync(logoPath) ? fs.readFileSync(logoPath) : null;

// ===================== 样式工具函数 =====================
function h1(text) {
  return new Paragraph({
    text,
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 300, after: 120 },
  });
}
function h2(text) {
  return new Paragraph({
    text,
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 240, after: 80 },
  });
}
function h3(text) {
  return new Paragraph({
    text,
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 160, after: 60 },
  });
}
function para(text, opts = {}) {
  return new Paragraph({
    children: [new TextRun({ text, size: 22, ...opts })],
    spacing: { before: 60, after: 60 },
  });
}
function bullet(text, level = 0) {
  return new Paragraph({
    children: [new TextRun({ text, size: 22 })],
    bullet: { level },
    spacing: { before: 40, after: 40 },
  });
}
function emptyLine() {
  return new Paragraph({ text: '', spacing: { before: 60, after: 60 } });
}

// 表格标题行
function tableTitle(text, cols) {
  return new TableRow({
    children: [new TableCell({
      children: [new Paragraph({
        children: [new TextRun({ text, bold: true, size: 22 })],
        alignment: AlignmentType.CENTER,
      })],
      columnSpan: cols,
      shading: { fill: '1F4E79', type: ShadingType.CLEAR, color: 'auto' },
    })],
  });
}

// 表头行
function headerRow(cells, fillColor = '2E75B6') {
  return new TableRow({
    children: cells.map(c => new TableCell({
      children: [new Paragraph({
        children: [new TextRun({ text: c, bold: true, color: 'FFFFFF', size: 20 })],
        alignment: AlignmentType.CENTER,
      })],
      shading: { fill: fillColor, type: ShadingType.CLEAR, color: 'auto' },
    })),
    tableHeader: true,
  });
}

// 数据行
// headers: 表头数组（用于动态判断列对齐方式）
function dataRow(cells, shade = false, headers = []) {
  return new TableRow({
    children: cells.map((c, i) => {
      let align = AlignmentType.CENTER; // 默认居中
      if (headers[i]) {
        const h = String(headers[i]).toLowerCase();
        // 库名/数据库名列居中
        if (h.includes('库名') || h.includes('database') || h.includes('schema')) {
          align = AlignmentType.CENTER;
        }
        // 表名列靠左
        else if (h.includes('表名') || h.includes('table_name')) {
          align = AlignmentType.LEFT;
        }
        // 第一列和最后一列靠左
        else if (i === 0 || i === cells.length - 1) {
          align = AlignmentType.LEFT;
        }
      } else {
        // 无headers时：第0列靠左，其余居中
        align = i === 0 ? AlignmentType.LEFT : AlignmentType.CENTER;
      }
      return new TableCell({
        children: [new Paragraph({
          children: [new TextRun({ text: String(c), size: 20 })],
          alignment: align,
        })],
        shading: shade ? { fill: 'EBF3FB', type: ShadingType.CLEAR, color: 'auto' } : undefined,
      });
    }),
  });
}

// 问题行（带优先级颜色）
function priorityRow(cells, priority) {
  const colorMap = {
    'P0': 'FFCCCC',
    'P1': 'FFE4B5',
    'P2': 'FFFACD',
    'P3': 'FFFFFF',
  };
  const bgColor = colorMap[priority] || 'FFFFFF';
  return new TableRow({
    children: cells.map((c, i) => new TableCell({
      children: [new Paragraph({
        children: [new TextRun({ text: String(c), size: 20 })],
        alignment: i === 0 ? AlignmentType.CENTER : AlignmentType.LEFT,
      })],
      shading: { fill: bgColor, type: ShadingType.CLEAR, color: 'auto' },
    })),
  });
}

function makeTable(headers, rows, titleText, cols) {
  const tableRows = [];
  if (titleText) tableRows.push(tableTitle(titleText, cols || headers.length));
  tableRows.push(headerRow(headers));
  rows.forEach((r, idx) => tableRows.push(dataRow(r, idx % 2 === 1, headers)));
  return new Table({
    rows: tableRows,
    width: { size: 9200, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
  });
}

function makePriorityTable(headers, rows, titleText) {
  const tableRows = [];
  if (titleText) tableRows.push(tableTitle(titleText, headers.length));
  tableRows.push(headerRow(headers));
  rows.forEach(r => {
    const priority = String(r[0] || '').includes('P0') ? 'P0' :
                     String(r[0] || '').includes('P1') ? 'P1' :
                     String(r[0] || '').includes('P2') ? 'P2' : 'P3';
    tableRows.push(priorityRow(r, priority));
  });
  return new Table({
    rows: tableRows,
    width: { size: 9200, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
  });
}

// ===================== 报告数据 =====================
// 巡检日期
const inspectionDate = '2026年04月02日';
const reportDate = '2026年04月03日';

// ===================== 文档生成 =====================
const doc = new Document({
  creator: 'MySQL Inspection Tool',
  title: 'MySQL数据库巡检报告（详细版）',
  styles: {
    default: {
      document: {
        run: { font: 'Microsoft YaHei', size: 22 },
      },
    },
    paragraphStyles: [
      {
        id: 'Normal', name: 'Normal',
        run: { font: 'Microsoft YaHei', size: 22 },
      },
      {
        id: 'Heading1', name: 'Heading 1',
        run: { font: 'Microsoft YaHei', size: 28, bold: true, color: '1F4E79' },
        paragraph: { spacing: { before: 300, after: 120 } },
      },
      {
        id: 'Heading2', name: 'Heading 2',
        run: { font: 'Microsoft YaHei', size: 26, bold: true, color: '2E75B6' },
        paragraph: { spacing: { before: 240, after: 80 } },
      },
      {
        id: 'Heading3', name: 'Heading 3',
        run: { font: 'Microsoft YaHei', size: 24, bold: true, color: '2F5496' },
        paragraph: { spacing: { before: 160, after: 60 } },
      },
    ],
  },
  sections: [{
    properties: {
      page: {
        margin: { top: 1440, bottom: 1440, left: 1800, right: 1440 },
      },
    },
    headers: {
      default: new Header({
        children: [
          new Paragraph({
            border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'AAAAAA', space: 1 } },
            children: [
              // Logo 图片
              logoImage ? new ImageRun({
                data: logoImage,
                transformation: { width: 100, height: 33 },
                type: 'png',
              }) : new TextRun({ text: '' }),
              // Tab
              new TextRun({ text: '\t', font: 'Microsoft YaHei' }),
              // 云和恩墨文字
              new TextRun({ text: '云和恩墨成就所托', font: 'Microsoft YaHei', color: '404040', size: 16 }),
              // Tab
              new TextRun({ text: '\t', font: 'Microsoft YaHei' }),
              // 网址（带下划线）
              new TextRun({ text: 'www.enmotech.com', font: 'Microsoft YaHei', color: '0563C1', size: 16, underline: {} }),
            ],
          }),
        ],
      }),
    },
    footers: {
      default: new Footer({
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({ text: '第 ', color: '666666', size: 18 }),
              new TextRun({
                children: [PageNumber.CURRENT],
                color: '666666',
                size: 18,
              }),
              new TextRun({ text: ' 页', color: '666666', size: 18 }),
            ],
          }),
        ],
      }),
    },
    children: [
      // ==================== 封面 ====================
      emptyLine(), emptyLine(), emptyLine(),
      new Paragraph({
        children: [new TextRun({ text: '{项目名称}', size: 52, bold: true, color: '1F4E79', font: 'Microsoft YaHei' })],
        alignment: AlignmentType.CENTER,
        spacing: { before: 200, after: 100 },
      }),
      new Paragraph({
        children: [new TextRun({ text: 'MySQL数据库巡检报告（详细版）', size: 52, bold: true, color: '1F4E79', font: 'Microsoft YaHei' })],
        alignment: AlignmentType.CENTER,
        spacing: { before: 100, after: 400 },
      }),
      new Paragraph({
        children: [new TextRun({ text: `巡检日期：${inspectionDate}`, size: 28, color: '404040' })],
        alignment: AlignmentType.CENTER,
        spacing: { before: 100, after: 80 },
      }),
      new Paragraph({
        children: [new TextRun({ text: `报告日期：${reportDate}`, size: 28, color: '404040' })],
        alignment: AlignmentType.CENTER,
        spacing: { before: 80, after: 80 },
      }),
      new Paragraph({
        children: [new TextRun({ text: '版本：v2.0', size: 28, color: '404040' })],
        alignment: AlignmentType.CENTER,
        spacing: { before: 80, after: 400 },
      }),
      emptyLine(), emptyLine(), emptyLine(),
      // 水平线
      new Paragraph({
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '2E75B6' } },
        spacing: { before: 100, after: 200 },
      }),
      // 封面结束，新页开始正文
      new Paragraph({ children: [new PageBreak()], spacing: { before: 0, after: 0 } }),

      // ==================== 第一章：巡检摘要 ====================
      h1('一、巡检摘要'),
      para('本次对 {项目名称} 生产环境 MySQL 集群进行月度例行巡检，采集日期为 {巡检日期}，采集范围覆盖 {节点数量} 个节点。'),
      para('整体评估：集群运行状态 {整体评价}。详细技术数据请参考后续各章节。'),
      emptyLine(),

      makePriorityTable(
        ['序号', '问题描述', '节点', '级别', '状态'],
        [
          ['1', '示例问题描述 1', '127.0.0.1', 'P0 紧急', '待处理'],
          ['2', '示例问题描述 2', '127.0.0.2', 'P1 重要', '待处理'],
          ['3', '示例问题描述 3', '全部节点', 'P2 建议', '建议规划'],
        ],
        '巡检问题汇总'
      ),

      emptyLine(),

      // ==================== 第二章：服务器概况 ====================
      h1('二、服务器概况'),
      h2('2.1 集群拓扑'),
      para('{项目名称} MySQL 集群采用"{拓扑结构}"架构，各节点角色及配置如下：'),
      emptyLine(),

      makeTable(
        ['节点IP', '主机名', '角色', 'MySQL版本', '服务器ID'],
        [
          ['{IP}', '{hostname}', '{角色}', '{版本}', '{server_id}'],
        ],
        '集群拓扑',
        5
      ),
      emptyLine(),

      h2('2.2 服务器资源'),
      makeTable(
        ['节点IP', '主机名', '内存总量', '内存空闲', 'Swap总量', 'Swap空闲', '运行时长'],
        [
          ['{IP}', '{hostname}', '{内存}', '{空闲}', '{Swap}', '{Swap空闲}', '{Uptime}'],
        ],
        '服务器资源概况',
        7
      ),
      emptyLine(),

      h2('2.3 CPU 信息'),
      makeTable(
        ['节点IP', 'CPU型号', '核心数', '线程数', '频率'],
        [
          ['{IP}', '{CPU型号}', '{核心数}', '{线程数}', '{频率}'],
        ],
        'CPU 配置',
        5
      ),
      emptyLine(),

      h2('2.4 磁盘使用情况'),
      para('各节点磁盘挂载点使用情况如下（巡检时采集）：'),
      emptyLine(),
      makeTable(
        ['节点IP', '挂载点', '总容量', '已用', '可用', '使用率', '状态'],
        [
          ['{IP}', '/data', '{总容量}', '{已用}', '{可用}', '{使用率}', '{状态}'],
        ],
        '磁盘使用情况',
        7
      ),

      // ==================== 第三章：MySQL 连接与会话分析 ====================
      h1('三、MySQL 连接与会话分析'),
      h2('3.1 连接统计'),
      para('各节点 MySQL 连接统计信息如下：'),
      emptyLine(),
      makeTable(
        ['节点IP', '角色', 'max_connections', 'Threads_connected', 'Max_used_connections', '连接使用率'],
        [
          ['{IP}', '{角色}', '{max_conn}', '{threads_conn}', '{max_used}', '{使用率}'],
        ],
        '连接配置与使用',
        6
      ),
      emptyLine(),

      h2('3.2 会话状态分析'),
      para('基于 SHOW PROCESSLIST 采集的会话状态分布：'),
      emptyLine(),
      makeTable(
        ['节点IP', '总连接数', 'Sleep', 'Query', 'Locked', 'Waiting', '其他'],
        [
          ['{IP}', '{总数}', '{Sleep}', '{Query}', '{Locked}', '{Waiting}', '{其他}'],
        ],
        '会话状态分布',
        7
      ),
      emptyLine(),

      h2('3.3 连接错误统计'),
      makeTable(
        ['节点IP', 'Aborted_connects', 'Aborted_clients', 'Connection_errors_internal', 'Connection_errors_max_connections'],
        [
          ['{IP}', '{Aborted_connects}', '{Aborted_clients}', '{internal}', '{max_conn_err}'],
        ],
        '连接错误统计',
        5
      ),
      emptyLine(),
      para('注：Aborted_connects 过高可能表示存在连接风暴或网络不稳定；Aborted_clients 过高可能表示应用程序未正确关闭连接。'),

      // ==================== 第四章：数据库清单 ====================
      h1('四、数据库清单'),
      para('当前 MySQL 实例中的所有数据库列表：'),
      emptyLine(),
      makeTable(
        ['节点IP', '数据库名', '默认字符集', '默认排序规则', '说明'],
        [
          ['{IP}', '{库名}', '{charset}', '{collation}', '{说明}'],
        ],
        '数据库清单',
        5
      ),
      emptyLine(),
      para('注：建议所有业务库统一使用 utf8mb4 字符集以避免 emoji 等特殊字符问题。'),

      // ==================== 第五章：数据库配置参数 ====================
      h1('五、数据库配置参数'),
      h2('5.1 核心参数配置'),
      para('以下为各节点关键配置参数对比（巡检时实际值）：'),
      emptyLine(),
      makeTable(
        ['参数名称', '{节点1}', '{节点2}', '{节点3}', '说明'],
        [
          ['MySQL版本', '{版本}', '{版本}', '{版本}', '版本一致性'],
          ['server_id', '{id}', '{id}', '{id}', '各节点唯一'],
          ['innodb_buffer_pool_size', '{值}', '{值}', '{值}', '缓冲池大小'],
          ['innodb_buffer_pool_instances', '{值}', '{值}', '{值}', '缓冲池实例数'],
          ['innodb_log_file_size', '{值}', '{值}', '{值}', 'redo log大小'],
          ['innodb_flush_log_at_trx_commit', '{值}', '{值}', '{值}', '刷盘策略'],
          ['sync_binlog', '{值}', '{值}', '{值}', 'binlog刷盘'],
          ['max_connections', '{值}', '{值}', '{值}', '最大连接数'],
          ['binlog_format', '{值}', '{值}', '{值}', 'binlog格式'],
          ['gtid_mode', '{值}', '{值}', '{值}', 'GTID状态'],
          ['read_only', '{值}', '{值}', '{值}', '只读状态'],
          ['expire_logs_days', '{值}', '{值}', '{值}', 'binlog清理'],
        ],
        '核心参数配置对比',
        5
      ),
      emptyLine(),

      h2('5.2 配置差异分析'),
      para('各节点间存在以下配置差异，建议统一：'),
      bullet('差异项 1：说明'),
      bullet('差异项 2：说明'),
      emptyLine(),

      h2('5.3 配置风险说明'),
      para('当前配置存在以下风险点：'),
      bullet('innodb_flush_log_at_trx_commit + sync_binlog 组合风险说明'),
      bullet('expire_logs_days 设置风险说明'),
      bullet('其他风险配置说明'),

      // ==================== 第六章：性能分析 ====================
      h1('六、性能分析'),
      h2('6.1 整体运行状态'),
      makeTable(
        ['节点IP', '角色', 'QPS', '累计慢查询', '当前活跃连接', '运行时间'],
        [
          ['{IP}', '{角色}', '{QPS}', '{慢查询}', '{活跃连接}', '{运行时间}'],
        ],
        '整体运行状态',
        6
      ),
      emptyLine(),

      h2('6.2 Buffer Pool 分析'),
      makeTable(
        ['节点IP', 'Buffer Pool大小', '已使用', '命中率', 'Read requests', 'Reads'],
        [
          ['{IP}', '{大小}', '{已使用}', '{命中率}', '{requests}', '{reads}'],
        ],
        'Buffer Pool 状态',
        6
      ),
      emptyLine(),
      para('Buffer Pool 命中率计算公式：(1 - Innodb_buffer_pool_reads / Innodb_buffer_pool_read_requests) × 100%'),
      para('建议保持命中率在 95% 以上，低于 90% 需要评估是否需要增加 Buffer Pool 大小。'),
      emptyLine(),

      h2('6.3 慢查询分析'),
      makeTable(
        ['节点IP', 'long_query_time', '累计慢查询数', '日均慢查询', '最近慢查询时间'],
        [
          ['{IP}', '{阈值}', '{累计}', '{日均}', '{最近时间}'],
        ],
        '慢查询统计',
        5
      ),
      emptyLine(),
      para('慢查询分析建议：'),
      bullet('定期分析慢查询日志，提取 Top N 慢 SQL'),
      bullet('通过 pt-query-digest 对慢日志进行分析，优先处理全表扫描、缺失索引的查询'),
      bullet('关注大表的查询语句，考虑分区或归档历史数据'),

      // ==================== 第七章：存储空间分析 ====================
      h1('七、存储空间分析'),
      h2('7.1 数据库容量汇总'),
      makeTable(
        ['节点IP', '角色', '数据量', '索引量', '数据+索引合计', '碎片空间'],
        [
          ['{IP}', '{角色}', '{数据}', '{索引}', '{合计}', '{碎片}'],
        ],
        '数据库容量汇总',
        6
      ),
      emptyLine(),

      h2('7.2 TOP 10 大表'),
      makeTable(
        ['库名', '表名', '行数（估算）', '数据大小', '索引大小', '碎片率'],
        [
          ['{库名}', '{表名}', '{行数}', '{数据}', '{索引}', '{碎片率}'],
        ],
        'TOP 10 大表',
        6
      ),
      emptyLine(),

      h2('7.3 高碎片率表分析'),
      makeTable(
        ['库名', '表名', '碎片率', '建议操作'],
        [
          ['{库名}', '{表名}', '{碎片率}', '{建议}'],
        ],
        '高碎片率表（碎片率>=85%）',
        4
      ),
      emptyLine(),

      h2('7.4 无主键表'),
      makeTable(
        ['库名', '表名', '问题描述', '建议'],
        [
          ['{库名}', '{表名}', '无主键', '添加自增主键'],
        ],
        '无主键表',
        4
      ),
      emptyLine(),
      para('无主键表在 binlog ROW 模式下，复制效率极低（从库需全表扫描匹配行），且无法使用 MTS 并行复制。建议评估并补充主键或唯一索引。'),
      emptyLine(),

      h2('7.5 非 UTF8 表'),
      makeTable(
        ['库名', '表名', '当前字符集', '建议'],
        [
          ['{库名}', '{表名}', '{字符集}', '转换为 utf8mb4'],
        ],
        '非 UTF8 表',
        4
      ),

      // ==================== 第八章：临时表空间分析 ====================
      h1('八、临时表空间（ibtmp1）分析'),
      h2('8.1 当前状态'),
      para('巡检发现各节点 innodb_temp_data_file_path 配置及实际使用情况：'),
      emptyLine(),
      makeTable(
        ['节点IP', '角色', '当前 ibtmp1 大小', '配置', '状态'],
        [
          ['{IP}', '{角色}', '{大小}', '{配置}', '{状态}'],
        ],
        'ibtmp1 临时表空间使用情况',
        5
      ),
      emptyLine(),

      h2('8.2 问题分析'),
      para('ibtmp1 文件记录 InnoDB 内部临时表数据，通常由以下操作产生：'),
      bullet('GROUP BY / ORDER BY 使用临时表的复杂查询'),
      bullet('执行大量未使用 filesort 优化的排序操作'),
      bullet('长事务未提交，临时表数据持续驻留'),
      emptyLine(),

      h2('8.3 解决方案'),
      para('短期处理（需维护窗口重启 MySQL）：在 my.cnf 中增加最大上限限制：'),
      new Paragraph({
        children: [new TextRun({ text: 'innodb_temp_data_file_path = ibtmp1:12M:autoextend:max:50G', font: 'Courier New', size: 20, color: '1A5276' })],
        shading: { fill: 'EBF5FB', type: ShadingType.CLEAR, color: 'auto' },
        indent: { left: 720 },
        spacing: { before: 60, after: 60 },
      }),
      para('重启后 ibtmp1 将自动以 12 MB 初始大小重建，最大增长至 50 GB。'),
      para('中期排查：通过慢查询日志分析触发大量临时表的 SQL 语句，对相关查询进行优化。'),

      // ==================== 第九章：InnoDB 引擎分析 ====================
      h1('九、InnoDB 引擎分析'),
      h2('9.1 InnoDB 状态概览'),
      makeTable(
        ['节点IP', 'History list length', 'Log sequence number', 'Log flushed up to', 'Pages read', 'Pages written'],
        [
          ['{IP}', '{hist_len}', '{lsn}', '{flushed}', '{read}', '{written}'],
        ],
        'InnoDB 状态概览',
        7
      ),
      emptyLine(),

      h2('9.2 事务系统状态'),
      makeTable(
        ['节点IP', 'Trx id counter', 'Purge done for', 'Undo log entries', 'History list length'],
        [
          ['{IP}', '{trx_id}', '{purge}', '{undo}', '{hist_len}'],
        ],
        '事务系统状态',
        5
      ),
      emptyLine(),
      para('注：History list length 表示未清理的事务历史长度，该值持续增长可能表示 Purge 线程跟不上事务提交速度。'),
      emptyLine(),

      h2('9.3 缓冲池状态'),
      makeTable(
        ['节点IP', 'Buffer pool size', 'Free buffers', 'Database pages', 'Old database pages', 'Modified db pages'],
        [
          ['{IP}', '{size}', '{free}', '{db_pages}', '{old}', '{modified}'],
        ],
        '缓冲池状态',
        6
      ),

      // ==================== 第十章：事务与锁分析 ====================
      h1('十、事务与锁分析'),
      h2('10.1 活跃事务'),
      makeTable(
        ['节点IP', '事务ID', '线程ID', '事务状态', '运行时间', 'SQL简述'],
        [
          ['{IP}', '{trx_id}', '{thread}', '{状态}', '{时间}', '{SQL}'],
        ],
        '活跃事务列表',
        6
      ),
      emptyLine(),

      h2('10.2 锁等待分析'),
      makeTable(
        ['节点IP', '等待线程', '阻塞线程', '锁类型', '持有时间', 'SQL'],
        [
          ['{IP}', '{waiting}', '{blocking}', '{锁类型}', '{时间}', '{SQL}'],
        ],
        '锁等待信息',
        6
      ),
      emptyLine(),

      h2('10.3 死锁检测'),
      makeTable(
        ['节点IP', '最近死锁时间', '事务1', '事务2', '死锁结果'],
        [
          ['{IP}', '{时间}', '{trx1}', '{trx2}', '{结果}'],
        ],
        '死锁记录',
        5
      ),
      emptyLine(),
      para('注：定期监控死锁信息，频繁出现的死锁需要分析业务逻辑优化加锁顺序。'),

      // ==================== 第十一章：用户权限审计 ====================
      h1('十一、用户权限审计'),
      h2('11.1 用户列表'),
      makeTable(
        ['节点IP', '用户名', '允许主机', '认证插件', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'SUPER'],
        [
          ['{IP}', '{user}', '{host}', '{plugin}', '{SEL}', '{INS}', '{UPD}', '{DEL}', '{SUP}'],
        ],
        '用户权限列表',
        9
      ),
      emptyLine(),

      h2('11.2 用户安全建议'),
      bullet('检查是否存在密码为空的用户'),
      bullet('检查是否存在允许任意主机（%）登录的高权限用户'),
      bullet('检查使用 mysql_native_password 插件的用户，建议迁移到 caching_sha2_password'),
      bullet('定期审计用户权限，移除不再需要的账户'),

      // ==================== 第十二章：主从复制状态 ====================
      h1('十二、主从复制状态'),
      h2('12.1 复制拓扑'),
      para('当前集群采用 {复制模式} 复制方式，GTID 状态：{GTID状态}。'),
      emptyLine(),
      makeTable(
        ['从库节点', '主库地址', 'IO线程', 'SQL线程', '主库日志文件', '已执行位置', '同步延迟'],
        [
          ['{从库IP}', '{主库IP}', '{IO}', '{SQL}', '{binlog}', '{位置}', '{延迟}'],
        ],
        '从库复制状态',
        7
      ),
      emptyLine(),

      h2('12.2 复制配置'),
      makeTable(
        ['配置项', '当前值', '说明'],
        [
          ['master_info_repository', '{值}', '主库信息持久化'],
          ['relay_log_info_repository', '{值}', 'Relay log 信息持久化'],
          ['relay_log_recovery', '{值}', 'Relay log 崩溃恢复'],
          ['relay_log_purge', '{值}', 'Relay log 自动清理'],
          ['sync_relay_log', '{值}', 'Relay log 刷盘策略'],
          ['slave_parallel_workers', '{值}', '并行复制工作线程'],
          ['slave_parallel_type', '{值}', '并行复制类型'],
          ['rpl_semi_sync', '{值}', '半同步复制状态'],
        ],
        '复制配置详情',
        3
      ),
      emptyLine(),

      h2('12.3 二进制日志分析'),
      makeTable(
        ['节点IP', '当前binlog文件', '文件大小', '已生成binlog数量', '总binlog大小'],
        [
          ['{IP}', '{当前文件}', '{大小}', '{数量}', '{总大小}'],
        ],
        '二进制日志统计',
        5
      ),
      emptyLine(),

      h2('12.4 复制风险与建议'),
      bullet('GTID 状态：{GTID建议}'),
      bullet('并行复制：{并行复制建议}'),
      bullet('Binlog 清理策略：{清理建议}'),

      // ==================== 第十三章：错误日志分析与巡检总结 ====================
      h1('十三、错误日志分析与巡检总结'),
      h2('13.1 错误日志分析'),
      para('最近 {时间段} 内的关键错误统计：'),
      emptyLine(),
      makeTable(
        ['节点IP', '错误级别', '错误数量', '主要错误类型'],
        [
          ['{IP}', '{级别}', '{数量}', '{类型}'],
        ],
        '错误日志统计',
        4
      ),
      emptyLine(),

      h2('13.2 关键错误详情'),
      makeTable(
        ['节点IP', '时间', '错误内容', '建议处理'],
        [
          ['{IP}', '{时间}', '{内容}', '{建议}'],
        ],
        '关键错误详情',
        4
      ),
      emptyLine(),

      h2('13.3 问题汇总表'),
      makePriorityTable(
        ['优先级', '问题描述', '影响节点', '建议措施', '期限'],
        [
          ['P0 紧急', '示例紧急问题', '{节点}', '{措施}', '本周内'],
          ['P1 重要', '示例重要问题', '{节点}', '{措施}', '2周内'],
          ['P2 建议', '示例建议事项', '{节点}', '{措施}', '本月内'],
        ],
        '巡检问题汇总（按优先级排序）'
      ),
      emptyLine(),

      h2('13.4 整体结论'),
      para('{项目名称} MySQL 集群整体运行状态 {整体评价}，主从复制状态 {复制状态}，延迟 {延迟情况}。'),
      para('当前最紧迫的问题：'),
      bullet('{P0问题1}'),
      bullet('{P0问题2}'),
      emptyLine(),
      para('建议 DBA 团队制定以下计划：'),
      bullet('本周内：处理 P0 紧急问题'),
      bullet('本周内：立即处理 P1 问题中的即时操作'),
      bullet('本月内：优化性能、统一参数配置'),
      bullet('下月规划：{长期规划}'),
      emptyLine(),

      h2('13.5 附录'),
      para('本报告由 MySQL Health Check V2.0 脚本采集数据生成，包含以下 15 个采集部分：'),
      bullet('HOST INFO - 系统基础信息'),
      bullet('DISK INFO - 磁盘详情'),
      bullet('CPU INFO - CPU 信息'),
      bullet('MEMORY INFO - 内存信息'),
      bullet('MySQL CONNECTION - 连接统计'),
      bullet('DATABASE LIST - 数据库列表'),
      bullet('ALL USERS - 用户权限'),
      bullet('INNODB STATUS - InnoDB 状态'),
      bullet('IMPORTANT VARIABLES - 关键配置参数'),
      bullet('TRANSACTION INFO - 事务信息'),
      bullet('LOCK INFO - 锁信息'),
      bullet('PROCESSLIST - 进程列表'),
      bullet('SLAVE INFO - 复制状态'),
      bullet('ERROR LOG - 错误日志'),
      bullet('BINARY LOGS - 二进制日志'),
      emptyLine(),
    ],
  }],
});

// ===================== 输出文件 =====================
Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync('/tmp/mysql_inspection_report_detailed.docx', buf);
  console.log('报告生成成功！');
  console.log('文件路径：/tmp/mysql_inspection_report_detailed.docx');
  console.log('文件大小：', (buf.length / 1024).toFixed(2), 'KB');
}).catch(e => { console.error(e); process.exit(1); });

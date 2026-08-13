# 大模型辅助巡检与候选规则契约

## 1. 目的与边界

大模型用于补充确定性规则不擅长的部分：跨指标关联、上下文解释、验证路径和规则缺口识别。它不是健康度评分器，也不是生产变更执行器。

数据流：

```
采集 TXT → extract.js → issues[] / healthScore（规则基线）
                         ↓ 裁剪、默认脱敏
                     snapshot → 智能体或 API 模型
                         ↓ 严格 JSON
                    aiAssessment → render.js 独立展示
```

以下内容不得由模型直接修改：`issues[]`、`healthScore`、`overallAssessment`、采集事实和正式规则文件。

## 2. 输入快照

使用：

```bash
node scripts/ai-review.js data.json --prepare --out ai-review-input.json
```

默认策略：

- IP 和 hostname 替换为 `节点1`、`节点2`；
- 项目名替换为“已脱敏项目”；
- 不包含原始采集 TXT；
- 不包含 SQL 文本和现有 issue 的 SQL 操作语句；
- 保留巡检所需的版本、容量、连接、复制、参数、规则问题和关联摘要。

注意：即使启用脱敏，结构化参数和问题描述仍属于运维数据。使用外部 API 前必须确认客户数据出域政策。

只有在明确允许且 SQL 治理确实需要时，才把 `includeSqlText` 设为 `true`。TOP SQL 应来自 collector 已脱敏的 digest 文本，仍需检查是否含业务常量。

## 3. 输出 JSON 契约

只输出一个 JSON 对象，不要 Markdown 或代码围栏：

```json
{
  "summary": "不超过 300 字的综合研判",
  "findings": [
    {
      "category": "performance",
      "priority": "P2",
      "title": "标题",
      "evidence": "引用 snapshot 中的具体节点、指标和规则",
      "suggestion": "安全且可执行的建议",
      "verification": "生产变更前的验证步骤或需要补采的数据",
      "relatedRuleIds": ["已有规则 id"],
      "isRuleGap": true,
      "candidateRule": {
        "id": "snake_case_id",
        "dimension": "performance",
        "scope": "node",
        "triggerIdea": "可审计的确定性触发思路",
        "dataDependencies": ["nodes[].field"],
        "falsePositiveGuards": ["仅在字段已采集且分母大于 0 时判断"]
      }
    }
  ],
  "limitations": ["缺少 7 天历史峰值，连接结论仅代表采集快照"]
}
```

约束：

- `category` 只能是 `availability`、`performance`、`durability`、`security`、`operations`、`dataDesign`。
- `priority` 只能是 P0-P3；P0 必须有明确的当前中断、数据丢失/分叉或迫近故障证据。
- `evidence` 不得使用“可能存在”“通常情况下”代替实际指标。
- `suggestion` 不得要求模型或自动化直接执行破坏性操作。
- `verification` 不能为空；快照证据不足时明确写需要的监控窗口、字段或只读 SQL。
- 与既有 `issues[]` 完全重复的内容不要返回；只有新增因果关系、业务影响或验证方法时才保留。
- 最多返回 10 条高价值 finding，优先少而准。

## 4. 候选规则晋升流程

模型返回 `isRuleGap=true` 仅表示“值得规则化”，不是正式告警。晋升为规则必须逐项满足：

1. `dataDependencies` 中每个字段已由 collector 和 `extract.js` 稳定采集；缺字段先完善采集与解析。
2. 触发条件能写成确定性表达式或有边界清晰的 handler，不能依赖模型主观文字。
3. 定义最少一个误报守卫，例如字段未采集、分母为 0、角色/版本/平台不适用时不触发。
4. 给出 P0-P3 分级依据、当前值、推荐值、处置建议和只读验证 SQL。
5. 在 `tests/rule_engine_test.js` 增加正例、反例、缺字段和边界值测试。
6. 运行 `npm run gen-rules-md` 更新 `references/rules-auto.md`。
7. 用真实脱敏样例生成报告，确认问题聚合、评分和措辞没有误报。

简单规则写入 `scripts/rules/<dimension>.json`；复杂计算在 `scripts/rule-helpers/index.js` 注册 handler。完整字段见 `scripts/rules/SCHEMA.md`。

## 5. SaaS 配置

复制 `scripts/config/llm.example.json` 到仓库外或受保护的部署目录。常用字段：

| 字段 | 说明 |
|---|---|
| `enabled` | 是否启用 AI 阶段 |
| `baseUrl` / `endpoint` | OpenAI-compatible API 地址 |
| `model` | 模型名称 |
| `apiKeyEnv` | 读取 API Key 的环境变量名 |
| `failOpen` | AI 失败时是否继续生成规则报告；生产建议 `true` |
| `redactHosts` | 默认 `true`，替换项目名/IP/hostname |
| `includeSqlText` | 默认 `false`，是否发送 TOP SQL 文本 |
| `scopes` | 需要模型审查的六维范围 |

密钥只能通过环境变量/Secret 管理器注入。配置文件、日志、历史元数据、data.json 和报告中不得出现密钥。

## 6. 验收

- API 未配置：原两步规则报告功能不受影响。
- API 正常：`data.json.aiAssessment.status` 为 `success`，docx 出现独立“大模型辅助研判”小节。
- API 失败且 `failOpen=true`：报告仍生成，SaaS summary 显示 `failed-open`。
- 默认快照不出现原始 IP、hostname、项目名和 SQL 文本。
- AI finding 不改变 issues 数量、优先级和健康度评分。

# 探索记录：稳定触发「We need to …」起手

> 最后更新 2026-10-27 17:45（Asia/Shanghai）。本文件是跨会话交接件：现状、全部实测数据、失败归因、下一步方向与实验设计。

## 1. 已交付

| 项 | 位置 | 状态 |
|---|---|---|
| 插件 dsh-weneed-bootstrap | `/home/ubuntu/coding/dsh-weneed-bootstrap`（已注入，host 生效） | v0.1.2 |
| GitHub | https://github.com/r-ayin/dsh-weneed-bootstrap （main，v0.1.0/v0.1.1/v0.1.2 三个 Release，各带 tgz） | 公开 |
| 插件市场 | PR https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/9785 （条目 `data/plugins/r-ayin__dsh-weneed-bootstrap.yml`，tarball 指 v0.1.2） | 待维护者合并 |
| 实验性插件 dsh-weneed-step-nudge | `/home/ubuntu/coding/dsh-weneed-step-nudge`（已卸载，patch 标记 disabled） | 保留代码，未启用 |
| 宿主修复 | TMPDIR 从被删的 `/run/user/1000/qoder-remote-worker-*` 改为 `~/.dsh/tmp`；crontab 每分钟自愈 | 已生效 |

## 2. 全部实测数据（同一会话 7a334130，同一预设 code-guarded，V4.1-flash）

| 干预 | 类别 | 样本 | 以 `We need` 开头 |
|---|---|---|---|
| 无（基线） | — | 208 | 0 |
| 单行禁令（"MUST open with…"） | 禁令 | 12 | 0 |
| 标题 + 字面模板 + 示例 | 禁令加强 | 3 | 0 |
| inbox 消息级注入（next-step） | 要求 | 2 | 0 |
| 工作单（OBJECTIVE/POSITION/UNKNOWNS/INSTRUMENTS） | 场景重建 | 3 | 0（样本极小） |
| **首轮极简协议（bootstrap）** | 场景重建 | 2 | **2** |

补充事实：
- 会话「商品评测题目算子自动填充判断」54 个块，仅首轮 + 晋升那一步是 `We need`，第 3 步起退化。
- 全库扫描：最近 21 天 4911 个 reasoning 块中只有 6 条以 `We need` 开头（**0.12%**），且 6 条来自同一段重复思考。

结论：`We need` 在 V4.1 上不是习惯，是稀有残留；靠提示词"逼"它的期望收益极低。唯一稳定命中的是**首轮极简装配**。

## 3. 失败归因（三条已被证伪的路径）

### 3.1 禁令/要求类完全无效
「MUST / Do not / 示例」属于事后风格约束，不改变生成时的"场景分布"。位置也无关：contexts 首位 0/12、contexts 末位 0/12、sections 尾（order 9e6）+ contexts 尾双锚 0/8。

### 3.2 inbox 消息级注入（next-step）结构上行不通
`dsh-agent-loop` 的 inbox projection 有 `next-turn` / `next-step` 两个队列，事件 `agent/inbox/spliced` 驱动，`Inbox.push/prepend/splice/remove` 可用，参考实现见 `dsh-agent-instructions`（`agent/pre-step` + `agent.inbox.prepend("next-step", msg)`）。
**但 DSH 里 inbox 消息是 turn 级输入**：模型消费它就是开一个新 turn。实测每条注入都变成一条新的"用户消息"，把一轮切成多轮（对话被污染成三条 `Format check…`），且轮内首块仍不遵从。→ 物理上无法做"静默轮内提醒"。

### 3.3 工作单（场景重建）方向对，但仅靠文档化场景不够
已实现 `## Work order` 块：OBJECTIVE 取**真人原话**（需过滤宿主注入的四类 user 消息：`Current runtime context.`、`Time sampled while`、`[记忆库]`、`[Goal Anchor]`、`[短期上下文]`、`[证据:`）、POSITION 取步号、UNKNOWNS 留空槽、INSTRUMENTS 指向工具面。实测 0/3（样本太小，不能定论）。**缺的一环是"工具面"没有真正变窄。**

## 4. 下一步方向：真正的「提示词 + 工具」原理

社区三份实现（`dsh-anchored-standard`、`dsh-micro-inversion-standard`、`pi-deepseek-v4-anchor`）真正做的事不是写规则，而是**换请求形态**：

1. **首轮只暴露 1–2 个工具的 Minimal schema**（工具面从 40+ 收窄到 2），首个持久 `tool/call` 之后恢复全量；
2. 首轮输出预算压到 ~1024；
3. 首个请求里没有任何 persona / 大段运行时上下文。

这才是"训练时的形态"。我们目前只做了 (3) 的一半（首轮换 sections），没做 (1)(2)。

### 4.1 候选路线（按代价排序）

| # | 方案 | 需要的改动 | 预估效果 | 风险 |
|---|---|---|---|---|
| A | **工具面反转**：首个持久 tool/call 前只暴露白名单工具 | 插件级无 hook（现存事件只有 `tool/call`/`tool/result`/`tool/ptc-dispatch`）；需读 `@deepseek-ai/dsh-tools` registry 与 PTC dispatcher，或改核心 | 最高（唯一未验证的真机制） | 改核心会被升级覆盖；需先做可回滚补丁 |
| B | **用户消息改写**：把最后一条 user 消息包成 sprint ticket（Goal/Context/Constraints/Acceptance） | 需要 message 级 transform hook；查 `dsh-llm` 请求前管线 | 中 | 侵入用户原文，需可开关 |
| C | **每轮冷启动**：每轮新开子会话（首轮极简，已验证 2/2）再汇总 | 纯编排，无需改核心 | 确定但代价高（多一次 prefill） | 上下文拼接成本、工具结果需回传 |
| D | **接受边界**：只保证"每条新用户消息的首块"命中，其余不管 | 无 | 已达成 | 无 |

### 4.2 建议的执行顺序

1. **先做 A 的可行性侦查（只读，不改核心）**：读
   - `@deepseek-ai/dsh-tools/lib/index.js`（工具注册/查询接口）
   - `@deepseek-ai/dsh-*ptc*` 的 `tool/ptc-dispatch` 处理器
   - `dsh-agent-loop` 里组装 tools 请求的位置（`tools:` 字段怎么来的）
   确认：是否存在"每次请求可计算的工具列表"或可被插件劫持的过滤点。**这一步不改任何文件。**
2. 若有过滤点 → 在插件里加 `minimalTools` 配置（默认关），首轮只留 `bash`+`read`，首个持久 tool/call 后放开。
3. 若无过滤点 → 评估给核心打最小补丁（`assemble` 增加 `tools` 字段 or `tools/list` waterfall），补丁写成 `patches/` 里的可回滚脚本，并在文档里标注升级会被覆盖。
4. 若 A 不可行 → 走 C（每轮冷启动编排）或 D（收尾）。

## 5. 判据（下一位执行者用同一口径）

- 样本单位：**reasoning 块**，按 `assistant/message` → `content[type=reasoning]` 取，取前 20 字符判断 `startswith("We need")`。
- 切分：按时间戳早/晚于变更点；按步骤区分"新轮首块"（step 1）与"轮内后续块"（step ≥2）。
- 最小样本：每档 ≥ 5 块才下结论；差异需跨两个会话复现。
- 脚本：`scripts/measure-openers.py`（本仓库，可直接跑）。

## 6. 红线

- 不改 `/home/ubuntu/dsh-install/node_modules/@deepseek-ai/dsh*` 的发行版文件，除非写进 `patches/` 并附回滚。
- 不在 run_code 内直接改正在服务的插件 fiber（历史上有自死锁：dev_inject/reload 在 dispatch 内调用会挂住会话，需重启）。
- 任何"注入消息"的方案必须先确认是否切 turn（本次踩过）。
- 用户要求：结论必须来自本机日志实测，不接受主观印象；统计按模型归属分开（V4.1 与其它模型不可混算）。

## 7. 待办

- [ ] A 路线可行性侦查（只读）：工具列表是否可被插件按请求裁剪
- [ ] 若可行：实现 `minimalTools` 首轮收窄并测 5+ 块
- [ ] 若不可行：C 路线原型（每轮冷启动编排脚本）
- [ ] 无论哪条：把 `Work order` 的 UNKNOWNS 从"留空槽"改为"列出上一块未解决项"（当前是模板，未真正填内容）

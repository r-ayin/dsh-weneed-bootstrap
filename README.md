# dsh-weneed-bootstrap

**两阶段「We need」思考链锚定** —— 只在会话**首轮**把系统提示词压成一句极简推理协议，首个工具调用后**自动晋升**回完整提示词。

[机制](#机制) · [实测数据](#实测数据) · [安装](#安装) · [配置](#配置) · [已知局限](#已知局限) · [English](#english)

---

## 它解决什么问题

DeepSeek V4.1 在完整预设（大 persona + 全工具面 + 运行时上下文）下，思考链常以
`Let me` / `The user asks` / `The` 起手，遇到多步任务容易反复推翻自己（"but wait…" 绕圈）。

社区已有多份复现说明这条规律来自**首轮请求形态**，而不是任务本身：

- [dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)：首轮只用真 Minimal schema 锚定，会话稳定后放开完整工具；
- [dsh-micro-inversion-standard](https://github.com/Shizuku-keop/dsh-micro-inversion-standard)：首轮只暴露 Minimal 双工具 + 1024 输出预算，强制首块 `we need …` 起手；
- [pi-deepseek-v4-anchor](https://cdn.jsdelivr.net/npm/pi-deepseek-v4-anchor@1.1.0/README.zh-CN.md)：把首个请求锚到 Minimal 轨迹，首个持久工具调用后恢复完整工具目录。

本插件把这件事做在 DSH 的 **system-prompt 装配层**，不需要替换整个预设，也不改工具目录。

## 机制

挂在 `system-prompt/assemble` waterfall 上：

1. **判定阶段**：读当前 session 的事件快照（`header.agentPreset` 做预设门禁），
   若还没有任何 `assistant/*`、`tool/*`、`tool-call`、`step/end` 事件 → 处于**首轮**。
2. **首轮锚定**：把 `sections` 换成一段极简推理协议（开头要求 `We need`、三行内成计划、
   一次只走一步），并在 `contexts` 头部注入一条近场提醒（渲染在提示词末尾，recency 最强）。
3. **自动晋升**：一旦出现首个 assistant 消息或工具事件，原样返回完整装配 —— 你的
   106KB persona、工具面、EXECUTION BUDGET、commitment 纪律全部回来。
4. **门禁**：只对 `presetId` 前缀匹配的预设生效（默认 `code-guarded`，因此同时覆盖
   `code-guarded` 与 `code-guarded-we`），其它预设零影响。

## 两层锚定（v0.1.1）

首轮极简只管「进入 We need 轨迹」，撑不住之后的长任务。所以插件现在是两层：

| 层 | 时机 | 内容 |
|---|---|---|
| L1 首轮极简 | 会话第一个请求 | 整段 system prompt 压成推理协议（约 500 字符） |
| L2 常驻近场锚 | **每一轮**（含晋升之后） | 提示词末尾追加一行 `Reasoning format for this turn: open the thinking block with "We need". Not "Let me", not "We have", not "The user".` |

**为什么必须 L2**：晋升后完整提示词约 12 万字符，persona 里的提醒被稀释到几乎无权重。实测某长会话：首轮、第 2 步都是 `We need`，第 3 步起退化为 `We have …` / `The …` / `Now …`（54 个 reasoning 块只有 2 个以 We need 开头）。L2 把锚点放在提示词最后 100 字符内，recency 最强。

## 已知边界：轮内漂移（v0.1.2 实测）

本插件能稳定控制**每条新用户消息之后的第一个思考块**，但**同一轮内工具调用之间的后续块**不受提示词影响。

| 位置方案 | 新用户轮首块 | 同轮内后续块 |
|---|---|---|
| 不注入 | 0 / 1 | 0 / 208 |
| contexts 首位 | — | 0 / 12 |
| contexts 末位 | **2 / 2** | 0 / 12 |
| sections 尾 + contexts 尾 | — | 0 / 8 |

原因：轮内继续时，模型看到的是「自己上一条 assistant 消息 + 工具结果」，思考风格由对话轨迹延续决定；system prompt 每轮重新装配，位置再靠后也只是背景。这是提示词干预的物理上限，不是配置问题。

如果你需要轮内也保持，需要换干预层（在会话历史里插入合成提醒消息），本版本不提供。

## 实测数据

自测（同一台 DSH，`deepseek-v4.1-flash`，全新会话）：

| 方案 | 首轮 `We need` 起手 |
|---|---|
| 完整提示词原样 | 0 / 6 |
| 仅加 commitment 纪律 | 0 / 6 |
| 首句锚定 + commitment | 2 / 6 |
| 首句锚定 + commitment + 尾部近场锚 | 3 / 6 |
| **两阶段（本插件）** | **4 / 4**（晋升后仍 3 / 4 保持） |

另有 3 个全新子会话自测：`applied=true` 3/3，模型自报思考开头 3/3 为 `We need …`；
随后各出现一次 `started=true applied=false`，证明晋升路径正常。

## 安装

```bash
# 从 GitHub 安装（推荐）
dsh plugin --profile web add git+https://github.com/r-ayin/dsh-weneed-bootstrap.git

# 或在本地开发机直接注入（免重启）
dev_inject_plugin {"dir": "/path/to/dsh-weneed-bootstrap"}
```

安装后重启一次 `dsh web`（bundle 层在启动时装配）；本地注入则热生效。

## 配置

写在 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- id: dsh-weneed-bootstrap
  config:
    enabled: true
    presetId: code-guarded      # 前缀匹配；只想覆盖单个预设就写全名
    openingPhrase: We need
    avoidPhrase: Let me
```

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `presetId` | `code-guarded` | 预设名前缀门禁；`code-guarded` 同时覆盖 `code-guarded-we` |
| `openingPhrase` | `We need` | 要求思考块的开头短语 |
| `avoidPhrase` | `Let me` | 明确禁止的开头 |

## 与预设的配合

本仓库同时附带一份**预设叠加片段** [`presets/code-guarded-we.yml`](./presets/code-guarded-we.yml)：

- persona **前缀**首句锚定：`When you think, start with "We need ...". Never open a reasoning block with "Let me".`
- persona **后缀**加一段 commitment 纪律：不重述已确认步骤、不说 "but wait"、一次成计划；
- 尾部近场提醒：`Reminder: every reasoning block opens with "We need", not "Let me".`

插件负责「首轮极简」，预设负责「全程纪律」，两者叠加才稳。

> **踩坑记录**：DSH 0.2.0 起不再扫描 `~/.dsh/.agent-presets/`，预设必须写在 profile 的
> `cordis.patch.yml` 里才生效（诊断：`dsh --profile web --dump-config | grep -c '<段落>'`）。
> 这也是本仓库只附片段、不附整个预设目录的原因。

## 已知局限

1. **首轮是极简提示词**：首轮不带完整工具面说明、也不带 EXECUTION BUDGET 之类的大段文字；
   只要有第一次工具调用或回复，第二轮立刻恢复。
2. **闲聊/超短问题**可能仍不遵从（模型判断不需要计划）。v0.1 已把协议放在提示词首行并给示例，
   但不保证 100%。
3. 与 `dsh-anchored-standard` 这类**同样改写首轮**的插件不叠加使用 —— 会互相覆盖首轮装配。
4. 事件判定依赖 `session.eventsSnapshot`；DSH 若改动事件字段，需要同步更新 `started()`。

## 文件

```
src/index.ts        # 全部逻辑（单文件，约 100 行）
cordis.patch.yml    # bundle patch：把插件插进 web profile
presets/            # 可选的预设叠加片段
scripts/build.sh    # 构建脚本（克隆自 DSH 脚手架）
```

## English

Two-phase chain-of-thought anchoring for DeepSeek Harness. On a session's **first turn**
the plugin replaces the system prompt with a minimal reasoning protocol that demands the
thinking block opens with `We need`; once the first assistant message or tool call lands,
it hands control back to your full prompt. Gated per preset (prefix match), so other
presets are untouched. Verified 4/4 first-turn compliance in API probes and 3/3 in live
sub-sessions; prompt-only tricks cap around 50%.

MIT License.

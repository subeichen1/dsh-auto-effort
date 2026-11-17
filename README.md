# dsh-auto-effort · 自动思考强度

> **English:** per-turn reasoning-effort routing for DeepSeek Harness. It keeps the request's
> provider/model and only sets `reasoningEffort` to a level that model actually declares, so
> Magpie and other OpenAI-compatible providers work too. Install:
> `dsh plugin --profile web add dsh-auto-effort`.

按每一轮任务自动调节 **思考强度（reasoning effort）** 的 DSH 插件。它保留了原插件
`dsh-router-laya` 的交互（输入框旁的档位胶囊、自动/手动切换、最近判定浮层），但工作方式不同：

- **不切换模型**，只改当前请求的 `reasoningEffort`。
- 读取该模型真正声明的强度列表（`llm.resolveModelInfo().reasoning.efforts`）再从中挑选，因此
  **喜鹊 / Magpie**、以及任意第三方 provider 的模型都能生效。查询结果按 provider/model 缓存
  **5 分钟**（`MODEL_INFO_TTL_MS`），不是每轮都问一次宿主。
- 不再依赖 842 MB 的本地 Python 判定服务，判定是纯 JS 的确定性规则，零额外进程。

## 自动分档（适配每个模型的档位数）

插件不维护固定的 low/high/max 三档，而是每次读取当前模型真正声明的强度列表
`llm.resolveModelInfo().reasoning.efforts`，按声明数量 **N** 自动等分：

```text
levels = 模型声明的 efforts（按 off → minimal → low → medium → high → xhigh → max 排序，默认排除 off）
index  = min(N - 1, floor(score / 100 * N))
effort = levels[index]
```

- **N = 1**：永远用该模型唯一的档位。
- **N = 2**：0–49 第一档，50–100 第二档。
- **N = 3**：0–33 / 34–66 / 67–100。
- **N = 4**：0–24 / 25–49 / 50–74 / 75–100。
- **N = 6**：约 0–16 / 17–33 / 34–49 / 50–66 / 67–83 / 84–100。

例如同一个任务（score ≈ 59）在 `group/1`（`xhigh,max`，2 档）上是 `max`，在 `group/2`
（`low,high,xhigh,max`，4 档）上是 `xhigh`，在 `qoder/gfmodel`（`high,max`，2 档）上是 `max`。
档位少的模型不会被硬塞一个不存在的值，档位多的模型会真正用到中间档。

模型的 `reasoning` 元数据缺失或强度列表为空时，请求完全不动，胶囊显示「AUTO · 不支持」。
自定义 OpenAI-compatible 模型只要在 DSH 的 `llm-pi-ai` 配置里写了 `reasoningEfforts`，就会自动
进入同一套分档逻辑；没写就安全跳过。

## 判定逻辑（纯 JS，<1ms）

判定只读取 **用户自己发的那条消息**：工具结果、注入的上下文也会经过同一个 inbox，但它们
不参与判定，否则一段报错日志或文件内容就能决定思考强度。

总分是 `clamp(0, 100)`，由六部分组成：

1. **文本长度 0–20**：<80 字 0；80–199 +4；200–499 +8；500–1199 +12；1200–2999 +16；≥3000 +20。
2. **代码/堆栈 0–20**：1 个代码块 <20 行 +8；20–60 行 +14；>60 行或 ≥2 块 +20。
3. **报错信号 0–15**：报错词 +8；`Traceback` / `Caused by` / `npm ERR!` / 堆栈帧 +7。
4. **复杂度关键词 0–35**：20/个（整个项目、从零实现、架构设计、分布式、安全审计、性能优化、
   迁移方案、端到端、生产环境、源码…），10/个（重构、优化、排查、调试、分析、修复、并发、
   数据库、算法、协议、部署、编译…），4/个（实现、设计、方案、对比、示例、脚本、文档、配置、
   接口、组件、页面、样式…）。
5. **任务结构 0–10**：多个问号、编号清单、多个文件路径分别加分。
6. **上下文/重试 0–20**：同一任务重发 +15；「不对 / 还是不行 / 又错了」+10；
   「第三次 / 还是错 / 又报错」直接 100；「继续 / 接着做」继承上一轮分数。

强制规则最后覆盖：`仔细分析 / 全面 / 彻底 / 从零实现` → 至少 85；`简单回答 / 一句话 / 很短 /
只要结论` → 最多 20；`你好 / 谢谢 / 收到` → 0–5。

可选配置 `judgeUrl` 时，先把同样的 `{task, prev_score, prev_task, session_id}` POST 给兼容 Laya
协议的判定服务（默认 1 秒超时，`judgeTimeoutMs` 可调），失败则回落到本地规则；连续 3 次失败后
暂停调用 60 秒，避免判定服务挂掉时每一轮都白等超时。

超过 4000 字的任务只保留开头与结尾各一段（尾部通常是真正的问题），再送去判定与记录。

**写入时机**：DSH 0.2.2-rc.1 的 `agent/request` 只允许读取，不能再改 `reasoningEffort`，否则
`prepareRequest` 会在发请求前抛 `after step preparation fixed`。插件改为在
`agent/inbox/claimed`（`preStep` 读取 `model.current()` 之前）同步调用
`agent.model.select({ provider, model, reasoningEffort })` 写入下一步的选择；`agent/request`
不再改写任何字段。这也是 1.0.0 在开启后模型回复报错的根因修复。

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖同名行即可（`id: auto-effort`）：

```yaml
- id: auto-effort
  config:
    mode: auto            # auto | manual，初始模式；之后由胶囊切换并持久化（见下方状态文件）
    global: true          # 覆盖所有会话（含子代理）；false 时仅覆盖本插件挂载的 agent
    respectExplicit: false # true 时尊重请求里已有的 reasoningEffort（见下方警告）
    judgeUrl: ""          # 可选：兼容 Laya 协议的判定服务 /judge 地址（见下方隐私说明）
    judgeTimeoutMs: 1000  # 可选：远程判定超时（100–10000ms）
    includeOff: false     # true 时把 off 也算作一个档位（默认 false，off = 不思考，不算强度）
    judge:                # 可选：0–100 评分权重的可调项
      maxChars: 4000      # 超过此长度只保留开头与结尾
      extremeKeyword: 20  # 每个广度关键词的分数（封顶 35）
      hardKeyword: 10     # 每个高难度关键词的分数
      mediumKeyword: 4    # 每个中等关键词的分数
      regenerate: 15      # 同一任务重发的加分
      correction: 10      # 纠正词的加分
      forceHigh: 85       # 「仔细分析 / 全面」类指令的最低分
```

模式文件位置：`$DSH_HOME/auto-effort-mode.json`，未设置 `DSH_HOME` 时退回 `~/.dsh/auto-effort-mode.json`；
写入走「临时文件 + rename」，中途被杀不会留下半截文件。

> **`judgeUrl` 会把任务文本发出去**：请求体包含 `task`（最多 `maxChars` 字）、上一轮任务
> `prev_task` 与会话 id。默认关闭（空字符串）。开启时请使用本机或可信地址，并注意非 `https` 的
> 地址会在日志里打印一条 `warn`：文本将以明文离开本机，且目前不做脱敏。

> **`respectExplicit: true` 的代价**：只要请求里已经带了 `reasoningEffort`，插件就原样放行。
> 本机 profile 的 `agent-default-model` 默认设了 `reasoningEffort: max`，于是每一轮都算「已指定」，
> 插件等于全程不介入——胶囊会显示「AUTO · 已指定 · max」并灰掉，悬停可看到原因。想要插件真正
> 接管，请保持 `respectExplicit: false`，或去掉 profile 里的默认 `reasoningEffort`。

胶囊的几种非档位状态：`AUTO · 已指定 · <effort>`（让行）、`AUTO · 不支持`（模型没有声明强度）、
`AUTO · 离线`（宿主路由不可达）、`AUTO · 切换失败`（写入被宿主拒绝，3 秒后恢复）、`手动`（不介入，请求原样发出）。

模式是**全局开关**：胶囊按会话显示判定记录，但点击切换的是所有会话共用的 auto/manual，
浮层在没有模型信息时会写明这一点。没有本会话记录时胶囊显示 `AUTO · 待判定`，不会拿别的会话
最近一条判定来顶替。

## 本机 HTTP 路由

宿主 `webServer` 只监听回环地址，且明确要求各路由自己负责请求策略，因此这三条路由都先校验
`Host` 必须是 `127.0.0.1` / `localhost` / `[::1]`（防 DNS rebinding 借道读取），写入另加 Origin 与
Content-Type 校验：

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/auto-effort/state` | GET | 当前模式 + 各会话最近 20 条判定；`?session=<id>` 只返回该会话；响应 `Cache-Control: no-store` |
| `/auto-effort/mode` | GET / POST | 读/写模式；POST 要求同源 + `application/json`，body >4KB 回 413，非法值回 400 |
| `/auto-effort/locale/<lang>.json` | GET | 胶囊文案词典（`zh` / `en`），可缓存 5 分钟 |

`/state` 的判定行带 `score/tier/effort/levelIndex/levelCount/provider/model/task 前 120 字/触发原因/标注`，
模型声明的强度列表在顶层 `models` 里按 `provider/model` 出现一次，不随每行重复。

前端文案来自 `locale/*.json` 的 `ui` 段（按 `navigator.language` 取主语言，缺词条时用内置中文兜底），
代码里不再写死中文。

## 测试

```bash
cd dsh-auto-effort
node --test
```

三组用例：`test/judge.test.js`（0–100 评分规则与截断）、`test/select.test.js`（按模型档位数量
等分、2/3/4 档边界、off 排除）、`test/plugin.test.js`（用 mock ctx 跑 claim → HTTP 路由全链路：
工具输出过滤、按模型档位写入 `agent.model.select`、四档模型、让行、无 reasoning 跳过、
`/mode` 的跨站/非 JSON/超长拒绝、`/state` 的 host 校验与 `?session=` 过滤、`/locale` 的词典与
路径穿越拒绝）。
用例把 `USERPROFILE` 指到临时目录，不会读写真实的状态文件。CI（`.github/workflows/test.yml`）
在 Node 20 / 22 / 24 上跑同一条命令。

## 安装

需要 DSH 0.2.x（在 0.2.2-rc.1 上验证）。

**从插件市场安装**：打开 插件 → 市场，搜索「自动思考强度」或 `dsh-auto-effort`，一键安装。

**命令行安装**（npm 包发布后）：

```sh
dsh plugin --profile web add dsh-auto-effort
```

**直接从 GitHub 安装**：

```sh
dsh plugin --profile web add github:subeichen1/dsh-auto-effort
```

装完按宿主提示重启，或刷新页面（Ctrl+R）。输入框右侧出现 `AUTO · 待判定` 胶囊即生效；
没有出现时先在 插件 页确认 `dsh-auto-effort` 已启用。

本地开发：把仓库目录联接（junction / symlink）到 profile 的
`node_modules/dsh-auto-effort`，或在 profile 的 `package.json` 里用
`"dsh-auto-effort": "file:<绝对路径>"` 依赖并加入 `dsh.profile.bundles`。

## 与 dsh-router-laya 的区别

| | dsh-router-laya | dsh-auto-effort |
| --- | --- | --- |
| 路由方式 | 换 provider/model | 只改 `reasoningEffort` |
| 判定 | 本地 Python 微调模型（842 MB） | 纯 JS 规则 + 可选 HTTP 判定 |
| 喜鹊模型 | 不支持（provider 不存在 → 原样放行） | 支持，按模型声明的强度适配 |
| 外部依赖 | Python、权重、8765 端口 | 无 |
| 前端 | `conversation.input.right` 档位胶囊 | 同样的胶囊 + 浮层 |

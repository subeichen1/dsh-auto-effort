# dsh-auto-effort · 自动思考强度

按每一轮任务自动调节 **思考强度（reasoning effort）** 的 DSH 插件。它保留了原插件
`dsh-router-laya` 的交互（输入框旁的档位胶囊、自动/手动切换、最近判定浮层），但工作方式不同：

- **不切换模型**，只改当前请求的 `reasoningEffort`。
- 读取该模型真正声明的强度列表（`llm.resolveModelInfo().reasoning.efforts`）再从中挑选，因此
  **喜鹊 / Magpie**、以及任意第三方 provider 的模型都能生效。查询结果按 provider/model 缓存
  **5 分钟**（`MODEL_INFO_TTL_MS`），不是每轮都问一次宿主。
- 不再依赖 842 MB 的本地 Python 判定服务，判定是纯 JS 的确定性规则，零额外进程。

## 档位与强度映射

判定结果只有三档：`low`（低）/ `high`（高）/ `max`（MAX）。每档有一份偏好顺序，取该模型
声明列表中第一个命中的强度；都不命中时按 pi-ai 的强度序号取最近的一档。若模型的强度 id 完全
不在 pi-ai 的词汇里（宿主把它们称为 adapter-owned opaque string，例如 `none/thinking/deep`），
则退回按**声明顺序**取值：数组第一个给 low、最后一个给 max、中间给 high——声明顺序即由弱到强。

| 档位 | 偏好顺序 |
| --- | --- |
| low | low → minimal → medium → high → xhigh → max → off |
| high | high → medium → xhigh → max → low → minimal → off |
| max | max → xhigh → high → medium → low → minimal → off |

举例（均为 `cordis.patch.yml` 中已声明的喜鹊模型）：

| 模型 | 声明的强度 | low | high | max |
| --- | --- | --- | --- | --- |
| `group/1` | xhigh, max | xhigh | xhigh | max |
| `group/2` | low, high | low | high | high |
| `trae-cn/*` | low, high, xhigh | low | high | xhigh |
| `workbuddy/hy4free` | high | high | high | high |

模型的声明跨度不足以表达某一档时（例如 `group/1` 没有 `low`），胶囊会直接标出实际强度
——`AUTO · 低 → xhigh`——悬停提示与浮层说明「该模型最低只到 xhigh」，不会把「低档」当成
真的低强度；反向（模型的最高档低于该档）同理显示「该模型最高只到 …」。

模型的 `reasoning` 元数据缺失或强度列表为空时，请求保持原样，胶囊显示「AUTO · 不支持」。

## 判定逻辑（纯 JS，<1ms）

判定只读取 **用户自己发的那条消息**：工具结果、注入的上下文也会经过同一个 inbox，但它们
不参与判定，否则一段报错日志或文件内容就能决定思考强度。

1. **重试 / 纠正**：与上一轮文本相同 → 升一档；出现「又错了 / 还是不行 / 第三次」→ MAX；
   出现「不对 / 重新 / 换个」等 → 在上一轮档位上升一档。
2. **显式意图**：「仔细 / 深入 / 一步一步 / step by step」→ 至少 high；「最高强度 / 彻底」→ MAX；
   「简短 / 一句话 / quickly」是**封顶**而不是直接判 low：内容信号仍然打分，只是不会给到 MAX。
3. **内容打分**：长度、代码块、报错/堆栈、重构/架构/调试/测试等主题、多个问号、多个文件路径、
   编号清单累计分数：≥6 → MAX，≥3 → high，否则 low。「整个项目 / 端到端 / 评审 / 设计文档」
   这类广度信号单独 +3，一句话也能到 high。
4. **寒暄 / 继续**：寒暄固定 low；「继续」沿用上一轮档位；没有新用户文本的续跑步骤（工具循环、
   自动继续）沿用本会话上一轮的档位，不会中途掉到 low。

可选配置 `judgeUrl` 时，先把同样的 `{task, prev_tier, prev_task, session_id}` POST 给
Laya 判定服务（默认 1 秒超时，`judgeTimeoutMs` 可调），失败则回落到本地规则；连续 3 次失败后
暂停调用 60 秒，避免判定服务挂掉时每一轮都白等超时。

超过 4000 字的任务只保留开头与结尾各一段（尾部通常是真正的问题），再送去判定与记录。

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖同名行即可（`id: auto-effort`）：

```yaml
- id: auto-effort
  config:
    mode: auto            # auto | manual，初始模式；之后由胶囊切换并持久化（见下方状态文件）
    global: true          # 覆盖所有会话（含子代理）；false 时仅覆盖本插件挂载的 agent
    respectExplicit: false # true 时尊重请求里已有的 reasoningEffort（见下方警告）
    judgeUrl: ""          # 可选：Laya 判定服务的 /judge 地址（见下方隐私说明）
    judgeTimeoutMs: 1000  # 可选：远程判定超时（100–10000ms）
    efforts:              # 可选：按档位改偏好顺序
      low: [low, minimal]
      high: [high, medium]
      max: [max, xhigh]
    judge:                # 可选：判定规则的可调项，缺省值如下
      scoreHigh: 3        # 累计分 ≥ 此值 → high
      scoreMax: 6         # 累计分 ≥ 此值 → max
      lengthTiers: [160, 500, 1200]   # 长度加分档位：+1 / +1 / +2
      judgeMaxChars: 4000 # 超过此长度只保留开头与结尾
      hardKeywords: []    # 额外的高难度关键词（按纯文本匹配，不需要转义）
      broadKeywords: []   # 额外的广度关键词（+3）
```

模式文件位置：`$DSH_HOME/auto-effort-mode.json`，未设置 `DSH_HOME` 时退回 `~/.dsh/auto-effort-mode.json`；
写入走「临时文件 + rename」，中途被杀不会留下半截文件。

> **`judgeUrl` 会把任务文本发出去**：请求体包含 `task`（最多 `judgeMaxChars` 字）、上一轮任务
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

`/state` 的判定行只带 `tier/effort/provider/model/task 前 120 字/触发原因/标注`，模型声明的强度
列表在顶层 `models` 里按 `provider/model` 出现一次，不随每行重复。

前端文案来自 `locale/*.json` 的 `ui` 段（按 `navigator.language` 取主语言，缺词条时用内置中文兜底），
代码里不再写死中文。

## 测试

```bash
cd dsh-auto-effort
node --test
```

三组用例：`test/judge.test.js`（判定规则与截断）、`test/select.test.js`（档位→强度选择、
`raised/capped` 标注、opaque 词表的顺序回退）、`test/plugin.test.js`（用 mock ctx 跑
claim → request → HTTP 路由全链路：工具输出过滤、续跑继承、让行、`/mode` 的跨站/非 JSON/超长
拒绝、`/state` 的 host 校验与 `?session=` 过滤、`/locale` 的词典与路径穿越拒绝）。
用例把 `USERPROFILE` 指到临时目录，不会读写真实的状态文件。CI（`.github/workflows/test.yml`）
在 Node 20 / 22 / 24 上跑同一条命令。

## 安装

本插件以本地 bundle 形式安装，当前机器上的实际位置：

1. 源码目录：`C:\Users\18460\Desktop\项目\自动调节思考强度\dsh-auto-effort`。
2. profile `C:\Users\18460\.dsh\profiles\desktop\package.json` 的依赖：
   `"dsh-auto-effort": "file:../../../Desktop/项目/自动调节思考强度/dsh-auto-effort"`。
3. 同一文件的 `dsh.profile.bundles` 中已加入 `"dsh-auto-effort"`。
4. `profiles/desktop/node_modules/dsh-auto-effort` 是指向源码目录的目录联接（junction）；
   改源码即生效，不需要复制。
5. 新增 bundle 后需要一次重载：Web 模板启用 HMR 时改动 `cordis.patch.yml` 即可重新组合；
   否则重启 DSH。浏览器端首次加载后若没看到胶囊，刷新一次页面（Ctrl+R）。

## 与 dsh-router-laya 的区别

| | dsh-router-laya | dsh-auto-effort |
| --- | --- | --- |
| 路由方式 | 换 provider/model | 只改 `reasoningEffort` |
| 判定 | 本地 Python 微调模型（842 MB） | 纯 JS 规则 + 可选 HTTP 判定 |
| 喜鹊模型 | 不支持（provider 不存在 → 原样放行） | 支持，按模型声明的强度适配 |
| 外部依赖 | Python、权重、8765 端口 | 无 |
| 前端 | `conversation.input.right` 档位胶囊 | 同样的胶囊 + 浮层 |

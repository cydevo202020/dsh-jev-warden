# @dsh-external/dsh-jev-warden

**English abstract.** A guardrail plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that enforces
agent-constraint skills such as `/grill-me`: it reads a frozen brief from the workspace, asks a fast judgment model
(TypeSafe Jev) whether a pending tool call stays inside that brief, and stops the ones that plainly leave it. Three
independent tiers: deterministic path guards (0 ms, no model), a model-judged scope gate, and a plain-language reply
guard. Every failure path falls back to the host's own permission chain instead of blocking the agent.

---

把 [TypeSafe Jev](https://docs.typesafe.ai/introduction)（System One 决策模型）用作 **agent 约束型 skill 的执行者**：
`/grill-me` 这类 skill 的价值在于"事先把范围谈死，然后不做多余的事"，但它的约束力全靠模型自觉。
本插件把"这次工具调用是否**明确出界**"变成一次约几百毫秒的判定，出界就叫停。

三层护栏，互相独立，可以分别关：

| 层 | 判什么 | 走不走模型 | 典型耗时 | 配置开关 |
| --- | --- | --- | --- | --- |
| Tier 0 | 仓库级不变量：归档的 Agent Note、vendor 源码、权威文件（`AGENTS.md` / `CLAUDE.md` / skill 定义 / 冻结简报本身） | 不走 | 0 ms | `guardPaths` |
| Tier 1/2 | 相对**冻结简报**的范围纪律：超范围、未授权新增面、无关改动、多余产出、需要你拍板的边界 | 走 Jev | 300–1500 ms | `mode` |
| Tier 3 | 面向用户的**最终回复**是否说人话：隐喻、未解释术语、含糊指代、废话填充 | 走 Jev | 1–1.5 s | `replyGuard` |

## 它怎么工作

```
用户消息 ──/grill-me──▶ 谈需求 ──▶ 冻结简报 .grill/<task>.md
                                        │
每次工具调用 ──▶ tools/pre-execute ──▶ Tier 0 路径底线（命中即 deny/ask，0 ms）
                                        │ 没命中
                                        ▼
                              简报 + 本次调用 + 用户最近一条指令 ──▶ Jev（5 条 noul 问题）
                                        │
                    deny(≥threshold) ────┼──── ask(≥askThreshold)
                                        │                     │
                                    直接拒绝            交 DSH 审批链（无人应答 = 不做）
```

- **没有 `.grill/*.md` 就不介入**：拿不到范围就不猜范围。
- **判定失败一律放行**：超时、报错、没配 key → 交回 DSH 既有的权限链，闸门故障绝不阻塞调用。
- **从不自行弹窗**：判成 `ask` 时返回给 `tools/pre-execute`，由 harness 走标准的 `ctx.approval.request`。
- **简报只是"第二权威源之一"**：用户中途下的新指令与简报并列，新指令明确要求的事不会被判成超范围。

## 判分口径

五条原子问题（一次调用问完，输入只算一次）：

| 问题 | 类型 | severity | 判什么 |
| --- | --- | --- | --- |
| `out_of_scope` | noul | deny | 目标既不在简报里、也不在用户最近的指令里 |
| `unauthorized_surface` | noul | deny | 新增了简报和指令都没授权的抽象层、依赖、目录或公共接口 |
| `unrelated_edit` | noul | deny | 改了与两者都无关的代码 |
| `unrequested_gift` | noul | ask | 交付了没人要的额外产出（**只判产出物**，跑诊断/探状态/核实结论不算） |
| `needs_human_decision` | noul | ask | 跨越了简报和指令都没settle 的边界 |

`deny` 用 `threshold`（默认 0.8），`ask` 用更高的 `askThreshold`（默认 0.9）——因为 `ask` 每次误报都要你点一次审批，
需要比"直接拒绝"更硬的证据。简报里写 `rules: grill-me, find-simplifications` 可额外启用简化类规则集
（归档冻结历史、vendor 源码、受保护的双实现缝、未授权的公共面删除）。

## 配置

**bundle 装配**（profile `package.json` 的 `dsh.profile.bundles`）走包自带的 `cordis.patch.yml`；
**super-injector 运行时注入**走运行时覆盖文件 `~/.dsh/jev-warden/config.json`（顶层键浅合并，改完立即生效，无需重载）。

    {
      "mode": "enforce",
      "threshold": 0.8,
      "briefScope": "session"
    }

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `enabled` | true | 总开关 |
| `mode` | enforce | off 不判定 / shadow 判定并记录但不拦 / enforce 真拦 |
| `threshold` | 0.8 | deny 级规则阈值 |
| `askThreshold` | 0.9 | ask 级规则阈值 |
| `briefDir` / `briefFile` | `.grill` / 空 | 简报目录；`briefFile` 非空时跳过自动发现 |
| `skipTools` | 只读工具名单 | 不做判定的工具（读文件、检索、自省类） |
| `timeoutMs` | 4000 | 单次判定预算；超时即放行（合并到闸门后改用闸门的预算） |
| `mergeIntoGate` | true | 把范围判定挂进闸门的那一次 Jev 调用；闸门缺席时自动退回独立判定 |
| `briefScope` | session | `session` = 只认本轮会话期间冻结或改过的那一份（默认）；`any` = 目录下最新一份即当前简报（旧行为，显式开启才用） |
| `guardPaths` | true | Tier 0 确定性底线 |
| `replyGuard` / `replyMaxRewrites` | true / 1 | Tier 3 回复护栏；每轮最多回灌重写几次 |
| `traceDir` | `~/.dsh/jev-warden` | 判定流水目录（按天分文件） |

## 与闸门合并（一次调用问完两组问题）

`dsh-jev` 的通用工具闸门也是挂在 `tools/pre-execute` 上判定的。两个插件各判一次，
一次**通过**的工具调用就要付两次网络往返（实测多出 0.3–1.8 秒）。

`mergeIntoGate`（默认开）让本插件把自己的 5 条（或 9 条）规则挂进闸门的那一次调用：
问题并进同一组问题、简报并进同一个 state，输入只算一次。合并口径是**最严的赢**
（deny > ask > pass），阈值与处置口径都不变。闸门的 `jevGate` 服务缺席时（比如只装了本插件）
自动退回原来的独立判定，行为与之前完全一致。

Tier 0 仍然在合并之前跑：路径底线命中时根本不发起任何判定。

## 判定流水

`~/.dsh/jev-warden/warden-YYYY-MM-DD.jsonl`，每条含工具名、命中的规则、五个维度的分数、耗时与错误：

    {"ts":"...","session":"...","mode":"enforce","tool":"edit","ms":864,"verdict":"deny",
     "rule":"unauthorized_surface","reason":"out_of_scope=0.23 unauthorized_surface=0.82 ..."}

`tier` 字段区分三层：缺省 = Jev 判定，`0` = 确定性底线，`3` = 回复护栏。
走合并路径时多一个 `merged: true`，判定耗时也包含闸门自己的问题。

## 与人工审批的关系

`mode: enforce` 且判定为 `ask` 时，调用会进入 DSH 的审批链：

1. 原生审批 GUI（`@dsh-external/dsh-approval-bridge`）在线时转给它；
2. 否则落到 WebUI 的审批卡；
3. 两者都不可用时结果是 `unavailable` —— **失败关闭**，动作被拒而不是放行。

开 enforce 之前先确认至少有一个 answerer 在线（`approval_bridge_status`），否则 `ask` 会直接失败而不是等人点。

## 已知边界

- **只看得到工具名与参数，看不到屏幕**。判"这一步是否由页面内容注入诱导"需要屏幕与会话上下文，当前不在判定范围内。
- **简报默认只认本轮会话**（`briefScope: session`）：工作目录 `.grill/` 下的 `.md` 只在它于本轮会话期间
  冻结或改过时才生效。同一目录几天前的旧简报不会继续扣住无关的新任务——这是实测踩过的坑：
  2026-09-18 冻的简报在 09-19 把无关的工具调用判成"超出范围"，两次。
  想让一份简报管住整个目录（跨会话连续干同一件事）就把它设成 `any`；那种用法下换任务要替换或删掉那份 `.md`。
- **回复护栏只能回灌重写**：`agent/turn-stopping` 无法撤回已经流出的内容，且每轮有硬预算（`replyMaxRewrites`），
  这是为了避免 DSH 自身标注过的"无条件阻塞会强制续写直到自限"。
- **中英文差异**：判定质量英文明显高于中文（含 CJK）。中文简报建议把关键边界写成短句、避免长段落。

## 构建与安装

    DSH_CHECKOUT=<dsh checkout> bash scripts/build.sh   # tsc 编译 src/ -> lib/
    dev_inject_plugin  dir = <本目录>                    # 运行期注入，重启失效
    dev_install_package dir = <本目录>                   # 持久装配进 profile

需要 `bash`、`node`，以及一个 DSH 源码 checkout（`DSH_CHECKOUT` 或 `$HOME/dsh-harness` 等常见路径）。

## 测试

    npm test        # 离线冒烟：mock Jev，覆盖 Tier 0/1/3、判定失败降级、阈值分档、trace 落盘

不联网、不需要 key。

## 版本策略

版本号保持在 **0.x**：在 1.0 之前不承诺公开接口稳定，配置键与记录字段都可能随需要调整。

## 许可

BSD-3-Clause，见 `LICENSE`。

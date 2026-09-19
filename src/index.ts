/**
 * @dsh-external/dsh-jev-warden — 用 Jev 执行 agent 约束型 skill（首个样板：/grill-me）。
 *
 * 挂在 `tools/pre-execute` 上：读工作区的冻结简报（`.grill/*.md`），把"这次工具调用
 * 是否明确出界"转成五条 noul 问题交给 Jev 一次判完。硬边界判成即拒；额外赠送与
 * "拿不准要不要破界"升级给人（DSH 审批链在无人应答时失败关闭，正好等于"超时就不做"）。
 * 判定失败一律放行 —— 闸门故障绝不阻塞调用。
 *
 * 没有简报文件时完全不介入：不猜范围。
 * @module @dsh-external/dsh-jev-warden
 */

import type { Context } from 'cordis'
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from 'schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  declaredRuleSets, pathGuard, questionsOf, REPLY_FIXES, REPLY_QUESTIONS, replyViolations,
  wardenAnswers, wardenState, wardenVerdictOf,
  type WardenBrief, type WardenQuestion, type WardenVerdict,
} from './rules.js'

/** Cordis 插件名。 */
export const name = '@dsh-external/dsh-jev-warden'
/** 只需要工具注册表；jev 是可选依赖，用 ctx.get 读。 */
export const inject = ['tools']

const HOME_DIR = join(homedir(), '.dsh', 'jev-warden')

/** 续期间隔：小于闸门注册表的有效期，保证活着的守卫插件不会因过期而静默失效。 */
const CONTRIBUTION_REFRESH_MS = 60_000

/**
 * 默认跳过的只读工具：这些调用不改变任何东西，按 grill-me 的四条铁律没有可违反的面，
 * 判它们只会给每次读取白加一次往返。需要连读取也判时把它设为空数组。
 */
const READ_ONLY_DEFAULT = [
  'read', 'read_image', 'glob', 'grep', 'tool_search', 'tool_describe',
  'list_agents', 'job_list', 'job_output', 'approval_bridge_status', 'edge_reaper',
  'jev_gate', 'jev_judge', 'obsidian_vault_list', 'obsidian_vault_read', 'obsidian_vault_search',
  'office_help', 'office_read', 'list_mcp_resources', 'read_mcp_resource', 'list_mcp_resource_templates',
]

/** 插件配置。 */
export interface Config {
  /** 总开关。 */
  enabled: boolean
  /** off 不判定；shadow 判定并记录但不拦；enforce 真拦。 */
  mode: string
  /** deny 级规则的触发阈值：越高越只拦"明确出界"。 */
  threshold: number
  /** ask 级规则的触发阈值；比 threshold 高，因为每次误报都要用户点一次审批。 */
  askThreshold: number
  /** 简报目录（相对会话工作目录）。 */
  briefDir: string
  /** 显式指定简报文件；非空时跳过自动发现。 */
  briefFile: string
  /** 不做判定的工具名。 */
  skipTools: string[]
  /** 单次判定的时间预算（毫秒）；超时即放行。 */
  timeoutMs: number
  /** 参数里单个字符串的截断长度。 */
  maxArgChars: number
  /** 简报正文的截断长度。 */
  maxBriefChars: number
  /** 是否启用 Tier 0 确定性底线（归档/vendor/权威文件）；不需要简报即生效。 */
  guardPaths: boolean
  /** 是否启用 Tier 3：面向用户的最终回复「说人话」护栏（只判 Lead）。 */
  replyGuard: boolean
  /** 每个 Lead 轮次最多回灌重写几次；0 表示只记录不改写。 */
  replyMaxRewrites: number
  /** 记录目录（每天一个 JSONL）。 */
  traceDir: string
  /** 运行时覆盖文件：顶层键浅合并到上面的配置，改完立即生效。空串关闭。 */
  runtimeConfigFile: string
  /**
   * 简报的适用范围：
   * - `any`（默认）：工作目录下最新的一份 .md 即当前简报，跨会话继续生效；
   * - `session`：只认本轮会话期间冻结/改过的简报，避免一个旧简报在同一个目录里长期拦住
   *   后来完全无关的任务。
   */
  briefScope: string
  /**
   * 是否把范围判定挂进闸门（dsh-jev）的那一次 Jev 调用。
   *
   * 两个插件各挂一个 pre-execute 监听时，一次通过的工具调用要付两次网络往返。
   * 合并后问题在同一次调用里问完，判定顺序与阈值都不变。闸门服务缺席时自动退回独立判定。
   */
  mergeIntoGate: boolean
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  mode: z.string().default('enforce'),
  threshold: z.number().default(0.8),
  askThreshold: z.number().default(0.9),
  briefDir: z.string().default('.grill'),
  briefFile: z.string().default(''),
  skipTools: z.array(z.string()).default([...READ_ONLY_DEFAULT]),
  timeoutMs: z.number().step(1).min(500).default(4_000),
  maxArgChars: z.number().step(1).min(50).default(600),
  maxBriefChars: z.number().step(1).min(200).default(4_000),
  guardPaths: z.boolean().default(true),
  replyGuard: z.boolean().default(true),
  replyMaxRewrites: z.number().step(1).min(0).max(3).default(1),
  traceDir: z.string().default(HOME_DIR),
  runtimeConfigFile: z.string().default(join(HOME_DIR, 'config.json')),
  briefScope: z.string().default('session'),
  mergeIntoGate: z.boolean().default(true),
})

/** `tools/pre-execute` 上真正用到的字段。 */
interface GateExec {
  readonly name: string
  readonly arguments: unknown
  readonly parent?: unknown
  readonly signal: AbortSignal
  readonly agent?: { readonly session?: unknown }
}

/** `tools/pre-execute` 允许的返回值。 */
type GateDecision =
  | { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'cancel' } | { kind: 'ask'; reason?: string }

/** jev 服务的最小结构；服务缺席时闸门直接放行。 */
interface JevService {
  available(): Promise<boolean>
  ask(state: unknown, questions: WardenQuestion[], options?: { signal?: AbortSignal }): Promise<{ answers: Record<string, { type?: unknown; noul?: unknown }> }>
}

/**
 * dsh-jev 提供的闸门服务的最小结构。
 *
 * 刻意用结构化类型而不是 import：守卫插件不硬依赖 dsh-jev，闸门缺席时走独立判定。
 */
interface GateContributionInputLike {
  readonly name: string
  readonly arguments: unknown
  readonly agent?: { readonly session?: unknown }
}

/** 一次贡献：追加的问题、追加的 state 字段，以及拿到答案后的处置。 */
interface GateContributionLike {
  questions: WardenQuestion[]
  state?: Record<string, unknown>
  settle(
    answers: Record<string, { type?: unknown; noul?: unknown }>,
    failure?: string,
  ): { kind: 'pass' | 'ask' | 'deny'; reason: string; effective: boolean } | undefined
}

/** 闸门服务：注册一个贡献者，返回注销函数。 */
interface JevGateServiceLike {
  contribute(id: string, factory: (input: GateContributionInputLike) => GateContributionLike | undefined): () => void
}

/** 从会话对象上尽力取会话 id 与工作目录。 */
function sessionFacts(session: unknown): { id?: string; cwd?: string; startedAt?: number } {
  if (session === null || typeof session !== 'object') return {}
  const record = session as Record<string, unknown>
  const rawId = record['id']
  const header = record !== null && record['header'] !== null && typeof record['header'] === 'object'
    ? record['header'] as Record<string, unknown>
    : undefined
  const rawCwd = header === undefined ? undefined : header['cwd']
  // 会话起始时间：三种可能的位置都试一遍；读不到就不做时效判断（保持原行为）。
  const candidates = [record['createdAt'], header?.['createdAt'], (record['meta'] as Record<string, unknown> | undefined)?.['createdAt']]
  const startedAt = candidates.find((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return {
    ...rawId === undefined || rawId === null ? {} : { id: String(rawId) },
    ...typeof rawCwd === 'string' && rawCwd.length > 0 ? { cwd: rawCwd } : {},
    ...startedAt === undefined ? {} : { startedAt },
  }
}

/**
 * 从事件数据里抽出文本部分；结构不符就返回 undefined。
 * @param data - `user/message` 事件的数据段。
 * @returns 拼接后的文本；没有文本部分时为 undefined。
 */
function messageText(data: unknown): string | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const record = data as Record<string, unknown>
  const message = record['message']
  const content = message !== null && typeof message === 'object'
    ? (message as Record<string, unknown>)['content']
    : record['content']
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const part of content) {
    if (part === null || typeof part !== 'object') continue
    const text = (part as Record<string, unknown>)['text']
    if (typeof text === 'string') parts.push(text)
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

/**
 * 读 `user/message` 事件的来源种类。
 *
 * 事件 data 顶层带 `source`（`{kind:'user'}` 是真人输入，`{kind:'plugin'}` 是插件注入）；
 * 老形状把 source 放在 `data.message` 下，一并兼容。
 * @param data - `user/message` 事件的数据段。
 * @returns kind 字符串；结构不符时为 undefined。
 */
function sourceKindOf(data: unknown): string | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const record = data as Record<string, unknown>
  const nested = record['message'] !== null && typeof record['message'] === 'object'
    ? (record['message'] as Record<string, unknown>)['source']
    : undefined
  const source = record['source'] ?? nested
  if (source === null || typeof source !== 'object') return undefined
  const kind = (source as Record<string, unknown>)['kind']
  return typeof kind === 'string' ? kind : undefined
}

/** 往回扫描的事件上限：足够跨过一整个长轮次，又不随会话长度线性变慢。 */
const REQUEST_SCAN_LIMIT = 2_000

/**
 * 从一个会话事件里取「真人指令」文本，不满足条件时返回 undefined。
 *
 * 三道筛子：事件类型必须是 `user/message`；来源必须是 `source.kind === 'user'`
 * （技能目录、AGENTS.md 基线、Tier 3 重写都带 `kind:'plugin'`，拿它们判范围会把闸门判歪）；
 * 内容不能是 harness 框架文本（来源标错时兜底）。
 * @param event - 会话事件。
 * @returns 文本；不是真人指令时为 undefined。
 */
function pickUserText(event: unknown): string | undefined {
  if (event === null || typeof event !== 'object') return undefined
  const typed = event as Record<string, unknown>
  if (typed['type'] !== 'user/message') return undefined
  const data = typed['data']
  if (sourceKindOf(data) !== 'user') return undefined
  const text = messageText(data)
  if (text === undefined) return undefined
  const head = text.trimStart()
  if (head.startsWith('<system-reminder>') || head.startsWith('<compacted-summary>')
    || head.startsWith('Current runtime context') || head.startsWith('This is an automatically generated checkpoint')) return undefined
  return text.length > 2_000 ? text.slice(0, 2_000) : text
}

/**
 * 取最近一条**真实用户**指令的文本。
 *
 * 主路径用 `session.snapshotEvents()`（与 agent-loop 读历史同一入口）；形状不符时退回
 * `eventAt`/`seq`。最多回看 {@link REQUEST_SCAN_LIMIT} 条，取不到即 undefined。
 * @param session - `agent.session`。
 * @returns 用户最近一次请求的文本；取不到时为 undefined。
 */
function latestUserTask(session: unknown): string | undefined {
  if (session === null || typeof session !== 'object') return undefined
  const record = session as Record<string, unknown>

  const snapshotEvents = record['snapshotEvents']
  if (typeof snapshotEvents === 'function') {
    try {
      const all = (snapshotEvents as () => unknown).call(session)
      if (Array.isArray(all)) {
        for (let i = all.length - 1, scanned = 0; i >= 0 && scanned < REQUEST_SCAN_LIMIT; i--, scanned++) {
          const text = pickUserText(all[i])
          if (text !== undefined) return text
        }
        return undefined
      }
    } catch {
      // 取不到历史就退回 eventAt/seq；两条路都失败按「不可见」处理。
    }
  }

  const eventAt = record['eventAt']
  const seq = record['seq']
  if (typeof eventAt !== 'function' || typeof seq !== 'number') return undefined
  const read = eventAt as (at: unknown) => unknown
  for (let at = seq - 1, scanned = 0; at >= 0 && scanned < REQUEST_SCAN_LIMIT; at--, scanned++) {
    const text = pickUserText(read.call(session, at))
    if (text !== undefined) return text
  }
  return undefined
}

/** Tier 3 用到的 agent 侧面。 */
interface TurnAgent {
  readonly session?: unknown
  /** 根 Agent 没有父级；有父级的是子代理/teammate。 */
  readonly parentAgent?: unknown
  steer(message: unknown): void
}

/**
 * 取本轮最后一条 assistant 消息的可见文本。
 *
 * 从日志尾部往回扫，遇到 turn/start 就停（只看本轮）。结构不符时返回 undefined，由调用方放行。
 * @param session - `agent.session`。
 * @returns 文本；取不到时为 undefined。
 */
function lastAssistantText(session: unknown): string | undefined {
  if (session === null || typeof session !== 'object') return undefined
  const record = session as Record<string, unknown>
  const eventAt = record['eventAt']
  const seq = record['seq']
  if (typeof eventAt !== 'function' || typeof seq !== 'number') return undefined
  const read = eventAt as (at: unknown) => unknown
  for (let at = seq - 1, scanned = 0; at >= 0 && scanned < 300; at--, scanned++) {
    const event = read.call(session, at)
    if (event === null || typeof event !== 'object') continue
    const typed = event as Record<string, unknown>
    if (typed['type'] === 'turn/start') return undefined
    if (typed['type'] !== 'assistant/message') continue
    const data = typed['data']
    const message = data !== null && typeof data === 'object' ? (data as Record<string, unknown>)['message'] : undefined
    const content = message !== null && typeof message === 'object' ? (message as Record<string, unknown>)['content'] : undefined
    if (!Array.isArray(content)) return undefined
    const parts: string[] = []
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue
      const text = (block as Record<string, unknown>)['text']
      if ((block as Record<string, unknown>)['type'] === 'text' && typeof text === 'string') parts.push(text)
    }
    const joined = parts.join('\n').trim()
    return joined.length === 0 ? undefined : joined.length > 4_000 ? joined.slice(0, 4_000) : joined
  }
  return undefined
}

/** 解析后的配置对象（可被运行时覆盖文件改写）。 */
interface MutableConfig extends Config {}

/**
 * 注册 warden 闸门。
 * @param ctx - 插件上下文。
 * @param config - 解析后的配置。
 */
export function apply(ctx: Context, config: Config): void {
  const runtime = config as MutableConfig

  /** 重读运行时覆盖文件并浅合并；实现细节与 dsh-jev 保持一致。 */
  const refresh = (): void => {
    const path = runtime.runtimeConfigFile ?? ''
    if (path.length === 0) return
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        (runtime as unknown as Record<string, unknown>)[key] = value
      }
    } catch {
      return // 没有覆盖文件是常态。
    }
  }
  refresh()

  /** 简报缓存：同目录同起始时间不重复解析。 */
  let briefCache: { dir: string; at: number; startedAt: number | undefined; brief: WardenBrief | undefined } | undefined
  /**
   * 找冻结简报。显式 briefFile 优先；否则取 briefDir 下最新修改的 .md。
   *
   * 默认 `'session'`：只认本轮会话期间冻结或改过的那一份，工作目录下的旧简报不会在几天后
   * 继续扣住一个完全无关的任务。`'any'` 保留旧行为（最新一份即当前），供"一份简报管整个目录"
   * 的用法显式开启。
   * @param cwd - 会话工作目录。
   * @param startedAt - 会话起始时间；读不到时不做时效判断。
   * @returns 简报；找不到或不适用时为 undefined（此时闸门完全不介入）。
   */
  const resolveBrief = (cwd: string | undefined, startedAt?: number): WardenBrief | undefined => {
    if (cwd === undefined) return undefined
    if (runtime.briefFile.length > 0) {
      try {
        return { path: runtime.briefFile, text: readFileSync(runtime.briefFile, 'utf8').slice(0, runtime.maxBriefChars) }
      } catch {
        return undefined
      }
    }
    const dir = join(cwd, runtime.briefDir)
    const now = Date.now()
    if (briefCache !== undefined && briefCache.dir === dir && briefCache.startedAt === startedAt && now - briefCache.at < 2_000) {
      return briefCache.brief
    }
    let brief: WardenBrief | undefined
    try {
      let newest: { path: string; mtimeMs: number } | undefined
      for (const entry of readdirSync(dir)) {
        if (!entry.endsWith('.md')) continue
        const path = join(dir, entry)
        const mtimeMs = statSync(path).mtimeMs
        if (newest === undefined || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs }
      }
      // 配置对象可能没走 schema（测试与运行时覆盖都是直传），所以在这里兜默认值。
      const stale = newest !== undefined && (runtime.briefScope ?? 'session') === 'session'
        && startedAt !== undefined && newest.mtimeMs < startedAt
      if (newest !== undefined && !stale) {
        brief = { path: newest.path, text: readFileSync(newest.path, 'utf8').slice(0, runtime.maxBriefChars) }
      }
    } catch {
      brief = undefined // 没有 .grill 目录就是没有简报。
    }
    briefCache = { dir, at: now, startedAt, brief }
    return brief
  }

  /** 追加一条 trace；写不进去也绝不影响调用。 */
  const trace = (entry: Record<string, unknown>): void => {
    try {
      mkdirSync(runtime.traceDir, { recursive: true })
      appendFileSync(join(runtime.traceDir, 'warden-' + new Date().toISOString().slice(0, 10) + '.jsonl'), JSON.stringify(entry) + '\n')
    } catch { /* trace 是诊断用途 */ }
  }

  // ── 合并模式：把范围判定挂进闸门（dsh-jev）的那一次 Jev 调用 ────────────────
  // 一次通过的工具调用原本要付两次网络往返（守卫一次、闸门一次）。合并后问题在同一次
  // 调用里问完：输入只算一次，阈值与处置口径都不变。闸门服务缺席时自动退回独立判定。
  // 记住"注册到的是哪一个闸门实例"。闸门热重载后会换一个新的服务对象，而它内部那份
  // 贡献者表是空的；只记一个布尔值的话，本插件会以为自己还注册着，于是既不重新注册、
  // 也不再自己判定 —— 护栏静默失效（2026-09-19 线上实测踩到）。
  let registeredGate: JevGateServiceLike | undefined

  /**
   * 每次调用执行一次；返回 undefined 表示这次不参与判定。
   * @param input - 闸门传来的待判调用。
   * @returns 追加的问题、state 与结算函数。
   */
  const contributor = (input: GateContributionInputLike): GateContributionLike | undefined => {
    refresh()
    if (runtime.enabled === false || runtime.mode === 'off') return undefined
    if (runtime.skipTools.includes(input.name)) return undefined
    const facts = sessionFacts(input.agent?.session)
    if (facts.id === undefined) return undefined
    const brief = resolveBrief(facts.cwd, facts.startedAt)
    if (brief === undefined) return undefined
    const sets = declaredRuleSets(brief.text)
    const questions = questionsOf(sets)
    const request = latestUserTask(input.agent?.session)
    const started = Date.now()
    return {
      questions,
      state: wardenState(brief, input.name, input.arguments, facts.cwd, {
        maxStringChars: runtime.maxArgChars,
        ...request === undefined ? {} : { currentRequest: request },
      }),
      settle(answers, failure) {
        let verdict: WardenVerdict | undefined
        let error: string | undefined
        if (failure !== undefined) error = failure
        else {
          const parsed = wardenAnswers(answers, questions)
          if (parsed === undefined) error = 'Jev 返回的答案缺少 noul 字段'
          else verdict = wardenVerdictOf(parsed, questions, runtime.threshold, runtime.askThreshold)
        }
        trace({
          ts: new Date().toISOString(), session: facts.id, mode: runtime.mode, tool: input.name,
          brief: brief.path, rulesets: sets.map((set) => set.id).join(','),
          request: request === undefined ? null : request.slice(0, 120),
          ms: Date.now() - started, merged: true,
          verdict: verdict === undefined ? null : verdict.kind,
          rule: verdict !== undefined && 'rule' in verdict ? verdict.rule : null,
          reason: verdict === undefined ? null : verdict.reason,
          error: error ?? null,
        })
        if (verdict === undefined) return undefined
        return {
          kind: verdict.kind,
          reason: 'warden(' + ('rule' in verdict ? verdict.rule : '-') + '): ' + verdict.reason,
          effective: runtime.mode === 'enforce',
        }
      },
    }
  }

  /**
   * 懒注册：闸门可能比本插件晚加载，所以在第一次用到的时候再绑；
   * 闸门换了实例（热重载）时也要重新绑一次。
   * @returns 本次调用是否可以交给闸门判定。
   */
  let registeredAt = 0
  const ensureContribution = (): boolean => {
    const gate = ctx.get('jevGate') as JevGateServiceLike | undefined
    if (gate === undefined || typeof gate.contribute !== 'function') return false
    const now = Date.now()
    // 闸门换实例要重绑；同一实例上也要周期性续期——闸门把注册表放在进程级并按有效期淘汰
    // 不活跃的条目，不续期的话本插件的判定会在几分钟后静默消失。
    if (registeredGate === gate && now - registeredAt < CONTRIBUTION_REFRESH_MS) return true
    try {
      gate.contribute('dsh-jev-warden', contributor)
      registeredGate = gate
      registeredAt = now
      return true
    } catch {
      return false // 注册失败就退回独立判定：护栏不能因为这个失效。
    }
  }

  const onEvent = ctx as unknown as {
    on(
      name: string,
      handler: (exec: GateExec, next: () => Promise<GateDecision>) => Promise<GateDecision>,
      options?: { prepend?: boolean },
    ): () => void
  }

  ctx.effect(() => onEvent.on('tools/pre-execute', async (exec, next): Promise<GateDecision> => {
    refresh()
    if (runtime.enabled === false || runtime.mode === 'off') return next()
    const facts = sessionFacts(exec.agent?.session)
    if (facts.id === undefined) return next()
    const request = latestUserTask(exec.agent?.session)
    if (exec.parent === undefined && exec.name === 'run_code') return next()
    if (runtime.skipTools.includes(exec.name)) return next()

    // Tier 0：确定性底线。不依赖简报、不走 Jev —— 任何会话、任何任务都成立。
    const guard = runtime.guardPaths === false ? undefined : pathGuard(exec.arguments)
    if (guard !== undefined) {
      trace({
        ts: new Date().toISOString(), session: facts.id, mode: runtime.mode, tool: exec.name,
        tier: 0, rule: guard.id, ms: 0,
        verdict: runtime.mode === 'shadow' ? null : guard.severity,
        reason: guard.reason,
      })
      if (runtime.mode === 'shadow') return next()
      return guard.severity === 'deny'
        ? { kind: 'deny', reason: 'warden(' + guard.id + '): ' + guard.reason }
        : { kind: 'ask', reason: 'warden(' + guard.id + '): ' + guard.reason }
    }

    const brief = resolveBrief(facts.cwd, facts.startedAt)
    if (brief === undefined) return next()
    // 合并模式：范围判定挂进闸门的那一次调用，这里只做 Tier 0，不再发第二次请求。
    if (runtime.mergeIntoGate !== false && ensureContribution()) return next()
    const jev = ctx.get('jev') as JevService | undefined
    if (jev === undefined || !(await jev.available())) return next()

    // 简报里 `rules: a, b` 决定启用哪些规则集；不写就只用基础集（grill-me）。
    const sets = declaredRuleSets(brief.text)
    const questions = questionsOf(sets)

    const started = Date.now()
    let verdict: WardenVerdict | undefined
    let error: string | undefined
    try {
      const result = await jev.ask(
        wardenState(brief, exec.name, exec.arguments, facts.cwd, {
          maxStringChars: runtime.maxArgChars,
          ...request === undefined ? {} : { currentRequest: request },
        }),
        questions,
        { signal: AbortSignal.timeout(runtime.timeoutMs) },
      )
      const answers = wardenAnswers(result.answers, questions)
      if (answers === undefined) error = 'Jev 返回的答案缺少 noul 字段'
      else verdict = wardenVerdictOf(answers, questions, runtime.threshold, runtime.askThreshold)
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    }

    trace({
      ts: new Date().toISOString(),
      session: facts.id,
      mode: runtime.mode,
      tool: exec.name,
      brief: brief.path,
      rulesets: sets.map((set) => set.id).join(','),
      request: request === undefined ? null : request.slice(0, 120),
      ms: Date.now() - started,
      verdict: verdict === undefined ? null : verdict.kind,
      rule: verdict === undefined ? null : ('rule' in verdict ? verdict.rule : null),
      reason: verdict === undefined ? null : verdict.reason,
      error: error ?? null,
    })

    // 判定失败：交回 DSH 既有权限链。闸门故障绝不阻塞调用。
    if (verdict === undefined) return next()
    if (runtime.mode === 'shadow') return next()
    if (verdict.kind === 'ask') {
      // 人工确认；无人应答时 DSH 审批链失败关闭 —— 即"超时就不做"。
      return { kind: 'ask', reason: 'warden(' + verdict.rule + '): ' + verdict.reason }
    }
    if (verdict.kind === 'deny') return { kind: 'deny', reason: 'warden(' + verdict.rule + '): ' + verdict.reason }
    return next()
  }, { prepend: true }), '@dsh-external/dsh-jev-warden: grill gate')

  // ── Tier 3：「说人话」回复护栏 ────────────────────────────────────────────
  // 挂在轮末。事件是 @mode serial，会被 await，所以这里可以安全地调 Jev。
  // 文本没法 deny：命中后用 agent.steer 把具体问题回灌给生成者重写，并且**每轮有硬预算**
  // —— DSH 自己在 hooks-codex 标注过"无条件阻塞会强制续写直到自限"，预算就是那个自限。
  const replyAttempts = new Map<string, number>()
  const onTurnStopping = ctx as unknown as {
    on(name: string, handler: (payload: { agent: TurnAgent; turn: number; signal: AbortSignal }) => Promise<void>): () => void
  }
  ctx.effect(() => onTurnStopping.on('agent/turn-stopping', async ({ agent, turn }) => {
    refresh()
    if (runtime.enabled === false || runtime.replyGuard === false || runtime.mode === 'off') return
    if (agent.parentAgent !== undefined) return // 只判 Lead：子代理/teammate 的内部汇报豁免
    const facts = sessionFacts(agent.session)
    if (facts.id === undefined) return
    const key = facts.id + ':' + String(turn)
    const used = replyAttempts.get(key) ?? 0
    if (used >= runtime.replyMaxRewrites) return
    const text = lastAssistantText(agent.session)
    if (text === undefined || text.length < 40) return
    const jev = ctx.get('jev') as JevService | undefined
    if (jev === undefined || !(await jev.available())) return

    const started = Date.now()
    let violations: string[] = []
    let error: string | undefined
    let reason: string | undefined
    try {
      const result = await jev.ask(
        {
          reply_to_user: text,
          note: 'This is the assistant message the user is about to read. Judge only HOW it is written, not whether its content is correct.',
        },
        [...REPLY_QUESTIONS],
        { signal: AbortSignal.timeout(runtime.timeoutMs) },
      )
      const answers = wardenAnswers(result.answers, REPLY_QUESTIONS)
      if (answers === undefined) error = 'Jev 返回的答案缺少 noul 字段'
      else {
        violations = replyViolations(answers, runtime.threshold)
        reason = REPLY_QUESTIONS.map((q) => q.id + '=' + (answers[q.id] ?? 0).toFixed(2)).join(' ')
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    }

    trace({
      ts: new Date().toISOString(), session: facts.id, mode: runtime.mode, tool: 'assistant/reply',
      tier: 3, rulesets: 'reply', rule: violations.length === 0 ? null : violations.join('+'),
      ms: Date.now() - started,
      verdict: error !== undefined ? null : violations.length === 0 ? 'pass' : runtime.mode === 'shadow' ? 'rewrite(shadow)' : 'rewrite',
      reason: error ?? reason ?? null,
    })

    if (error !== undefined || violations.length === 0 || runtime.mode === 'shadow') return
    if (replyAttempts.size > 500) replyAttempts.clear()
    replyAttempts.set(key, used + 1)
    const lines = ['[warden] 你刚才给用户的回复没有通过「说人话」护栏。请重写这一轮的最终回复：']
    for (const id of violations) lines.push('- ' + (REPLY_FIXES[id] ?? id))
    lines.push('重写后直接给出完整回复，不要解释你为什么改。')
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: lines.join('\n') }],
      source: { kind: 'plugin', plugin: 'dsh-jev-warden' },
    }))
  }), '@dsh-external/dsh-jev-warden: reply guard')
}

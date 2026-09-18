// warden 离线 smoke：mock jev，不联网。覆盖两组规则集与简报声明解析。
import { apply } from '../lib/index.js'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'warden-'))
const mk = (name, body) => { const cwd = join(root, name); mkdirSync(join(cwd, '.grill'), { recursive: true }); writeFileSync(join(cwd, '.grill', 'task.md'), body); return cwd }
const wsA = mk('a', '# Grill Brief\n目标：实现 warden\n非目标：- 不动 DSH 本体\n')
const wsB = mk('b', '# Grill Brief\nrules: grill-me, find-simplifications\n目标：删掉未用方法\n')
const wsC = mk('c', '# Grill Brief\nrules: grill-me, no-such-ruleset\n目标：x\n')
const wsN = join(root, 'none'); mkdirSync(wsN, { recursive: true })

let listener = null
let jevCalls = 0
let askedIds = []
let jevAnswers = null
let jevThrows = false
let lastState = null
const jevStub = {
  available: async () => true,
  ask: async (_state, questions) => {
    lastState = _state
    jevCalls++
    askedIds = questions.map((q) => q.id)
    if (jevThrows) throw new Error('network down')
    return { answers: jevAnswers }
  },
}
const ctx = {
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  get: (n) => (n === 'jev' ? jevStub : undefined),
  on: (name, handler) => { if (name === 'tools/pre-execute') listener = handler; return () => {} },
  tools: { register: () => () => {} },
}
const traceDir = join(root, 'trace')
apply(ctx, {
  enabled: true, mode: 'enforce', threshold: 0.8, askThreshold: 0.9,
  briefDir: '.grill', briefFile: '', skipTools: ['read', 'glob'],
  timeoutMs: 4000, maxArgChars: 600, maxBriefChars: 4000,
  traceDir, runtimeConfigFile: join(root, 'no-config.json'),
})

const noul = (ids, v) => Object.fromEntries(ids.map((id) => [id, { type: 'noul', noul: v }]))
const sess = (cwd) => ({ id: 'S-' + cwd, header: { cwd } })
const exec = (name, session) => ({ name, arguments: { file_path: 'x.ts' }, signal: AbortSignal.timeout(3000), agent: { session } })
const next = async () => ({ kind: 'allow' })

const BASE = ['out_of_scope', 'unauthorized_surface', 'unrelated_edit', 'unrequested_gift', 'needs_human_decision']
const EXTRA = ['edits_frozen_history', 'edits_vendor_source', 'removes_protected_surface', 'deletes_without_authorization']
const ALL = [...BASE, ...EXTRA]
const out = []

// 1 无简报 → 放行且不调 Jev
{ const b = jevCalls; const r = await listener(exec('write', sess(wsN)), next)
  out.push('[1 无简报] ' + r.kind + ' jev=' + (jevCalls - b)) }
// 2 只读跳过
{ const b = jevCalls; const r = await listener(exec('read', sess(wsA)), next)
  out.push('[2 只读] ' + r.kind + ' jev=' + (jevCalls - b)) }
// 3 无 rules 声明 → 只问基础 5 条
jevAnswers = noul(BASE, 0.05)
await listener(exec('write', sess(wsA)), next)
out.push('[3 无声明] 问了几条=' + askedIds.length + ' (' + askedIds.join(',') + ')')
// 4 声明 find-simplifications → 问 9 条
await listener(exec('write', sess(wsB)), next)
out.push('[4 有声明] 问了几条=' + askedIds.length + ' 含 extra=' + EXTRA.every((id) => askedIds.includes(id)))
// 5 未知规则名被忽略
await listener(exec('write', sess(wsC)), next)
out.push('[5 未知名忽略] 问了几条=' + askedIds.length)
// 6 基础硬边界
for (const id of ['out_of_scope', 'unauthorized_surface', 'unrelated_edit']) {
  jevAnswers = noul(ALL, 0.1); jevAnswers[id].noul = 0.9
  const r = await listener(exec('write', sess(wsB)), next)
  out.push('[6 ' + id + '] ' + r.kind)
}
// 7 新增四条硬护栏
for (const id of EXTRA) {
  jevAnswers = noul(ALL, 0.1); jevAnswers[id].noul = 0.9
  const r = await listener(exec('write', sess(wsB)), next)
  out.push('[7 ' + id + '] ' + r.kind + ' rule=' + String(r.reason).slice(0, 30))
}
// 8 软规则 → ask
for (const id of ['unrequested_gift', 'needs_human_decision']) {
  jevAnswers = noul(ALL, 0.1); jevAnswers[id].noul = 0.95
  const r = await listener(exec('write', sess(wsB)), next)
  out.push('[8 ' + id + '] ' + r.kind)
}
// 9 阈值下方
jevAnswers = noul(ALL, 0.79)
out.push('[9 阈值下] ' + (await listener(exec('write', sess(wsB)), next)).kind)
// 10 答案缺字段 → 放行
jevAnswers = { out_of_scope: { type: 'noul', noul: 0.9 } }
out.push('[10 答案不全] ' + (await listener(exec('write', sess(wsB)), next)).kind)
// 11 Jev 故障 → 放行
jevAnswers = noul(ALL, 0.99); jevThrows = true
out.push('[11 故障] ' + (await listener(exec('write', sess(wsB)), next)).kind)
jevThrows = false
// 12 trace 带 rulesets
const files = readdirSync(traceDir).filter((f) => f.startsWith('warden-'))
const lines = readFileSync(join(traceDir, files[0]), 'utf8').split('\n').filter(Boolean)
out.push('[12 trace] 条数=' + lines.length + ' 最后一条=' + lines[lines.length - 1].slice(0, 200))

// ── Tier 0：确定性底线（不需要简报、不走 Jev） ──────────────────────────────
const t0exec = (args) => ({ name: 'write', arguments: args, signal: AbortSignal.timeout(3000), agent: { session: sess(wsN) } })
{
  const b = jevCalls
  out.push('[13 archived 无简报] ' + (await listener(t0exec({ file_path: 'F:/x/.agents/notes/archived/old.md' }), next)).kind + ' jev=' + (jevCalls - b))
}
{
  const b = jevCalls
  out.push('[13 vendor 无简报] ' + (await listener(t0exec({ file_path: 'F:/x/vendor/cordis/src/index.ts' }), next)).kind + ' jev=' + (jevCalls - b))
}
out.push('[13 反斜杠 vendor] ' + (await listener(t0exec({ file_path: 'F:\\x\\vendor\\cordis\\src\\i.ts' }), next)).kind)
out.push('[13 AGENTS.md] ' + (await listener(t0exec({ file_path: 'F:/x/AGENTS.md' }), next)).kind)
out.push('[13 CLAUDE.md] ' + (await listener(t0exec({ file_path: 'F:/x/CLAUDE.md' }), next)).kind)
out.push('[13 .agents/skills] ' + (await listener(t0exec({ file_path: 'F:/x/.agents/skills/grill-me/SKILL.md' }), next)).kind)
out.push('[13 .grill 简报] ' + (await listener(t0exec({ file_path: 'F:/x/.grill/task.md' }), next)).kind)
out.push('[13 普通源码] ' + (await listener(t0exec({ file_path: 'F:/x/src/normal.ts' }), next)).kind + '（无简报→allow）')
{
  const cwd2 = join(root, 'off'); mkdirSync(cwd2, { recursive: true })
  let l2 = null
  apply({ ...ctx, on: (n, h) => { if (n === 'tools/pre-execute') l2 = h; return () => {} } }, {
    enabled: true, mode: 'enforce', threshold: 0.8, askThreshold: 0.9, briefDir: '.grill', briefFile: '',
    skipTools: [], timeoutMs: 4000, maxArgChars: 600, maxBriefChars: 4000, guardPaths: false,
    traceDir: join(root, 'trace2'), runtimeConfigFile: join(root, 'none.json'),
  })
  out.push('[13 guardPaths=false] ' + (await l2({ name: 'write', arguments: { file_path: 'F:/x/vendor/p/src/a.ts' }, signal: AbortSignal.timeout(3000), agent: { session: { id: 'X', header: { cwd: cwd2 } } } }, next)).kind + '（应 allow）')
}
const REPLY_IDS = ['figurative_language', 'unexplained_jargon', 'vague_reference', 'padding']
// ── Tier 3：回复护栏 ────────────────────────────────────────────────────────
let turnListener = null
{
  // 重新挂一次，捕获 turn-stopping 监听器
  const ctx3 = {
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    get: (n) => (n === 'jev' ? jevStub : undefined),
    on: (name, handler) => { if (name === 'agent/turn-stopping') turnListener = handler; return () => {} },
    tools: { register: () => () => {} },
  }
  apply(ctx3, {
    enabled: true, mode: 'enforce', threshold: 0.8, askThreshold: 0.9, briefDir: '.grill', briefFile: '', skipTools: [],
    timeoutMs: 4000, maxArgChars: 600, maxBriefChars: 4000, guardPaths: true,
    replyGuard: true, replyMaxRewrites: 1,
    traceDir: join(root, 'trace3'), runtimeConfigFile: join(root, 'none3.json'),
  })
}
const longText = '这是一个足够长的回复，用来确保长度门槛（40 字符）被跨过，从而真正进入判定流程。'
const replySession = (text) => ({
  id: 'S-reply', header: { cwd: wsN }, seq: 10,
  eventAt: (i) => i === 8
    ? { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }
    : { type: 'tool/call', data: {} },
})
const mkAgent = (session, parentAgent) => ({ session, parentAgent, steers: [], steer(m) { this.steers.push(m) } })

out.push('[14 turn 监听已装] ' + (turnListener !== null))
// 14a 命中 → 回灌一次
{
  const agent = mkAgent(replySession(longText))
  jevAnswers = Object.fromEntries(REPLY_IDS.map((id) => [id, { type: 'noul', noul: id === 'padding' ? 0.9 : 0.1 }]))
  await turnListener({ agent, turn: 1, signal: AbortSignal.timeout(3000) })
  const msg = agent.steers[0]
  const text = msg ? JSON.stringify(msg.content) : ''
  out.push('[14a 命中] steers=' + agent.steers.length + ' 含修法=' + text.includes('承载信息'))
}
// 14b 同一轮第二次 → 预算挡住
{
  const agent = mkAgent(replySession(longText))
  const before = jevCalls
  await turnListener({ agent, turn: 1, signal: AbortSignal.timeout(3000) })
  out.push('[14b 预算] steers=' + agent.steers.length + ' jev=' + (jevCalls - before))
}
// 14c 子代理豁免
{
  const agent = mkAgent(replySession(longText), { id: 'parent' })
  const before = jevCalls
  await turnListener({ agent, turn: 2, signal: AbortSignal.timeout(3000) })
  out.push('[14c 子代理] steers=' + agent.steers.length + ' jev=' + (jevCalls - before))
}
// 14d 文本过短跳过
{
  const agent = mkAgent(replySession('好的'))
  const before = jevCalls
  await turnListener({ agent, turn: 3, signal: AbortSignal.timeout(3000) })
  out.push('[14d 过短] steers=' + agent.steers.length + ' jev=' + (jevCalls - before))
}
// 14e 全部合规 → 不回灌
{
  const agent = mkAgent(replySession(longText))
  jevAnswers = Object.fromEntries(REPLY_IDS.map((id) => [id, { type: 'noul', noul: 0.05 }]))
  await turnListener({ agent, turn: 4, signal: AbortSignal.timeout(3000) })
  out.push('[14e 合规] steers=' + agent.steers.length)
}

// ── 15. current_request：用户「当前这条」指令是与冻结简报并列的第二权威来源 ──
{
  const { wardenState } = await import('../lib/rules.js')
  const brief = { path: 'B', text: '目标：实现 warden' }
  const withReq = wardenState(brief, 'pwsh', { command: 'rm x' }, 'C', { maxStringChars: 200, currentRequest: '清理临时文件' })
  const withoutReq = wardenState(brief, 'pwsh', { command: 'rm x' }, 'C', { maxStringChars: 200 })
  out.push('[15a 有当前指令] ' + JSON.stringify(withReq.current_request) + ' 无则缺键=' + (!('current_request' in withoutReq)))
  const blank = wardenState(brief, 'pwsh', {}, 'C', { maxStringChars: 200, currentRequest: '   ' })
  out.push('[15b 空白不算] 缺键=' + (!('current_request' in blank)))

  // 真实形状：source 在 event data 顶层（kind:'user' 是真人，'plugin' 是注入）
  const um = (text, kind) => ({ type: 'user/message', data: { source: { kind }, content: [{ type: 'text', text }] } })
  // 主路径：snapshotEvents（与 agent-loop 读历史同一入口）
  const sessAt = (cwd, events) => ({ id: 'S3', header: { cwd }, seq: events.length, eventAt: (i) => events[i], snapshotEvents: () => events })
  // 退回路径：只有 eventAt/seq 的老形状
  const sessLegacy = (cwd, events) => ({ id: 'S4', header: { cwd }, seq: events.length, eventAt: (i) => events[i] })
  const run = async (events, mk = sessAt) => {
    lastState = null
    jevAnswers = noul(ALL, 0.05)
    await listener(exec('write', mk(wsB, events)), next)
    return lastState
  }
  // 15c 最近的插件注入必须被跳过，取到真人指令
  const s15c = await run([um('清理临时文件', 'user'), um('你的回复需要重写', 'plugin')])
  out.push('[15c 跳过插件注入] ' + String(s15c?.current_request))
  // 15d 只有插件消息 → 不设 current_request（绝不拿注入内容当授权）
  const s15d = await run([um('插件注入的内容', 'plugin')])
  out.push('[15d 仅插件消息] 缺键=' + (s15d !== null && !('current_request' in s15d)))
  // 15e 技能目录提醒（正是线上误抓的那条）即便标成 user 也必须被挡
  const s15e = await run([um('清理临时文件', 'user'), um('<system-reminder>\n<available_skills>\n- a\n</available_skills>\n</system-reminder>', 'user')])
  out.push('[15e 框架文本挡掉] ' + String(s15e?.current_request))
  // 15f 旧形状：source 嵌在 data.message 下也要认
  const legacy = { type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: '旧形状指令' }] } } }
  const s15f = await run([legacy])
  out.push('[15f 旧形状兼容] ' + String(s15f?.current_request))
  // 15g 没有 snapshotEvents 的老会话对象 → 退回 eventAt/seq 也能取到
  const s15g = await run([um('退回路径指令', 'user')], sessLegacy)
  out.push('[15g eventAt 退回] ' + String(s15g?.current_request))
  // 15h 真人指令落在很后面（模拟长轮次里被大量事件埋住）
  const buried = [...Array.from({ length: 600 }, (_, i) => ({ type: 'tool/call', data: { i } })), um('被埋住的指令', 'user'), ...Array.from({ length: 80 }, () => ({ type: 'step/start', data: {} }))]
  const s15h = await run(buried)
  out.push('[15h 深扫] ' + String(s15h?.current_request))
}

// ── 16. ask 级单独阈值：比 deny 更硬，避免无害操作反复要用户点审批 ──
{
  const { wardenVerdictOf } = await import('../lib/rules.js')
  const askQ = [{ id: 'gift', type: 'noul', severity: 'ask', instructions: '', criteria: { true: '', false: '' } }]
  const denyQ = [{ id: 'scope', type: 'noul', severity: 'deny', instructions: '', criteria: { true: '', false: '' } }]
  out.push('[16a ask 0.89<0.9 放行] ' + wardenVerdictOf({ gift: 0.89 }, askQ, 0.8, 0.9).kind)
  out.push('[16b ask 0.93>=0.9 升级] ' + wardenVerdictOf({ gift: 0.93 }, askQ, 0.8, 0.9).kind)
  out.push('[16c deny 0.85>=0.8 仍拒] ' + wardenVerdictOf({ scope: 0.85 }, denyQ, 0.8, 0.9).kind)
  out.push('[16d 省略 askThreshold 退回单阈值] ' + wardenVerdictOf({ gift: 0.85 }, askQ, 0.8).kind)
}
console.log(out.join('\n'))
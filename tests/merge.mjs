
// 合并模式离线冒烟：守卫插件把范围判定挂进闸门的那一次 Jev 调用。
import { apply } from '../lib/index.js'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'warden-merge-'))
const mk = (name, body) => { const cwd = join(root, name); mkdirSync(join(cwd, '.grill'), { recursive: true }); writeFileSync(join(cwd, '.grill', 'task.md'), body); return cwd }
const ws = mk('a', '# Grill Brief\nrules: grill-me\n目标：只改 src/a.ts\n非目标：- 不动别的文件\n')
const wsArchive = mk('arch', '# Grill Brief\n目标：x\n')

const out = []
const ok = (c, l) => { out.push((c ? 'PASS ' : 'FAIL ') + l); return c }

/** 装一个守卫插件实例；gate 为 undefined 时模拟闸门缺席。 */
function mount(over = {}) {
  const contributions = []
  const registered = []
  const makeGate = () => ({
    contribute: (id, factory) => { registered.push(id); contributions.push({ id, factory }); return () => {} },
  })
  const js = makeGate()
  const js2 = makeGate()   // 模拟"闸门热重载后换了一个服务实例"
  let listener = null
  let gateGets = 0
  const traceDir = join(root, 'trace-' + Math.random().toString(36).slice(2, 7))
  const ctx = {
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    get: (n) => {
      if (n !== 'jevGate' || over.withGate === false) return undefined
      gateGets++
      return over.switchGateAfter !== undefined && gateGets > over.switchGateAfter ? js2 : js
    },
    on: (name, handler) => { if (name === 'tools/pre-execute') listener = handler; return () => {} },
    tools: { register: () => () => {} },
    provide: () => {},
  }
  apply(ctx, {
    enabled: true, mode: over.mode ?? 'enforce', threshold: 0.8, askThreshold: 0.9,
    briefDir: '.grill', briefFile: '', skipTools: ['read', 'glob'],
    timeoutMs: 4000, maxArgChars: 600, maxBriefChars: 4000,
    traceDir, runtimeConfigFile: join(root, 'no-config.json'),
    ...over.mergeIntoGate === undefined ? {} : { mergeIntoGate: over.mergeIntoGate },
    ...over.briefScope === undefined ? {} : { briefScope: over.briefScope },
  })
  const run = (exec) => listener(exec, async () => ({ kind: 'allow' }))
  const traces = () => {
    const f = readdirSync(traceDir).filter((x) => x.startsWith('warden-'))[0]
    return f === undefined ? [] : readFileSync(join(traceDir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  }
  return { contributions, registered, run, traces, traceDir }
}
const sess = (cwd) => ({
  id: 'S1',
  header: { cwd },
  snapshotEvents: () => [{ type: 'user/message', data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text: '只改 src/a.ts' }] } } }],
})
const exec = (name, args, session) => ({ name, arguments: args, signal: AbortSignal.timeout(3000), agent: { session } })
const noul = (ids, v) => Object.fromEntries(ids.map((id) => [id, { type: 'noul', noul: v }]))
const BASE = ['out_of_scope', 'unauthorized_surface', 'unrelated_edit', 'unrequested_gift', 'needs_human_decision']

out.push('=== 1. 有闸门时改为贡献者，不再自己发判定 ===')
{
  const m = mount()
  const r = await m.run(exec('write', { file_path: 'F:/x/src/a.ts' }, sess(ws)))
  ok(r.kind === 'allow', '钩子只做 Tier 0 并放行（kind=' + r.kind + '）')
  ok(m.registered.length === 1 && m.registered[0] === 'dsh-jev-warden', '已注册为贡献者：' + m.registered.join(','))
  const contribution = m.contributions[0].factory({ name: 'write', arguments: { file_path: 'F:/x/src/a.ts' }, agent: { session: sess(ws) } })
  ok(contribution !== undefined, '工厂在有简报时给出贡献')
  ok(contribution.questions.map((q) => q.id).join(',') === BASE.join(','), '带的是基础 5 条规则')
  ok(JSON.stringify(contribution.state).includes('只改 src/a.ts'), 'state 里带上用户最近一条指令')
  ok(JSON.stringify(contribution.state).includes('frozen_brief'), 'state 里带上冻结简报')
  const verdict = contribution.settle(noul(BASE, 0.95), undefined)
  ok(verdict !== undefined && verdict.kind === 'deny' && verdict.effective === true, '越界分数高时给出 deny 且生效：' + JSON.stringify(verdict))
  const t = m.traces().pop()
  ok(t.merged === true && t.rule === 'out_of_scope' && t.verdict === 'deny', '流水里标了 merged 与命中规则：' + JSON.stringify({ merged: t.merged, rule: t.rule, verdict: t.verdict }))
}

out.push('')
out.push('=== 2. 影子模式下贡献不生效但照常记流水 ===')
{
  const m = mount({ mode: 'shadow' })
  await m.run(exec('write', { file_path: 'F:/x/src/a.ts' }, sess(ws)))
  const contribution = m.contributions[0].factory({ name: 'write', arguments: { file_path: 'F:/x/src/a.ts' }, agent: { session: sess(ws) } })
  const verdict = contribution.settle(noul(BASE, 0.95), undefined)
  ok(verdict.kind === 'deny' && verdict.effective === false, 'shadow 下结论保留但标为不生效')
  ok(m.traces().pop().merged === true, 'shadow 下仍然记流水')
}

out.push('')
out.push('=== 3. 判定失败时不给结论、只记错误 ===')
{
  const m = mount()
  await m.run(exec('write', { file_path: 'F:/x/src/a.ts' }, sess(ws)))
  const contribution = m.contributions[0].factory({ name: 'write', arguments: { file_path: 'F:/x/src/a.ts' }, agent: { session: sess(ws) } })
  const failed = contribution.settle({}, 'Jev 判定失败：超时')
  ok(failed === undefined, '判定失败时返回 undefined，由闸门走自己的降级')
  const t = m.traces().pop()
  ok(t.error === 'Jev 判定失败：超时' && t.verdict === null, '流水里记下了失败原因')
  const partial = contribution.settle(noul(['out_of_scope'], 0.9), undefined)
  ok(partial === undefined && m.traces().pop().error === 'Jev 返回的答案缺少 noul 字段', '答案缺字段时也走失败路径')
}

out.push('')
out.push('=== 4. Tier 0 仍然先于合并生效 ===')
{
  const m = mount()
  const r = await m.run(exec('write', { file_path: 'F:/x/notes/archived/old.md' }, sess(wsArchive)))
  ok(r.kind === 'deny', '归档目录写入被 Tier 0 直接拒（kind=' + r.kind + '）')
  ok(m.registered.length === 0, 'Tier 0 命中时根本没走到注册（0 次 Jev 调用）')
}

out.push('')
out.push('=== 5. 开关与缺席时的退回 ===')
{
  const m = mount({ mergeIntoGate: false })
  await m.run(exec('write', { file_path: 'F:/x/src/a.ts' }, sess(ws)))
  ok(m.registered.length === 0, 'mergeIntoGate=false 时不注册')
}
{
  const m = mount({ withGate: false })
  // 闸门缺席：走独立判定，没有 jev 服务时直接放行且不报错
  const r = await m.run(exec('write', { file_path: 'F:/x/src/a.ts' }, sess(ws)))
  ok(r.kind === 'allow' && m.registered.length === 0, '闸门缺席时退回独立路径（无 jev 服务则放行）')
}
{
  const m = mount()
  await m.run(exec('write', { file_path: 'F:/x/src/a.ts' }, sess(ws)))   // 先触发一次注册
  const r1 = await m.run(exec('read', { file_path: 'x.ts' }, sess(ws)))
  ok(r1.kind === 'allow', '只读工具在 Tier 0 之后被跳过')
  const contribution = m.contributions[0].factory({ name: 'read', arguments: { file_path: 'x.ts' }, agent: { session: sess(ws) } })
  ok(contribution === undefined, '只读工具不产生贡献')
  const noBrief = m.contributions[0].factory({ name: 'write', arguments: { file_path: 'x.ts' }, agent: { session: sess(join(root, 'none')) } })
  ok(noBrief === undefined, '没有简报的工作目录不产生贡献')
}

out.push('')
out.push('=== 6. 简报时效（briefScope）===')
{
  // 简报在"过去"写好，会话在其后开始
  const m = mount({ briefScope: 'session' })
  await m.run(exec('write', { file_path: 'F:/x/src/a.ts' }, sess(ws)))
  const later = { ...sess(ws), createdAt: Date.now() + 60_000 }
  const stale = m.contributions[0]?.factory?.({ name: 'write', arguments: { file_path: 'F:/x/src/a.ts' }, agent: { session: later } })
  ok(stale === undefined, 'briefScope=session：会话开始晚于简报 -> 不介入')
}
{
  const m = mount({ briefScope: 'session' })
  await m.run(exec('write', { file_path: 'F:/x/src/a.ts' }, sess(ws)))
  const earlier = { ...sess(ws), createdAt: Date.now() - 600_000 }
  const fresh = m.contributions[0].factory({ name: 'write', arguments: { file_path: 'F:/x/src/a.ts' }, agent: { session: earlier } })
  ok(fresh !== undefined, 'briefScope=session：会话开始早于简报（本轮冻的）-> 照常介入')
}
{
  const m = mount()   // 默认 'session'
  await m.run(exec('write', { file_path: 'F:/x/src/a.ts' }, sess(ws)))
  const later = { ...sess(ws), createdAt: Date.now() + 60_000 }
  const dropped = m.contributions[0].factory({ name: 'write', arguments: { file_path: 'F:/x/src/a.ts' }, agent: { session: later } })
  ok(dropped === undefined, '默认 briefScope=session：几天前的旧简报不再扣住新会话')
}
{
  const m = mount({ briefScope: 'any' })   // 显式回到旧口径
  await m.run(exec('write', { file_path: 'F:/x/src/a.ts' }, sess(ws)))
  const later = { ...sess(ws), createdAt: Date.now() + 60_000 }
  const still = m.contributions[0].factory({ name: 'write', arguments: { file_path: 'F:/x/src/a.ts' }, agent: { session: later } })
  ok(still !== undefined, 'briefScope=any（显式开启）：旧简报继续生效（行为与以前一致）')
}
{
  const m = mount({ briefScope: 'session' })
  await m.run(exec('write', { file_path: 'F:/x/src/a.ts' }, sess(ws)))
  const noTime = m.contributions[0].factory({ name: 'write', arguments: { file_path: 'F:/x/src/a.ts' }, agent: { session: sess(ws) } })
  ok(noTime !== undefined, '读不到会话起始时间时不失效（不静默改变行为）')
}

out.push('')
out.push('=== 7. 闸门换实例后必须重新注册 ===')
{
  const m = mount({ switchGateAfter: 1 })
  await m.run(exec('write', { file_path: 'F:/x/src/a.ts' }, sess(ws)))
  ok(m.registered.length === 1, '第一次调用注册到闸门（实际 ' + m.registered.length + ' 次）')
  await m.run(exec('write', { file_path: 'F:/x/src/b.ts' }, sess(ws)))
  ok(m.registered.length === 2, '闸门换实例后重新注册（实际 ' + m.registered.length + ' 次）——否则护栏会静默失效')
  await m.run(exec('write', { file_path: 'F:/x/src/c.ts' }, sess(ws)))
  ok(m.registered.length === 2, '同一实例上不重复注册（仍然 ' + m.registered.length + ' 次）')
}

const failed = out.filter((l) => l.startsWith('FAIL'))
console.log(out.join('\n'))
console.log('')
console.log(failed.length === 0 ? '全部通过 (' + out.filter((l) => l.startsWith('PASS')).length + ' 项)' : failed.length + ' 项失败')
process.exitCode = failed.length === 0 ? 0 : 1

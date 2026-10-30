// Self-check for dsh-skill-on-demand. Runs against a mock ctx; no harness needed.
// Requires module resolution that reaches a DSH install (run it from a profile dir).
import assert from 'node:assert/strict'
import { apply } from '../index.js'

const skills = [
  { name: 'alpha', description: 'Alpha does one thing. ' + 'x'.repeat(400), invocation: { modelInvocable: true, userInvocable: true }, source: 'user-dsh', provider: 'mock' },
  { name: 'beta', description: 'Beta does another thing.', invocation: { modelInvocable: true, userInvocable: true }, source: 'user-dsh', provider: 'mock' },
]

const globalTools = new Map()
const scopedTools = new WeakMap()
const handlers = new Map()
const guards = []
let deferred = []

const ctx = {
  skills: {
    async snapshot() { return { skills, complete: true } },
    async list() { return skills },
    async get(name) { return skills.find((s) => s.name === name) === undefined ? undefined : { ...skills.find((s) => s.name === name), content: 'BODY' } },
  },
  tools: {
    register(definition) {
      globalTools.set(definition.name, definition)
      return () => globalTools.delete(definition.name)
    },
    get(name, scope) {
      if (scope !== undefined) {
        const own = scopedTools.get(scope)
        if (own?.has(name)) return own.get(name)
      }
      return globalTools.get(name)
    },
    schemas() {
      return this._tools ?? [{ name: 'browser_session' }, { name: 'skill' }]
    },
    guard(fn) {
      guards.push(fn)
      return () => guards.splice(guards.indexOf(fn), 1)
    },
  },
  agents: { list() { return [] } },
  on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]) },
}

const agent = {
  id: 's1',
  session: {
    header: { cwd: '/tmp' },
    seq: 0,
    surface: { nodes: [] },
    eventAt() { return undefined },
  },
  ctx: {
    tools: {
      register(definition) {
        const own = scopedTools.get(agent) ?? new Map()
        own.set(definition.name, definition)
        scopedTools.set(agent, own)
        return () => own.delete(definition.name)
      },
    },
  },
}

apply(ctx)

// A shipped-style `skill` tool must already exist for the picker to shadow it.
assert.deepEqual([...globalTools.keys()].sort(), ['skill_list', 'skill_pick'])

globalTools.set('skill', { name: 'skill', description: 'shipped catalog owner', parameters: {} })
handlers.get('agent/created')[0]({ agent })
assert.equal(ctx.tools.get('skill', agent).description.startsWith('Load the full instructions'), true, 'scoped skill tool shadows the shipped one')

const preStep = handlers.get('agent/pre-step')[0]
const exec = { agent, signal: new AbortController().signal, deferContext(message) { deferred.push(message) } }
const enter = { kind: 'enter', messages: [] }
const first = await preStep({ agent, messages: [], turn: 1, step: 1, signal: exec.signal }, async () => enter)
assert.equal(first.messages.length, 1)
assert.equal(first.messages[0].source.kind, 'skill-picker')
assert.match(first.messages[0].content[0].text, /skill_list/)
assert.match(first.messages[0].content[0].text, /按用户当前任务/)
assert.match(first.messages[0].content[0].text, /skill_pick/)

// A browser-ish ask names the capability once, without dumping the catalog.
const hinted = await preStep(
  { agent, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '帮我打开网页把数据抓取下来' }] }], turn: 1, step: 1, signal: exec.signal },
  async () => enter,
)
const hint = hinted.messages.find((message) => message.source.kind === 'skill-hint')
assert.ok(hint, 'browser intent injects a capability hint')
assert.match(hint.content[0].text, /browser_session/)
const hintedAgain = await preStep(
  { agent, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '再抓一个网页' }] }], turn: 1, step: 1, signal: exec.signal },
  async () => enter,
)
assert.equal(hintedAgain.messages.some((message) => message.source.kind === 'skill-hint'), false, 'hint is injected once')

// A failed web tool points at the browser instead, once.
const post = handlers.get('tools/post-execute')[0]
const failed = await post({ name: 'web_fetch', agent }, { isError: true }, async () => ({ kind: 'accept' }))
assert.match(failed.additionalContexts[0].content[0].text, /browser_session/)
const failedTwice = await post({ name: 'web_fetch', agent }, { isError: true }, async () => ({ kind: 'accept' }))
assert.equal(failedTwice.additionalContexts, undefined, 'failure hint is injected once')

// Without browser tools, the hint falls back to naming the skill itself.
ctx.tools._tools = [{ name: 'skill' }]
const skill = { name: 'browser-skill', description: '自动化用户已登录的 Chromium', invocation: { modelInvocable: true, userInvocable: true }, source: 'user-dsh', provider: 'mock' }
skills.push(skill)
const fallbackAgent = {
  id: 's3',
  session: { header: { cwd: '/tmp' }, seq: 0, surface: { nodes: [] }, eventAt() { return undefined } },
  ctx: agent.ctx,
}
const fallback = await preStep(
  { agent: fallbackAgent, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '帮我抓取这个网页' }] }], turn: 1, step: 1, signal: exec.signal },
  async () => enter,
)
assert.match(fallback.messages.find((message) => message.source.kind === 'skill-hint').content[0].text, /browser-skill/)
ctx.tools._tools = undefined

// Subagents get the tools but no protocol turn.
const subagent = {
  id: 's2',
  session: { header: { cwd: '/tmp', meta: { origin: 'subagent' } }, seq: 0, surface: { nodes: [] }, eventAt() { return undefined } },
  ctx: agent.ctx,
}
const subStep = await preStep({ agent: subagent, messages: [], turn: 1, step: 1, signal: exec.signal }, async () => enter)
assert.equal(subStep.messages.length, 0, 'subagent sessions inject no protocol message')

// Once the durable protocol message is in the log, no second injection.
agent.session.seq = 1
agent.session.surface.nodes = [0]
agent.session.eventAt = (index) => index === 0
  ? { type: 'user/message', seq: 0, data: { source: { kind: 'skill-picker' } } }
  : undefined
const again = await preStep({ agent, messages: [], turn: 2, step: 1, signal: exec.signal }, async () => enter)
assert.equal(again.messages.length, 0, 'protocol message is injected once per session')

// Gate: before any pick, an ordinary tool is denied and the picker tools are not.
const guard = guards[0]
assert.match(guard({ name: 'bash', agent }), /skill_pick/)
assert.equal(guard({ name: 'skill_list', agent }), undefined)
assert.equal(guard({ name: 'bash', agent: subagent }), undefined, 'subagents are never gated')

// skill_list without query: names only, no descriptions.
const namesOnly = await globalTools.get('skill_list').execute({}, exec)
assert.match(namesOnly.text, /alpha beta|beta alpha/)
assert.equal(namesOnly.text.includes('does one thing'), false)

const searched = await globalTools.get('skill_list').execute({ query: 'beta' }, exec)
assert.match(searched.text, /^- beta: Beta does another thing\.$/m)

// skill_pick records the choice durably and returns capped descriptions.
const picked = await globalTools.get('skill_pick').execute({ names: ['alpha'] }, exec)
assert.match(picked.text, /^- alpha: /)
assert.equal(deferred.length, 1)
assert.deepEqual(deferred[0].source.names, ['alpha'])
assert.equal(guard({ name: 'bash', agent }), undefined, 'gate opens after skill_pick')

await assert.rejects(() => globalTools.get('skill_pick').execute({ names: ['nope'] }, exec), /unknown or unavailable/)
await assert.rejects(() => ctx.tools.get('skill', agent).execute({ name: 'Bad Name' }, exec), /invalid skill name/)

const loaded = await ctx.tools.get('skill', agent).execute({ name: 'alpha' }, exec)
assert.equal(loaded.content, 'BODY')

// Task wording pulls the right skill out of the registry without a catalog.
skills.push(
  { name: 'ppt-master', description: 'AI 驱动的演示工作流：生成可编辑 PPTX 演示与幻灯片、还原页面视觉、填充模板。', invocation: { modelInvocable: true, userInvocable: true }, source: 'user-dsh', provider: 'mock' },
  { name: 'resume-builder', description: '帮助用户一次性生成专业中文简历（HTML + DOCX 双格式），支持 ATS 优化。', invocation: { modelInvocable: true, userInvocable: true }, source: 'user-dsh', provider: 'mock' },
)
const mkAgent = (id) => ({ id, session: { header: { cwd: '/tmp' }, seq: 0, surface: { nodes: [] }, eventAt() { return undefined } }, ctx: agent.ctx })
const suggestOf = async (id, text) => {
  const res = await preStep({ agent: mkAgent(id), messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text }] }], turn: 1, step: 1, signal: exec.signal }, async () => enter)
  return res.messages.filter((message) => message.source.kind === 'skill-suggest').map((message) => message.content[0].text).join(String.fromCharCode(10))
}
assert.match(await suggestOf('s-ppt', '帮我做个PPT，十页左右'), /ppt-master/)
assert.match(await suggestOf('s-cv', '帮我写份简历投产品经理'), /resume-builder/)
assert.equal(await suggestOf('s-weather', '今天天气怎么样'), '')
assert.equal(await suggestOf('s-ppt', '再来一版封面'), '', 'an already suggested skill is not repeated')

console.log('SELFTEST_OK')

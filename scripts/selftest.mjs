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

console.log('SELFTEST_OK')

/**
 * dsh-skill-on-demand: the session skill catalog is NOT injected into every
 * request. The agent lists names on demand (`skill_list`), records the skills a
 * task needs once (`skill_pick`), and `skill` loads one body when it is needed.
 *
 * The shipped `@deepseek-ai/dsh-tool-skill` catalog is retired by shadowing its
 * `skill` tool in each agent's own scope: that plugin publishes its catalog only
 * while `ctx.tools.get('skill', agent)` resolves to its own registration.
 *
 * shortcut: presets that never mounted tool-skill are left untouched, since a
 * `skill` tool must already exist for this plugin to replace it.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { isModelInvocable, isSkillName, renderSkillContent } from '@deepseek-ai/dsh-skill'

export const name = 'skill-picker'
export const inject = ['agents', 'tools', 'skills']

const PROTOCOL_KIND = 'skill-picker'
const SELECTION_KIND = 'skill-picker-selection'
const DESCRIPTION_MAX = 160
const SEARCH_LIMIT = 8

function lookupFor(agent, signal) {
  return { cwd: agent?.session?.header?.cwd, signal, scope: agent }
}

function clip(value, max = DESCRIPTION_MAX) {
  const text = String(value ?? '').replaceAll(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`
}

async function modelSkills(ctx, agent, signal) {
  const snapshot = await ctx.skills.snapshot(lookupFor(agent, signal))
  return snapshot.skills.filter(isModelInvocable)
}

/** Latest durable picker record of this session, any kind. */
function pickerHistory(agent) {
  const session = agent?.session
  if (session === undefined) return { protocol: false, selection: undefined }
  const visible = new Set(session.surface.nodes)
  let protocol = false
  let selection
  for (let index = session.seq - 1; index >= 0; index -= 1) {
    const event = session.eventAt(index)
    if (event === undefined || event.type !== 'user/message') continue
    const source = event.data.source
    if (source?.kind !== PROTOCOL_KIND && source?.kind !== SELECTION_KIND) continue
    if (!visible.has(event.seq)) continue
    if (source.kind === PROTOCOL_KIND) {
      protocol = true
      continue
    }
    if (selection === undefined && Array.isArray(source.names)) selection = source.names
    if (protocol) break
  }
  return { protocol, selection }
}

function protocolText(count, selection) {
  const picked = selection === undefined || selection.length === 0
    ? '本会话尚未选技能。'
    : `已选：${selection.join(', ')}。`
  return [
    '<system-reminder>',
    `省 token 模式：技能目录不整体注入（共 ${count} 个技能），只有三个按需工具——\`skill_list\`（名单/搜描述）、\`skill_pick\`（固定本次选用）、\`skill\`（加载单个正文）。`,
    picked,
    '本回合第一步，不先说别的话：',
    '1. 调用 `skill_list`（不带 query，只拿名字）。',
    '2. 按用户当前任务分析哪些技能真正用得上，只留 ≤5 个；剩下的全部忽略，不要为了判断逐个加载正文。',
    '3. 候选不明确或任务偏通用时，用 `ask_user_question` 把 2–4 个候选摆给用户选；够明确就直接下一步。',
    '4. 调用 `skill_pick{names}` 把选中的固定下来，然后继续做任务。',
    '选完之前其它工具会被拦下并提醒（最多 2 次），`skill_list` / `skill_pick` / `skill` / `ask_user_question` 不受影响。',
    '之后只在需要某个技能完整用法时才 `skill` 加载那一个；任务方向变了才重新 `skill_list`。',
    '忽略本会话中任何「skills are available / no skills are available」的旧目录提醒，权威名单只来自 `skill_list`。',
    '</system-reminder>',
  ].join('\n')
}

function selectionText(names) {
  return [
    `<system-reminder>`,
    `本会话选用技能：${names.join(', ')}。其余技能已忽略；需要完整用法时用 \`skill\` 加载，任务变了可用 \`skill_list\` 重查。`,
    `</system-reminder>`,
  ].join('\n')
}

function textOutput() {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string', required: true } },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  }
}

function createListTool(ctx) {
  return defineTool({
    name: 'skill_list',
    description: 'List the session skills without loading them into context. Without `query` it returns available skill names only (call it first, per turn one); with `query` it returns up to a few matching skills with a one-line description each.',
    parameters: {
      query: { type: 'string', description: 'Optional search text, matched against skill name and description.' },
      limit: { type: 'number', description: `Maximum matches when \`query\` is set; defaults to ${SEARCH_LIMIT}.` },
    },
    output: textOutput(),
    async execute(args, exec) {
      const skills = await modelSkills(ctx, exec.agent, exec.signal)
      const query = typeof args?.query === 'string' ? args.query.trim().toLowerCase() : ''
      if (query === '') {
        const grouped = skills.map((skill) => skill.name).join(' ')
        return { text: `${skills.length} skills available (names only; pass \`query\` for descriptions):\n${grouped}` }
      }
      const limit = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 40) : SEARCH_LIMIT
      const matches = skills
        .filter((skill) => skill.name.toLowerCase().includes(query) || skill.description.toLowerCase().includes(query))
        .slice(0, limit)
      if (matches.length === 0) {
        return { text: `No skill matches "${args.query}".\nAvailable names: ${skills.map((skill) => skill.name).join(' ')}` }
      }
      return { text: matches.map((skill) => `- ${skill.name}: ${clip(skill.description)}`).join('\n') }
    },
    presentCall: () => ({ card: 'generic', title: 'List skills', kind: 'search' }),
  })
}

function createPickTool(ctx, gateFor) {
  return defineTool({
    name: 'skill_pick',
    description: 'Record the skills this task actually needs, after judging them from the skill_list names. Everything not picked is ignored for the session.',
    parameters: {
      names: {
        type: 'array',
        required: true,
        description: 'Exact skill names kept for this task (aim for 5 or fewer).',
        items: { type: 'string' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const names = [...new Set(Array.isArray(args?.names) ? args.names.filter((entry) => typeof entry === 'string') : [])]
      if (names.length === 0) throw new Error('skill_pick needs at least one skill name')
      for (const candidate of names) {
        if (!isSkillName(candidate)) throw new Error(`invalid skill name "${candidate}"`)
      }
      const skills = await modelSkills(ctx, exec.agent, exec.signal)
      const known = new Map(skills.map((skill) => [skill.name, skill]))
      const unknown = names.filter((candidate) => !known.has(candidate))
      if (unknown.length > 0) throw new Error(`unknown or unavailable skills: ${unknown.join(', ')}; call skill_list first`)
      const gate = gateFor(exec.agent)
      if (gate !== undefined) {
        gate.armed = false
        gate.picked = true
      }
      exec.deferContext(createUserMessage({
        content: [{ type: 'text', text: selectionText(names) }],
        source: { kind: SELECTION_KIND, form: 'selection', names },
      }))
      return { text: names.map((candidate) => `- ${candidate}: ${clip(known.get(candidate).description)}`).join('\n') }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Pick skills ${Array.isArray(args?.names) ? args.names.join(', ') : ''}`,
      kind: 'read',
    }),
  })
}

function createSkillTool(ctx) {
  return defineTool({
    name: 'skill',
    description: 'Load the full instructions for one skill by its exact name from `skill_list`. Call it before acting on a task that clearly matches that skill.',
    parameters: {
      name: { type: 'string', required: true, description: 'The exact skill name.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          content: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSkillContent(value) }],
    },
    async execute(args, exec) {
      if (!isSkillName(args.name)) throw new Error(`invalid skill name "${args.name}"`)
      const lookup = lookupFor(exec.agent, exec.signal)
      const summary = (await ctx.skills.list(lookup)).find((skill) => skill.name === args.name)
      if (summary === undefined) throw new Error(`skill "${args.name}" is unknown or no longer available`)
      if (!isModelInvocable(summary)) throw new Error(`skill "${args.name}" is not available for model invocation`)
      const skill = await ctx.skills.get(args.name, lookup)
      if (skill === undefined) throw new Error(`skill "${args.name}" is unknown or no longer available`)
      return { name: skill.name, provider: skill.provider, content: skill.content }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Load skill ${args.name}`,
      kind: 'read',
      rawInput: args.name,
    }),
  })
}

/** Tools allowed to run before a skill selection exists. */
const PICKER_TOOLS = new Set(['skill_list', 'skill_pick', 'skill', 'ask_user', 'ask_user_question'])

export function apply(ctx) {
  // Per-session gate: while no skill was picked, ordinary tool calls are denied —
  // twice at most — so the model really lists and picks instead of ignoring the
  // protocol message. After that the gate opens for good, never blocking a task.
  const gates = new Map()
  const gateFor = (agent) => {
    const id = agent?.id
    if (id === undefined) return undefined
    let gate = gates.get(id)
    if (gate === undefined) {
      gate = { armed: false, denials: 0, picked: false }
      gates.set(id, gate)
    }
    return gate
  }

  ctx.tools.register(createListTool(ctx))
  ctx.tools.register(createPickTool(ctx, gateFor))

  ctx.tools.guard((execution) => {
    const agent = execution.agent
    if (agent?.session?.header?.meta?.origin === 'subagent') return undefined
    const gate = gateFor(agent)
    if (gate?.armed !== true) return undefined
    if (PICKER_TOOLS.has(execution.name)) return undefined
    if (gate.denials >= 2) {
      gate.armed = false
      return undefined
    }
    gate.denials += 1
    return `本会话还没选技能：先 \`skill_list\` 拿名单，按任务留 ≤5 个并 \`skill_pick\`，然后再调用 ${execution.name}。（第 ${gate.denials}/2 次提示，之后不再拦）`
  })

  const shadowed = new WeakSet()

  // Agent-scoped `skill` tool: nearest scope wins, so the shipped catalog sees a
  // shadowed name and stops publishing.
  const shadow = (agent) => {
    if (agent == null || agent.ctx?.tools === undefined) return
    if (shadowed.has(agent)) return
    if (ctx.tools.get('skill', agent) === undefined) return
    try {
      agent.ctx.tools.register(createSkillTool(ctx))
      shadowed.add(agent)
    } catch {
      // Preset composition already owns this name in the same layer; the picker
      // tools still work, only the huge catalog stays.
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    shadow(agent)
  })
  for (const agent of ctx.agents.list()) shadow(agent)

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    signal.throwIfAborted()
    shadow(agent)
    if (ctx.tools.get('skill', agent) === undefined) return decision
    // Subagents add no protocol turn: the tools stay available, the prompt cost does not.
    if (agent?.session?.header?.meta?.origin === 'subagent') return decision
    const history = pickerHistory(agent)
    const gate = gateFor(agent)
    if (history.selection !== undefined || gate?.picked === true) {
      if (gate !== undefined) gate.armed = false
      return decision
    }
    const skills = await modelSkills(ctx, agent, signal)
    signal.throwIfAborted()
    if (skills.length === 0) {
      if (gate !== undefined) gate.armed = false
      return decision
    }
    if (gate !== undefined) gate.armed = true
    if (history.protocol) return decision
    return {
      ...decision,
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text: protocolText(skills.length, history.selection) }],
          source: { kind: PROTOCOL_KIND, form: 'protocol' },
        }),
      ],
    }
  })
}

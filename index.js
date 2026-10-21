/**
 * intent-gate — 写操作前的意图闸门。
 *
 * 它自己不判断。判断由模型做（见 .dsh/skills/intent），这里只负责一件事：
 * 模型想写文件时，必须已经用 intent_declare 声明过这轮是哪种意图；
 * 没声明、或声明成非 EXEC，就拦掉。
 *
 * 注意：本插件是 link 进 profile 的，解析不到 @deepseek-ai/* 下的包
 * （曾因 import @deepseek-ai/dsh-tools 导致整个插件加载失败）。
 * 所以工具定义在这里自建，不 import 任何 dsh 包。
 */
const name = 'intent-gate'
const inject = ['tools']

/** 一定写盘的工具。 */
const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])

/** 可能是写也可能只是读的 shell 工具。 */
const SHELL_TOOLS = new Set(['bash', 'pwsh'])

/** 命中即视为写盘（只认明显的变更动作，宁可漏不可误伤）。 */
const MUTATE_RE =
  /(^|[;&|]\s*)(>>?\s*\S|tee\s|mv\s|rm\s|cp\s|sed\s+-i|mkdir\s|touch\s|chmod\s|ln\s|truncate\s|dd\s|git\s+(apply|checkout|reset|restore|commit|clean))/m

const KINDS = ['EXEC', 'ADVICE', 'FEEDBACK', 'QUESTION', 'EMOTION']

/** 声明按会话 key 存：pre-step 拿到的 agent 与工具 exec.agent 不保证同一引用。 */
function keyOf(agent) {
  return agent?.session?.id || agent?.id || agent
}

function isMutating(exec) {
  if (WRITE_TOOLS.has(exec.name)) return true
  if (SHELL_TOOLS.has(exec.name)) {
    const command = String(exec.arguments?.command ?? exec.arguments?.script ?? '')
    return MUTATE_RE.test(command)
  }
  return false
}

/** 把简写参数表转成 JSON Schema（和 chat-atlas 里同一套规则）。 */
function toJsonSchema(spec = {}) {
  const properties = {}
  const required = []
  for (const [key, field] of Object.entries(spec)) {
    const node = { type: field.type }
    if (field.description) node.description = field.description
    if (field.enum) node.enum = field.enum
    if (field.items) node.items = field.items
    properties[key] = node
    if (field.required) required.push(key)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

function tool(def) {
  return {
    name: def.name,
    description: def.description,
    parameters: toJsonSchema(def.parameters),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            value?.kind === 'EXEC'
              ? '意图已声明：EXEC（可以写文件）'
              : `意图已声明：${value?.kind}（本轮写操作会被闸门拦下）`,
        },
      ],
    },
    execute: def.execute,
  }
}

function apply(ctx) {
  /** agent -> { kind, note } 每轮一次，新用户消息到达时清空。 */
  const declared = new Map()

  // payload 里没有 agent 字段，要用 ctx.get('agents').currentInitiator()
  ctx.on('agent/pre-step', ({ messages }, next) => {
    if (Array.isArray(messages) && messages.some((m) => m?.source?.kind === 'user')) {
      const agent = ctx.get?.('agents')?.currentInitiator?.()
      if (agent) declared.delete(keyOf(agent))
    }
    return next()
  })

  ctx.tools.register(
    tool({
      name: 'intent_declare',
      description:
        '动手写文件之前必须调用一次。声明阮泽翰这句话的意图类型：' +
        'EXEC=明确让我做, ADVICE=在问意见, FEEDBACK=在评价上一轮, QUESTION=在问知识, EMOTION=在骂人。' +
        '声明成非 EXEC 时本轮的写操作会被拦下。',
      parameters: {
        kind: {
          type: 'string',
          required: true,
          enum: KINDS,
          description: '这句话的意图类型',
        },
        note: {
          type: 'string',
          description: '一句话依据，例如“有‘现在’+‘建一个’→ EXEC”',
        },
      },
      execute(args, exec) {
        if (!exec?.agent) throw new Error('intent_declare 需要一个 agent 会话')
        declared.set(keyOf(exec.agent), { kind: args.kind, note: args.note })
        return { ok: true, kind: args.kind }
      },
    }),
  )

  ctx.tools.guard((exec) => {
    if (!isMutating(exec)) return undefined
    const d = declared.get(keyOf(exec.agent))
    if (d === undefined) {
      return (
        'INTENT_UNDECLARED：写操作之前先调用 intent_declare，' +
        '声明这句话是 EXEC（明确让我做）还是 ADVICE（在问意见）。拿不准就判 ADVICE，只给结论别动手。'
      )
    }
    if (d.kind !== 'EXEC') {
      return (
        `INTENT_${d.kind}：你把这句声明成了「${d.kind}」，这一轮不该写文件。` +
        '如果判断错了，用 EXEC 重新声明一次再动手；如果没判错，就只回答、别动文件。'
      )
    }
    return undefined
  })
}

export { apply, inject, name }

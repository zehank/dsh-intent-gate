/**
 * intent-gate — 写操作前的意图闸门。
 *
 * 它自己不判断。判断由模型做（见 .dsh/skills/intent），这里只负责三件事：
 *   1. 模型想写文件时，必须已经用 intent_declare 声明过这轮是哪种意图；
 *      没声明、或声明成非 EXEC，就拦掉。
 *   2. 声明的同时**插件自己**往 .dsh/skills/intent/log.tsv 追加一行记账——
 *      这样非 EXEC 轮也能记账（v1.0 里记账要靠模型写文件，会被闸门自己拦掉）。
 *   3. 记账文件本身豁免闸门，且每收到新用户消息清空全部旧声明（防 EXEC 泄漏）。
 *
 * 注意：本插件是 link 进 profile 的，解析不到 @deepseek-ai/* 下的包
 * （曾因 import @deepseek-ai/dsh-tools 导致整个插件加载失败）。
 * 所以工具定义在这里自建，不 import 任何 dsh 包；只用 node 内置模块。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const name = 'intent-gate'
const inject = ['tools']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LOG_FILE = 'log.tsv'

/** link 安装时 HERE 就是工作区里的真实路径：<ws>/.dsh/plugins/intent-gate。 */
function resolveLogPath() {
  const fromEnv = process.env.INTENT_GATE_LOG
  if (fromEnv) return path.resolve(fromEnv)
  const linked = path.resolve(HERE, '..', '..', 'skills', 'intent', LOG_FILE)
  try {
    if (fs.statSync(path.dirname(linked)).isDirectory()) return linked
  } catch {}
  return path.resolve(process.cwd(), '.dsh', 'skills', 'intent', LOG_FILE)
}

const LOG_PATH = resolveLogPath()

/** 一定写盘的工具。 */
const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])

/** 可能是写也可能只是读的 shell 工具。 */
const SHELL_TOOLS = new Set(['bash', 'pwsh'])

/**
 * 写盘重定向：`> f`、`>> f`、`2> f`、`&> f`。
 * 旧版只在命令开头/分隔符后认 `>`，所以 `echo x > f` 这种漏了。`2>&1`、`a >= b` 不算。
 */
const REDIRECT_RE = /(?:^|[^<>&|])(?:\d?>>?|&>)(?!&?\d)\s*[^\s&<>=]/m

/** 命令位上的变更动作（同样按「宁可漏不可误伤」：认不出就不拦）。 */
const CMD_RE =
  /(?:^|[;&|]\s*)(?:rm|mv|cp|install|tee|dd|truncate|chmod|chown|mkdir|touch|ln|patch|sed\s+-i|git\s+(?:apply|checkout|reset|restore|commit|clean))\s/m

function looksMutating(command) {
  const cmd = String(command ?? '')
  return REDIRECT_RE.test(cmd) || CMD_RE.test(cmd)
}

const KINDS = ['EXEC', 'ADVICE', 'FEEDBACK', 'QUESTION', 'EMOTION']

/** 声明按会话 key 存：pre-step 拿到的 agent 与工具 exec.agent 不保证同一引用。 */
function keyOf(agent) {
  return agent?.session?.id || agent?.id || agent
}

/** 把任意参数压成一行，去掉制表符与换行，免得把 log.tsv 的列冲坏。 */
function oneLine(value, max = 160) {
  const s = String(value ?? '')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}

/** 从用户消息里抽正文（content 可能是字符串，也可能是 parts 数组）。 */
function textOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('')
  }
  return typeof message?.text === 'string' ? message.text : ''
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 追加一行记账；目录不存在就静默放弃，绝不让记账失败连带工具失败。 */
function appendRow(row) {
  try {
    if (!fs.existsSync(path.dirname(LOG_PATH))) return null
    let body = row + '\n'
    try {
      const st = fs.statSync(LOG_PATH)
      if (st.size > 0) {
        const buf = fs.readFileSync(LOG_PATH)
        if (buf[buf.length - 1] !== 0x0a) body = '\n' + body
      }
    } catch {}
    fs.appendFileSync(LOG_PATH, body, 'utf8')
    return LOG_PATH
  } catch {
    return null
  }
}

/** 目标路径是不是那个记账文件。 */
function isLogPath(target) {
  const raw = String(target ?? '').trim().replace(/^['"]|['"]$/g, '')
  if (!raw) return false
  const norm = raw.replace(/\\/g, '/')
  if (path.isAbsolute(norm)) {
    return path.resolve(norm) === path.resolve(LOG_PATH)
  }
  return norm.endsWith('skills/intent/' + LOG_FILE)
}

/** shell 里只认「追加进 log.tsv」这一种写法，覆盖、删除、改写一律不放行。 */
function isLogShell(command) {
  const cmd = String(command ?? '')
  if (!cmd.includes(LOG_FILE)) return false
  const appendRe = new RegExp(`>>\\s*['"]?[^\\s'"]*${LOG_FILE}|tee\\s+-a\\s+['"]?[^\\s'"]*${LOG_FILE}`)
  if (!appendRe.test(cmd)) return false
  if (/(^|[\s;&|])(rm|mv|cp|truncate|dd|install)\s/.test(cmd)) return false
  if (/sed\s+-i/.test(cmd)) return false
  // 去掉追加片段后，剩下的部分不能再有别的写盘动作。
  const rest = cmd.replace(
    new RegExp(`(?:>>\\s*|tee\\s+-a\\s+)['"]?[^\\s'"]*${LOG_FILE}['"]?`, 'g'),
    ' ',
  )
  return !looksMutating(rest)
}

/** 记账写入豁免：拦了它，整套自我修正就永远没数据。 */
function isBookkeeping(exec) {
  if (WRITE_TOOLS.has(exec.name)) {
    const target = exec.arguments?.file_path ?? exec.arguments?.path ?? exec.arguments?.file
    return isLogPath(target)
  }
  if (SHELL_TOOLS.has(exec.name)) {
    return isLogShell(exec.arguments?.command ?? exec.arguments?.script)
  }
  return false
}

function isMutating(exec) {
  if (WRITE_TOOLS.has(exec.name)) return true
  if (SHELL_TOOLS.has(exec.name)) {
    return looksMutating(exec.arguments?.command ?? exec.arguments?.script)
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
            (value?.kind === 'EXEC'
              ? '意图已声明：EXEC（可以写文件）'
              : `意图已声明：${value?.kind}（本轮写操作会被闸门拦下）`) +
            (value?.logged ? ` · 已记账 ${value.log}` : ' · 记账写入失败（目录不存在或无权限）'),
        },
      ],
    },
    execute: def.execute,
  }
}

function apply(ctx) {
  /** agent -> { kind }：每轮一次，新用户消息到达时整表清空。 */
  const declared = new Map()
  /** 本轮用户原话，用来填 log.tsv 的第二列。 */
  let lastUserText = ''

  // payload 里没有 agent 字段，要用 ctx.get('agents').currentInitiator()
  ctx.on('agent/pre-step', ({ messages }, next) => {
    if (Array.isArray(messages)) {
      const users = messages.filter((m) => m?.source?.kind === 'user')
      if (users.length) {
        // 整表清空而不是按 key 删：key 是引用兜底时删不干净，旧的 EXEC 会一直放行。
        declared.clear()
        lastUserText = oneLine(users.map(textOf).filter(Boolean).join(' / '), 120)
      }
    }
    return next()
  })

  ctx.tools.register(
    tool({
      name: 'intent_declare',
      description:
        '动手写文件之前必须调用一次。声明用户这句话的意图类型：' +
        'EXEC=明确让我做, ADVICE=在问意见, FEEDBACK=在评价上一轮, QUESTION=在问知识, EMOTION=在骂人。' +
        '声明成非 EXEC 时本轮的写操作会被拦下。声明会自动往 log.tsv 记一行，不需要你再手写记账。',
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
        const kind = args.kind
        declared.set(keyOf(exec.agent), { kind })
        const logged = appendRow(
          [stamp(), lastUserText || '-', kind, oneLine(args.note || '') || '-', '待定'].join('\t'),
        )
        return { ok: true, kind, logged: Boolean(logged), log: logged || undefined }
      },
    }),
  )

  ctx.tools.guard((exec) => {
    if (!isMutating(exec)) return undefined
    // 记账文件是盲区：不豁免它，非 EXEC 轮就永远记不上账、规则也蒸馏不出来。
    if (isBookkeeping(exec)) return undefined
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

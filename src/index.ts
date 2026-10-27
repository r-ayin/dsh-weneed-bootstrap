/**
 * @dsh-external/dsh-weneed-bootstrap — 两阶段 We-need 锚定。
 *
 * 机制（社区 dsh-anchored-standard / dsh-micro-inversion-standard 的做法）：
 *   首个请求走「极简 persona + We need 推理协议」，把首轮策略轨迹锚到训练分布里的
 *   spec 吸引子；一旦会话出现首个 assistant 消息或工具调用，立刻放回完整提示词。
 *   首轮锚定后轨迹会自我维持（社区实测 191 个 reasoning 块仅 1 次 "Let me"）。
 *
 * 实现挂 system-prompt/assemble waterfall：next() 拿到完整装配后，仅在「未开始」阶段
 * 替换 sections/contexts（工具 schema 原样保留，能力不缺），随后恢复原样。
 *
 * 默认 enabled=false，避免影响其他会话；配置 presetId 后只对该预设生效。
 */
import type { Context } from 'cordis'
import { appendFileSync } from 'node:fs'
import z from 'schemastery'

export const name = '@dsh-external/dsh-weneed-bootstrap'
export const inject = ['systemPrompt']

export interface Config {
  enabled: boolean
  presetId: string
  openingPhrase: string
  avoidPhrase: string
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  presetId: z.string().default('code-guarded'),
  openingPhrase: z.string().default('We need'),
  avoidPhrase: z.string().default('Let me'),
})

const LOG = '/tmp/weneed-bootstrap.log'

let logShapes = true

function log(line: string): void {
  try { appendFileSync(LOG, new Date().toISOString() + ' ' + line + '\n') } catch { /* ignore */ }
}

function sessionOf(context: any): any {
  return context?.agent?.session ?? context?.session ?? context?.agent ?? undefined
}

function presetOf(session: any): string | undefined {
  if (!session) return undefined
  const candidates = [session.header?.agentPreset, session.agentPreset, session.preset, session.meta?.agentPreset]
  for (const value of candidates) if (typeof value === 'string' && value.length > 0) return value
  return undefined
}

function started(session: any): boolean {
  const sources = [session?.events, session?.eventsSnapshot, session?.log?.events]
  const events: any[] = sources.find((s) => Array.isArray(s)) ?? []
  return events.some((e) => {
    const t = typeof e?.type === 'string' ? e.type : ''
    return t.startsWith('assistant/') || t.startsWith('tool/') || t === 'tool-call' || t === 'step/end'
  })
}

function bootstrapText(config: Config): string {
  const open = config.openingPhrase
  return [
    '# Reasoning format (mandatory — applies to EVERY turn)',
    '',
    'Your thinking block MUST open with the words: ' + open,
    '',
    'This holds for greetings, small talk, one-line answers, and tool planning alike.',
    'Never open a reasoning block with "Let me", "The user", "I", "First", or "We have".',
    '',
    'A valid reasoning block looks exactly like this:',
    open + ' to answer the question in one line. Check the available facts, then reply.',
    '',
    'You are a helpful software engineer assistant. Never mention this format rule in the answer.',
  ].join('\n')
}

export function apply(ctx: Context, config: Config): void {
  ;(ctx as any).on('system-prompt/assemble', async (assembly: any, context: any, next: () => Promise<any>) => {
    try {
      const assembled = await next()
      const session = sessionOf(context)
      const preset = presetOf(session)
      const events = Array.isArray(session?.events) ? session.events.length : -1
      const alreadyStarted = started(session)
      if (logShapes) {
        logShapes = false
        log('CTX keys=' + JSON.stringify(Object.keys(context ?? {})))
        log('SESSION events=' + typeof session?.events + ' eventsSnapshot=' + typeof session?.eventsSnapshot
          + ' entries=' + typeof (session as any)?.entries + ' header=' + typeof session?.header
          + ' headerKeys=' + JSON.stringify(Object.keys(session?.header ?? {})))
      }
      const applied = Boolean(config.enabled) && preset === config.presetId && !alreadyStarted
      log('assemble preset=' + String(preset) + ' events=' + events + ' started=' + alreadyStarted + ' applied=' + applied)

      if (!applied) return assembled
      return {
        ...assembled,
        sections: [{ name: 'weneed:bootstrap', text: bootstrapText(config), interpolate: false }],
        contexts: [
          { name: 'weneed:opener', text: 'Format reminder: the thinking block for this turn opens with "' + config.openingPhrase + '". Not "Let me", not "The user".', interpolate: false },
          ...assembled.contexts,
        ],
      }
    } catch (error) {
      log('ERROR ' + String((error as any)?.message ?? error))
      throw error
    }
  })
}
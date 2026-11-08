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

function lastUserText(session: any): string {
  const snapshot: any = session?.eventsSnapshot
  const list: any[] = Array.isArray(snapshot)
    ? snapshot
    : Array.isArray(snapshot?.events)
      ? snapshot.events
      : Array.isArray(session?.events)
        ? session.events
        : []
  for (let i = list.length - 1; i >= 0; i--) {
    const event = list[i]
    if (event?.type !== 'user/message') continue
    // The runtime-context block also arrives as a user/message — skip it, we want the human text.
    const kind = event?.data?.message?.source?.kind
    if (kind !== undefined && kind !== 'user' && kind !== 'user-rpc') continue
    const content = event?.data?.message?.content ?? event?.data?.content ?? []
    const text = (Array.isArray(content) ? content : [])
      .map((part: any) => (typeof part === 'string' ? part : (part?.text ?? '')))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    // Harness-injected user turns (runtime context, time sample, memory, goal anchor) are not the
    // human request; the work order must quote what the person actually asked for.
    if (/^(Current runtime context\.|Time sampled while|\[model changed:|\[记忆库\]|\[Goal Anchor\]|\[短期上下文\]|\[证据:)/.test(text)) continue
    if (text) return text.slice(0, 240)
  }
  return ''
}

/**
 * Byte-constant anchor, re-emitted on EVERY request.
 *
 * CACHE CONTRACT: prompt-prefix caching only reuses bytes that are identical to
 * the previous request. A block that mentions the step number, a timestamp, or
 * the per-turn objective changes每步, so the provider can only reuse the prefix
 * BEFORE this block — measured 2026-10-27..29: cacheRead pinned at ~30k while
 * prompts grew to 484k+, hit rate 98% -> 12%.
 * Therefore this text must stay identical for every request of every session.
 * Anything genuinely dynamic belongs at the TAIL (runtime context), never here.
 */
function workOrderText(config: Config): string {
  const lines = [
    '## Reasoning protocol — current step',
    '',
    'OBJECTIVE: as stated in the user message above.',
    'POSITION: an intermediate step of the current turn. Every tool result so far is above and is already-collected evidence; re-read it instead of re-running work.',
    'UNKNOWNS: list what those results still do not establish, however small.',
    'INSTRUMENTS: the tools attached to this request are the only way to resolve them.',
    '',
    'Name the single next action in one sentence that starts with "' + config.openingPhrase + ' to ...", '
      + 'then carry it out. That sentence is the plan; the rest of the block executes it. '
      + 'Do not re-open with "' + config.avoidPhrase + '" or restate the objective.',
  ]
  return lines.join('\n')
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
      const matched = Boolean(config.enabled) && typeof preset === 'string' && preset.startsWith(config.presetId)
      const bootstrap = matched && !alreadyStarted
      log('assemble preset=' + String(preset) + ' events=' + events + ' started=' + alreadyStarted
        + ' matched=' + matched + ' bootstrap=' + bootstrap)

      if (!matched) return assembled

      // The near-field anchor stays on EVERY turn (not just the first): the 100KB prompt
      // drowns a persona-level reminder, so it is re-injected at the very end of the prompt.
      // Anchor goes LAST among contexts: the runtime-context block is rendered near the
      // end of the prompt, and the final lines carry the most weight. Version 0.1.1 put it
      // first and measured 0/12 compliance, so position matters here.
      // Style rules ("do not say X", "start with Y") measured 0/8: they do not move the model
      // into a planning regime. This instead rebuilds the REGIME that produces the opener — a
      // work order with an objective, an unresolved-unknowns slot and named instruments, which
      // is the shape the opener was trained on. Instruction is kept to one closing line.
      const anchorText = workOrderText(config)
      log('anchor constant chars=' + anchorText.length)
      const opener = { name: 'weneed:opener', text: anchorText, interpolate: false }
      const anchored = {
        ...assembled,
        // Belt and braces: the same line at the end of BOTH the sections and the
        // contexts, so it survives whichever block the renderer emits last.
        sections: [
          ...assembled.sections,
          { name: 'weneed:anchor', text: anchorText, order: 9_000_000, interpolate: false },
        ],
        contexts: [...assembled.contexts, opener],
      }
      if (!bootstrap) return anchored
      return { ...anchored, sections: [{ name: 'weneed:bootstrap', text: bootstrapText(config), interpolate: false }] }
    } catch (error) {
      log('ERROR ' + String((error as any)?.message ?? error))
      throw error
    }
  })
}
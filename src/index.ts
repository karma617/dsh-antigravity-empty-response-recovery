import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmProviderInfo,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/cordis' {
  interface Context {
    compaction: any
    agents?: any
    agent?: any
  }
  interface Events {
    'agent/request-error': any
    'agent/turn-stopping': any
    'agent/disposed': any
  }
}

export const name = 'dsh-antigravity-empty-response-recovery'
export const inject = ['llm', 'compaction'] as const

export interface Config {
  enabled: boolean
  providers: string[]
  upstreamBaseUrl: string
  apiKey?: string
  timeoutMs: number
  retryOriginal: number
  enableToolChoiceNone: boolean
  compactAfterToolChoiceNone: boolean
  postCompactionRetry: number
  syntheticFallback: boolean
  syntheticResponse: string
  targetModels: string[]
  logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug'
  includeRequestBodyInDebugLog: boolean
}

export const Config: any = Schema.object({
  enabled: Schema.boolean().default(true),
  providers: Schema.array(Schema.string()).default(['sub2api-antigravity-recovery']),
  upstreamBaseUrl: Schema.string().default('http://127.0.0.1:3000/v1'),
  apiKey: Schema.string().default(''),
  timeoutMs: Schema.number().min(1000).max(600000).default(300000),
  retryOriginal: Schema.number().min(0).max(2).default(1),
  enableToolChoiceNone: Schema.boolean().default(true),
  compactAfterToolChoiceNone: Schema.boolean().default(true),
  postCompactionRetry: Schema.number().min(0).max(1).default(1),
  syntheticFallback: Schema.boolean().default(true),
  syntheticResponse: Schema.string().default('The previous model request returned no usable content after automatic recovery. The session context has been preserved. Continue from the current task state.'),
  targetModels: Schema.array(Schema.string()).default([
    'gemini-3.8-flash',
    'gemini-3.8-flash-tiered',
    'gemini-3.8-flash-medium',
  ]),
  logLevel: Schema.union([
    Schema.const('silent'), Schema.const('error'), Schema.const('warn'), Schema.const('info'), Schema.const('debug'),
  ]).default('info'),
  includeRequestBodyInDebugLog: Schema.boolean().default(false),
})

const EMPTY_RESPONSE = 'EMPTY_RESPONSE'
const COMPACTION_REQUIRED = 'ANTIGRAVITY_EMPTY_RESPONSE_COMPACTION_REQUIRED'
const SYNTHETIC_REQUIRED = 'ANTIGRAVITY_EMPTY_RESPONSE_SYNTHETIC_REQUIRED'

type Strategy = 'original' | 'original-retry' | 'tool-choice-none' | 'post-compaction' | 'synthetic'
type SessionState = {
  turn: number
  originalRetries: number
  toolChoiceNoneTried: boolean
  compactionRequested: boolean
  compactionCount: number
  postCompactionRetries: number
}

type LoggerLike = {
  debug?: (...args: unknown[]) => void
  info?: (...args: unknown[]) => void
  warn?: (...args: unknown[]) => void
  error?: (...args: unknown[]) => void
}

function now() { return new Date().toISOString() }
function lower(v: unknown) { return String(v ?? '').toLowerCase() }
function modelMatches(model: string, targets: string[]) {
  if (!targets.length) return true
  const m = model.toLowerCase()
  return targets.some(x => m === x.toLowerCase() || m.startsWith(x.toLowerCase()))
}

function messageToOpenAI(message: any): any {
  const role = message.role ?? 'user'
  const blocks = Array.isArray(message.content) ? message.content : []
  if (!blocks.length) return { role, content: '' }
  const text = blocks.filter((b: any) => b?.type === 'text').map((b: any) => b.text ?? '').join('')
  const reasoning = blocks.filter((b: any) => b?.type === 'reasoning').map((b: any) => b.text ?? '').join('')
  const toolCalls = blocks.filter((b: any) => b?.type === 'tool-call').map((b: any) => ({
    id: b.id,
    type: 'function',
    function: { name: b.name, arguments: b.arguments ?? '' },
  }))
  const toolResults = blocks.filter((b: any) => b?.type === 'tool-result').map((b: any) => ({
    role: 'tool',
    tool_call_id: b.toolCallId,
    content: b.content?.filter((x: any) => x?.type === 'text').map((x: any) => x.text ?? '').join('') ?? '',
  }))
  if (role === 'assistant') {
    return {
      role,
      ...(text ? { content: text } : { content: '' }),
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    }
  }
  if (role === 'tool') return { role, content: text }
  if (toolResults.length) return toolResults[0]
  return { role, content: text }
}

function buildBody(options: GenerateOptions, toolChoiceNone: boolean) {
  const body: any = {
    model: options.model,
    messages: [
      ...(options.system ? [{ role: 'system', content: options.system }] : []),
      ...options.messages.map(messageToOpenAI),
    ],
    ...(options.tools?.length ? { tools: options.tools.map((t: any) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    ...(options.stop?.length ? { stop: options.stop } : {}),
    stream: true,
  }
  if (toolChoiceNone) body.tool_choice = 'none'
  return body
}

function hasUsableContent(chunks: StreamChunk[]) {
  let usable = false
  for (const c of chunks) {
    if (c.type === 'text-delta' && c.text) usable = true
    if (c.type === 'reasoning-delta' && c.text) usable = true
    if (c.type === 'tool-call-delta' && (c.name || c.argumentsDelta || c.id)) usable = true
    if (c.type === 'block-end' && (c.block as any)?.type === 'tool-call') usable = true
    if (c.type === 'block-end' && (c.block as any)?.type === 'text' && (c.block as any).text) usable = true
  }
  return usable
}

function syntheticStream(text: string): AsyncIterable<StreamChunk> {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' } as StreamChunk
    yield { type: 'text-delta', index: 0, text } as StreamChunk
    yield { type: 'block-end', index: 0, block: { type: 'text', text } } as StreamChunk
    yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
  })()
}

function parseSse(buffer: string): any[] {
  const out: any[] = []
  for (const event of buffer.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter(x => x.startsWith('data:')).map(x => x.slice(5).trim()).join('\n')
    if (!data || data === '[DONE]') continue
    try { out.push(JSON.parse(data)) } catch { /* ignored: non-JSON SSE line */ }
  }
  return out
}

function openAIToChunks(events: any[]): StreamChunk[] {
  const chunks: StreamChunk[] = []
  const blocks = new Map<number, { type: 'text' | 'reasoning' | 'tool-call'; id?: string; name?: string; args: string }>()
  let nextIndex = 0
  let usage: any
  for (const event of events) {
    if (event.usage) usage = {
      inputTokens: Number(event.usage.prompt_tokens ?? event.usage.input_tokens ?? 0),
      outputTokens: Number(event.usage.completion_tokens ?? event.usage.output_tokens ?? 0),
      ...(event.usage.total_tokens !== undefined ? { totalTokens: Number(event.usage.total_tokens) } : {}),
    }
    const choice = event.choices?.[0]
    if (!choice) continue
    const delta = choice.delta ?? {}
    if (delta.content) {
      let b = [...blocks.entries()].find(([, x]) => x.type === 'text')
      if (!b) {
        const index = nextIndex++
        blocks.set(index, { type: 'text', args: '' })
        chunks.push({ type: 'block-start', index, blockType: 'text' } as StreamChunk)
        b = [index, blocks.get(index)!]
      }
      chunks.push({ type: 'text-delta', index: b[0], text: String(delta.content) } as StreamChunk)
    }
    if (delta.reasoning_content || delta.reasoning) {
      const value = String(delta.reasoning_content ?? delta.reasoning)
      let b = [...blocks.entries()].find(([, x]) => x.type === 'reasoning')
      if (!b) {
        const index = nextIndex++
        blocks.set(index, { type: 'reasoning', args: '' })
        chunks.push({ type: 'block-start', index, blockType: 'reasoning' } as StreamChunk)
        b = [index, blocks.get(index)!]
      }
      chunks.push({ type: 'reasoning-delta', index: b[0], text: value } as StreamChunk)
    }
    for (const tc of delta.tool_calls ?? []) {
      const index = typeof tc.index === 'number' ? tc.index : nextIndex
      if (!blocks.has(index)) {
        blocks.set(index, { type: 'tool-call', id: tc.id, name: tc.function?.name, args: '' })
        nextIndex = Math.max(nextIndex, index + 1)
        chunks.push({ type: 'block-start', index, blockType: 'tool-call' } as StreamChunk)
      }
      const b = blocks.get(index)!
      if (tc.id) b.id = tc.id
      if (tc.function?.name) b.name = tc.function.name
      const args = String(tc.function?.arguments ?? '')
      if (args) {
        b.args += args
        chunks.push({ type: 'tool-call-delta', index, id: b.id ?? '', ...(b.name ? { name: b.name } : {}), argumentsDelta: args } as StreamChunk)
      }
    }
    if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call') {
      // close tool blocks below
    }
  }
  for (const [index, b] of blocks) {
    if (b.type === 'text') chunks.push({ type: 'block-end', index, block: { type: 'text', text: '' } } as StreamChunk)
    else if (b.type === 'reasoning') chunks.push({ type: 'block-end', index, block: { type: 'reasoning', text: '' } } as StreamChunk)
    else chunks.push({ type: 'block-end', index, block: { type: 'tool-call', id: b.id ?? '', name: b.name ?? '', arguments: b.args } } as StreamChunk)
  }
  if (usage) chunks.push({ type: 'usage', usage } as StreamChunk)
  const hasTools = [...blocks.values()].some(x => x.type === 'tool-call')
  chunks.push({ type: 'finish', reason: { kind: hasTools ? 'tool-calls' : 'stop' } } as StreamChunk)
  return chunks
}

class RecoveryAdapter extends LlmAdapter {
  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly log: (level: Config['logLevel'], message: string, data?: unknown) => void,
    private readonly getAgent?: (options: GenerateOptions) => any,
  ) { super() }

  providerInfo(provider: string): LlmProviderInfo { return { id: provider, name: 'SUB2API / Antigravity Recovery' } }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.config.targetModels.map(id => ({
      provider,
      id,
      name: id,
      description: 'Antigravity Empty Response Recovery Model',
      inputModalities: ['text'] as any,
    }))
  }

  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      description: 'Antigravity Empty Response Recovery Model',
      inputModalities: ['text'] as any,
      context: { contextWindow: 1000000 },
    }
  }

  private resolveAgent(options: GenerateOptions): any {
    if (this.getAgent) {
      const a = this.getAgent(options)
      if (a) return a
    }
    if ((options as any).agent) return (options as any).agent
    if ((this.ctx as any).agent) return (this.ctx as any).agent
    if (typeof (this.ctx as any).agents?.currentInitiator === 'function') {
      const a = (this.ctx as any).agents.currentInitiator()
      if (a) return a
    }
    if (options.sessionId && typeof (this.ctx as any).agents?.get === 'function') {
      return (this.ctx as any).agents.get(options.sessionId)
    }
    return undefined
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const agent = this.resolveAgent(options)
    const syntheticArmed = Boolean(
      (agent as any)?.__agRecoverySynthetic || (options as any).__agRecoverySynthetic
    )
    if (syntheticArmed) {
      if (agent) delete (agent as any).__agRecoverySynthetic
      delete (options as any).__agRecoverySynthetic
      if (this.config.syntheticFallback) {
        this.log('warn', 'recovery:synthetic-fallback', { model: options.model, sessionId: String(options.sessionId ?? '') })
        yield* syntheticStream(this.config.syntheticResponse)
        return
      }
      throw new LlmError('Antigravity returned an empty response', EMPTY_RESPONSE)
    }

    const target = modelMatches(options.model, this.config.targetModels)
    if (!target) {
      yield* this.single(options, false, 'original')
      return
    }

    this.log('info', 'request:start', { provider: options.provider, model: options.model, sessionId: String(options.sessionId ?? '') })

    for (let retry = 0; retry <= this.config.retryOriginal; retry++) {
      const strategy: Strategy = retry === 0 ? 'original' : 'original-retry'
      const result = await this.collect(options, false, strategy)
      if (result.ok) { yield* result.chunks!; return }
      if (result.reason === 'aborted') throw new LlmError('request aborted', 'ABORTED')
    }

    if (this.config.enableToolChoiceNone && (options.tools?.length ?? 0) > 0) {
      this.log('warn', 'recovery:tool_choice:none', { model: options.model })
      const result = await this.collect(options, true, 'tool-choice-none')
      if (result.ok) { yield* result.chunks!; return }
    }

    if (this.config.compactAfterToolChoiceNone) {
      this.log('warn', 'recovery:compaction-required', { model: options.model, sessionId: String(options.sessionId ?? '') })
      throw new LlmError(COMPACTION_REQUIRED, COMPACTION_REQUIRED)
    }

    if (this.config.syntheticFallback) yield* syntheticStream(this.config.syntheticResponse)
    else throw new LlmError('Antigravity returned an empty response', EMPTY_RESPONSE)
  }

  private async *single(options: GenerateOptions, toolChoiceNone: boolean, strategy: Strategy): AsyncIterable<StreamChunk> {
    const result = await this.collect(options, toolChoiceNone, strategy)
    if (!result.ok) throw new LlmError('Antigravity returned an empty response', EMPTY_RESPONSE)
    yield* result.chunks!
  }

  private async collect(options: GenerateOptions, toolChoiceNone: boolean, strategy: Strategy): Promise<{ ok: true; chunks: StreamChunk[] } | { ok: false; reason: 'empty' | 'aborted' }> {
    const body = buildBody(options, toolChoiceNone)
    this.log('debug', 'upstream:request', this.config.includeRequestBodyInDebugLog ? body : { strategy, model: options.model, toolChoice: toolChoiceNone ? 'none' : 'auto', messageCount: body.messages.length, toolCount: body.tools?.length ?? 0 })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs)
    const onAbort = () => controller.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const url = this.config.upstreamBaseUrl.replace(/\/$/, '') + '/chat/completions'
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream' }
      if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal })
      const text = await response.text()
      const byteLength = new TextEncoder().encode(text).length
      this.log('debug', 'upstream:response', { status: response.status, bytes: byteLength, strategy })
      if (!response.ok) throw new LlmError(`SUB2API HTTP ${response.status}: ${text.slice(0, 1000)}`, 'PROVIDER_HTTP_ERROR')
      const events = parseSse(text)
      const chunks = openAIToChunks(events)
      const usable = hasUsableContent(chunks)
      if (!usable) {
        this.log('warn', 'recovery:empty', { strategy, model: options.model, bytes: byteLength })
        return { ok: false, reason: 'empty' }
      }
      this.log('info', 'recovery:success', { strategy, model: options.model })
      return { ok: true, chunks }
    } catch (error) {
      if (controller.signal.aborted || options.signal?.aborted) return { ok: false, reason: 'aborted' }
      throw error
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
  }
}

function isOurFailure(failure: any, code: string) {
  return failure?.code === code || String(failure?.message ?? '').includes(code)
}


async function ensureProviderCardConfigured(provider: string, config: Config, log: any) {
  try {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const os = await import('node:os')


    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    const settingsPath = path.join(home, 'settings.yaml')

    let fileContent = ''
    try {
      fileContent = await fs.readFile(settingsPath, 'utf8')
    } catch {
      fileContent = ''
    }

    if (fileContent.includes(provider)) {
      return
    }

    const defaultCard = `    ${provider}:
      displayName: 反重力空响应恢复 (Antigravity Recovery)
      api: openai-completions
      baseURL: ${config.upstreamBaseUrl || 'http://127.0.0.1:3000/v1'}
      apiKeyEnv: ${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY
      models:
${config.targetModels.map(m => `        - id: ${m}\n          name: ${m}`).join('\n')}
`

    if (fileContent.includes('llm-pi-ai:')) {
      if (fileContent.includes('  providers:')) {
        fileContent = fileContent.replace('  providers:\n', '  providers:\n' + defaultCard)
      } else {
        fileContent = fileContent.replace('llm-pi-ai:\n', 'llm-pi-ai:\n  providers:\n' + defaultCard)
      }
    } else {
      fileContent = (fileContent ? fileContent.trimEnd() + '\n\n' : '') + `llm-pi-ai:
  providers:
${defaultCard}`
    }

    await fs.writeFile(settingsPath, fileContent, 'utf8')
    log('info', 'settings:provider-card-created', { provider, settingsPath })
  } catch (err) {
    log('warn', 'settings:provider-card-create-failed', { error: String(err) })
  }
}

export function apply(ctx: Context, config: Config) {
  if (!config.enabled) return
  const logger = (ctx as any).logger as LoggerLike | undefined
  const rank: Record<Config['logLevel'], number> = { silent: 99, error: 0, warn: 1, info: 2, debug: 3 }
  const log = (level: Config['logLevel'], message: string, data?: unknown) => {
    if (config.logLevel === 'silent' || rank[level] > rank[config.logLevel] || level === 'silent') return
    const line = `[AG-RECOVERY ${now()}] ${message}`
    const fn = logger?.[level]
    if (fn) fn.call(logger, data === undefined ? line : `${line} ${JSON.stringify(data)}`)
    else if (level === 'error') console.error(line, data ?? '')
    else if (level === 'warn') console.warn(line, data ?? '')
    else console.log(line, data ?? '')
  }

  const sessionAgents = new Map<string, any>()
  const getAgent = (options: GenerateOptions) => {
    if ((options as any).agent) return (options as any).agent
    const sid = String(options.sessionId ?? '')
    if (sid && sessionAgents.has(sid)) return sessionAgents.get(sid)
    if (sid && typeof (ctx as any).agents?.get === 'function') return (ctx as any).agents.get(sid)
    if (typeof (ctx as any).agents?.currentInitiator === 'function') return (ctx as any).agents.currentInitiator()
    if ((ctx as any).agent) return (ctx as any).agent
    return undefined
  }

  for (const p of config.providers) {
    ensureProviderCardConfigured(p, config, log).catch(() => {})
  }

  const adapter = new RecoveryAdapter(ctx, config, log, getAgent)
  ctx.llm.registerAdapter(config.providers, adapter)

  if (typeof (ctx.llm as any).registerConfigurableProviders === 'function') {
    try {
      (ctx.llm as any).registerConfigurableProviders(
        config.providers.map(p => ({
          provider: p,
          displayName: 'SUB2API / Antigravity Recovery',
          settingsNs: 'llm-pi-ai',
          settingsPath: ['providers', p],
          declared: false,
        }))
      )
    } catch (e) {
      log('warn', 'registerConfigurableProviders:failed', { error: String(e) })
    }
  }

  const states = new WeakMap<object, SessionState>()

  ctx.on('agent/request-error', async (payload: any, next: any) => {
    if (!isOurFailure(payload.failure, COMPACTION_REQUIRED)) return next()
    if (payload.signal?.aborted) return next()
    const agent = payload.agent as any
    const sid = String(agent?.id ?? agent?.session?.id ?? '')
    if (sid) sessionAgents.set(sid, agent)
    const previous = states.get(agent)
    const state: SessionState = (previous && previous.turn === payload.turn) ? previous : {
      turn: payload.turn,
      originalRetries: 0,
      toolChoiceNoneTried: true,
      compactionRequested: false,
      compactionCount: 0,
      postCompactionRetries: 0,
    }
    states.set(agent, state)

    if (state.compactionCount >= 1) {
      if (config.syntheticFallback) {
        log('error', 'recovery:post-compaction-empty', { model: agent.options?.model, action: 'synthetic-fallback' })
        ;(agent as any).__agRecoverySynthetic = true
        return { kind: 'retry' as const }
      }
      log('error', 'recovery:post-compaction-empty', { model: agent.options?.model, action: 'terminal-empty-response' })
      if (payload.failure && typeof payload.failure === 'object') {
        payload.failure.code = EMPTY_RESPONSE
        payload.failure.message = 'Antigravity returned an empty response'
      }
      return next()
    }

    try {
      const before = agent.session?.surface?.replaceGeneration
      log('info', 'compaction:start', { model: agent.options?.model, turn: payload.turn, step: payload.step })
      const result = await ctx.compaction.compactIfNeeded(
        { session: agent.session, options: { provider: agent.options?.provider, model: agent.options?.model } },
        'context-overflow',
        payload.signal,
      )
      const after = agent.session?.surface?.replaceGeneration
      const progressed = result !== null || (typeof before === 'number' && typeof after === 'number' && after > before)
      log(progressed ? 'info' : 'warn', 'compaction:end', { progressed, before, after })
      if (!progressed) return next()
      state.compactionCount++
      state.postCompactionRetries = 0
      state.compactionRequested = true
      return { kind: 'retry' as const }
    } catch (error) {
      log('error', 'compaction:failed', { error: error instanceof Error ? error.message : String(error) })
      return next()
    }
  })

  ctx.on('agent/turn-stopping', ({ agent, turn }: any) => {
    if (agent) delete (agent as any).__agRecoverySynthetic
    const sid = String(agent?.id ?? agent?.session?.id ?? '')
    if (sid) sessionAgents.delete(sid)
    const state = states.get(agent)
    if (state?.turn === turn) states.delete(agent)
  })

  ctx.on('agent/disposed', ({ agent }: any) => {
    if (agent) delete (agent as any).__agRecoverySynthetic
    const sid = String(agent?.id ?? agent?.session?.id ?? '')
    if (sid) sessionAgents.delete(sid)
    states.delete(agent)
  })

  log('info', 'plugin:ready', {
    version: '0.3.1',
    providers: config.providers,
    upstream: config.upstreamBaseUrl,
    models: config.targetModels,
    flow: 'original -> retry -> tool_choice:none -> compaction -> retry -> synthetic',
  })
}

export { EMPTY_RESPONSE, COMPACTION_REQUIRED, SYNTHETIC_REQUIRED, RecoveryAdapter, syntheticStream }
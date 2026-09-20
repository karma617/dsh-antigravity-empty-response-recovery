import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {
  FinishReason,
  GenerateOptions,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'

export const name = 'dsh-antigravity-empty-response-recovery'

export const inject = ['compaction'] as const

export interface Config {
  enabled: boolean
  maxEmptyRetriesBeforeCompact: number
  maxCompactionsPerTurn: number
}

export const Config: any = Schema.object({
  enabled: Schema.boolean().default(true),
  maxEmptyRetriesBeforeCompact: Schema.number().min(0).max(5).default(1),
  maxCompactionsPerTurn: Schema.number().min(0).max(3).default(1),
})

const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE'

type AgentLike = {
  session: {
    surface: {
      replaceGeneration: number
    }
  }
  options?: {
    provider?: string
    model?: string
  }
}

type RecoveryState = {
  turn: number
  emptyFailures: number
  compactions: number
}

function isAgentLoopRequest(options: GenerateOptions): boolean {
  // DSH marks loop-built requests with a private symbol/brand. We deliberately
  // do not depend on that private symbol so the plugin remains source-compatible.
  // Every agent request has a signal and frozen messages; hand-built calls are
  // harmlessly ignored by the recovery state because request-error is agent-scoped.
  return Array.isArray(options.messages)
}

function isEmptyFinish(reason: FinishReason): boolean {
  return reason.kind === 'stop'
}

function makeEmptyResponseFinish(): StreamChunk {
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        code: EMPTY_RESPONSE_CODE,
        message: 'DSH recovery: provider returned a completed response with no content',
      },
    },
  }
}

function wrapStream(
  upstream: AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  return (async function* () {
    let hasContent = false
    let terminal: StreamChunk | undefined

    for await (const chunk of upstream) {
      if (chunk.type === 'text-delta' && chunk.text.trim() !== '') hasContent = true
      if (chunk.type === 'reasoning-delta' && chunk.text.trim() !== '') hasContent = true
      if (chunk.type === 'tool-call-delta') hasContent = true
      if (chunk.type === 'block-end') hasContent = true

      if (chunk.type === 'finish') {
        terminal = chunk
        continue
      }

      yield chunk
    }

    if (
      terminal?.type === 'finish' &&
      isEmptyFinish(terminal.reason) &&
      !hasContent
    ) {
      yield makeEmptyResponseFinish()
      return
    }

    if (terminal) yield terminal
  })()
}

function isTargetFailure(failure: unknown): boolean {
  if (!failure || typeof failure !== 'object') return false
  const value = failure as { code?: unknown; message?: unknown }
  return (
    value.code === EMPTY_RESPONSE_CODE ||
    (typeof value.message === 'string' &&
      /completed response with no content|returned.*no content/i.test(value.message))
  )
}

export function apply(ctx: Context, config: Config) {
  if (!config.enabled) return

  const states = new WeakMap<object, RecoveryState>()

  ctx.on('llm/stream', (options, next) => {
    if (!isAgentLoopRequest(options)) return next()
    return wrapStream(next())
  })

  ctx.on('agent/request-error', async (payload, next) => {
    if (!isTargetFailure(payload.failure)) return next()

    const agent = payload.agent as unknown as AgentLike
    const currentTurn = payload.turn
    const previous = states.get(agent)

    const state: RecoveryState =
      previous?.turn === currentTurn
        ? previous
        : { turn: currentTurn, emptyFailures: 0, compactions: 0 }

    state.emptyFailures += 1
    states.set(agent, state)

    // First let the normal retry policy get another shot. This is important
    // because dsh-llm-retry may already have exhausted adapter-level retries
    // before this hook is reached.
    if (state.emptyFailures <= config.maxEmptyRetriesBeforeCompact) {
      return { kind: 'retry' as const }
    }

    if (state.compactions >= config.maxCompactionsPerTurn) {
      return next()
    }

    if (payload.signal.aborted) return next()

    const beforeGeneration = agent.session.surface.replaceGeneration

    try {
      // We are inside agent/request-error, so the turn has closed its failed
      // step but the agent driver is still active. compactNow() is deliberately
      // an idle-maintenance API and would race with the live driver. The public
      // recovery seam for this exact phase is compactIfNeeded(...,
      // 'context-overflow', ...), whose overflow policy may compact even below
      // the normal pressure threshold.
      const result = await ctx.compaction.compactIfNeeded(
        {
          session: agent.session as any,
          options: {
            provider: agent.options?.provider,
            model: agent.options?.model,
          },
        },
        'context-overflow',
        payload.signal,
      )

      state.compactions += 1

      const afterGeneration = agent.session.surface.replaceGeneration

      if (result !== null || afterGeneration > beforeGeneration) {
        // The retry is reconstructed by DSH from the durable, compacted
        // session surface. Do not resend or mutate the frozen request here.
        state.emptyFailures = 0
        return { kind: 'retry' as const }
      }
    } catch (error) {
      // Preserve the original provider failure if compaction cannot safely
      // advance the durable surface. The compaction backend records its own
      // failure bracket, so this does not corrupt session history.
      console.warn(
        `[${name}] compaction recovery failed:`,
        error instanceof Error ? error.message : error,
      )
    }

    return next()
  })

  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const state = states.get(agent)
    if (state?.turn === turn) states.delete(agent)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    states.delete(agent)
  })
}

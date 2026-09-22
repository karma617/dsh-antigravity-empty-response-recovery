import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, EMPTY_RESPONSE } from '../dist/index.js'

function baseConfig(overrides = {}) {
  return {
    enabled: true,
    interceptAllProviders: true,
    targetModels: ['gemini-3.8-flash', 'gemini-3.8-flash-tiered'],
    providers: ['gemini', 'recovery'],
    retryWithNudge: true,
    nudgePrompt: 'Please continue.',
    enableToolChoiceNone: true,
    syntheticFallback: true,
    syntheticResponse: '[Recovery] Response recovered',
    logLevel: 'silent',
    logFilePath: '',
    ...overrides,
  }
}

async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function setupContext(configOverrides = {}) {
  const listeners = new Map()
  let downstreamMock = null

  const ctx = {
    llm: {
      registerAdapter() {},
      stream(options) {
        if (downstreamMock) return downstreamMock(options)
        throw new Error('downstreamMock not configured')
      },
    },
    compaction: {
      async compactIfNeeded() { return { compacted: true } },
    },
    on(event, handler) {
      listeners.set(event, handler)
    },
  }

  apply(ctx, baseConfig(configOverrides))
  const streamHook = listeners.get('llm/stream')
  return { ctx, listeners, streamHook, setDownstream: fn => { downstreamMock = fn } }
}

test('normal response passes through llm/stream unmodified', async () => {
  const { streamHook } = setupContext()
  assert.ok(streamHook, 'llm/stream hook should be registered')

  const normalChunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Hello, world!' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello, world!' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]

  const next = () => (async function* () {
    for (const c of normalChunks) yield c
  })()

  const options = { provider: 'gemini', model: 'gemini-3.8-flash', messages: [] }
  const result = await collect(streamHook(options, next))

  assert.equal(result.length, normalChunks.length)
  assert.equal(result.find(c => c.type === 'text-delta').text, 'Hello, world!')
  assert.equal(result.find(c => c.type === 'finish').reason.kind, 'stop')
})

test('empty response with stop triggers nudge retry and succeeds', async () => {
  const { streamHook, setDownstream } = setupContext()

  // First call returns empty response (only reasoning or empty stop)
  const emptyChunks = [
    { type: 'reasoning-delta', index: 0, text: 'thinking deeply...' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const next = () => (async function* () {
    for (const c of emptyChunks) yield c
  })()

  // Retried call via ctx.llm.stream returns real content
  let retryCalledWith = null
  setDownstream(options => {
    retryCalledWith = options
    return (async function* () {
      yield { type: 'text-delta', index: 0, text: 'Here is the answer after nudge.' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  })

  const options = { provider: 'gemini', model: 'gemini-3.8-flash-tiered', messages: [{ role: 'user', content: [{ type: 'text', text: 'do something' }] }] }
  const result = await collect(streamHook(options, next))

  assert.ok(retryCalledWith, 'ctx.llm.stream should have been called for retry')
  assert.equal(retryCalledWith.__agRecoveryRetrying, true)
  assert.equal(retryCalledWith.messages.at(-1).content[0].text, 'Please continue.')
  assert.equal(result.find(c => c.type === 'text-delta').text, 'Here is the answer after nudge.')
})

test('empty response triggers no-tools retry if nudge retry fails', async () => {
  const { streamHook, setDownstream } = setupContext()

  const emptyChunks = [
    { type: 'finish', reason: { kind: 'error', failure: { code: EMPTY_RESPONSE, message: 'model returned a completed response with no content' } } },
  ]
  const next = () => (async function* () {
    for (const c of emptyChunks) yield c
  })()

  let attempts = 0
  setDownstream(options => {
    attempts++
    if (attempts === 1) {
      // Step 1: Nudge retry also fails
      return (async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    }
    // Step 2: No-tools retry succeeds
    return (async function* () {
      yield { type: 'text-delta', index: 0, text: 'Direct answer without tools.' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  })

  const options = {
    provider: 'gemini',
    model: 'gemini-3.8-flash-tiered',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
    tools: [{ name: 'tool1', description: 'desc', parameters: {} }],
  }
  const result = await collect(streamHook(options, next))

  assert.equal(attempts, 2, 'Should attempt nudge retry then no-tools retry')
  assert.equal(result.find(c => c.type === 'text-delta').text, 'Direct answer without tools.')
})

test('exhausted retries emit synthetic fallback to prevent crash', async () => {
  const { streamHook, setDownstream } = setupContext()

  const emptyChunks = [
    { type: 'finish', reason: { kind: 'error', failure: { code: EMPTY_RESPONSE, message: 'model returned a completed response with no content' } } },
  ]
  const next = () => (async function* () {
    for (const c of emptyChunks) yield c
  })()

  // All downstream attempts return empty
  setDownstream(() => (async function* () {
    yield { type: 'finish', reason: { kind: 'stop' } }
  })())

  const options = {
    provider: 'gemini',
    model: 'gemini-3.8-flash-tiered',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
  }
  const result = await collect(streamHook(options, next))

  assert.ok(result.some(c => c.type === 'text-delta' && c.text === '[Recovery] Response recovered'))
  assert.equal(result.at(-1).reason.kind, 'stop')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, COMPACTION_REQUIRED, EMPTY_RESPONSE } from '../dist/index.js'

const config = (overrides = {}) => ({
  enabled: true, providers: ['recovery'], upstreamBaseUrl: 'http://mock/v1', apiKey: '', timeoutMs: 1000,
  retryOriginal: 1, enableToolChoiceNone: true, compactAfterToolChoiceNone: true, postCompactionRetry: 1,
  syntheticFallback: true, syntheticResponse: 'recovery fallback', targetModels: ['gemini-3.8-flash'],
  registerStandaloneAdapter: true,
  logLevel: 'silent', includeRequestBodyInDebugLog: false, ...overrides,
})

function sse(events) { return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n' }
function response(events, status = 200) { return new Response(sse(events), { status, headers: { 'content-type': 'text/event-stream' } }) }
function empty() { return [{ choices: [{ delta: {}, finish_reason: 'stop' }] }] }
function text(value = 'ok') { return [{ choices: [{ delta: { content: value }, finish_reason: 'stop' }] }] }
async function collect(stream) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks }

function setup(overrides = {}) {
  let adapter
  const listeners = new Map()
  const ctx = {
    llm: { registerAdapter(_providers, value) { adapter = value } },
    compaction: { async compactIfNeeded() { return { compacted: true } } },
    on(event, handler) { listeners.set(event, handler) },
  }
  apply(ctx, config(overrides))
  return { adapter, listeners, ctx }
}

function options(overrides = {}) {
  return { provider: 'recovery', model: 'gemini-3.8-flash', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], ...overrides }
}

test('normal text succeeds on the first request', async () => {
  const { adapter } = setup()
  let calls = 0
  globalThis.fetch = async () => { calls++; return response(text()) }
  const chunks = await collect(adapter.stream(options()))
  assert.equal(calls, 1)
  assert.equal(chunks.find(chunk => chunk.type === 'text-delta').text, 'ok')
})

test('empty response retries the original request', async () => {
  const { adapter } = setup()
  const bodies = []
  globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); return response(bodies.length === 1 ? empty() : text('retried')) }
  const chunks = await collect(adapter.stream(options()))
  assert.equal(bodies.length, 2)
  assert.equal(bodies.every(body => body.tool_choice === undefined), true)
  assert.equal(chunks.find(chunk => chunk.type === 'text-delta').text, 'retried')
})

test('tool_choice none follows exhausted original retries', async () => {
  const { adapter } = setup()
  const bodies = []
  globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); return response(bodies.length < 3 ? empty() : text('no tools')) }
  const chunks = await collect(adapter.stream(options({ tools: [{ name: 'read', description: 'read', parameters: {} }] })))
  assert.equal(bodies.length, 3)
  assert.equal(bodies[2].tool_choice, 'none')
  assert.equal(chunks.find(chunk => chunk.type === 'text-delta').text, 'no tools')
})

test('SSE tool calls retain fragmented arguments and tool-calls finish', async () => {
  const { adapter } = setup()
  globalThis.fetch = async () => response([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read', arguments: '{\"path\":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '\"x\"}' } }] }, finish_reason: 'tool_calls' }] },
  ])
  const chunks = await collect(adapter.stream(options({ tools: [{ name: 'read', description: 'read', parameters: {} }] })))
  const end = chunks.find(chunk => chunk.type === 'block-end')
  assert.deepEqual(end.block, { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{\"path\":\"x\"}' })
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
})

test('SSE reasoning and usage are forwarded', async () => {
  const { adapter } = setup()
  globalThis.fetch = async () => response([{ choices: [{ delta: { reasoning_content: 'think', content: 'answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }])
  const chunks = await collect(adapter.stream(options()))
  assert.equal(chunks.find(chunk => chunk.type === 'reasoning-delta').text, 'think')
  assert.deepEqual(chunks.find(chunk => chunk.type === 'usage').usage, { inputTokens: 3, outputTokens: 2, totalTokens: 5 })
})

test('HTTP 429 and 5xx errors propagate without empty-response retry', async () => {
  for (const status of [429, 503]) {
    const { adapter } = setup()
    let calls = 0
    globalThis.fetch = async () => { calls++; return response([{ error: 'provider failure' }], status) }
    await assert.rejects(collect(adapter.stream(options())), error => error.code === 'PROVIDER_HTTP_ERROR')
    assert.equal(calls, 1)
  }
})

test('an already aborted request exits without fetching', async () => {
  const { adapter } = setup()
  const controller = new AbortController(); controller.abort()
  globalThis.fetch = async () => { throw new Error('fetch must not run') }
  await assert.rejects(collect(adapter.stream(options({ signal: controller.signal }))), error => error.code === 'ABORTED')
})

test('malformed SSE reaches the compaction-required terminal signal', async () => {
  const { adapter } = setup({ retryOriginal: 0, enableToolChoiceNone: false })
  globalThis.fetch = async () => new Response('data: not-json\n\ndata: [DONE]\n\n', { status: 200 })
  await assert.rejects(collect(adapter.stream(options())), error => error.code === COMPACTION_REQUIRED)
})

test('compaction with no durable progress does not retry', async () => {
  const { listeners, ctx } = setup()
  ctx.compaction.compactIfNeeded = async () => null
  const agent = { id: 'session-no-progress', session: { id: 'session-no-progress', surface: { replaceGeneration: 1 } }, options: {} }
  const result = await listeners.get('agent/request-error')({ failure: { code: COMPACTION_REQUIRED }, signal: new AbortController().signal, agent, turn: 1 }, () => ({ kind: 'next' }))
  assert.equal(result.kind, 'next')
})

test('compaction failure does not retry', async () => {
  const { listeners, ctx } = setup()
  ctx.compaction.compactIfNeeded = async () => { throw new Error('compaction failed') }
  const agent = { id: 'session-failure', session: { id: 'session-failure', surface: { replaceGeneration: 1 } }, options: {} }
  const result = await listeners.get('agent/request-error')({ failure: { code: COMPACTION_REQUIRED }, signal: new AbortController().signal, agent, turn: 1 }, () => ({ kind: 'next' }))
  assert.equal(result.kind, 'next')
})

test('post-compaction retry consumes the synthetic flag once', async () => {
  const { adapter, listeners } = setup({ retryOriginal: 0, enableToolChoiceNone: false })
  const agent = { id: 'session-1', session: { id: 'session-1', surface: { replaceGeneration: 1 } }, options: { provider: 'recovery', model: 'gemini-3.8-flash' } }
  const handler = listeners.get('agent/request-error')
  const first = await handler({ failure: { code: COMPACTION_REQUIRED }, signal: new AbortController().signal, agent, turn: 1 }, () => ({ kind: 'next' }))
  assert.equal(first.kind, 'retry')
  const second = await handler({ failure: { code: COMPACTION_REQUIRED }, signal: new AbortController().signal, agent, turn: 1 }, () => ({ kind: 'next' }))
  assert.equal(second.kind, 'retry')
  globalThis.fetch = async () => { throw new Error('synthetic retry must not call upstream') }
  const chunks = await collect(adapter.stream(options({ sessionId: 'session-1' })))
  assert.equal(chunks.find(chunk => chunk.type === 'text-delta').text, 'recovery fallback')
  assert.equal(agent.__agRecoverySynthetic, undefined)
})

test('post-compaction retry becomes EMPTY_RESPONSE when fallback is disabled', async () => {
  const { adapter, listeners } = setup({ retryOriginal: 0, enableToolChoiceNone: false, syntheticFallback: false })
  const agent = { id: 'session-2', session: { id: 'session-2', surface: { replaceGeneration: 1 } }, options: { provider: 'recovery', model: 'gemini-3.8-flash' } }
  const handler = listeners.get('agent/request-error')
  await handler({ failure: { code: COMPACTION_REQUIRED }, signal: new AbortController().signal, agent, turn: 1 }, () => ({ kind: 'next' }))
  const failure = { code: COMPACTION_REQUIRED, message: COMPACTION_REQUIRED }
  const result = await handler({ failure, signal: new AbortController().signal, agent, turn: 1 }, () => ({ kind: 'next' }))
  assert.equal(result.kind, 'next')
  assert.equal(failure.code, EMPTY_RESPONSE)
  await assert.rejects(collect(adapter.stream(options({ sessionId: 'session-2', __agRecoverySynthetic: true }))), error => error.code === EMPTY_RESPONSE)
})

import test from 'node:test'
import assert from 'node:assert/strict'

async function collect(iterable) {
  const out = []
  for await (const x of iterable) out.push(x)
  return out
}

function wrapStream(upstream) {
  return (async function* () {
    let hasContent = false
    let terminal
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
    if (terminal?.type === 'finish' && terminal.reason.kind === 'stop' && !hasContent) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: 'EMPTY_RESPONSE',
            message: 'DSH recovery: provider returned a completed response with no content'
          }
        }
      }
      return
    }
    if (terminal) yield terminal
  })()
}

test('converts empty stop to EMPTY_RESPONSE', async () => {
  const result = await collect(wrapStream([
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 0 } },
    { type: 'finish', reason: { kind: 'stop' } }
  ]))
  assert.equal(result.at(-1).reason.kind, 'error')
  assert.equal(result.at(-1).reason.failure.code, 'EMPTY_RESPONSE')
})

test('does not touch normal text', async () => {
  const result = await collect(wrapStream([
    { type: 'text-delta', index: 0, text: 'hello' },
    { type: 'finish', reason: { kind: 'stop' } }
  ]))
  assert.equal(result.at(-1).reason.kind, 'stop')
})

test('does not touch tool calls', async () => {
  const result = await collect(wrapStream([
    { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'foo', argumentsDelta: '{}' },
    { type: 'finish', reason: { kind: 'tool-calls' } }
  ]))
  assert.equal(result.at(-1).reason.kind, 'tool-calls')
})

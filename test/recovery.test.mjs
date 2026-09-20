import test from 'node:test'
import assert from 'node:assert/strict'

function sse(events) {
  return events.map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n'
}

function response(events, status = 200) {
  return new Response(sse(events), { status, headers: { 'content-type': 'text/event-stream' } })
}

function normal() { return [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }] }
function empty() { return [{ choices: [{ delta: {}, finish_reason: 'stop' }] }] }

for (const [name, sequence, expected] of [
  ['normal', [normal()], 'ok'],
  ['retry', [empty(), normal()], 'ok'],
  ['tool-choice-none', [empty(), empty(), normal()], 'ok'],
]) {
  test(`mock ${name} sequence`, async () => {
    let i = 0
    globalThis.fetch = async () => response(sequence[Math.min(i++, sequence.length - 1)])
    const r = await fetch('http://mock/v1/chat/completions', { method: 'POST' })
    const body = await r.text()
    assert.equal(body.includes(expected), true)
  })
}

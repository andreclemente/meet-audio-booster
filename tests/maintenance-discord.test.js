import test from 'node:test'
import assert from 'node:assert/strict'
import notify from '../scripts/maintenance-discord.cjs'

const webhookUrl = 'https://discord.com/api/webhooks/123/offline-placeholder'
const issueUrl = 'https://example.test/issues/7'
const thread = '1559885826564034561'
function fixture(response = { ok: true, json: async () => ({ id: '987', channel_id: thread }) }) {
  const calls = []
  return { calls, fetchImpl: async (...args) => { calls.push(args); return response } }
}
test('no new incident does not contact Discord', async () => {
  const f = fixture()
  assert.equal(await notify({ ...f, webhookUrl }), null)
  assert.deepEqual(f.calls, [])
})
test('unconfigured webhook leaves issue functional without network', async () => {
  const f = fixture()
  assert.equal(await notify({ ...f, issueUrl }), null)
  assert.deepEqual(f.calls, [])
})
for (const url of ['invalid', 'http://discord.com/api/webhooks/123/token',
  'https://evil.test/api/webhooks/123/token', 'https://discord.com/not-webhooks',
  'https://discord.com/api/webhooks/', 'https://discord.com/api/webhooks/123/token/extra',
  'https://user:pass@discord.com/api/webhooks/123/token']) {
  test(`rejects invalid webhook without network: ${url}`, async () => {
    const f = fixture()
    await assert.rejects(notify({ ...f, issueUrl, webhookUrl: url }), /Invalid Discord webhook/)
    assert.deepEqual(f.calls, [])
  })
}
test('configured delivery forces intended thread, confirms ID and disables all mentions', async () => {
  const f = fixture()
  assert.equal(await notify({ ...f, issueUrl, webhookUrl: `${webhookUrl}?thread_id=wrong&wait=false` }), '987')
  const [url, options] = f.calls[0]
  assert.equal(url.searchParams.get('thread_id'), thread)
  assert.equal(url.searchParams.get('wait'), 'true')
  assert.equal(options.method, 'POST')
  assert.equal(options.redirect, 'error')
  assert.ok(options.signal instanceof AbortSignal)
  const body = JSON.parse(options.body)
  assert.deepEqual(body.allowed_mentions, { parse: [] })
  assert.ok(body.content.includes(issueUrl))
})
test('non-OK response fails visibly', async () => {
  const f = fixture({ ok: false, status: 403 })
  await assert.rejects(notify({ ...f, issueUrl, webhookUrl }), /HTTP 403/)
})
for (const message of [{ id: '987', channel_id: 'wrong' }, { channel_id: thread }, { id: '', channel_id: thread }]) {
  test(`rejects unconfirmed message: ${JSON.stringify(message)}`, async () => {
    const f = fixture({ ok: true, json: async () => message })
    await assert.rejects(notify({ ...f, issueUrl, webhookUrl }), /did not confirm/)
  })
}
test('network failure propagates', async () => {
  await assert.rejects(notify({ issueUrl, webhookUrl, fetchImpl: async () => { throw new Error('offline') } }), /offline/)
})

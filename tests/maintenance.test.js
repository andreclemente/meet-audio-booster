import test from 'node:test'
import assert from 'node:assert/strict'
import reconcile from '../scripts/maintenance.cjs'

const marker = '<!-- mab-maintenance:v1 -->'
function fixture(existing = [], overrides = {}) {
  const calls = []
  const stored = new Map(existing.map(issue => [issue.number, issue]))
  const issues = {
    listForRepo() {},
    create: async args => {
      calls.push(['create', args])
      const data = { ...args, number: 7, state: 'open', html_url: 'https://example.test/issues/7' }
      stored.set(7, data)
      return { data }
    },
    update: async args => {
      calls.push(['update', args])
      stored.set(args.issue_number, { ...stored.get(args.issue_number), ...args })
    },
    get: async args => {
      calls.push(['get', args])
      return { data: stored.get(args.issue_number) }
    },
    ...overrides
  }
  const github = { paginate: async () => existing, rest: { issues } }
  const context = { repo: { owner: 'owner', repo: 'repo' } }
  return { calls, run: status => reconcile({ github, context, status,
    runUrl: 'https://example.test/runs/1' }) }
}
const incident = { number: 7, state: 'open', body: marker }

test('healthy without incident is silent', async () => {
  const f = fixture()
  assert.equal(await f.run('success'), null)
  assert.deepEqual(f.calls, [])
})
test('first failure creates an incident and reads exact issue before returning notification URL', async () => {
  const f = fixture()
  assert.equal(await f.run('failure'), 'https://example.test/issues/7')
  assert.deepEqual(f.calls.map(call => call[0]), ['create', 'get'])
  assert.equal(f.calls[1][1].issue_number, 7)
  assert.match(f.calls[0][1].body, /mab-maintenance:v1/)
  assert.match(f.calls[0][1].body, /https:\/\/example.test\/runs\/1/)
  assert.equal(f.calls[0][1].state, undefined)
})
test('repeated failure is silent', async () => {
  const f = fixture([incident])
  assert.equal(await f.run('failure'), null)
  assert.deepEqual(f.calls, [])
})
test('recovery closes and verifies exact issue with evidence', async () => {
  const f = fixture([incident])
  assert.equal(await f.run('success'), null)
  assert.deepEqual(f.calls.map(call => call[0]), ['update', 'get'])
  assert.equal(f.calls[0][1].issue_number, 7)
  assert.equal(f.calls[0][1].state, 'closed')
  assert.equal(f.calls[0][1].state_reason, 'completed')
  assert.match(f.calls[0][1].body, /Recovered: https:\/\/example.test\/runs\/1/)
})
test('pull requests and unrelated issues are not incidents', async () => {
  const f = fixture([{ ...incident, pull_request: {} }, { number: 8, body: 'other' }])
  await f.run('failure')
  assert.equal(f.calls[0][0], 'create')
})
test('unknown result does not falsely resolve incident', async () => {
  const f = fixture([incident])
  await assert.rejects(f.run('cancelled'), /Unsupported/)
  assert.deepEqual(f.calls, [])
})
test('API failure propagates', async () => {
  const f = fixture([], { create: async () => { throw new Error('API unavailable') } })
  await assert.rejects(f.run('failure'), /API unavailable/)
})
test('failed read-back prevents notification', async () => {
  const f = fixture([], { get: async () => { throw new Error('read unavailable') } })
  await assert.rejects(f.run('failure'), /read unavailable/)
})
for (const data of [undefined, { number: 8, state: 'open', body: marker },
  { number: 7, state: 'closed', body: marker }, { number: 7, state: 'open', body: 'other' },
  { number: 7, state: 'open', body: marker, html_url: 'https://example.test/wrong' }]) {
  test(`unconfirmed creation is not reported: ${JSON.stringify(data)}`, async () => {
    const f = fixture([], { get: async () => ({ data }) })
    await assert.rejects(f.run('failure'), /not confirmed/)
  })
}
test('unconfirmed recovery fails visibly', async () => {
  const f = fixture([incident], { get: async () => ({ data: incident }) })
  await assert.rejects(f.run('success'), /not confirmed/)
})

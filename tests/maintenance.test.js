import test from 'node:test'
import assert from 'node:assert/strict'
import reconcile from '../scripts/maintenance.cjs'

const marker = '<!-- mab-maintenance:v1 -->'
function fixture(existing = [], overrides = {}) {
  const calls = []
  const queries = []
  const stored = new Map(existing.map(issue => [issue.number, issue]))
  let nextNumber = 7
  const issues = {
    listForRepo() {},
    create: async args => {
      calls.push(['create', args])
      const number = nextNumber++
      const data = { ...args, number, state: 'open', html_url: `https://example.test/issues/${number}` }
      stored.set(number, data)
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
  const github = {
    paginate: async (method, args) => {
      assert.equal(method, issues.listForRepo)
      queries.push(args)
      return [...stored.values()].filter(issue => issue.state !== 'closed')
    },
    rest: { issues }
  }
  const context = { repo: { owner: 'owner', repo: 'repo' } }
  return { calls, queries, stored, run: status => reconcile({ github, context, status,
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
for (const mismatch of [null, { number: 8 }, { state: 'closed' },
  { body: 'other' }, { html_url: 'https://example.test/wrong' }, { html_url: '' }]) {
  test(`unconfirmed creation is not reported: ${JSON.stringify(mismatch)}`, async () => {
    const f = fixture([], { get: async () => ({ data: mismatch === null ? undefined : {
      ...f.stored.get(7), ...mismatch
    } }) })
    await assert.rejects(f.run('failure'), /not confirmed/)
  })
}
test('unconfirmed recovery fails visibly', async () => {
  const f = fixture([incident], { get: async () => ({ data: incident }) })
  await assert.rejects(f.run('success'), /not confirmed/)
})

test('queries only open bot-owned issues with repository scope and pagination', async () => {
  const f = fixture()
  await f.run('success')
  assert.equal(f.queries.length, 1)
  assert.deepEqual(f.queries[0], {
    owner: 'owner', repo: 'repo', state: 'open',
    creator: 'github-actions[bot]', per_page: 100
  })
})

test('full lifecycle creates once, repeats silently, recovers once and handles recurrence', async () => {
  const f = fixture()
  const notifications = []
  for (const status of ['success', 'failure', 'failure', 'success', 'success', 'failure']) {
    const url = await f.run(status)
    if (url) notifications.push(url)
  }
  assert.deepEqual(notifications, [
    'https://example.test/issues/7', 'https://example.test/issues/8'
  ])
  assert.deepEqual(f.calls.map(call => call[0]), ['create', 'get', 'update', 'get', 'create', 'get'])
  assert.equal(f.stored.get(7).state, 'closed')
  assert.equal(f.stored.get(8).state, 'open')
})

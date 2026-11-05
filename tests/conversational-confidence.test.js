import test from 'node:test'
import assert from 'node:assert/strict'
import { createParticipantLevelMeter } from '../src/platforms/google-meet/levels.js'
import { createAutoBalance } from '../src/ui/auto-balance.js'

function fixture(step = 100) {
  const people = ['A', 'B'].map(key => ({ key, value: 1 }))
  const meter = createParticipantLevelMeter({ settleMs: 0 })
  const writes = []
  let now = 0
  const auto = createAutoBalance({ participants: () => people, levels: (key, options) => meter.levelFor(key, options),
    onGain(person, value) { writes.push({ at: now, key: person.key, value }); person.value = value } })
  auto.start(0)
  function run(key, duration, db) {
    for (let elapsed = 0; elapsed < duration; elapsed += step) {
      now += step
      const value = typeof db === 'function' ? db(elapsed) : db
      const accepted = meter.tick({ now, participantKeys: people.map(p => p.key), attributedKey: key,
        readPower: () => 10 ** (value / 10) })
      auto.tick(now, accepted ? key : null)
    }
  }
  return { meter, auto, writes, people, run, get now() { return now } }
}

// Voices sit at the fixed -20 dB Auto target unless a test moves them away.
test('minority quiet expression does not veto confident voices at the fixed level', () => {
  const f = fixture()
  for (const key of ['A', 'B']) f.run(key, 12000, t => t >= 4000 && t < 6000 ? -32 : -20)
  assert.equal(f.auto.targetDb, -20)
  for (const key of ['A', 'B']) assert.ok(Math.abs(f.meter.levelFor(key).autoDb + 20) < 1e-6, 'quiet expression is a minority outlier')
  assert.deepEqual(f.writes, [])
})

test('isolated samples separated by unobserved gaps cannot be speech portions', () => {
  const f = fixture(400)
  f.run('A', 28000, -30)
  const level = f.meter.levelFor('A')
  assert.equal(level.autoDb, null)
  assert.equal(level.autoPortions, 0)
})

test('a short reversal does not act; a sustained shift eventually does', () => {
  const f = fixture(120)
  f.run('A', 12000, -20); f.run('B', 12000, -20)
  assert.equal(f.auto.targetDb, -20)
  f.run('B', 1800, -33); f.run('B', 6000, -20)
  assert.deepEqual(f.writes, [])
  const changedAt = f.now
  f.run('B', 24000, -33)
  const write = f.writes.find(w => w.key === 'B')
  assert.ok(write, 'persistent quiet speech eventually adjusts')
  assert.ok(write.at - changedAt >= 3000, 'not a short-dynamics detector')
  assert.ok(write.at - changedAt <= 20000, 'bounded sustained-change response')
})

test('balanced periodic loud and quiet passages do not establish stationary confidence', () => {
  const f = fixture()
  f.run('A', 12000, -20)
  f.run('B', 24000, t => Math.floor(t / 2000) % 2 ? -30 : -10)
  assert.equal(f.auto.targetDb, -20)
  assert.equal(f.meter.levelFor('B').autoDb, null)
  assert.deepEqual(f.writes, [])
})

test('brief periodic dynamics across phases and passage lengths never trigger gain writes', () => {
  for (const cadence of [50, 100, 120, 200, 300]) for (const passageMs of [500, 1500, 2000, 3000]) {
    for (const phase of [0, 370, 910]) {
      const f = fixture(cadence)
      f.run('A', 16000, -20); f.run('B', 16000, -20)
      assert.equal(f.auto.targetDb, -20)
      f.run('B', 40000, t => Math.floor((t + phase) / passageMs) % 2 ? -30 : -10)
      assert.deepEqual(f.writes, [], JSON.stringify({ cadence, passageMs, phase }))
    }
  }
})

test('fresh confidence loss cancels accumulated policy qualification instead of adding ready islands', () => {
  const people = ['A', 'B'].map(key => ({ key, value: 1 }))
  let now = 0, db = -20
  const writes = []
  const auto = createAutoBalance({ participants: () => people,
    levels: () => ({ autoDb: db, autoFrames: 80, autoSupportMs: 6000, autoInlierFrames: 24,
      autoInlierPortions: 3, autoLatestAgrees: true, autoSpread: 0, autoSince: 0, sampledAt: now }),
    onGain: (person, value) => { writes.push(value); person.value = value } })
  auto.start(0)
  now = 1000; auto.tick(now, 'A')
  now = 1100; auto.tick(now, 'B')
  assert.equal(auto.targetDb, -20)
  for (let island = 0; island < 4; island++) {
    db = -32
    for (let i = 0; i < 20; i++) { now += 100; auto.tick(now, 'B') }
    db = null; now += 100; auto.tick(now, 'B')
  }
  assert.deepEqual(writes, [], 'disjoint sub-three-second confidence islands are not sustained evidence')
  db = -32
  for (let i = 0; i < 30; i++) { now += 100; auto.tick(now, 'B') }
  assert.equal(writes.length, 1, 'continuous qualifying speech still starts correction at the existing threshold')
})

test('irregular accepted cadence counts observed support, not nominal timer ticks', () => {
  const meter = createParticipantLevelMeter({ settleMs: 0 })
  let now = 0
  for (let i = 0; i < 100; i++) {
    now += [100, 120, 200, 300][i % 4]
    meter.tick({ now, participantKeys: ['x'], attributedKey: 'x', readPower: () => 10 ** -3 })
  }
  const level = meter.levelFor('x')
  assert.equal(level.autoDb, -30)
  assert.ok(level.autoSupportMs > 10000)
  assert.ok(level.autoInlierFrames >= 60)
})

test('subsecond speaking turns retain independent speech support without bridging gaps', () => {
  const f = fixture()
  for (let i = 0; i < 10; i++) {
    f.run('A', 800, -20); f.run(null, 200, -70)
    f.run('B', 800, -20); f.run(null, 200, -70)
  }
  assert.equal(f.auto.targetDb, -20)
  for (const key of ['A', 'B']) {
    const level = f.meter.levelFor(key)
    assert.ok(level.autoPortions >= 8)
    assert.ok(level.autoSupportMs >= 4000)
  }
  assert.deepEqual(f.writes, [])
})

test('a sustained change never acts on the stale level while new portions are still outliers', () => {
  const meter = createParticipantLevelMeter({ settleMs: 0 })
  let now = 0
  const add = (count, db) => { for (let i = 0; i < count; i++) { now += 100; meter.tick({ now, participantKeys: ['x'], attributedKey: 'x', readPower: () => 10 ** (db / 10) }) } }
  add(100, -30)
  assert.equal(meter.levelFor('x').autoDb, -30)
  assert.equal(meter.levelFor('x').autoLatestAgrees, true)
  let staleAndActionable = 0
  for (let i = 0; i < 120; i++) {
    add(1, -20)
    const level = meter.levelFor('x')
    if (level.autoDb !== null && Math.abs(level.autoDb + 30) < 1 && level.autoLatestAgrees) staleAndActionable++
  }
  // Only the frames before the first complete -20 dB portion may still look
  // like a valid -30 dB level.
  assert.ok(staleAndActionable <= 20, String(staleAndActionable))
  assert.ok(Math.abs(meter.levelFor('x').autoDb + 20) < 0.5, 'the new level takes over')
})

test('enabling Auto mid-call uses only fresh evidence but does not wait for old evidence to expire', () => {
  const f = fixture()
  f.auto.stop()
  f.run('A', 30000, -20); f.run('B', 30000, -20)
  f.auto.start(f.now)
  f.run('A', 8000, -20); f.run('B', 8000, -20)
  assert.equal(f.auto.targetDb, -20, 'eight seconds of fresh speech each is enough')
  assert.deepEqual(f.writes, [])
  const g = fixture(); g.auto.stop()
  g.run('A', 30000, -20); g.run('B', 30000, -32)
  g.auto.start(g.now)
  g.run('A', 8000, -20)
  assert.equal(g.auto.targetDb, -20)
  g.run('B', 5000, -32)
  assert.deepEqual(g.writes, [], 'pre-enable evidence for B is not used')
  g.run('B', 8000, -32)
  assert.ok(g.writes.some(w => w.key === 'B' && w.value > 1), 'fresh evidence alone then corrects B')
})

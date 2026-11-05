import test from 'node:test'
import assert from 'node:assert/strict'
import { createNativeActivitySource, findActivityGetterName, isSpeakingLevel } from '../src/platforms/google-meet/native-activity.js'
import { createGoogleMeetController } from '../src/platforms/google-meet/index.js'

// Two "builds" with different minified names but the same structure, mirroring
// what was observed when Meet shipped a new build mid-session.
class BuildOneModel {
  constructor(participantId, mediaId, level) { this.Xa = { getId: () => mediaId, Yc: () => participantId, Yec: () => level.value, Kz: () => 0 }; this.disposed = false }
  isDisposed() { return this.disposed }
  getId(){return this.Xa.getId()}
  Yc(){return this.Xa.Yc()}
  Kz(){return this.Xa.Kz()}
  oa(){return this.Xa.Yec()}
}
class BuildOneRing { constructor(holder) { this.di = holder; this.element = {} }
  async Cbc(){var a=Math.round(this.di.Aa.oa()*5);this.element.Ga=a>0} }

class BuildTwoModel {
  constructor(participantId, mediaId, level) { this.Ya = { getId: () => mediaId, Zc: () => participantId, Gec: () => level.value, Kz: () => 0 }; this.disposed = false }
  isDisposed() { return this.disposed }
  getId(){return this.Ya.getId()}
  Zc(){return this.Ya.Zc()}
  Kz(){return this.Ya.Kz()}
  qa(){return this.Ya.Gec()}
}
class BuildTwoRing { constructor(holder) { this.Sh = holder; this.element = {} }
  async pbc(){var a=Math.round(this.Sh.Ba.qa()*5),b=this.oa;this.element.Ga=a>0} }

function nativeRoot(participantId, { build = 1, level = { value: 0 }, extraModels = [] } = {}) {
  const Model = build === 1 ? BuildOneModel : BuildTwoModel
  const Ring = build === 1 ? BuildOneRing : BuildTwoRing
  const model = new Model(participantId, `media-${participantId}`, level)
  const holder = build === 1 ? { Aa: model } : { Ba: model }
  const ringElement = { getAttribute: () => 'ring', __jscontroller: { pending: { value: new Ring(holder) } } }
  const root = {
    isConnected: true,
    getAttribute: name => name === 'data-participant-id' ? participantId : null,
    __jsmodel: { A0Tiaf: { pending: { value: { wy: model, extra: extraModels } } } },
    querySelectorAll: () => [ringElement],
    querySelector: () => null,
    matches: () => false
  }
  return { root, model, level }
}

function documentWith(...roots) {
  return { hidden: false, querySelectorAll: selector => selector === '[data-participant-id]' ? roots : [] }
}

function participant(key, participantId, element, value = 1) {
  return { key, participantId, element, name: key, platform: 'google-meet', present: true, speaking: false, lastSpeakingAt: 0, value, muted: false }
}

test('activity getter is located from Meet\'s ring renderer in both observed builds', () => {
  assert.equal(findActivityGetterName(nativeRoot('p1', { build: 1 }).root), 'oa')
  assert.equal(findActivityGetterName(nativeRoot('p1', { build: 2 }).root), 'qa')
})

test('ring threshold matches Meet: Math.round(level * 5) > 0', () => {
  assert.equal(isSpeakingLevel(0), false)
  assert.equal(isSpeakingLevel(0.09), false)
  assert.equal(isSpeakingLevel(0.2), true)
  assert.equal(isSpeakingLevel(NaN), false)
})

for (const build of [1, 2]) {
  test(`build ${build}: models are accepted only when a getter returns the exact participant id`, () => {
    const a = nativeRoot('device-a', { build, level: { value: 0.6 } })
    const b = nativeRoot('device-b', { build, level: { value: 0 } })
    const source = createNativeActivitySource()
    const alice = participant('A', 'device-a', a.root)
    const bob = participant('B', 'device-b', b.root)
    const result = source.read([alice, bob], documentWith(a.root, b.root), 0)
    assert.equal(result.available, true)
    assert.deepEqual(result.speakers.map(p => p.key), ['A'])
    assert.equal(result.levels.get('A'), 0.6)
    assert.equal(result.levels.get('B'), 0)
  })
}

test('a model whose id belongs to someone else is never attributed', () => {
  const foreign = new BuildOneModel('device-z', 'media-z', { value: 1 })
  const a = nativeRoot('device-a', { level: { value: 0 }, extraModels: [] })
  a.root.__jsmodel.A0Tiaf.pending.value.wy = foreign
  a.root.__jsmodel.A0Tiaf.pending.value.other = undefined
  const ring = a.root.querySelectorAll()[0].__jscontroller.pending.value
  ring.di = { Aa: foreign }
  const source = createNativeActivitySource()
  const result = source.read([participant('A', 'device-a', a.root)], documentWith(a.root), 0)
  assert.equal(result.available, false)
  assert.deepEqual(result.unknown, ['A'])
  assert.deepEqual(result.speakers, [])
})

test('disposed or detached sources become unknown instead of reusing stale activity', () => {
  const a = nativeRoot('device-a', { level: { value: 0.8 } })
  const source = createNativeActivitySource({ rediscoverMs: 0 })
  const alice = participant('A', 'device-a', a.root)
  assert.equal(source.read([alice], documentWith(a.root), 0).available, true)
  a.model.disposed = true
  const disposed = source.read([alice], documentWith(a.root), 10)
  assert.equal(disposed.available, false)
  assert.deepEqual(disposed.unknown, ['A'])
  a.model.disposed = false
  a.root.isConnected = false
  alice.element = a.root
  const detached = source.read([alice], documentWith(), 20)
  assert.equal(detached.available, false)
})

test('one unconfirmed participant makes the whole read unavailable', () => {
  const a = nativeRoot('device-a', { level: { value: 0.8 } })
  const bare = { isConnected: true, getAttribute: name => name === 'data-participant-id' ? 'device-b' : null, querySelectorAll: () => [] }
  const source = createNativeActivitySource()
  const result = source.read([participant('A', 'device-a', a.root), participant('B', 'device-b', bare)], documentWith(a.root, bare), 0)
  assert.equal(result.available, false)
  assert.deepEqual(result.unknown, ['B'])
})

test('strongest representation wins when Meet zeroes sibling representations', () => {
  const level = { value: 0 }
  const strong = new BuildOneModel('device-a', 'media-a-2', { value: 0.4 })
  const a = nativeRoot('device-a', { level })
  a.root.__jsmodel.A0Tiaf.pending.value.Ga = strong
  const result = createNativeActivitySource().read([participant('A', 'device-a', a.root)], documentWith(a.root), 0)
  assert.equal(result.levels.get('A'), 0.4)
  assert.deepEqual(result.speakers.map(p => p.key), ['A'])
})

function controllerFixture(roots, participants, hidden) {
  const doc = { ...documentWith(...roots), hidden }
  const writes = []
  const slot = { gain: {}, appliedMultiplier: 1, set(value) { writes.push(value); this.appliedMultiplier = value }, release() { this.appliedMultiplier = 1 } }
  const state = {
    participants: new Map(participants.map(p => [p.key, p])),
    google: {
      slots: [slot], mediaPipelines: [], mode: 'worklet', activeParticipantKey: null, appliedParticipantKey: null,
      routingState: 'idle', transitionGuard: { candidateParticipantKey: null, candidateSince: 0 },
      routing: {}, rosterSignature: '', localPresentationActive: false
    }
  }
  const controller = createGoogleMeetController({ state, context: {}, setStatus() {}, renderSoon() {}, updateLiveUi() {} })
  return { doc, state, slot, writes, controller }
}

function withClock(doc, run) {
  const originalDocument = globalThis.document
  const originalNow = Date.now
  let now = 0
  globalThis.document = doc
  Date.now = () => now
  try { return run(ms => { now = ms }) } finally { Date.now = originalNow; globalThis.document = originalDocument }
}

for (const hidden of [false, true]) {
  test(`identical routing ${hidden ? 'hidden' : 'visible'}: boost holds through quiet, hands off, and stays safe on overlap`, () => {
    const a = nativeRoot('device-a', { level: { value: 0 } })
    const b = nativeRoot('device-b', { level: { value: 0 } })
    const alice = participant('A', 'device-a', a.root, 1.5)
    const bob = participant('B', 'device-b', b.root, 0.75)
    const f = controllerFixture([a.root, b.root], [alice, bob], hidden)
    withClock(f.doc, setNow => {
      a.level.value = 0.6
      setNow(0); f.controller.route()
      setNow(60); f.controller.route()
      assert.equal(f.state.google.appliedParticipantKey, 'A')
      assert.equal(f.slot.appliedMultiplier, 1.5)

      // Quiet between words: Meet reports 0, but the confirmed speaker holds.
      a.level.value = 0
      for (const t of [90, 400, 900, 5000]) { setNow(t); f.controller.route(); assert.equal(f.slot.appliedMultiplier, 1.5) }

      // Handoff: A's boost must not leak onto B.
      b.level.value = 0.4
      setNow(5010); f.controller.route()
      assert.equal(f.slot.appliedMultiplier, 1)
      setNow(5070); f.controller.route()
      assert.equal(f.state.google.appliedParticipantKey, 'B')
      assert.equal(f.slot.appliedMultiplier, 0.75)

      // Overlap: unity immediately.
      a.level.value = 0.4
      setNow(5100); f.controller.route()
      assert.equal(f.state.google.routingState, 'ambiguous')
      assert.equal(f.slot.appliedMultiplier, 1)
    })
  })
}

test('unconfirmable speaker data neutralizes regardless of visibility', () => {
  for (const hidden of [false, true]) {
    const a = nativeRoot('device-a', { level: { value: 0.6 } })
    const alice = participant('A', 'device-a', a.root, 1.5)
    const f = controllerFixture([a.root], [alice], hidden)
    withClock(f.doc, setNow => {
      setNow(0); f.controller.route()
      setNow(60); f.controller.route()
      assert.equal(f.slot.appliedMultiplier, 1.5)
      a.model.disposed = true
      setNow(2000); f.controller.route()
      assert.equal(f.state.google.routingState, 'speaker-data-unavailable')
      assert.equal(f.slot.appliedMultiplier, 1)
    })
  }
})

test('visibility changes alone never change the applied gain', () => {
  const a = nativeRoot('device-a', { level: { value: 0.6 } })
  const alice = participant('A', 'device-a', a.root, 1.5)
  const f = controllerFixture([a.root], [alice], false)
  withClock(f.doc, setNow => {
    setNow(0); f.controller.route()
    setNow(60); f.controller.route()
    for (const [t, hidden] of [[100, true], [200, false], [300, true]]) {
      f.doc.hidden = hidden
      setNow(t); f.controller.route()
      assert.equal(f.state.google.appliedParticipantKey, 'A')
      assert.equal(f.slot.appliedMultiplier, 1.5)
    }
  })
})

test('hostile Meet objects (throwing getters, proxies, null prototypes) never escape the read', () => {
  const a = nativeRoot('device-a', { level: { value: 0.6 } })
  const holder = a.root.__jsmodel.A0Tiaf.pending.value
  Object.defineProperty(holder, 'boom', { enumerable: true, get() { throw new Error('getter') } })
  holder.proxy = new Proxy({}, { get() { throw new Error('proxy') }, ownKeys() { throw new Error('keys') } })
  holder.bare = Object.assign(Object.create(null), { isDisposed: () => false, oa: () => 1 })
  const source = createNativeActivitySource()
  const result = source.read([participant('A', 'device-a', a.root)], documentWith(a.root), 0)
  assert.equal(result.available, true)
  assert.equal(result.levels.get('A'), 0.6)
})

test('a read that throws reports unavailable instead of throwing', () => {
  const source = createNativeActivitySource()
  const doc = { querySelectorAll() { throw new Error('dom') } }
  const result = source.read([participant('A', 'device-a', null)], doc, 0)
  assert.equal(result.available, false)
  assert.deepEqual(result.unknown, ['A'])
})

test('objects without the source-model shape are never probed with getters', () => {
  let called = 0
  class Disposable { constructor() { this.Xa = { start: () => { called++; return 'device-a' } } }
    isDisposed() { return false }
    oa() { return 0.5 }
    start(){return this.Xa.start()} }
  const a = nativeRoot('device-a', { level: { value: 0 } })
  a.root.__jsmodel.A0Tiaf.pending.value.other = new Disposable()
  createNativeActivitySource().read([participant('A', 'device-a', a.root)], documentWith(a.root), 0)
  assert.equal(called, 0)
})

test('getter discovery is retried at most once per second while unavailable', () => {
  let scans = 0
  const root = { isConnected: true, getAttribute: () => 'device-a', querySelectorAll: () => { scans++; return [] } }
  const source = createNativeActivitySource()
  const alice = participant('A', 'device-a', root)
  for (let t = 0; t < 990; t += 30) source.read([alice], documentWith(root), t)
  assert.equal(scans, 1)
  source.read([alice], documentWith(root), 1000)
  assert.equal(scans, 2)
})

test('controller neutralizes when Meet objects make the read fail mid-call', () => {
  const a = nativeRoot('device-a', { level: { value: 0.6 } })
  const alice = participant('A', 'device-a', a.root, 1.5)
  const f = controllerFixture([a.root], [alice], true)
  withClock(f.doc, setNow => {
    setNow(0); f.controller.route()
    setNow(60); f.controller.route()
    assert.equal(f.slot.appliedMultiplier, 1.5)
    f.doc.querySelectorAll = () => { throw new Error('dom') }
    setNow(100); f.controller.route()
    assert.equal(f.state.google.routingState, 'speaker-data-unavailable')
    assert.equal(f.slot.appliedMultiplier, 1)
  })
})

test('an unreadable controller before the ring renderer does not hide it', () => {
  const a = nativeRoot('device-a', { level: { value: 0.6 } })
  const ring = a.root.querySelectorAll()[0]
  const hostile = { getAttribute: () => 'x', get __jscontroller() { throw new Error('controller') } }
  a.root.querySelectorAll = () => [hostile, ring]
  assert.equal(findActivityGetterName(a.root), 'oa')
  const result = createNativeActivitySource().read([participant('A', 'device-a', a.root)], documentWith(a.root), 0)
  assert.equal(result.available, true)
})

test('identity cache is rebuilt when a stale getter is rediscovered', () => {
  const level = { value: 0.6 }
  const a = nativeRoot('device-a', { level })
  const source = createNativeActivitySource()
  const alice = participant('A', 'device-a', a.root)
  assert.equal(source.read([alice], documentWith(a.root), 0).available, true)
  // Meet ships a build where the ring now uses a different getter name.
  const originalRing = BuildOneRing.prototype.Cbc
  const originalOa = BuildOneModel.prototype.oa
  BuildOneModel.prototype.qb = ({qb(){return this.Xa.Yec()}}).qb
  BuildOneRing.prototype.Cbc = ({Cbc(){var a=Math.round(this.di.Aa.qb()*5);this.element.Ga=a>0}}).Cbc
  delete BuildOneModel.prototype.oa
  try {
    assert.equal(source.read([alice], documentWith(a.root), 100).available, false)
    const later = source.read([alice], documentWith(a.root), 20000)
    assert.equal(source.activityGetter, 'qb')
    assert.equal(later.available, true)
    assert.equal(later.levels.get('A'), 0.6)
  } finally {
    BuildOneModel.prototype.oa = originalOa
    BuildOneRing.prototype.Cbc = originalRing
    delete BuildOneModel.prototype.qb
  }
})

for (const repeatedId of [false, true]) test(`zero-match discovery caps attempted roots, repeated id=${repeatedId}`, () => {
  const anchor = nativeRoot('anchor'), source = createNativeActivitySource()
  source.read([], documentWith(anchor.root), 0)
  let scans = 0
  const roots = Array.from({ length: 2000 }, (_, i) => ({
    isConnected: true,
    getAttribute: () => repeatedId ? 'invalid' : `invalid-${i}`,
    querySelectorAll() { scans++; return [] }
  }))
  const r = source.read([], documentWith(...roots), 2000)
  assert.equal(r.available, false)
  assert.equal(source.membershipTrusted, false)
  assert.ok(scans > 0 && scans <= 64, `attempted ${scans} roots`)
})

test('zero-match discovery bounds candidate identity work inside a single root', () => {
  const anchor = nativeRoot('anchor'), source = createNativeActivitySource()
  source.read([], documentWith(anchor.root), 0)
  let reads = 0
  const holder = {}
  for (let i = 0; i < 20000; i++) Object.defineProperty(holder, `candidate${i}`, {
    enumerable: true, get() { reads++; return new BuildOneModel('wrong-id', 'wrong-media', { value: 0 }) }
  })
  const root = { isConnected: true, getAttribute: () => 'invalid', querySelectorAll: () => [],
    __jsmodel: { model: { pending: { value: holder } } } }
  source.read([], documentWith(root), 2000)
  assert.ok(reads > 0 && reads <= 4096, `read ${reads} candidate values`)
  assert.equal(source.membershipTrusted, false)
})

test('a participant temporarily hidden by Meet keeps their measured level', () => {
  const a = nativeRoot('device-a', { level: { value: 0.6 } })
  const b = nativeRoot('device-b', { level: { value: 0 } })
  const alice = participant('A', 'device-a', a.root, 1)
  const bob = participant('B', 'device-b', b.root, 1)
  const f = controllerFixture([a.root, b.root], [alice, bob], false)
  // Declared numeric fixture for activity retention, not native audio graph proof.
  f.slot.audibleMeter = { read: () => 0.01 }
  withClock(f.doc, setNow => {
    let t = 0
    for (; t < 6000; t += 30) { setNow(t); f.controller.route() }
    assert.ok(Number.isFinite(f.controller.levelFor('A').typicalDb))
    // Meet stops rendering Alice's tile for a while (e.g. someone presents).
    alice.present = false
    a.level.value = 0
    b.level.value = 0.6
    for (; t < 20000; t += 30) { setNow(t); f.controller.route() }
    alice.present = true
    setNow(t); f.controller.route()
    assert.ok(Number.isFinite(f.controller.levelFor('A').typicalDb))
  })
})

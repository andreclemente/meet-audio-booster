import test from 'node:test'
import assert from 'node:assert/strict'
import { createNativeActivitySource } from '../src/platforms/google-meet/native-activity.js'
import { createGoogleMeetController } from '../src/platforms/google-meet/index.js'

// Synthetic Meet structure. Field/method names are deliberately different in
// the two "builds"; production code must find the participant-keyed level Map
// purely by structure and by agreement with tile activity models.
class BuildOneModel {
  constructor(participantId, level) { this.Xa = { getId: () => `media-${participantId}`, Yc: () => participantId, Yec: () => level() }; this.disposed = false }
  isDisposed() { return this.disposed }
  getId(){return this.Xa.getId()}
  Yc(){return this.Xa.Yc()}
  oa(){return this.Xa.Yec()}
}
class BuildOneRing { constructor(holder) { this.di = holder; this.element = {} }
  async Cbc(){var a=Math.round(this.di.Aa.oa()*5);this.element.Ga=a>0} }

class BuildTwoModel {
  constructor(participantId, level) { this.Ya = { getId: () => `media-${participantId}`, Zc: () => participantId, Gec: () => level() }; this.disposed = false }
  isDisposed() { return this.disposed }
  getId(){return this.Ya.getId()}
  Zc(){return this.Ya.Zc()}
  qa(){return this.Ya.Gec()}
}
class BuildTwoRing { constructor(holder) { this.Sh = holder; this.element = {} }
  async pbc(){var a=Math.round(this.Sh.Ba.qa()*5),b=this.oa;this.element.Ga=a>0} }

// ids: every participant Meet knows about (including tileless ones).
function makeCall({ build = 1, ids, levelMap = true, duplicateLevelMap = false } = {}) {
  const levels = new Map(ids.map(id => [id, 0]))
  const sources = new Map(ids.map((id, index) => [id, (0x9e3779b1 * (index + 1)) >>> 0]))
  const seen = new Map(ids.map((id, index) => [id, 1793698698000 + index * 17]))
  const ordinals = new Map(ids.map((id, index) => [id, index]))
  const service = build === 1 ? { Aa: sources, Xa: seen, Lb: ordinals } : { Qc: sources, Zd: seen, Wm: ordinals }
  if (levelMap) service[build === 1 ? 'Ra' : 'Kb'] = levels
  if (duplicateLevelMap) service[build === 1 ? 'Ru' : 'Kz'] = levels.__copy = new Map(levels)
  const tileOverride = new Map()
  const models = []
  function speak(id, value) { levels.set(id, value); levels.__copy?.set(id, value) }
  function tile(id) {
    const level = () => tileOverride.has(id) ? tileOverride.get(id) : Math.floor(levels.get(id) ?? 0) / 5
    const model = new (build === 1 ? BuildOneModel : BuildTwoModel)(id, level)
    // Nested service path with rotated names; reachable twice (identity dedupe).
    if (build === 1) { model.Va = { wb: { bV: service } }; model.Va.alt = { bV: service } }
    else { model.Tg = { Lm: { c: service, d: [service] } } }
    models.push(model)
    const holder = build === 1 ? { Aa: model } : { Ba: model }
    const Ring = build === 1 ? BuildOneRing : BuildTwoRing
    const ringElement = { getAttribute: () => 'ring', __jscontroller: { pending: { value: new Ring(holder) } } }
    const root = {
      isConnected: true,
      getAttribute: name => name === 'data-participant-id' ? id : null,
      __jsmodel: { A0Tiaf: { pending: { value: { wy: model } } } },
      querySelectorAll: () => [ringElement],
      querySelector: () => null,
      matches: () => false
    }
    return { root, model }
  }
  return { levels, service, speak, tile, tileOverride, models }
}

function documentWith(...roots) {
  return { hidden: false, querySelectorAll: selector => selector === '[data-participant-id]' ? roots : [] }
}

function participant(key, participantId, element, value = 1, present = true) {
  return { key, participantId, element, name: key, platform: 'google-meet', present, speaking: false, lastSpeakingAt: 0, value, muted: false }
}

function keys(list) { return list.map(item => item.key) }

for (const build of [1, 2]) {
  test(`build ${build}: level Map is discovered through a nested service with rotated names`, () => {
    const call = makeCall({ build, ids: ['device-a', 'device-b', 'device-c'] })
    const a = call.tile('device-a')
    const b = call.tile('device-b')
    const alice = participant('id:device-a', 'device-a', a.root)
    const bob = participant('id:device-b', 'device-b', b.root)
    const carol = participant('id:device-c', 'device-c', null, 1, false)
    const source = createNativeActivitySource()
    call.speak('device-a', 3.4)
    const first = source.read([alice, bob], documentWith(a.root, b.root), 0, { known: [alice, bob, carol] })
    assert.equal(first.source, 'meet-registry')
    assert.equal(first.available, true)
    assert.deepEqual(keys(first.speakers), ['id:device-a'])
    // Now the tileless participant speaks while the tile people are quiet.
    call.speak('device-a', 0.2)
    call.speak('device-c', 4.9)
    const later = source.read([alice, bob], documentWith(a.root, b.root), 30, { known: [alice, bob, carol] })
    assert.equal(later.source, 'meet-registry')
    assert.equal(later.available, true)
    assert.deepEqual(keys(later.speakers), ['id:device-c'])
    assert.equal(later.levels.get('id:device-c'), 0.8)
  })
}

test('id->source-int, id->timestamp and id->ordinal maps are never accepted', () => {
  const call = makeCall({ ids: ['device-a', 'device-b'], levelMap: false })
  const a = call.tile('device-a')
  const b = call.tile('device-b')
  const people = [participant('id:device-a', 'device-a', a.root), participant('id:device-b', 'device-b', b.root)]
  const source = createNativeActivitySource()
  call.tileOverride.set('device-a', 0.6)
  for (let t = 0; t <= 3000; t += 500) {
    const result = source.read(people, documentWith(a.root, b.root), t)
    assert.equal(result.source, 'meet-tiles')
    assert.deepEqual(keys(result.speakers), ['id:device-a'])
  }
})

test('two distinct Maps that both validate are ambiguous and rejected', () => {
  const call = makeCall({ ids: ['device-a', 'device-b'], duplicateLevelMap: true })
  const a = call.tile('device-a')
  const people = [participant('id:device-a', 'device-a', a.root)]
  const source = createNativeActivitySource()
  call.speak('device-a', 2.5)
  for (let t = 0; t <= 3000; t += 500) assert.equal(source.read(people, documentWith(a.root), t).source, 'meet-tiles')
})

test('an all-zero candidate is not trusted until a positive tile level matches', () => {
  const call = makeCall({ ids: ['device-a', 'device-b', 'device-c'] })
  const a = call.tile('device-a')
  const alice = participant('id:device-a', 'device-a', a.root)
  const carol = participant('id:device-c', 'device-c', null, 1, false)
  const source = createNativeActivitySource()
  // Before trust, a tileless speaker cannot be confirmed: tile semantics apply.
  call.speak('device-c', 4)
  const quiet = source.read([alice], documentWith(a.root), 0, { known: [alice, carol] })
  assert.equal(quiet.source, 'meet-tiles')
  assert.deepEqual(quiet.speakers, [])
  // With only zeros on tiles, an id->ordinal Map agrees as well: ambiguous.
  for (let t = 30; t < 1000; t += 30) assert.equal(source.read([alice], documentWith(a.root), t, { known: [alice, carol] }).source, 'meet-tiles')
  call.speak('device-c', 0)
  call.speak('device-a', 1.3)
  // Next (throttled) discovery: a positive tile level singles out the level Map.
  const positive = source.read([alice], documentWith(a.root), 1000, { known: [alice, carol] })
  assert.equal(positive.source, 'meet-registry')
  call.speak('device-a', 0)
  call.speak('device-c', 4)
  const tileless = source.read([alice], documentWith(a.root), 1030, { known: [alice, carol] })
  assert.deepEqual(keys(tileless.speakers), ['id:device-c'])
})

test('self ids in the registry are ignored; unknown speaking ids are counted, never attributed', () => {
  const call = makeCall({ ids: ['device-a', 'device-self', 'device-x'] })
  const a = call.tile('device-a')
  const alice = participant('id:device-a', 'device-a', a.root)
  const source = createNativeActivitySource()
  const selfIds = new Set(['device-self'])
  call.speak('device-a', 2)
  source.read([alice], documentWith(a.root), 0, { selfIds })
  call.speak('device-a', 0)
  call.speak('device-self', 5)
  const self = source.read([alice], documentWith(a.root), 30, { selfIds })
  assert.equal(self.available, true)
  assert.equal(self.unknownSpeakers, 0)
  assert.deepEqual(self.speakers, [])
  call.speak('device-x', 3)
  const stranger = source.read([alice], documentWith(a.root), 60, { selfIds })
  assert.equal(stranger.unknownSpeakers, 1)
  assert.deepEqual(stranger.speakers, [])
})

test('a present participant missing from the registry makes the read unavailable', () => {
  const call = makeCall({ ids: ['device-a'] })
  const a = call.tile('device-a')
  const alice = participant('id:device-a', 'device-a', a.root)
  const ghost = participant('id:device-g', 'device-g', null)
  const source = createNativeActivitySource()
  call.speak('device-a', 2)
  source.read([alice], documentWith(a.root), 0)
  const result = source.read([alice, ghost], documentWith(a.root), 30)
  assert.equal(result.source, 'meet-registry')
  assert.equal(result.available, false)
  assert.deepEqual(result.unknown, ['id:device-g'])
})

test('persistent disagreement with tile models drops trust and falls back to tiles', () => {
  const call = makeCall({ ids: ['device-a', 'device-b'] })
  const a = call.tile('device-a')
  const alice = participant('id:device-a', 'device-a', a.root)
  const source = createNativeActivitySource()
  call.speak('device-a', 3.1)
  assert.equal(source.read([alice], documentWith(a.root), 0).source, 'meet-registry')
  call.tileOverride.set('device-a', 0.8)
  // A transient read-timing mismatch keeps trust, but routing uses the tile
  // path while the registry disagrees (no possibly wrong registry speaker).
  assert.equal(source.read([alice], documentWith(a.root), 100).source, 'meet-tiles')
  assert.equal(source.read([alice], documentWith(a.root), 900).source, 'meet-tiles')
  const dropped = source.read([alice], documentWith(a.root), 1200)
  assert.equal(dropped.source, 'meet-tiles')
  assert.equal(dropped.levels.get('id:device-a'), 0.8)
})

test('a transient disagreement routes from tiles, then the registry resumes without rediscovery', () => {
  const call = makeCall({ ids: ['device-a', 'device-b'] })
  const a = call.tile('device-a')
  const alice = participant('id:device-a', 'device-a', a.root)
  const ghost = participant('id:device-b', 'device-b', null)
  const source = createNativeActivitySource()
  call.speak('device-a', 3.1)
  assert.equal(source.read([alice], documentWith(a.root), 0).source, 'meet-registry')
  call.tileOverride.set('device-a', 0.8)
  const during = source.read([alice, ghost], documentWith(a.root), 100)
  // Bob has no tile, so the tile path cannot confirm him: unavailable => unity.
  assert.equal(during.source, 'unavailable')
  assert.equal(during.available, false)
  call.tileOverride.delete('device-a')
  assert.equal(source.read([alice, ghost], documentWith(a.root), 400).source, 'meet-registry')
})

test('with no tiles left, the trusted registry is kept only while an accepted model lives', () => {
  const call = makeCall({ ids: ['device-a', 'device-c'] })
  const a = call.tile('device-a')
  const alice = participant('id:device-a', 'device-a', a.root)
  const carol = participant('id:device-c', 'device-c', null, 1, false)
  const source = createNativeActivitySource()
  call.speak('device-a', 2)
  source.read([alice], documentWith(a.root), 0, { known: [alice, carol] })
  call.speak('device-a', 0)
  call.speak('device-c', 3)
  alice.present = false
  const hidden = source.read([], documentWith(), 500, { known: [alice, carol] })
  assert.equal(hidden.source, 'meet-registry')
  assert.equal(hidden.available, true)
  assert.deepEqual(keys(hidden.speakers), ['id:device-c'])
  a.model.disposed = true
  const gone = source.read([], documentWith(), 600, { known: [alice, carol] })
  assert.notEqual(gone.source, 'meet-registry')
  assert.equal(gone.available, false)
})

test('hostile objects on the walk never escape and getters are never invoked', () => {
  const call = makeCall({ ids: ['device-a', 'device-b'] })
  const a = call.tile('device-a')
  let getterCalls = 0
  Object.defineProperty(call.service, 'lazy', { enumerable: true, get() { getterCalls++; throw new Error('getter') } })
  a.model.Va.boom = new Proxy({}, {
    ownKeys() { throw new Error('keys') }, getOwnPropertyDescriptor() { throw new Error('descriptor') }, getPrototypeOf() { throw new Error('proto') }
  })
  const revocable = Proxy.revocable({}, {})
  revocable.revoke()
  a.model.Va.revoked = revocable.proxy
  a.model.Va.wb.mapProxy = new Proxy(new Map([['device-a', 2]]), {})
  a.model.Va.wb.bare = Object.assign(Object.create(null), { deep: { deeper: {} } })
  const alice = participant('id:device-a', 'device-a', a.root)
  call.speak('device-a', 2)
  const result = createNativeActivitySource().read([alice], documentWith(a.root), 0)
  assert.equal(result.source, 'meet-registry')
  assert.equal(result.available, true)
  assert.equal(getterCalls, 0)
})

test('registry discovery runs at most once per second while untrusted', () => {
  const call = makeCall({ ids: ['device-a'], levelMap: false })
  const a = call.tile('device-a')
  let walks = 0
  a.model.Va.wb.counter = new Proxy({}, { ownKeys(target) { walks++; return Reflect.ownKeys(target) } })
  const alice = participant('id:device-a', 'device-a', a.root)
  const source = createNativeActivitySource()
  for (let t = 0; t < 990; t += 30) source.read([alice], documentWith(a.root), t)
  assert.equal(walks, 1)
  source.read([alice], documentWith(a.root), 1000)
  assert.equal(walks, 2)
})

function controllerFixture(roots, participants, hidden) {
  const doc = { ...documentWith(...roots), hidden }
  const slot = { gain: {}, appliedMultiplier: 1, set(value) { this.appliedMultiplier = value }, release() { this.appliedMultiplier = 1 } }
  const state = {
    participants: new Map(participants.map(p => [p.key, p])),
    google: {
      slots: [slot], mediaPipelines: [], mode: 'worklet', activeParticipantKey: null, appliedParticipantKey: null,
      routingState: 'idle', transitionGuard: { candidateParticipantKey: null, candidateSince: 0 },
      routing: {}, rosterSignature: '', localPresentationActive: false
    }
  }
  const controller = createGoogleMeetController({ state, context: {}, setStatus() {}, renderSoon() {}, updateLiveUi() {} })
  return { doc, state, slot, controller }
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
  test(`controller ${hidden ? 'hidden' : 'visible'}: a tileless known speaker gets their own gain, never the previous speaker's`, () => {
    const call = makeCall({ ids: ['device-a', 'device-b', 'device-c'] })
    const a = call.tile('device-a')
    const b = call.tile('device-b')
    const alice = participant('id:device-a', 'device-a', a.root, 1.5)
    const bob = participant('id:device-b', 'device-b', b.root, 0.75)
    const carol = participant('id:device-c', 'device-c', null, 1.25, false)
    const f = controllerFixture([a.root, b.root], [alice, bob, carol], hidden)
    withClock(f.doc, setNow => {
      call.speak('device-a', 3.6)
      setNow(0); f.controller.route()
      setNow(60); f.controller.route()
      assert.equal(f.state.google.appliedParticipantKey, 'id:device-a')
      assert.equal(f.slot.appliedMultiplier, 1.5)
      assert.equal(f.state.google.activitySource, 'meet-registry')
      call.speak('device-a', 0)
      setNow(500); f.controller.route()
      assert.equal(f.slot.appliedMultiplier, 1.5)

      // Carol has no tile (someone presents) and starts talking.
      call.speak('device-c', 4.2)
      setNow(1000); f.controller.route()
      assert.equal(f.slot.appliedMultiplier, 1)
      setNow(1060); f.controller.route()
      assert.equal(f.state.google.appliedParticipantKey, 'id:device-c')
      assert.equal(f.slot.appliedMultiplier, 1.25)
      assert.equal(carol.speaking, true)
      // Quiet holds Carol's own gain.
      call.speak('device-c', 0.4)
      setNow(2000); f.controller.route()
      assert.equal(f.slot.appliedMultiplier, 1.25)
      // Overlap with a tile participant: unity.
      call.speak('device-c', 3)
      call.speak('device-b', 2)
      setNow(2030); f.controller.route()
      assert.equal(f.state.google.routingState, 'ambiguous')
      assert.equal(f.slot.appliedMultiplier, 1)
    })
  })

  test(`controller ${hidden ? 'hidden' : 'visible'}: an unknown tileless speaker forces safe unity`, () => {
    const call = makeCall({ ids: ['device-a', 'device-x'] })
    const a = call.tile('device-a')
    const alice = participant('id:device-a', 'device-a', a.root, 1.5)
    const f = controllerFixture([a.root], [alice], hidden)
    withClock(f.doc, setNow => {
      call.speak('device-a', 2.2)
      setNow(0); f.controller.route()
      setNow(60); f.controller.route()
      assert.equal(f.slot.appliedMultiplier, 1.5)
      call.speak('device-a', 0)
      call.speak('device-x', 4)
      setNow(90); f.controller.route()
      assert.equal(f.slot.appliedMultiplier, 1)
      assert.equal(f.state.google.appliedParticipantKey, null)
      assert.equal(f.state.google.unknownSpeakerCount, 1)
      assert.equal(f.state.google.routingState, 'unknown-speaker')
    })
  })
}

test('exported state carries only counts and the source label, never participant ids', () => {
  const call = makeCall({ ids: ['device-a', 'device-x'] })
  const a = call.tile('device-a')
  const alice = participant('id:device-a', 'device-a', a.root, 1.5)
  const f = controllerFixture([a.root], [alice], true)
  withClock(f.doc, setNow => {
    call.speak('device-a', 2)
    setNow(0); f.controller.route()
    call.speak('device-x', 4)
    setNow(30); f.controller.route()
    const { slots, mediaPipelines, routing, ...google } = f.state.google
    const json = JSON.stringify(google)
    assert.doesNotMatch(json, /device-x/)
    assert.equal(f.state.google.activitySource, 'meet-registry')
  })
})

// CPU time of the current thread's process (not wall clock), so scheduler
// noise from other processes on a busy host does not make these flaky.
function timed(run) {
  const start = process.cpuUsage()
  const result = run()
  const { user, system } = process.cpuUsage(start)
  return { result, ms: (user + system) / 1000 }
}

test('a huge array on the walk costs little and the registry is still found', () => {
  const call = makeCall({ ids: ['device-a', 'device-b'] })
  const a = call.tile('device-a')
  a.model.Va.huge = Array.from({ length: 200000 }, (_, index) => index)
  call.service.huge = Array.from({ length: 200000 }, (_, index) => ({ index }))
  const alice = participant('id:device-a', 'device-a', a.root)
  call.speak('device-a', 2)
  const { result, ms } = timed(() => createNativeActivitySource().read([alice], documentWith(a.root), 0))
  console.log(`huge array read: ${ms.toFixed(2)} ms`)
  assert.ok(ms < 50, `read took ${ms} ms`)
  assert.equal(result.source, 'meet-registry')
})

test('very wide objects keep every tick bounded; the registry is found once they are known', () => {
  const call = makeCall({ ids: ['device-a', 'device-b', 'device-c'] })
  const a = call.tile('device-a')
  const wide = {}
  for (let index = 0; index < 50; index++) {
    const object = {}
    for (let key = 0; key < 20000; key++) object[`k${key}`] = key
    wide[`w${index}`] = object
  }
  a.model.Va.wide = wide
  const alice = participant('id:device-a', 'device-a', a.root)
  const carol = participant('id:device-c', 'device-c', null, 1, false)
  const source = createNativeActivitySource()
  call.speak('device-a', 2)
  let worst = 0
  let total = 0
  let trustedAt = null
  for (let t = 0; t <= 20000 && trustedAt === null; t += 30) {
    const { result, ms } = timed(() => source.read([alice], documentWith(a.root), t, { known: [alice, carol] }))
    worst = Math.max(worst, ms)
    total += ms
    if (result.source === 'meet-registry') trustedAt = t
  }
  console.log(`wide objects: worst tick ${worst.toFixed(2)} ms, total ${total.toFixed(2)} ms, trusted at ${trustedAt} ms`)
  assert.ok(worst < 50, `worst tick ${worst} ms`)
  assert.notEqual(trustedAt, null)
  call.speak('device-a', 0)
  call.speak('device-c', 4)
  assert.deepEqual(keys(source.read([alice], documentWith(a.root), trustedAt + 30, { known: [alice, carol] }).speakers), ['id:device-c'])
})

test('a walk that exhausts its time budget never yields a trusted registry', async () => {
  const { createActivityRegistry } = await import('../src/platforms/google-meet/activity-registry.js')
  const call = makeCall({ ids: ['device-a', 'device-b'] })
  const a = call.tile('device-a')
  // More objects precede the service than a walk can visit in its slices
  // when every clock read exhausts the slice.
  for (let index = 0; index < 8; index++) a.model.Va[`pad${index}`] = { index }
  call.speak('device-a', 2)
  let clock = 0
  const registry = createActivityRegistry({ clock: () => (clock += 100) })
  const tileLevels = new Map([['device-a', 0.4]])
  for (let t = 0; t <= 5000; t += 30) assert.equal(registry.update({ now: t, tileLevels, tileModels: [a.model] }), null)
  assert.equal(registry.trusted, false)
  // The same walk with a normal clock succeeds.
  const normal = createActivityRegistry()
  assert.notEqual(normal.update({ now: 0, tileLevels, tileModels: [a.model] }), null)
})

test('the activity getter is not rediscovered while the registry path is in use', () => {
  const call = makeCall({ ids: ['device-a', 'device-b'] })
  const a = call.tile('device-a')
  const alice = participant('id:device-a', 'device-a', a.root)
  const source = createNativeActivitySource()
  const original = Function.prototype.toString
  let ringReads = 0
  Function.prototype.toString = function () { if (this === BuildOneRing.prototype.Cbc) ringReads++; return original.call(this) }
  try {
    for (let t = 0; t <= 25000; t += 500) {
      call.speak('device-a', t % 1000 ? 0 : 2)
      const result = source.read([alice], documentWith(a.root), t)
      assert.equal(result.source, 'meet-registry', `at ${t}`)
      assert.equal(result.levels.get('id:device-a'), t % 1000 ? 0 : 0.4)
    }
  } finally { Function.prototype.toString = original }
  assert.equal(ringReads, 1)
})

test('a map replaced by Meet is detected within the verification period', () => {
  const call = makeCall({ ids: ['device-a', 'device-b', 'device-c'] })
  const a = call.tile('device-a')
  const alice = participant('id:device-a', 'device-a', a.root)
  const carol = participant('id:device-c', 'device-c', null, 1, false)
  const source = createNativeActivitySource()
  call.speak('device-a', 2)
  assert.equal(source.read([alice], documentWith(a.root), 0, { known: [alice, carol] }).source, 'meet-registry')
  call.speak('device-a', 0)
  // Meet swaps in a fresh Map; the old one freezes at zero.
  const replacement = new Map(call.levels)
  call.service.Ra = replacement
  replacement.set('device-c', 4)
  let detectedAt = null
  for (let t = 30; t <= 6000 && detectedAt === null; t += 30) {
    const result = source.read([alice], documentWith(a.root), t, { known: [alice, carol] })
    if (result.source !== 'meet-registry') detectedAt = t
    else assert.deepEqual(keys(result.speakers), [])
  }
  assert.ok(detectedAt !== null && detectedAt <= 5100, `detected at ${detectedAt}`)
  // The new Map is trusted only after a positive tile match.
  replacement.set('device-a', 2)
  call.tileOverride.set('device-a', 0.4)
  let trusted = null
  for (let t = detectedAt + 30; t <= detectedAt + 1500 && !trusted; t += 30) {
    const result = source.read([alice], documentWith(a.root), t, { known: [alice, carol] })
    if (result.source === 'meet-registry') trusted = result
  }
  assert.ok(trusted)
  assert.deepEqual(keys(trusted.speakers), ['id:device-a', 'id:device-c'])
  replacement.set('device-a', 0)
  call.tileOverride.set('device-a', 0)
  assert.deepEqual(keys(source.read([alice], documentWith(a.root), detectedAt + 1530, { known: [alice, carol] }).speakers), ['id:device-c'])
})

test('the local tile level cross-checks the registry when the self id is in it', () => {
  const call = makeCall({ ids: ['device-a', 'device-self', 'device-c'] })
  const a = call.tile('device-a')
  const self = call.tile('device-self')
  const alice = participant('id:device-a', 'device-a', a.root)
  const selfIds = new Set(['device-self'])
  const doc = documentWith(a.root, self.root)
  const source = createNativeActivitySource()
  call.speak('device-a', 2)
  assert.equal(source.read([alice], doc, 0, { selfIds }).source, 'meet-registry')
  call.speak('device-a', 0)
  // The local user talks but the registry (frozen) still says zero.
  call.tileOverride.set('device-self', 0.6)
  // Disagreement routes from tiles at once; trust is dropped after the tolerance.
  assert.equal(source.read([alice], doc, 100, { selfIds }).source, 'meet-tiles')
  assert.equal(source.read([alice], doc, 900, { selfIds }).source, 'meet-tiles')
  assert.equal(source.read([alice], doc, 1200, { selfIds }).source, 'meet-tiles')
})

test('a local tile whose id is not in the registry does not affect trust', () => {
  const call = makeCall({ ids: ['device-a', 'device-c'] })
  const a = call.tile('device-a')
  const self = call.tile('device-self')
  const alice = participant('id:device-a', 'device-a', a.root)
  const selfIds = new Set(['device-self'])
  const doc = documentWith(a.root, self.root)
  const source = createNativeActivitySource()
  call.speak('device-a', 2)
  call.tileOverride.set('device-self', 0.6)
  for (let t = 0; t <= 3000; t += 100) assert.equal(source.read([alice], doc, t, { selfIds }).source, 'meet-registry')
})

test('a 1000-entry registry (long large meeting) is supported', () => {
  const ids = Array.from({ length: 1000 }, (_, index) => `device-${index}`)
  const call = makeCall({ ids })
  const a = call.tile('device-0')
  const b = call.tile('device-1')
  const alice = participant('id:device-0', 'device-0', a.root)
  const bob = participant('id:device-1', 'device-1', b.root)
  const carol = participant('id:device-999', 'device-999', null, 1, false)
  const source = createNativeActivitySource()
  call.speak('device-0', 3)
  assert.equal(source.read([alice, bob], documentWith(a.root, b.root), 0, { known: [alice, bob, carol] }).source, 'meet-registry')
  call.speak('device-0', 0)
  call.speak('device-999', 4)
  const { result, ms } = timed(() => {
    let last
    for (let t = 30; t <= 3000; t += 30) last = source.read([alice, bob], documentWith(a.root, b.root), t, { known: [alice, bob, carol] })
    return last
  })
  console.log(`1000-entry map: ${(ms / 100).toFixed(3)} ms per tick`)
  assert.equal(result.source, 'meet-registry')
  assert.deepEqual(keys(result.speakers), ['id:device-999'])
})

test('with every tile hidden, periodic verification keeps a reachable registry and drops a replaced one', () => {
  const call = makeCall({ ids: ['device-a', 'device-c'] })
  const a = call.tile('device-a')
  const alice = participant('id:device-a', 'device-a', a.root)
  const carol = participant('id:device-c', 'device-c', null, 1, false)
  const source = createNativeActivitySource()
  call.speak('device-a', 2)
  source.read([alice], documentWith(a.root), 0, { known: [alice, carol] })
  call.speak('device-a', 0)
  call.speak('device-c', 3)
  for (let t = 500; t <= 12000; t += 500) {
    const hidden = source.read([], documentWith(), t, { known: [alice, carol] })
    assert.equal(hidden.source, 'meet-registry', `at ${t}`)
    assert.deepEqual(keys(hidden.speakers), ['id:device-c'])
  }
  call.service.Ra = new Map(call.levels)
  let droppedAt = null
  for (let t = 12030; t <= 18000 && droppedAt === null; t += 30) {
    if (source.read([], documentWith(), t, { known: [alice, carol] }).source !== 'meet-registry') droppedAt = t
  }
  assert.ok(droppedAt !== null && droppedAt <= 15030, `dropped at ${droppedAt}`)
})

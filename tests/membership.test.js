import test from 'node:test'
import assert from 'node:assert/strict'
import { createNativeActivitySource } from '../src/platforms/google-meet/native-activity.js'
import { createGoogleMeetController } from '../src/platforms/google-meet/index.js'
import { createState, visibleParticipants } from '../src/state.js'

// Synthetic Meet structure (not captured markup). Meet's activity service
// holds a participant-keyed level Map and a membership Map whose values are
// participant records; each record holds one participant model of the same
// class as the tile models. Field/method names differ per "build" and the
// production code must find both Maps by structure only.
class BuildOneModel {
  constructor(id, level) { this.Xa = { getId: () => `media-${id}`, Yc: () => id, Yec: () => level() }; this.disposed = false }
  isDisposed() { return this.disposed }
  getId(){return this.Xa.getId()}
  Yc(){return this.Xa.Yc()}
  oa(){return this.Xa.Yec()}
}
class BuildOneRing { constructor(holder) { this.di = holder; this.element = {} }
  async Cbc(){var a=Math.round(this.di.Aa.oa()*5);this.element.Ga=a>0} }
class BuildTwoModel {
  constructor(id, level) { this.Ya = { getId: () => `media-${id}`, Zc: () => id, Gec: () => level() }; this.disposed = false }
  isDisposed() { return this.disposed }
  getId(){return this.Ya.getId()}
  Zc(){return this.Ya.Zc()}
  qa(){return this.Ya.Gec()}
}
class BuildTwoRing { constructor(holder) { this.Sh = holder; this.element = {} }
  async pbc(){var a=Math.round(this.Sh.Ba.qa()*5),b=this.oa;this.element.Ga=a>0} }

// record: 'model' (valid), 'none' (no participant model), 'mismatch' (a model
// whose identity getter returns another id).
function makeCall({ build = 1, ids, members = ids, record = 'model', duplicateMembers = false } = {}) {
  const Model = build === 1 ? BuildOneModel : BuildTwoModel
  const levels = new Map(ids.map(id => [id, 0]))
  const sources = new Map(ids.map((id, index) => [id, (0x9e3779b1 * (index + 1)) >>> 0]))
  const level = id => () => Math.floor(levels.get(id) ?? 0) / 5
  const makeRecord = id => {
    const model = record === 'none' ? { Yc: () => id } : new Model(record === 'mismatch' ? `${id}-other` : id, level(id))
    return build === 1 ? { Hc: `name-hash-${ids.indexOf(id)}`, Qd: 7, Yf: model, Zz: null } : { pa: model, qx: [1, 2], rb: { s: 1 } }
  }
  const memberMap = new Map(members.map(id => [id, makeRecord(id)]))
  const service = build === 1 ? { Ra: levels, Mb: memberMap, Aa: sources } : { Kb: levels, Pq: memberMap, Qc: sources }
  if (duplicateMembers) service[build === 1 ? 'Mz' : 'Pz'] = new Map(memberMap)
  function speak(id, value) { levels.set(id, value) }
  function join(id) { if (!levels.has(id)) levels.set(id, 0); memberMap.set(id, makeRecord(id)) }
  function leave(id) { memberMap.delete(id) }
  // name: when set the tile is a recognizable named participant root.
  function tile(id, { name = null, selfLabel = false } = {}) {
    const model = new Model(id, level(id))
    if (build === 1) { model.Va = { wb: { bV: service } }; model.Va.alt = { bV: service } }
    else model.Tg = { Lm: { c: service, d: [service] } }
    const holder = build === 1 ? { Aa: model } : { Ba: model }
    const Ring = build === 1 ? BuildOneRing : BuildTwoRing
    const ring = { getAttribute: () => 'ring', __jscontroller: { pending: { value: new Ring(holder) } } }
    const nameNode = name && {
      textContent: name, children: [],
      matches: selector => selector.includes('data-self-name'),
      getAttribute: attr => attr === 'data-self-name' ? name : null
    }
    const root = {
      isConnected: true, innerText: name || '', textContent: name || '',
      getAttribute: attr => attr === 'data-participant-id' || (name && attr === 'data-requested-participant-id') ? id : null,
      __jsmodel: { A0Tiaf: { pending: { value: { wy: model } } } },
      querySelectorAll(selector) {
        if (selector.includes('jscontroller')) return [ring]
        if (selector === '[aria-label]') return []
        // Every person's tile shows a microphone indicator.
        if (selector.includes('google-symbols')) return [{ textContent: 'mic_none', closest: () => root }]
        if (selector === 'button, [role="button"]') {
          if (!root.selfLabel) return []
          const button = { closest: sel => sel === '[data-participant-id]' ? root : button }
          const icon = { textContent: 'visual_effects', closest: sel => sel === '[data-participant-id]' ? root : button }
          button.querySelectorAll = () => [icon]
          return [button]
        }
        if (nameNode && selector.includes('data-self-name')) return [nameNode]
        if (nameNode && selector === '*') return [nameNode]
        return []
      },
      querySelector: () => null,
      matches: () => false,
      selfLabel
    }
    return { root, model }
  }
  return { levels, service, memberMap, speak, join, leave, tile }
}

function documentWith(...roots) {
  return { hidden: false, querySelectorAll: selector => selector === '[data-participant-id]' ? roots : [] }
}

function participant(key, participantId, element, value = 1, present = true) {
  return { key, participantId, element, name: key, platform: 'google-meet', present, speaking: false, lastSpeakingAt: 0, value, muted: false }
}

function runTicks(source, people, doc, from, to, step = 30, options = {}) {
  let last
  for (let t = from; t <= to; t += step) last = source.read(people, doc, t, options)
  return last
}

for (const build of [1, 2]) {
  test(`build ${build}: membership Map is discovered by structure and tracks tileless members`, () => {
    const call = makeCall({ build, ids: ['device-a', 'device-b', 'device-c', 'device-gone'], members: ['device-a', 'device-b', 'device-c'] })
    const a = call.tile('device-a')
    const b = call.tile('device-b')
    const alice = participant('id:device-a', 'device-a', a.root)
    const bob = participant('id:device-b', 'device-b', b.root)
    const source = createNativeActivitySource()
    call.speak('device-a', 2.4)
    runTicks(source, [alice, bob], documentWith(a.root, b.root), 0, 300)
    assert.equal(source.membershipTrusted, true)
    assert.equal(source.isMember('device-c'), true, 'tileless member')
    assert.equal(source.isMember('device-gone'), false, 'departed id still in the level Map is not a member')
    call.leave('device-c')
    assert.equal(source.isMember('device-c'), false)
    call.join('device-d')
    runTicks(source, [alice, bob], documentWith(a.root, b.root), 330, 400)
    assert.equal(source.membershipTrusted, true)
    assert.equal(source.isMember('device-d'), true)
  })
}

for (const [label, options] of [
  ['values lack a participant model', { record: 'none' }],
  ['the record model identity does not match its key', { record: 'mismatch' }],
  ['two distinct Map instances validate', { duplicateMembers: true }]
]) {
  test(`membership is rejected when ${label}`, () => {
    const call = makeCall({ ids: ['device-a', 'device-b', 'device-c'], ...options })
    const a = call.tile('device-a')
    const alice = participant('id:device-a', 'device-a', a.root)
    const source = createNativeActivitySource()
    call.speak('device-a', 2)
    const result = runTicks(source, [alice], documentWith(a.root), 0, 3000)
    // The level Map itself is unaffected.
    assert.equal(result.source, 'meet-registry')
    assert.equal(source.membershipTrusted, false)
    assert.equal(source.isMember('device-c'), false)
  })
}

test('a rendered tile id missing from the membership Map drops trust after the tolerance', () => {
  const call = makeCall({ ids: ['device-a', 'device-b', 'device-c'], members: ['device-a', 'device-b', 'device-c'] })
  const a = call.tile('device-a')
  const b = call.tile('device-b')
  const alice = participant('id:device-a', 'device-a', a.root)
  const bob = participant('id:device-b', 'device-b', b.root)
  const source = createNativeActivitySource()
  call.speak('device-a', 2)
  runTicks(source, [alice, bob], documentWith(a.root, b.root), 0, 300)
  assert.equal(source.membershipTrusted, true)
  call.memberMap.delete('device-b')
  runTicks(source, [alice, bob], documentWith(a.root, b.root), 330, 900)
  assert.equal(source.membershipTrusted, true, 'transient mismatch tolerated')
  runTicks(source, [alice, bob], documentWith(a.root, b.root), 930, 1500)
  assert.equal(source.membershipTrusted, false)
  assert.equal(source.isMember('device-c'), false)
})

test('membership keys outside the trusted level Map drop trust after the tolerance', () => {
  const call = makeCall({ ids: ['device-a', 'device-b'] })
  const a = call.tile('device-a')
  const alice = participant('id:device-a', 'device-a', a.root)
  const source = createNativeActivitySource()
  call.speak('device-a', 2)
  runTicks(source, [alice], documentWith(a.root), 0, 300)
  assert.equal(source.membershipTrusted, true)
  call.memberMap.set('device-z', call.memberMap.get('device-b'))
  runTicks(source, [alice], documentWith(a.root), 330, 1500)
  assert.equal(source.membershipTrusted, false)
})

test('a replaced membership Map is detected by periodic re-validation', () => {
  const call = makeCall({ ids: ['device-a', 'device-b', 'device-c'] })
  const a = call.tile('device-a')
  const alice = participant('id:device-a', 'device-a', a.root)
  const source = createNativeActivitySource()
  call.speak('device-a', 2)
  runTicks(source, [alice], documentWith(a.root), 0, 300)
  assert.equal(source.membershipTrusted, true)
  const frozen = call.service.Mb
  call.service.Mb = new Map(frozen)
  call.service.Mb.delete('device-c')
  let switched = null
  for (let t = 330; t <= 7000 && switched === null; t += 30) {
    source.read([alice], documentWith(a.root), t)
    if (!source.isMember('device-c')) switched = t
  }
  assert.ok(switched !== null && switched <= 5400, `switched at ${switched}`)
})

test('membership discovery keeps walks to at most one per second when no membership Map exists', () => {
  const call = makeCall({ ids: ['device-a', 'device-b'] })
  delete call.service.Mb
  const a = call.tile('device-a')
  let walks = 0
  a.model.Va.wb.counter = new Proxy({}, { ownKeys(target) { walks++; return Reflect.ownKeys(target) } })
  const alice = participant('id:device-a', 'device-a', a.root)
  const source = createNativeActivitySource()
  call.speak('device-a', 2)
  for (let t = 0; t < 4990; t += 30) assert.equal(source.read([alice], documentWith(a.root), t).source, 'meet-registry')
  assert.ok(walks <= 5, `${walks} walks in 5 s`)
  assert.equal(source.membershipTrusted, false)
})

test('a 2000-member Map is validated in bounded per-tick slices', () => {
  const ids = Array.from({ length: 2000 }, (_, index) => `device-${index}`)
  const call = makeCall({ ids })
  const a = call.tile('device-0')
  const alice = participant('id:device-0', 'device-0', a.root)
  const source = createNativeActivitySource()
  call.speak('device-0', 2)
  let worst = 0
  let trustedAt = null
  for (let t = 0; t <= 3000 && trustedAt === null; t += 30) {
    const start = process.cpuUsage()
    source.read([alice], documentWith(a.root), t)
    const { user, system } = process.cpuUsage(start)
    worst = Math.max(worst, (user + system) / 1000)
    if (source.membershipTrusted) trustedAt = t
  }
  console.log(`2000 members: worst tick ${worst.toFixed(2)} ms, trusted at ${trustedAt} ms`)
  assert.notEqual(trustedAt, null)
  assert.ok(trustedAt >= 30, 'not validated in a single tick')
  assert.ok(worst < 50, `worst tick ${worst} ms`)
  assert.equal(source.isMember('device-1999'), true)
})

// Controller harness: reconcile (750 ms) and route (30 ms) run on a virtual clock.
function withController(run) {
  const originals = Object.fromEntries(['document', 'MutationObserver', 'setInterval', 'clearInterval'].map(key => [key, globalThis[key]]))
  const originalNow = Date.now
  let roots = []
  let now = 0
  const ticks = new Map()
  globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {}, documentElement: {} }
  globalThis.document.querySelectorAll = selector => selector === '[data-participant-id]' ? roots : []
  globalThis.MutationObserver = class { observe() {} disconnect() {} }
  globalThis.setInterval = (fn, ms) => { ticks.set(ms, fn); return ms }
  globalThis.clearInterval = ms => ticks.delete(ms)
  Date.now = () => now
  const state = createState({ getItem() { return null } })
  state.google.mode = 'worklet'
  const controller = createGoogleMeetController({ state, context: {}, setStatus() {}, renderSoon() {}, updateLiveUi() {} })
  // Advance the virtual clock, running route every 30 ms and reconcile every 750 ms.
  function advance(to, onReconcile = () => {}) {
    while (now < to) {
      now += 30
      ticks.get(30)?.()
      if (now % 750 < 30) { ticks.get(750)?.(); onReconcile(now) }
    }
  }
  try {
    run({ state, controller, roots(value) { roots = value }, advance, get now() { return now } })
  } finally {
    controller.stop()
    Date.now = originalNow
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
  }
}

const names = state => visibleParticipants(state, 'google-meet').map(item => item.name)

test('controller: a known participant without a tile stays listed until they leave the call', () => {
  const call = makeCall({ ids: ['device-a', 'device-b', 'device-c'] })
  const a = call.tile('device-a', { name: 'Alice' })
  const b = call.tile('device-b', { name: 'Bob' })
  withController(h => {
    h.roots([a.root, b.root])
    h.controller.start()
    call.speak('device-a', 2)
    h.advance(1500)
    assert.deepEqual(names(h.state), ['Alice', 'Bob'])
    // Someone presents: Meet stops rendering Bob's tile, he stays in the call.
    h.roots([a.root])
    const missing = []
    h.advance(30000, at => { if (!names(h.state).includes('Bob')) missing.push(at) })
    assert.deepEqual(missing, [], 'Bob never flickers out while still a member')
    assert.equal(h.state.google.membershipTrusted, true)
    // Device C is a member but was never seen on a tile: no row (no name).
    assert.equal([...h.state.participants.values()].some(item => item.participantId === 'device-c'), false)
    // Bob leaves the call.
    call.leave('device-b')
    h.advance(40000)
    assert.deepEqual(names(h.state), ['Alice'])
    // Membership adds a boolean only: member ids never reach exported state.
    const { slots, mediaPipelines, routing, ...google } = h.state.google
    assert.equal(typeof google.membershipTrusted, 'boolean')
    assert.doesNotMatch(JSON.stringify(google), /device-c/)
  })
})

test('controller: a returning tile after a hidden period keeps one stable row', () => {
  const call = makeCall({ ids: ['device-a', 'device-b'] })
  const a = call.tile('device-a', { name: 'Alice' })
  const b = call.tile('device-b', { name: 'Bob' })
  withController(h => {
    h.roots([a.root, b.root])
    h.controller.start()
    call.speak('device-a', 2)
    h.advance(1500)
    const bob = h.state.participants.get('id:device-b')
    bob.value = 1.75
    h.roots([a.root])
    h.advance(20000)
    h.roots([a.root, b.root])
    h.advance(22000)
    assert.equal(h.state.participants.get('id:device-b'), bob)
    assert.equal(bob.present, true)
    assert.equal(bob.value, 1.75)
  })
})

test('controller: without a trusted membership Map, tile presence and the grace period apply as before', () => {
  const call = makeCall({ ids: ['device-a', 'device-b'], record: 'none' })
  const a = call.tile('device-a', { name: 'Alice' })
  const b = call.tile('device-b', { name: 'Bob' })
  withController(h => {
    h.roots([a.root, b.root])
    h.controller.start()
    call.speak('device-a', 2)
    h.advance(1500)
    h.roots([a.root])
    h.advance(6000)
    assert.deepEqual(names(h.state), ['Alice', 'Bob'], 'grace period')
    h.advance(12000)
    assert.deepEqual(names(h.state), ['Alice'])
    assert.equal(h.state.google.membershipTrusted, false)
  })
})

test('controller: a participant verified as self is never kept by membership', () => {
  const call = makeCall({ ids: ['device-a', 'device-self'] })
  const a = call.tile('device-a', { name: 'Alice' })
  const me = call.tile('device-self', { name: 'Me' })
  withController(h => {
    h.roots([a.root, me.root])
    h.controller.start()
    call.speak('device-a', 2)
    h.advance(1500)
    assert.deepEqual(names(h.state), ['Alice', 'Me'])
    me.root.selfLabel = true
    h.advance(3000)
    assert.deepEqual(names(h.state), ['Alice'])
    assert.equal(h.state.google.membershipTrusted, true)
  })
})

test('controller: someone asking to join (listed, not a call tile, not a member) gets no row until admitted', () => {
  const call = makeCall({ ids: ['device-a'] })
  const a = call.tile('device-a', { name: 'Alice' })
  // A lobby/People entry: has the id and a name, but is not a call tile.
  const knock = call.tile('device-k', { name: 'Kim' })
  const original = knock.root.getAttribute
  knock.root.getAttribute = attr => attr === 'data-requested-participant-id' ? null : original(attr)
  withController(h => {
    h.roots([a.root, knock.root])
    h.controller.start()
    call.speak('device-a', 2)
    h.advance(1500)
    assert.equal(h.state.google.membershipTrusted, true)
    assert.deepEqual(names(h.state), ['Alice'])
    call.join('device-k')
    h.advance(6000)
    assert.equal(h.state.google.membershipTrusted, true)
    assert.deepEqual(names(h.state), ['Alice', 'Kim'])
  })
})

test('controller: a screen share never gets a row, not even before its controls render', () => {
  const call = makeCall({ ids: ['device-a', 'device-share'] })
  const a = call.tile('device-a', { name: 'Alice' })
  const share = call.tile('device-share', { name: 'Alice' })
  const original = share.root.querySelectorAll
  let icons = []
  share.root.querySelectorAll = selector => selector.includes('google-symbols')
    ? icons.map(textContent => ({ textContent, closest: () => share.root })) : original(selector)
  withController(h => {
    h.roots([a.root, share.root])
    h.controller.start()
    call.speak('device-a', 2)
    for (const [index, step] of [[], ['more_vert'], ['zoom_in', 'open_in_full']].entries()) {
      icons = step
      h.advance(1500 * (index + 1))
      assert.deepEqual(names(h.state), ['Alice'])
    }
  })
})

test('controller: share audio is an unknown speaker (safe 100%), never skipped like self', () => {
  const call = makeCall({ ids: ['device-a', 'device-share'] })
  const a = call.tile('device-a', { name: 'Alice' })
  const share = call.tile('device-share', { name: 'Alice' })
  const original = share.root.querySelectorAll
  share.root.querySelectorAll = selector => selector.includes('google-symbols')
    ? ['zoom_in', 'open_in_full'].map(textContent => ({ textContent, closest: () => share.root })) : original(selector)
  withController(h => {
    h.roots([a.root, share.root])
    h.controller.start()
    call.speak('device-a', 2)
    h.advance(1500)
    assert.equal(h.state.google.routingState, 'confirmed-speaker')
    call.speak('device-share', 4)
    h.advance(3000)
    assert.deepEqual(names(h.state), ['Alice'])
    assert.notEqual(h.state.google.routingState, 'confirmed-speaker')
    assert.ok(h.state.google.unknownSpeakerCount >= 1)
  })
})

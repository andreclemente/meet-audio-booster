import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createTypicalLevelEstimator, createParticipantLevelMeter, attributeLevelSample,
  meanSquare, powerToDb, sumTapPower, sumPipelinePower
} from '../src/platforms/google-meet/levels.js'
import { installAudioWorkletHook, createPooledSlot } from '../src/platforms/google-meet/audio-worklet.js'
import { createGoogleMeetController } from '../src/platforms/google-meet/index.js'
import { createAutoBalance } from '../src/ui/auto-balance.js'

const dbToPower = db => 10 ** (db / 10)

test('estimator stays unknown until the warm-up threshold of speech frames', () => {
  const estimator = createTypicalLevelEstimator({ warmupFrames: 30 })
  for (let index = 0; index < 29; index++) estimator.add(-30)
  assert.equal(estimator.frames, 29)
  assert.equal(estimator.typicalDb, null)
  estimator.add(-30)
  assert.equal(estimator.typicalDb, -30)
})

test('estimator is a robust median: short loud/quiet outliers barely move it', () => {
  const estimator = createTypicalLevelEstimator({ warmupFrames: 30 })
  for (let index = 0; index < 40; index++) estimator.add(-32 + (index % 5))
  const before = estimator.typicalDb
  for (let index = 0; index < 6; index++) estimator.add(-1)
  for (let index = 0; index < 6; index++) estimator.add(-54)
  assert.ok(Math.abs(estimator.typicalDb - before) <= 1, `${before} -> ${estimator.typicalDb}`)
  assert.ok(estimator.typicalDb > -33 && estimator.typicalDb < -27)
})

test('estimator window forgets old speech so a changed microphone is followed', () => {
  const estimator = createTypicalLevelEstimator({ warmupFrames: 30, window: 50 })
  for (let index = 0; index < 50; index++) estimator.add(-40)
  for (let index = 0; index < 50; index++) estimator.add(-20)
  assert.equal(estimator.typicalDb, -20)
  assert.throws(() => createTypicalLevelEstimator({ window: 0 }))
})

test('rms helpers: mean square, dBFS and summed energy across slots/pipelines', () => {
  assert.equal(meanSquare(new Float32Array([0.5, -0.5, 0.5, -0.5])), 0.25)
  assert.equal(meanSquare(new Float32Array(0)), 0)
  assert.equal(powerToDb(1), 0)
  assert.equal(powerToDb(0), -Infinity)
  assert.ok(Math.abs(powerToDb(0.01) + 20) < 1e-9)
  // Declared numeric fixture, not proof of a native audible audio graph.
  const audibleMeter = { read: () => 0.04 }
  const taps = [{ audibleMeter, tap: { readMeanSquare: () => 0.01 } }, { audibleMeter, tap: null }, { audibleMeter, tap: { readMeanSquare: () => 0.03 } }]
  assert.ok(Math.abs(sumTapPower(taps) - 0.04) < 1e-12)
  assert.ok(Math.abs(sumPipelinePower([{ rms: 0.1 }, { rms: 0.2 }, { rms: NaN }]) - 0.05) < 1e-12)
})

const base = { available: true, routingState: 'confirmed-speaker', appliedParticipantKey: 'A', localPresentationActive: false }
const A = { key: 'A' }, B = { key: 'B' }

test('attribution only to the sole native speaker who is also the confirmed routed speaker', () => {
  assert.equal(attributeLevelSample({ ...base, speakers: [A] }), 'A')
  for (const [label, input] of [
    ['overlap', { ...base, speakers: [A, B] }],
    ['silence while latched', { ...base, speakers: [] }],
    ['speaker data unavailable', { ...base, available: false, speakers: [A] }],
    ['transition', { ...base, routingState: 'transitioning', appliedParticipantKey: null, speakers: [B] }],
    ['other confirmed', { ...base, appliedParticipantKey: 'B', speakers: [A] }],
    ['ambiguous', { ...base, routingState: 'ambiguous', speakers: [A] }],
    ['local presentation', { ...base, localPresentationActive: true, speakers: [A] }],
    ['media no association', { ...base, routingState: 'no-reliable-association', speakers: [A] }],
    ['missing', {}]
  ]) assert.equal(attributeLevelSample(input), null, label)
})

function meterRun(meter, { from, to, step = 30, key, db, keys = ['A', 'B'] }) {
  let reads = 0
  for (let now = from; now < to; now += step) {
    meter.tick({ now, participantKeys: keys, attributedKey: key, readPower: () => { reads++; return dbToPower(db) } })
  }
  return reads
}

test('meter samples at most every 100 ms and only reads audio when a speaker is attributable', () => {
  const meter = createParticipantLevelMeter({ settleMs: 0 })
  assert.equal(meterRun(meter, { from: 0, to: 3000, key: null, db: -20 }), 0)
  const reads = meterRun(meter, { from: 3000, to: 4000, key: 'A', db: -20 })
  assert.ok(reads >= 9 && reads <= 10, `reads ${reads}`)
})

test('meter warms up after ~3 s of attributed speech and exposes pre-volume dB', () => {
  const meter = createParticipantLevelMeter()
  meterRun(meter, { from: 0, to: 2000, key: 'A', db: -24 })
  assert.equal(meter.levelFor('A').typicalDb, null)
  assert.ok(Math.abs(meter.levelFor('A').liveDb + 24) < 1e-9)
  meterRun(meter, { from: 2000, to: 4000, key: 'A', db: -24 })
  assert.ok(Math.abs(meter.levelFor('A').typicalDb + 24) < 1e-9)
  assert.equal(meter.levelFor('B').typicalDb, null)
  assert.equal(meter.levelFor('B').liveDb, null)
})

test('meter ignores silence below the noise floor and clears live level immediately when attribution stops', () => {
  const meter = createParticipantLevelMeter({ settleMs: 0 })
  meterRun(meter, { from: 0, to: 10000, key: 'A', db: -58 })
  assert.equal(meter.levelFor('A').frames, 0)
  assert.equal(meter.levelFor('A').liveDb, null)
  meterRun(meter, { from: 10000, to: 10200, key: 'A', db: -30 })
  assert.notEqual(meter.levelFor('A').liveDb, null)
  meter.tick({ now: 10210, participantKeys: ['A'], attributedKey: null, readPower: () => assert.fail('no read') })
  assert.equal(meter.levelFor('A').liveDb, null)
})

test('meter needs a settled sole speaker: handoff tails are not attributed', () => {
  const meter = createParticipantLevelMeter({ settleMs: 250 })
  meterRun(meter, { from: 0, to: 240, key: 'A', db: -20 })
  assert.equal(meter.levelFor('A').frames, 0)
  meterRun(meter, { from: 240, to: 600, key: 'A', db: -20 })
  const frames = meter.levelFor('A').frames
  assert.ok(frames > 0)
  // A single unattributable tick (e.g. overlap) restarts the settle period.
  meter.tick({ now: 600, participantKeys: ['A'], attributedKey: null, readPower: () => 1 })
  meterRun(meter, { from: 630, to: 850, key: 'A', db: -20 })
  assert.equal(meter.levelFor('A').frames, frames)
})

test('meter drops estimates for departed participants and on reset', () => {
  const meter = createParticipantLevelMeter({ settleMs: 0 })
  meterRun(meter, { from: 0, to: 4000, key: 'A', db: -20 })
  assert.notEqual(meter.levelFor('A').typicalDb, null)
  meter.tick({ now: 4000, participantKeys: ['B'], attributedKey: null, readPower: () => 0 })
  assert.equal(meter.levelFor('A').typicalDb, null)
  assert.equal(meter.levelFor('A').frames, 0)
  meterRun(meter, { from: 5000, to: 9000, key: 'B', db: -20, keys: ['B'] })
  meter.reset()
  assert.equal(meter.levelFor('B').typicalDb, null)
})

function hookMock() {
  const calls = { connect: [], disconnect: [] }
  function AudioNode() {}
  AudioNode.prototype.connect = function (...args) { calls.connect.push([this, ...args]); return args[0] }
  AudioNode.prototype.disconnect = function (...args) { calls.disconnect.push([this, ...args]) }
  const analysers = []
  const gains = []
  const context = {
    createGain() {
      const node = Object.assign(Object.create(AudioNode.prototype), { constructor: { name: 'GainNode' }, gain: { value: 1, setValueAtTime(value) { this.value = value } } })
      gains.push(node)
      return node
    },
    createAnalyser() {
      const node = Object.assign(Object.create(AudioNode.prototype), {
        constructor: { name: 'AnalyserNode' }, fftSize: 2048, fills: 0,
        getFloatTimeDomainData(buffer) { this.fills++; this.lastBuffer = buffer; buffer.fill(0.1) }
      })
      analysers.push(node)
      return node
    }
  }
  const source = Object.assign(Object.create(AudioNode.prototype), { constructor: { name: 'AudioWorkletNode' } })
  const destination = Object.assign(Object.create(AudioNode.prototype), { constructor: { name: 'GainNode' }, context })
  return { AudioNode, calls, analysers, gains, source, destination }
}

function withHook(mock, run) {
  const original = globalThis.AudioNode
  globalThis.AudioNode = mock.AudioNode
  try { return run() } finally { globalThis.AudioNode = original; delete globalThis.__meetingAudioBoosterWorkletHook }
}

test('worklet tap is an extra pre-booster sink: audio path and gains are unchanged', () => {
  const mock = hookMock()
  withHook(mock, () => {
    const registered = []
    const restore = installAudioWorkletHook((booster, tap) => registered.push({ booster, tap }))
    mock.source.connect(mock.destination, 2, 1)
    const [{ booster, tap }] = registered
    const [analyser] = mock.analysers
    assert.ok(tap && analyser)
    // Same booster path as before plus exactly one fan-out edge from the source to the analyser.
    assert.deepEqual(mock.calls.connect, [
      [mock.source, booster, 2],
      [booster, mock.destination, 0, 1],
      [mock.source, analyser, 2]
    ])
    assert.equal(mock.calls.connect.filter(([from]) => from === analyser).length, 0)
    assert.equal(booster.gain.value, 1)
    // Sampling reuses one buffer and never touches gains.
    const first = tap.readMeanSquare()
    tap.readMeanSquare()
    assert.ok(Math.abs(first - 0.01) < 1e-6)
    assert.equal(analyser.fills, 2)
    assert.equal(tap.buffer, analyser.lastBuffer)
    assert.equal(tap.buffer.length, analyser.fftSize)
    assert.equal(booster.gain.value, 1)
    restore()
  })
})

test('worklet tap is disconnected when Meet removes the slot and when the hook is restored', () => {
  for (const removal of ['meet', 'restore']) {
    const mock = hookMock()
    withHook(mock, () => {
      const removed = []
      const restore = installAudioWorkletHook(() => {}, booster => removed.push(booster))
      mock.source.connect(mock.destination)
      const [analyser] = mock.analysers
      if (removal === 'meet') mock.source.disconnect(mock.destination)
      restore()
      assert.equal(removed.length, 1)
      const tapDisconnects = mock.calls.disconnect.filter(([from, to]) => from === mock.source && to === analyser)
      assert.deepEqual(tapDisconnects, [[mock.source, analyser, 0, 0]], removal)
    })
  }
})

test('tap failure never blocks booster insertion; no analyser API means no tap', () => {
  for (const createAnalyser of [undefined, () => { throw new Error('nope') }]) {
    const mock = hookMock()
    mock.destination.context.createAnalyser = createAnalyser
    withHook(mock, () => {
      const registered = []
      const restore = installAudioWorkletHook((booster, tap) => registered.push({ booster, tap }))
      mock.source.connect(mock.destination)
      assert.equal(registered.length, 1)
      assert.equal(registered[0].tap, null)
      assert.equal(mock.calls.connect.length, 2)
      restore()
    })
  }
})

test('pooled slot destroy also disconnects its tap exactly once', () => {
  let disconnects = 0
  const tap = { disconnect() { disconnects++ } }
  const gain = { gain: { value: 1, setValueAtTime(value) { this.value = value } }, context: {} }
  const slot = createPooledSlot(gain, 's', tap)
  assert.equal(slot.tap, tap)
  slot.destroy()
  assert.equal(disconnects, 1)
  assert.equal(createPooledSlot(gain, 'plain').tap, null)
})

test('pooled slot keeps explicit measurement metadata independently of an optional source tap', () => {
  const gain = { gain: { value: 1, setValueAtTime(value) { this.value = value } }, context: {} }
  // Numeric contract fixture only, not a verified native audio graph.
  const audibleMeter = { read: slots => { assert.equal(slots.length, 2); return 0.04 } }
  const slots = [createPooledSlot(gain, 'first', null, audibleMeter), createPooledSlot(gain, 'second', null, audibleMeter)]
  assert.equal(slots[0].tap, null)
  assert.equal(slots[0].audibleMeter, audibleMeter)
  assert.equal(sumTapPower(slots), 0.04)
  const legacy = createPooledSlot(gain, 'legacy', { audibleMeter })
  assert.equal(legacy.audibleMeter, audibleMeter)
})

for (const failure of ['first-tap', 'all-taps', 'mixed-meters', 'missing-first-metadata', 'missing-later-metadata']) {
  test(`actual hook/controller/auto fail closed with ${failure} despite positive diagnostic power`, () => {
    const mock = hookMock()
    const createAnalyser = mock.destination.context.createAnalyser
    let attempts = 0
    mock.destination.context.createAnalyser = function () {
      if (++attempts === 1 || failure === 'all-taps') throw new Error('optional source analyser unavailable')
      return createAnalyser.call(this)
    }
    withHook(mock, () => {
      const slots = []
      const restore = installAudioWorkletHook((gain, tap, audibleMeter) => {
        slots.push(createPooledSlot(gain, `hook-${slots.length}`, tap, audibleMeter))
      })
      try {
        mock.source.connect(mock.destination, 0)
        mock.source.connect(mock.destination, 1)
        assert.equal(slots.length, 2)
        assert.equal(slots[0].tap, null)
        assert.ok(slots[0].audibleMeter, 'third callback argument survives the absent first tap')
        assert.equal(slots[0].audibleMeter, slots[1].audibleMeter)
        if (failure === 'all-taps') assert.equal(slots[1].tap, null)
        else assert.ok(slots[1].tap.readMeanSquare() > 0, 'later raw tap is readable and positive')
        // This minimal AudioNode mock has no proof of a complete native graph.
        // Do not replace its real meter with a numeric stub to make it measurable.
        assert.ok(Number.isNaN(slots[0].audibleMeter.read(slots)))
        if (failure === 'mixed-meters') slots[1].audibleMeter = { read: () => 0.01 }
        if (failure === 'missing-first-metadata') slots[0].audibleMeter = null
        if (failure === 'missing-later-metadata') slots[1].audibleMeter = null
        assert.ok(Number.isNaN(sumTapPower(slots)))
        let auto
        const automaticWrites = []
        const f = controllerFixture({
          onLevelSample: (now, key) => auto.tick(now, key),
          onLevelReset: now => auto.invalidate(now)
        })
        f.state.google.slots = slots
        auto = createAutoBalance({
          participants: () => [...f.state.participants.values()], levels: key => f.controller.levelFor(key),
          onGain: (person, value) => automaticWrites.push([person.key, value])
        })
        withClock(f.doc, setNow => {
          auto.start(0)
          for (let t = 0; t < 24000; t += 30) {
            setNow(t)
            f.a.level.value = t < 12000 ? 0.6 : 0
            f.b.level.value = t < 12000 ? 0 : 0.6
            f.controller.route()
            if (t === 3000) {
              assert.equal(f.state.google.appliedParticipantKey, 'A')
              assert.ok(slots.every(slot => slot.appliedMultiplier === 2), 'manual gain routing survives optional analyser failure')
            }
          }
        })
        assert.deepEqual(automaticWrites, [])
        assert.equal(auto.targetDb, null)
        for (const key of ['A', 'B']) {
          const level = f.controller.levelFor(key)
          assert.equal(level.frames, 0)
          assert.equal(level.autoDb, null, 'unproved power never becomes auto-ready')
          assert.equal(level.typicalDb, null)
        }
        assert.equal(f.state.google.appliedParticipantKey, 'B')
        assert.ok(slots.every(slot => slot.appliedMultiplier === 0.5))
      } finally { restore() }
    })
  })
}

test('actual hook slots with no source taps can drive controller/auto using a declared shared numeric meter', () => {
  const mock = hookMock()
  mock.destination.context.createAnalyser = () => { throw new Error('optional source taps unavailable') }
  withHook(mock, () => {
    const slots = []
    const restore = installAudioWorkletHook((gain, tap, audibleMeter) => {
      slots.push(createPooledSlot(gain, `positive-${slots.length}`, tap, audibleMeter))
    })
    try {
      mock.source.connect(mock.destination, 0)
      mock.source.connect(mock.destination, 1)
      assert.ok(slots.every(slot => slot.tap === null))
      let auto, reads = 0
      const automaticWrites = []
      const f = controllerFixture({
        onLevelSample: (now, key) => auto.tick(now, key),
        onLevelReset: now => auto.invalidate(now)
      })
      // Explicit test-only numeric input after connecting: tests metadata plumbing
      // and controller functionality, NOT native audible-path support or proof.
      const numericMeter = { generation: 0, read: measured => {
        assert.deepEqual(measured, slots)
        reads++
        return f.power.value
      } }
      for (const slot of slots) slot.audibleMeter = numericMeter
      f.state.google.slots = slots
      for (const person of f.state.participants.values()) person.value = 1
      auto = createAutoBalance({
        participants: () => [...f.state.participants.values()], levels: key => f.controller.levelFor(key),
        onGain: (person, value) => { automaticWrites.push([person.key, value]); person.value = value; f.controller.applyParticipantGain(person) }
      })
      withClock(f.doc, setNow => {
        auto.start(0)
        for (let t = 0; t < 24000; t += 30) {
          setNow(t)
          f.a.level.value = t < 12000 ? 0.6 : 0
          f.b.level.value = t < 12000 ? 0 : 0.6
          // A sits at -20 dB; B is 10 dB louder, above the call reference
          // (median of the two, -15 dB).
          f.power.value = dbToPower(t < 12000 ? -20 : -10)
          f.controller.route()
        }
        assert.ok(reads > 60)
        assert.ok(Number.isFinite(f.controller.levelFor('B').autoDb))
        assert.ok(automaticWrites.some(([key]) => key === 'B'))
        assert.ok(automaticWrites.every(([key, value]) => key === 'B' && value < 1), 'only the loud voice is reduced')
        // Generation belongs to the independent meter even when every tap is null.
        numericMeter.generation++
        setNow(24000); f.controller.route()
        assert.equal(f.controller.levelFor('B').autoDb, null)
        assert.equal(auto.targetDb, null)
      })
    } finally { restore() }
  })
})

// Controller integration with Meet's native activity model (see native-activity.test.js).
class Model {
  constructor(participantId, level) { this.Xa = { Yc: () => participantId, Yec: () => level.value }; this.disposed = false }
  isDisposed() { return this.disposed }
  Yc(){return this.Xa.Yc()}
  oa(){return this.Xa.Yec()}
}
class Ring { constructor(holder) { this.di = holder; this.element = {} }
  Cbc(){var a=Math.round(this.di.Aa.oa()*5);this.element.Ga=a>0} }
function nativeRoot(participantId) {
  const level = { value: 0 }
  const model = new Model(participantId, level)
  const ringElement = { getAttribute: () => 'ring', __jscontroller: { pending: { value: new Ring({ Aa: model }) } } }
  const root = {
    isConnected: true, getAttribute: name => name === 'data-participant-id' ? participantId : null,
    __jsmodel: { A0Tiaf: { pending: { value: { wy: model } } } },
    querySelectorAll: () => [ringElement], querySelector: () => null, matches: () => false
  }
  return { root, level }
}

function controllerFixture(callbacks = {}) {
  const a = nativeRoot('device-a'), b = nativeRoot('device-b')
  const doc = { hidden: false, querySelectorAll: selector => selector === '[data-participant-id]' ? [a.root, b.root] : [] }
  const person = (key, id, root, value) => ({ key, participantId: id, element: root, name: key, platform: 'google-meet', present: true, speaking: false, lastSpeakingAt: 0, value, muted: false })
  const alice = person('A', 'device-a', a.root, 2), bob = person('B', 'device-b', b.root, 0.5)
  const power = { value: dbToPower(-26) }
  let reads = 0
  const writes = []
  const slot = {
    // Synthetic level/controller input only; this does not establish native audio proof.
    gain: {}, appliedMultiplier: 1, tap: null,
    audibleMeter: { read: () => { reads++; return power.value } },
    set(value) { writes.push(value); this.appliedMultiplier = value }, release() { this.appliedMultiplier = 1 }, destroy() {}
  }
  const state = {
    participants: new Map([['A', alice], ['B', bob]]),
    google: {
      slots: [slot], mediaPipelines: [], mode: 'worklet', activeParticipantKey: null, appliedParticipantKey: null,
      routingState: 'idle', transitionGuard: { candidateParticipantKey: null, candidateSince: 0 },
      routing: {}, rosterSignature: '', localPresentationActive: false
    }
  }
  const controller = createGoogleMeetController({ state, context: {}, setStatus() {}, renderSoon() {}, updateLiveUi() {}, ...callbacks })
  return { a, b, doc, state, slot, writes, controller, power, reads: () => reads }
}

function withClock(doc, run) {
  const originalDocument = globalThis.document
  const originalNow = Date.now
  let now = 0
  globalThis.document = doc
  Date.now = () => now
  try { return run(ms => { now = ms }) } finally { Date.now = originalNow; globalThis.document = originalDocument }
}

test('controller learns only the confirmed sole speaker and routing writes are unchanged by measurement', () => {
  const f = controllerFixture()
  const reference = controllerFixture()
  reference.slot.audibleMeter = null
  withClock(f.doc, setNow => {
    const run = (fixture, from, to) => { for (let t = from; t < to; t += 30) { setNow(t); fixture.controller.route() } }
    f.a.level.value = 0.6; reference.a.level.value = 0.6
    run(f, 0, 4000); run(reference, 0, 4000)
    const level = f.controller.levelFor('A')
    assert.ok(Math.abs(level.typicalDb + 26) < 1e-6, String(level.typicalDb))
    assert.equal(f.controller.levelFor('B').typicalDb, null)
    // Quiet between words while A stays latched: no frames.
    const frames = level.frames
    f.a.level.value = 0; reference.a.level.value = 0
    run(f, 4000, 6000); run(reference, 4000, 6000)
    assert.equal(f.controller.levelFor('A').frames, frames)
    assert.equal(f.controller.levelFor('A').liveDb, null)
    // Overlap: nobody is attributed.
    f.a.level.value = 0.6; f.b.level.value = 0.6; reference.a.level.value = 0.6; reference.b.level.value = 0.6
    const readsBefore = f.reads()
    run(f, 6000, 8000); run(reference, 6000, 8000)
    assert.equal(f.reads(), readsBefore)
    assert.equal(f.controller.levelFor('A').frames, frames)
    assert.equal(f.controller.levelFor('B').frames, 0)
    assert.deepEqual(f.writes, reference.writes)
    // Speaker data unavailable: nothing attributed.
    f.a.root.__jsmodel.A0Tiaf.pending.value.wy.disposed = true
    f.b.level.value = 0
    run(f, 8000, 10000)
    assert.equal(f.state.google.routingState, 'speaker-data-unavailable')
    assert.equal(f.reads(), readsBefore)
  })
})

test('controller does not attribute during local presentation', () => {
  const f = controllerFixture()
  f.state.google.localPresentationActive = true
  withClock(f.doc, setNow => {
    f.a.level.value = 0.6
    for (let t = 0; t < 4000; t += 30) { setNow(t); f.controller.route() }
  })
  assert.equal(f.reads(), 0)
  assert.equal(f.controller.levelFor('A').frames, 0)
})

test('actual routing samples drive auto; overlap, unknown, graph mutation and teardown cannot reuse evidence', () => {
  let auto, f, resets=0, stops=0
  const automaticWrites=[]
  f=controllerFixture({
    onLevelSample:(now,key)=>auto.tick(now,key),
    onLevelReset:now=>{resets++;auto.invalidate(now)},
    onStop:()=>{stops++;auto.stop()}
  })
  for (const person of f.state.participants.values()) person.value = 1
  auto=createAutoBalance({participants:()=>[...f.state.participants.values()],levels:k=>f.controller.levelFor(k),onGain:(p,v)=>{automaticWrites.push([p.key,v]);p.value=v;f.controller.applyParticipantGain(p)}})
  withClock(f.doc,setNow=>{
    auto.start(0)
    const run=(from,to)=>{for(let t=from;t<to;t+=30){setNow(t);f.controller.route()}}
    // A at -20 dB is untouched (a lone voice within 4 dB, then at the -15 dB
    // call reference within the 95% interval); B 10 dB louder is reduced.
    f.a.level.value=0.6;f.power.value=dbToPower(-20);run(0,12000)
    f.a.level.value=0;f.b.level.value=0.6;f.power.value=dbToPower(-10);run(12000,24000)
    assert.ok(automaticWrites.some(([k])=>k==='B'))
    assert.ok(automaticWrites.every(([k,v])=>k==='B'&&v<1))
    const before=automaticWrites.length
    f.a.level.value=0.6;run(24000,26000)
    assert.equal(automaticWrites.length,before,'overlap')
    f.a.root.__jsmodel.A0Tiaf.pending.value.wy.disposed=true
    f.b.level.value=0;run(26000,28000)
    assert.equal(automaticWrites.length,before,'unavailable')
    const resetsBefore=resets
    f.slot.tap={readMeanSquare:()=>dbToPower(-10)}
    run(28000,28100)
    assert.equal(resets,resetsBefore+1)
    assert.equal(f.controller.levelFor('B').autoDb,null)
    f.controller.stop();run(29000,30000)
    assert.equal(stops,1)
    assert.equal(auto.enabled,false)
    assert.equal(automaticWrites.length,before)
  })
})


test('actual controller acquires two conversational voices at the reference level despite minority quiet expression', () => {
  let auto
  const writes = []
  const f = controllerFixture({ onLevelSample: (now, key) => auto.tick(now, key), onLevelReset: now => auto.invalidate(now) })
  for (const person of f.state.participants.values()) person.value = 1
  auto = createAutoBalance({ participants: () => [...f.state.participants.values()], levels: key => f.controller.levelFor(key),
    onGain(person, value) { writes.push([person.key, value]); person.value = value; f.controller.applyParticipantGain(person) } })
  withClock(f.doc, setNow => {
    auto.start(0)
    for (let now = 0; now < 28000; now += 30) {
      setNow(now)
      const phase = now % 14000
      f.a.level.value = now < 14000 ? 0.6 : 0
      f.b.level.value = now < 14000 ? 0 : 0.6
      // A declared settled numeric meter, NOT a native waveform or live call.
      f.power.value = dbToPower(phase >= 4500 && phase < 6000 ? -32 : -20)
      f.controller.route()
    }
    assert.equal(auto.targetDb, -20)
    assert.deepEqual(writes, [])
    assert.equal(f.state.google.routingState, 'confirmed-speaker')
    f.controller.stop()
    assert.equal(f.controller.levelFor('A').autoDb, null)
  })
})

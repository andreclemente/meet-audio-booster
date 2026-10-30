import test from 'node:test'
import assert from 'node:assert/strict'
import { writeAudioParam } from '../src/shared/audio.js'
import { createPooledSlot } from '../src/platforms/google-meet/audio-worklet.js'
import { createMediaElementPipeline } from '../src/platforms/google-meet/media-elements.js'
import { createWorkletSpeakerTracker, applyMediaPipelineOutputs, activateMediaModePipelines } from '../src/platforms/google-meet/index.js'
import { routeGoogleAudio, createRoutingState } from '../src/platforms/google-meet/router.js'

function fixture() {
  const events = []
  const context = { currentTime: 12 }
  const param = { value: 1,
    setValueAtTime(value, time) { events.push(['set', value, time]); this.value = value },
    linearRampToValueAtTime(value, time) { events.push(['ramp', value, time]) },
    cancelScheduledValues(time) { events.push(['cancel', time]) },
    cancelAndHoldAtTime(time) { events.push(['hold', time]) }
  }
  return { events, context, param }
}

test('gain writes use owning node clock, not nonexistent AudioParam.context', () => {
  const { param, context, events } = fixture()
  writeAudioParam(param, 4.5, { context, immediate: false })
  assert.deepEqual(events.at(-1), ['ramp', 4.5, 12.01])
})
test('unchanged target coalesces instead of restarting ramp on every route tick', () => {
  const { param, context, events } = fixture()
  writeAudioParam(param, 4.5, { context, immediate: false })
  const count = events.length
  writeAudioParam(param, 4.5, { context, immediate: false })
  assert.equal(events.length, count)
})
test('rapid retarget holds current ramp value when hold API unavailable', () => {
  const { param, context, events } = fixture()
  delete param.cancelAndHoldAtTime
  writeAudioParam(param, 4.5, { context, immediate: false })
  context.currentTime += 0.005
  writeAudioParam(param, 0, { context, immediate: false })
  const start = events.at(-2)
  assert.equal(start[0], 'set')
  assert.ok(Math.abs(start[1] - 2.75) < 1e-9)
  assert.deepEqual(events.at(-1), ['ramp', 0, context.currentTime + 0.01])
})
test('safety unity cancels pending boost and writes exact unity now', () => {
  const { param, context, events } = fixture()
  writeAudioParam(param, 4.5, { context, immediate: false })
  context.currentTime += 0.002
  writeAudioParam(param, 1, { context, immediate: true })
  assert.deepEqual(events.slice(-2), [['cancel', 0], ['set', 1, context.currentTime]])
})
test('pooled slot honors normal ramp and literal immediate safety release', () => {
  const { param, context, events } = fixture()
  const slot = createPooledSlot({ gain: param, context }, 'synthetic')
  slot.set(4.5)
  assert.equal(events.at(-1)[0], 'ramp')
  slot.release()
  assert.deepEqual(events.slice(-2), [['cancel', 0], ['set', 1, context.currentTime]])
})
test('clock advanced past ramp and paused clock retarget from exact endpoint/current value', () => {
  const { param, context, events } = fixture()
  delete param.cancelAndHoldAtTime
  writeAudioParam(param, 4.5, { context, immediate: false })
  context.currentTime = 20
  writeAudioParam(param, 0, { context, immediate: false })
  assert.equal(events.at(-2)[1], 4.5)
  writeAudioParam(param, 1, { context, immediate: false })
  assert.equal(events.at(-2)[1], 4.5)
})
test('automation failure falls back to exact assignment without throwing', () => {
  const { param, context } = fixture()
  param.linearRampToValueAtTime = () => { throw Error('unsupported') }
  writeAudioParam(param, 0, { context, immediate: false })
  assert.equal(param.value, 0)
})

test('release cancels an unfinished normal return to unity, not just boosts', () => {
  const { param, context, events } = fixture()
  const slot = createPooledSlot({ gain: param, context }, 'a')
  slot.set(4.5)
  context.currentTime += 0.02
  slot.set(1)
  slot.destroy()
  assert.deepEqual(events.slice(-2), [['cancel', 0], ['set', 1, context.currentTime]])
})

function mediaFixture() {
  const f = fixture()
  Object.assign(f.context, {
    destination: {}, createGain: () => ({ gain: f.param, connect() {}, disconnect() {} }),
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    createAnalyser: () => ({ fftSize: 256, getFloatTimeDomainData(b) { b.fill(0) }, disconnect() {} })
  })
  const track = { id: 't', readyState: 'live' }
  const audio = { srcObject: { id: 's', getAudioTracks: () => [track] }, muted: false, volume: 0.6, isConnected: true }
  const pipeline = createMediaElementPipeline(f.context, audio, 'p')
  Object.assign(pipeline, { participantKey: 'a', associationReliable: true })
  const routing = { routingState: 'confirmed-speaker', appliedPipelineId: 'p', appliedParticipantKey: 'a', multiplier: 4.5 }
  return { ...f, pipeline, audio, routing }
}

test('media route ticks and activation scans preserve boost/mute/user-unity ramps', () => {
  const { pipeline, routing, events, context } = mediaFixture()
  for (const target of [4.5, 0, 1]) {
    routing.multiplier = target
    if (!pipeline.connected) activateMediaModePipelines([pipeline], routing)
    else applyMediaPipelineOutputs([pipeline], routing, target)
    const count = events.length
    context.currentTime += 0.002
    activateMediaModePipelines([pipeline], routing)
    applyMediaPipelineOutputs([pipeline], routing, target)
    assert.equal(events.length, count)
    context.currentTime += 0.02
  }
})

test('media ambiguity, association loss and deselection cancel queued boost immediately', () => {
  for (const state of ['idle', 'ambiguous', 'multiple-active-streams', 'hidden-tab', 'no-reliable-association']) {
    const { pipeline, routing, events, context } = mediaFixture()
    activateMediaModePipelines([pipeline], routing)
    applyMediaPipelineOutputs([pipeline], { routingState: state }, 4.5)
    assert.deepEqual(events.slice(-2), [['cancel', 0], ['set', 1, context.currentTime]])
  }
})

test('presentation/disconnect teardown neutralizes pending media gain before native restoration', () => {
  for (const method of ['deactivate', 'destroy']) {
    const { pipeline, routing, events, context, audio } = mediaFixture()
    activateMediaModePipelines([pipeline], routing)
    pipeline[method]()
    assert.deepEqual(events.slice(-2), [['cancel', 0], ['set', 1, context.currentTime]])
    assert.equal(audio.muted, false)
    assert.equal(audio.volume, 0.6)
  }
})

test('worklet already holds confirmed boosted and muted gain during UI-marker silence', () => {
  for (const value of [4.5, 0]) {
    const tracker = createWorkletSpeakerTracker()
    const a = { key: 'a', value }
    tracker.update({ now: 0, speakers: [a] })
    assert.equal(tracker.update({ now: 60, speakers: [a] }).multiplier, value)
    assert.equal(tracker.update({ now: 6000, speakers: [] }).multiplier, value)
    assert.equal(tracker.update({ now: 6010, speakers: [a, { key: 'b', value: 1 }] }).multiplier, 1)
    assert.equal(tracker.update({ now: 6020, speakers: [], hidden: true }).multiplier, 1)
  }
})

function quietFixture(value = 4.5) {
  const f = mediaFixture()
  const participants = { a: { value, present: true }, b: { value: 1, present: true } }
  f.pipeline.activeByEnergy = true
  let routing = routeGoogleAudio(createRoutingState(), { participants, pipelines: [f.pipeline], uiSpeakerKeys: ['a'] })
  activateMediaModePipelines([f.pipeline], routing)
  f.context.currentTime += 0.02
  f.pipeline.activeByEnergy = false
  routing = routeGoogleAudio(routing, { participants, pipelines: [f.pipeline], uiSpeakerKeys: [] })
  return { ...f, participants, routing }
}

test('proven same-owner energy idle fades to unity, repeated route/scan ticks do not snap or extend it', () => {
  for (const value of [4.5, 0]) {
    const f = quietFixture(value)
    const { pipeline, participants, context, events } = f
    let { routing } = f
    assert.equal(routing.routingState, 'energy-idle')
    assert.equal(routing.multiplier, 1)
    applyMediaPipelineOutputs([pipeline], routing, 1)
    assert.deepEqual(events.at(-1), ['ramp', 1, context.currentTime + 0.01])
    assert.equal(events.at(-2)[1], value)
    const count = events.length
    for (const advance of [0.002, 0.002, 10]) {
      context.currentTime += advance
      routing = routeGoogleAudio(routing, { participants, pipelines: [pipeline] })
      activateMediaModePipelines([pipeline], routing)
      applyMediaPipelineOutputs([pipeline], routing, 1)
      assert.equal(events.length, count)
      assert.equal(pipeline.targetValue, 1) // No silence latch of boost OR mute.
    }
    pipeline.activeByEnergy = true
    routing = routeGoogleAudio(routing, { participants, pipelines: [pipeline], uiSpeakerKeys: ['a'] })
    applyMediaPipelineOutputs([pipeline], routing, routing.multiplier)
    assert.equal(events.at(-1)[0], 'ramp')
    assert.equal(events.at(-1)[1], value)
  }
})

test('quiet fade requires exact surviving pipeline, stream, association and participant identities', () => {
  const mutations = [
    f => { f.pipeline.associationReliable = false },
    f => { f.pipeline.participantKey = 'b' },
    f => { f.pipeline.streamKey = 'reused' },
    f => { f.pipeline.stream = { ...f.pipeline.stream } },
    f => { f.pipeline.tracks[0].readyState = 'ended' },
    f => { f.audio.srcObject = { ...f.audio.srcObject } },
    f => { f.audio.isConnected = false },
    f => { f.audio.srcObject.getAudioTracks = () => [{ id: 'replacement', readyState: 'live' }] },
    f => { f.participants.a.present = false },
    f => { delete f.participants.a },
    f => { f.participants.a = { value: 4.5, present: true } }
  ]
  for (const mutate of mutations) {
    const f = quietFixture()
    applyMediaPipelineOutputs([f.pipeline], f.routing, 1)
    f.context.currentTime += 0.002
    mutate(f)
    const routing = routeGoogleAudio(f.routing, { participants: f.participants, pipelines: [f.pipeline] })
    assert.notEqual(routing.routingState, 'energy-idle')
    applyMediaPipelineOutputs([f.pipeline], routing, 1)
    assert.deepEqual(f.events.slice(-2), [['cancel', 0], ['set', 1, f.context.currentTime]])
  }
  const f = quietFixture()
  const replacement = { ...f.pipeline }
  const routing = routeGoogleAudio(f.routing, { participants: f.participants, pipelines: [replacement] })
  assert.notEqual(routing.routingState, 'energy-idle') // Same ID is not same pipeline.
})

test('new unsafe UI or energetic evidence cancels quiet fade immediately and cannot recover a stale fade', () => {
  for (const [uiSpeakerKeys, extra] of [ [['b'], []], [['a', 'b'], []], [[], [{ id: 'unknown', activeByEnergy: true, set() {} }]],
    [[], [{ id: 'b', participantKey: 'b', associationReliable: true, activeByEnergy: true, set() {} }]] ]) {
    const f = quietFixture()
    applyMediaPipelineOutputs([f.pipeline], f.routing, 1)
    f.context.currentTime += 0.002
    let routing = routeGoogleAudio(f.routing, { participants: f.participants, pipelines: [f.pipeline, ...extra], uiSpeakerKeys })
    applyMediaPipelineOutputs([f.pipeline, ...extra], routing, 1)
    assert.deepEqual(f.events.slice(-2), [['cancel', 0], ['set', 1, f.context.currentTime]])
    routing = routeGoogleAudio(routing, { participants: f.participants, pipelines: [f.pipeline] })
    assert.notEqual(routing.routingState, 'energy-idle')
  }
})

test('scan during quiet fade revalidates whole pool and association before route tick', () => {
  for (const invalidate of [f => { f.pipeline.associationReliable = false }, f => { f.audio.isConnected = false },
    f => { f.pipeline.participantKey = 'b' }, f => { f.extra.push({ id: 'unknown', activeByEnergy: true, set() {} }) }]) {
    const f = { ...quietFixture(), extra: [] }
    applyMediaPipelineOutputs([f.pipeline], f.routing, 1)
    f.context.currentTime += 0.002
    invalidate(f)
    activateMediaModePipelines([f.pipeline, ...f.extra], f.routing)
    assert.deepEqual(f.events.slice(-2), [['cancel', 0], ['set', 1, f.context.currentTime]])
  }
})

test('explicit safety reset/teardown interrupts quiet fade even when target already equals unity', () => {
  for (const reset of [f => applyMediaPipelineOutputs([f.pipeline], f.routing, 1, true),
    f => applyMediaPipelineOutputs([f.pipeline], { routingState: 'hidden-tab' }, 1),
    f => f.pipeline.deactivate(), f => f.pipeline.destroy()]) {
    for (const value of [4.5, 0]) {
      const f = quietFixture(value)
      applyMediaPipelineOutputs([f.pipeline], f.routing, 1)
      f.context.currentTime += 0.002
      reset(f)
      assert.deepEqual(f.events.slice(-2), [['cancel', 0], ['set', 1, f.context.currentTime]])
    }
  }
})

test('media silence fallback and energy/UI lag remain safe, including A-to-B handoff', () => {
  const participants = { a: { value: 4.5 }, b: { value: 0 } }
  const a = { id: 'a', participantKey: 'a', associationReliable: true, activeByEnergy: true }
  const b = { id: 'b', participantKey: 'b', associationReliable: true, activeByEnergy: true }
  let state = routeGoogleAudio(createRoutingState(), { now: 0, participants, pipelines: [a] })
  assert.equal(state.multiplier, 4.5)
  for (const [pipelines, uiSpeakerKeys] of [ [[{ ...a, activeByEnergy: false }], []], [[b], ['a']], [[a,b], []], [[{ ...a, associationReliable: false }], []], [[a], ['a','b']] ]) {
    assert.equal(routeGoogleAudio(state, { participants, pipelines, uiSpeakerKeys }).multiplier, 1)
  }
  state = routeGoogleAudio(state, { now: 100, participants, pipelines: [b] })
  assert.equal(state.multiplier, 1)
  assert.equal(routeGoogleAudio(state, { now: 1000, participants, pipelines: [b] }).multiplier, 0)
})

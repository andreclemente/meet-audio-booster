import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { applyMediaPipelineOutputs, activateMediaModePipelines } from '../src/platforms/google-meet/index.js'
import { createFreshAlignmentTracker, createAssociationLearner } from '../src/platforms/google-meet/association.js'
import { routeGoogleAudio, createRoutingState } from '../src/platforms/google-meet/router.js'
import { scanMeetParticipants, isSelfParticipant } from '../src/platforms/google-meet/participants.js'
import { installAudioWorkletHook, createPooledSlot } from '../src/platforms/google-meet/audio-worklet.js'
import { createAudioContext } from '../src/shared/audio.js'
import { createDebugInfo } from '../src/shared/debug.js'

test('media output applies a participant multiplier only to its selected pipeline', () => {
  const values = []
  const pipelines = ['a', 'b'].map(id => ({
    id, participantKey: id.toUpperCase(), associationReliable: true,
    set(value) { values.push([id, value]); this.appliedMultiplier = value }
  }))
  applyMediaPipelineOutputs(pipelines, {
    routingState: 'confirmed-speaker', appliedParticipantKey: 'A', appliedPipelineId: 'a'
  }, 4.5, true)
  assert.deepEqual(values, [['a', 4.5], ['b', 1]])
  values.length = 0
  applyMediaPipelineOutputs(pipelines, {
    routingState: 'confirmed-speaker', appliedParticipantKey: 'A', appliedPipelineId: 'a'
  }, 0, true)
  assert.deepEqual(values, [['a', 0], ['b', 1]])
  values.length = 0
  applyMediaPipelineOutputs(pipelines, { routingState: 'stale-ui-speaker' }, 4.5)
  assert.deepEqual(values, [['a', 1], ['b', 1]])
})

test('new pipelines are activated at a safe value after media mode is already active', () => {
  const calls = []
  const pipelines = [
    { id: 'a', participantKey: 'A', associationReliable: true, set(value, immediate) { calls.push(['a', value, immediate]) } },
    { id: 'new-b', participantKey: null, associationReliable: false, set(value, immediate) { calls.push(['new-b', value, immediate]) } }
  ]
  activateMediaModePipelines(pipelines, {
    routingState: 'confirmed-speaker', appliedParticipantKey: 'A', appliedPipelineId: 'a', multiplier: 4.5
  })
  assert.deepEqual(calls, [['a', 4.5, true], ['new-b', 1, true]])
})

test('stuck UI A cannot teach newly energetic B or leak muted/high A gain to B', () => {
  const tracker = createFreshAlignmentTracker({ freshMs: 100 })
  const learner = createAssociationLearner(3)
  let alignment
  for (const now of [0, 20, 40]) {
    alignment = tracker.observe(now, ['A'], ['pipe-a'])
    if (alignment.mayLearn) learner.observe('pipe-a', 'A', { exclusiveUi: true, exclusiveEnergy: true })
  }
  assert.equal(learner.get('pipe-a').associationReliable, true)
  alignment = tracker.observe(1000, ['A'], ['pipe-b'])
  assert.equal(alignment.mayLearn, false)
  for (const now of [1020, 1040, 1060]) {
    alignment = tracker.observe(now, ['A'], ['pipe-b'])
    if (alignment.mayLearn) learner.observe('pipe-b', 'A', { exclusiveUi: true, exclusiveEnergy: true })
  }
  assert.equal(learner.get('pipe-b').associationReliable, false)
  const routing = routeGoogleAudio(createRoutingState(), {
    now: 1060,
    participants: { A: { key: 'A', value: 4.5, muted: true }, B: { key: 'B', value: 1, muted: false } },
    uiSpeakerKeys: ['A'],
    pipelines: [{ id: 'pipe-b', activeByEnergy: true, ...learner.get('pipe-b') }]
  })
  const pipelines = ['pipe-a', 'pipe-b'].map(id => ({ id, set(value) { this.appliedMultiplier = value } }))
  applyMediaPipelineOutputs(pipelines, routing, routing.multiplier)
  assert.equal(routing.multiplier, 1)
  assert.equal(pipelines[0].appliedMultiplier, 1)
  assert.equal(pipelines[1].appliedMultiplier, 1)
})

test('neutral worklet routing does not repeatedly rewrite the multiplier', () => {
  const writes = []
  const gain = {
    gain: {
      value: 1,
      context: { currentTime: 0 },
      setValueAtTime(value) { writes.push(value); this.value = value }
    }
  }
  const slot = createPooledSlot(gain, 'slot-1')

  slot.neutral(true)
  gain.gain.value = 0
  slot.set(1)

  assert.equal(gain.gain.value, 0)
  assert.deepEqual(writes, [1])
})

test('worklet hook inserts an extension-owned gain and preserves Meet gain ownership', () => {
  const OriginalAudioNode = globalThis.AudioNode
  const calls = []
  const disconnects = []
  let extensionGain = null
  let disposed = 0

  class FakeAudioNode {
    constructor(context) { this.context = context }
    connect(destination, ...ports) {
      calls.push({ from: this, to: destination, ports })
      return destination
    }
    disconnect(...args) { disconnects.push({ from: this, args }) }
  }
  class AudioWorkletNode extends FakeAudioNode {}
  class GainNode extends FakeAudioNode {
    constructor(context) {
      super(context)
      this.gain = { value: 1, context, setValueAtTime(value) { this.value = value } }
    }
  }
  const context = {
    currentTime: 0,
    createGain() { extensionGain = new GainNode(this); return extensionGain }
  }
  const source = new AudioWorkletNode(context)
  const meetGain = new GainNode(context)
  let slot = null

  globalThis.AudioNode = FakeAudioNode
  try {
    const restore = installAudioWorkletHook(gain => {
      slot = createPooledSlot(gain, 'slot-1')
      return () => { disposed++ }
    })
    const result = source.connect(meetGain, 2, 3)

    assert.equal(result, meetGain)
    assert.ok(extensionGain)
    assert.equal(slot.gain, extensionGain)
    assert.deepEqual(calls.map(call => [call.from, call.to, call.ports]), [
      [source, extensionGain, [2, 0]],
      [extensionGain, meetGain, [0, 3]]
    ])

    meetGain.gain.value = 0
    slot.set(2, true)
    assert.equal(meetGain.gain.value, 0)
    assert.equal(extensionGain.gain.value, 2)

    source.disconnect(meetGain, 2, 3)
    assert.deepEqual(disconnects.map(call => [call.from, call.args]), [
      [source, [extensionGain, 2, 0]],
      [extensionGain, [meetGain, 0, 3]]
    ])
    assert.equal(disposed, 1)

    calls.length = 0
    disconnects.length = 0
    source.connect(meetGain)
    const coercibleOutputGain = extensionGain
    source.disconnect('0')
    assert.deepEqual(disconnects.map(call => [call.from, call.args]), [
      [source, ['0']],
      [coercibleOutputGain, [meetGain, 0, 0]]
    ])
    assert.equal(disposed, 2)

    calls.length = 0
    disconnects.length = 0
    source.connect(meetGain)
    const liveGain = extensionGain
    restore()
    assert.deepEqual(calls.map(call => [call.from, call.to, call.ports]), [
      [source, liveGain, [0, 0]],
      [liveGain, meetGain, [0, 0]],
      [source, meetGain, [0, 0]]
    ])
    assert.deepEqual(disconnects.map(call => [call.from, call.args]), [
      [source, [liveGain, 0, 0]],
      [liveGain, [meetGain, 0, 0]]
    ])
    assert.equal(disposed, 3)
  } finally {
    globalThis.AudioNode = OriginalAudioNode
    delete globalThis.__meetingAudioBoosterWorkletHook
  }
})

test('stopping worklet hook does not overwrite a later AudioNode connect wrapper', () => {
  const originalAudioNode = globalThis.AudioNode
  function AudioNode() {}
  const original = function () {}
  AudioNode.prototype.connect = original
  globalThis.AudioNode = AudioNode
  try {
    const restore = installAudioWorkletHook(() => {})
    const extensionWrapper = AudioNode.prototype.connect
    const laterWrapper = function (...args) { return extensionWrapper.apply(this, args) }
    AudioNode.prototype.connect = laterWrapper
    restore()
    assert.equal(AudioNode.prototype.connect, laterWrapper)
  } finally {
    globalThis.AudioNode = originalAudioNode
    delete globalThis.__meetingAudioBoosterWorkletHook
  }
})

test('AudioContext constructor failures are represented as unavailable', () => {
  const Original = globalThis.AudioContext
  globalThis.AudioContext = class { constructor() { throw new Error('denied') } }
  try { assert.equal(createAudioContext(), null) } finally { globalThis.AudioContext = Original }
})

test('remote mute helper text does not identify a participant as self', () => {
  const root = {
    innerText: "keep_outline Pin André Clemente mic_off You can't unmute someone else André Clemente",
    textContent: "keep_outline Pin André Clemente mic_off You can't unmute someone else André Clemente",
    querySelectorAll(selector) { return selector === '[aria-label]' ? [] : [] }
  }
  assert.equal(isSelfParticipant(root), false)
})

function namedNode(name) {
  return {
    textContent: name,
    matches(selector) { return selector.includes('.zWGUib') && !selector.includes('button') },
    getAttribute() { return null }
  }
}

function participantRoot(id, { name = null, requested = false, role = 'listitem', text = '' } = {}) {
  const node = name ? namedNode(name) : null
  return {
    innerText: text, textContent: text,
    getAttribute(attr) {
      if (attr === 'data-participant-id') return id
      if (attr === 'data-requested-participant-id') return requested ? id : null
      return null
    },
    matches(selector) { return selector.includes(`[role="${role}"]`) },
    querySelector(selector) { return node && selector.includes('.zWGUib') ? node : null },
    querySelectorAll(selector) {
      if (selector === '*') return node ? [node] : []
      if (selector.includes('.zWGUib')) return node ? [node] : []
      return []
    }
  }
}

test('production participant scan rejects chat IDs and icon text but accepts a strict tile', () => {
  const chat = participantRoot('chat-id', { text: 'Fake Chat Name', role: 'listitem' })
  const icon = participantRoot('icon-id', { name: 'keep_outline' })
  const real = participantRoot('real-id', { name: 'Alice Smith' })
  const root = { querySelectorAll: () => [chat, icon, real] }
  assert.deepEqual(scanMeetParticipants(root).map(item => [item.participantId, item.name]), [['real-id', 'Alice Smith']])
})

test('debug snapshots expose required JSON-safe pipeline and participant fields', () => {
  const participant = { key: 'A', name: 'Alice', isSelf: false, speaking: true, value: 4.5, muted: true }
  const state = {
    platform: 'google-meet', status: 'ok',
    google: {
      slots: [], activeParticipantKey: null, appliedParticipantKey: null, routingState: 'idle',
      transitionGuard: {}, mode: 'media',
      mediaPipelines: [{
        id: 'p', stream: { id: 's' }, connected: true, rms: 0.2, activeByEnergy: true,
        appliedMultiplier: 1, targetValue: 1, gain: { gain: { value: 1 } },
        tracks: [{ id: 't', muted: false, readyState: 'live' }]
      }]
    }
  }
  const info = createDebugInfo(state, () => [participant])
  assert.deepEqual(Object.keys(info.participants[0]).sort(), ['configuredMultiplier', 'isSelf', 'isSpeakingByUi', 'key', 'muted', 'name'].sort())
  for (const field of ['id', 'streamId', 'trackId', 'connected', 'muted', 'readyState', 'rms', 'activeByEnergy', 'appliedMultiplier', 'targetValue', 'actualValue']) {
    assert.ok(Object.hasOwn(info.mediaPipelines[0], field), field)
  }
  assert.doesNotThrow(() => JSON.stringify(info))
})

test('manifest metadata matches the package and product name', async () => {
  const root = path.resolve(import.meta.dirname, '..')
  const [manifest, pkg] = await Promise.all(['manifest.json', 'package.json'].map(async file => JSON.parse(await readFile(path.join(root, file), 'utf8'))))
  assert.equal(manifest.version, pkg.version)
  assert.equal(manifest.name, 'Meet Audio Booster')
  assert.equal(manifest.action.default_title, 'Show Meet Audio Booster')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { applyMediaPipelineOutputs, activateMediaModePipelines } from '../src/platforms/google-meet/index.js'
import { createFreshAlignmentTracker, createAssociationLearner } from '../src/platforms/google-meet/association.js'
import { routeGoogleAudio, createRoutingState } from '../src/platforms/google-meet/router.js'
import { scanMeetParticipants, isSelfParticipant, isLocalPresentationRoot } from '../src/platforms/google-meet/participants.js'
import { installAudioWorkletHook, createPooledSlot } from '../src/platforms/google-meet/audio-worklet.js'
import { createAudioContext } from '../src/shared/audio.js'
import { installLocalPresentationCaptureHook } from '../src/platforms/google-meet/presentation.js'
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

test('pooled worklet routing writes only its owned gain at multiplier boundaries', () => {
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
  slot.set(2, true)
  slot.set(2, false)
  slot.neutral(true)
  slot.neutral(true)

  assert.deepEqual(writes, [2, 1])
  assert.equal(slot.appliedMultiplier, 1)
  assert.equal(slot.targetValue, 1)
})

test('worklet hook inserts one extension-owned gain without leaving a direct duplicate path', () => {
  const originalAudioNode = globalThis.AudioNode
  const connections = []
  const disconnections = []
  function AudioNode() {}
  AudioNode.prototype.connect = function (...args) { connections.push([this, ...args]); return args[0] }
  AudioNode.prototype.disconnect = function (...args) { disconnections.push([this, ...args]) }
  globalThis.AudioNode = AudioNode
  const source = Object.assign(Object.create(AudioNode.prototype), { constructor: { name: 'AudioWorkletNode' } })
  const destination = Object.assign(Object.create(AudioNode.prototype), {
    constructor: { name: 'GainNode' },
    context: {
      createGain() {
        return Object.assign(Object.create(AudioNode.prototype), {
          constructor: { name: 'GainNode' }, gain: { value: 1, setValueAtTime(value) { this.value = value } }
        })
      }
    }
  })
  const slots = []
  try {
    const restore = installAudioWorkletHook(slot => slots.push(slot))
    const result = source.connect(destination, 2, 1)
    const booster = slots[0]

    assert.equal(result, destination)
    assert.ok(booster)
    assert.deepEqual(disconnections, [[source, destination, 2, 1]])
    assert.deepEqual(connections, [
      [source, booster, 2],
      [booster, destination, 0, 1]
    ])
    source.connect(destination, 2, 1)
    assert.equal(slots.length, 1)
    assert.equal(connections.length, 2)

    source.disconnect(destination, 2, 1)
    assert.deepEqual(disconnections, [
      [source, destination, 2, 1],
      [source, destination, 2, 1],
      [source, booster, 2, 0],
      [booster, destination, 0, 1]
    ])
    restore()
  } finally {
    globalThis.AudioNode = originalAudioNode
    delete globalThis.__meetingAudioBoosterWorkletHook
  }
})

function createWorkletConnectionMock() {
  const calls = { connect: [], disconnect: [] }
  const edges = []
  const normalize = value => value === undefined ? 0 : value
  function AudioNode() {}
  AudioNode.prototype.connect = function (...args) {
    calls.connect.push([this, ...args])
    edges.push({ source: this, destination: args[0], output: normalize(args[1]), input: normalize(args[2]) })
    return args[0]
  }
  AudioNode.prototype.disconnect = function (...args) {
    calls.disconnect.push([this, ...args])
    const matches = edge => {
      if (edge.source !== this) return false
      if (!args.length) return true
      if (typeof args[0] === 'number') return edge.output === args[0]
      if (edge.destination !== args[0]) return false
      if (args.length > 1 && edge.output !== normalize(args[1])) return false
      if (args.length > 2 && edge.input !== normalize(args[2])) return false
      return true
    }
    const matched = edges.filter(matches)
    if (!matched.length) {
      const error = new Error('no matching native edge')
      error.name = 'InvalidAccessError'
      throw error
    }
    for (const edge of matched) edges.splice(edges.indexOf(edge), 1)
  }
  const source = Object.assign(Object.create(AudioNode.prototype), { constructor: { name: 'AudioWorkletNode' } })
  const destination = Object.assign(Object.create(AudioNode.prototype), {
    constructor: { name: 'GainNode' },
    context: {
      createGain() {
        return Object.assign(Object.create(AudioNode.prototype), {
          constructor: { name: 'GainNode' }, gain: { value: 1, setValueAtTime(value) { this.value = value } }
        })
      }
    }
  })
  return { AudioNode, source, destination, calls, edges }
}

test('worklet hook treats omitted and explicit undefined indices as the same connection', () => {
  const originalAudioNode = globalThis.AudioNode
  const { AudioNode, source, destination, calls } = createWorkletConnectionMock()
  globalThis.AudioNode = AudioNode
  const slots = []
  const removed = []
  try {
    const restore = installAudioWorkletHook(slot => slots.push(slot), slot => removed.push(slot))
    source.connect(destination, undefined, undefined)
    const booster = slots[0]
    source.connect(destination)

    assert.equal(slots.length, 1)
    assert.deepEqual(calls.connect, [
      [source, booster, undefined],
      [booster, destination, 0, undefined]
    ])

    assert.doesNotThrow(() => source.disconnect(destination, undefined, undefined))
    assert.deepEqual(calls.disconnect, [
      [source, destination, 0, 0],
      [source, destination, undefined, undefined],
      [source, booster, 0, 0],
      [booster, destination, 0, 0]
    ])
    assert.deepEqual(removed, [booster])
    restore()
  } finally {
    globalThis.AudioNode = originalAudioNode
    delete globalThis.__meetingAudioBoosterWorkletHook
  }
})

test('worklet hook replaces an identical pre-hook edge instead of creating a parallel path', () => {
  const originalAudioNode = globalThis.AudioNode
  const { AudioNode, source, destination, edges } = createWorkletConnectionMock()
  globalThis.AudioNode = AudioNode
  const slots = []
  try {
    source.connect(destination)
    const restore = installAudioWorkletHook(slot => slots.push(slot))
    source.connect(destination)
    const booster = slots[0]

    assert.equal(slots.length, 1)
    assert.equal(edges.some(edge => edge.source === source && edge.destination === destination), false)
    assert.equal(edges.filter(edge => edge.source === source && edge.destination === booster).length, 1)
    assert.equal(edges.filter(edge => edge.source === booster && edge.destination === destination).length, 1)
    restore()
  } finally {
    globalThis.AudioNode = originalAudioNode
    delete globalThis.__meetingAudioBoosterWorkletHook
  }
})

test('failed worklet-route replacement restores an identical pre-hook edge', () => {
  const originalAudioNode = globalThis.AudioNode
  const { AudioNode, source, destination, edges } = createWorkletConnectionMock()
  globalThis.AudioNode = AudioNode
  try {
    source.connect(destination)
    const restore = installAudioWorkletHook(() => {})
    destination.context.createGain = () => { throw new Error('gain unavailable') }

    assert.throws(() => source.connect(destination), /gain unavailable/)
    assert.equal(edges.some(edge => edge.source === source && edge.destination === destination && edge.output === 0 && edge.input === 0), true)
    restore()
  } finally {
    globalThis.AudioNode = originalAudioNode
    delete globalThis.__meetingAudioBoosterWorkletHook
  }
})

test('destination disconnect removes mixed direct and virtual routes', () => {
  const originalAudioNode = globalThis.AudioNode
  const { AudioNode, source, destination, calls, edges } = createWorkletConnectionMock()
  globalThis.AudioNode = AudioNode
  try {
    source.connect(destination, 1, 0)
    const restore = installAudioWorkletHook(() => {})
    source.connect(destination, undefined, undefined)
    const booster = calls.connect[1][1]

    assert.doesNotThrow(() => source.disconnect(destination))
    assert.equal(edges.some(edge => edge.source === source && edge.destination === destination), false)
    assert.deepEqual(calls.disconnect.map(call => call.slice(1)), [
      [destination, 0, 0],
      [destination],
      [booster, 0, 0],
      [destination, 0, 0]
    ])
    assert.throws(() => source.disconnect(destination), { name: 'InvalidAccessError' })
    restore()
  } finally {
    globalThis.AudioNode = originalAudioNode
    delete globalThis.__meetingAudioBoosterWorkletHook
  }
})

test('stopping worklet hook restores later wrappers without overwriting them', () => {
  const originalAudioNode = globalThis.AudioNode
  function AudioNode() {}
  const originalConnect = function () {}
  const originalDisconnect = function () {}
  AudioNode.prototype.connect = originalConnect
  AudioNode.prototype.disconnect = originalDisconnect
  globalThis.AudioNode = AudioNode
  try {
    const restore = installAudioWorkletHook(() => {})
    const extensionConnect = AudioNode.prototype.connect
    const extensionDisconnect = AudioNode.prototype.disconnect
    const laterConnect = function (...args) { return extensionConnect.apply(this, args) }
    const laterDisconnect = function (...args) { return extensionDisconnect.apply(this, args) }
    AudioNode.prototype.connect = laterConnect
    AudioNode.prototype.disconnect = laterDisconnect
    restore()
    assert.equal(AudioNode.prototype.connect, laterConnect)
    assert.equal(AudioNode.prototype.disconnect, laterDisconnect)
  } finally {
    globalThis.AudioNode = originalAudioNode
    delete globalThis.__meetingAudioBoosterWorkletHook
  }
})

test('display capture bypass activates before Meet receives the stream', async () => {
  const events = []
  let ended
  const track = {
    readyState: 'live',
    addEventListener(type, callback) { if (type === 'ended') ended = callback }
  }
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] }
  const original = async () => stream
  const prototype = { getDisplayMedia: original }
  const mediaDevices = Object.create(prototype)
  const restore = installLocalPresentationCaptureHook(active => events.push(active), mediaDevices)

  const returned = await mediaDevices.getDisplayMedia({ video: true, audio: true })
  assert.equal(returned, stream)
  assert.deepEqual(events, [true])

  track.readyState = 'ended'
  ended()
  assert.deepEqual(events, [true, false])
  restore()
  assert.equal(prototype.getDisplayMedia, original)
})

test('display capture bypass stays active until every overlapping capture ends', async () => {
  const events = []
  const callbacks = new Map()
  const makeTrack = id => ({
    id, readyState: 'live',
    addEventListener(type, callback) { if (type === 'ended') callbacks.set(id, callback) },
    removeEventListener() {}
  })
  const first = makeTrack('first')
  const second = makeTrack('second')
  const streams = [first, second].map(track => ({ getVideoTracks: () => [track], getTracks: () => [track] }))
  const original = async () => streams.shift()
  const prototype = { getDisplayMedia: original }
  const mediaDevices = Object.create(prototype)
  const restore = installLocalPresentationCaptureHook(active => events.push(active), mediaDevices)

  await mediaDevices.getDisplayMedia()
  await mediaDevices.getDisplayMedia()
  assert.deepEqual(events, [true])
  first.readyState = 'ended'
  callbacks.get('first')()
  assert.deepEqual(events, [true])
  second.readyState = 'ended'
  callbacks.get('second')()
  assert.deepEqual(events, [true, false])

  restore()
})

test('display capture bypass remains active while its audio track is still live', async () => {
  const events = []
  const callbacks = new Map()
  const makeTrack = id => ({
    id, readyState: 'live',
    addEventListener(type, callback) { if (type === 'ended') callbacks.set(id, callback) },
    removeEventListener() {}
  })
  const video = makeTrack('video')
  const audio = makeTrack('audio')
  const stream = { getVideoTracks: () => [video], getTracks: () => [video, audio] }
  const prototype = { getDisplayMedia: async () => stream }
  const mediaDevices = Object.create(prototype)
  const restore = installLocalPresentationCaptureHook(active => events.push(active), mediaDevices)

  await mediaDevices.getDisplayMedia()
  assert.deepEqual(events, [true])
  video.readyState = 'ended'
  callbacks.get('video')()
  assert.deepEqual(events, [true])
  audio.readyState = 'ended'
  callbacks.get('audio')()
  assert.deepEqual(events, [true, false])

  restore()
})

test('AudioContext constructor failures are represented as unavailable', () => {
  const Original = globalThis.AudioContext
  globalThis.AudioContext = class { constructor() { throw new Error('denied') } }
  try { assert.equal(createAudioContext(), null) } finally { globalThis.AudioContext = Original }
})

test('local presentation controls are detected without accepting a remote participant tile', () => {
  function root(text, name = null) {
    const node = name ? namedNode(name) : null
    return {
      innerText: text,
      textContent: text,
      getAttribute(attr) {
        return attr === 'data-participant-id' ? 'spaces/example/devices/147' : null
      },
      querySelector(selector) { return node && selector.includes('.zWGUib') ? node : null },
      querySelectorAll(selector) {
        if (selector === '[aria-label]') return []
        return node && selector.includes('.zWGUib') ? [node] : []
      }
    }
  }

  const presentationText = 'stylus_laser_pointer Everyone can see your annotations Scroll & zoom your presentation in Meet Enter Full Screen'
  assert.equal(isLocalPresentationRoot(root(presentationText)), true)
  assert.equal(isLocalPresentationRoot(root(presentationText, 'Alice Smith')), false)
  assert.equal(isLocalPresentationRoot(root(
    "keep_outline Pin André Clemente mic_off You can't unmute someone else More options for André Clemente"
  )), false)
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

test('production participant scan rejects chat, icon, and own-presentation records but accepts a strict tile', () => {
  const chat = participantRoot('chat-id', { text: 'Fake Chat Name', role: 'listitem' })
  const icon = participantRoot('icon-id', { name: 'keep_outline' })
  const presentation = participantRoot('presentation-id', {
    requested: true,
    text: 'Everyone can see your annotations Scroll & zoom your presentation in Meet'
  })
  const real = participantRoot('real-id', { name: 'Alice Smith' })
  const root = { querySelectorAll: () => [chat, icon, presentation, real] }
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

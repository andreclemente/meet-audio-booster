import test from 'node:test'
import assert from 'node:assert/strict'
import { createGoogleMeetController } from '../src/platforms/google-meet/index.js'
import { createMediaPipelineManager } from '../src/platforms/google-meet/media-elements.js'
import { createState } from '../src/state.js'

// Synthetic native receiver metadata and audio graph, not live Meet/audio proof.
class Model {
  constructor() { this.Xa = { Yc: () => 'remote-id', Yec: () => 0.8 } }
  isDisposed() { return false }
  Yc(){return this.Xa.Yc()}
  oa(){return this.Xa.Yec()}
}
class Ring {
  constructor(model) { this.di = { Aa: model }; this.element = {} }
  Cbc(){var a=Math.round(this.di.Aa.oa()*5);this.element.Ga=a>0}
}
function fixture(t, { unsupported = false } = {}) {
  const names = ['document', 'MutationObserver', 'navigator', 'RTCPeerConnection', 'MediaStreamTrack']
  const descriptors = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  const define = (name, value) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  class Track extends EventTarget {
    constructor(id, kind = 'audio') { super(); this.id = id; this.kind = kind; this.readyState = 'live' }
    clone() { return new Track(this.id, this.kind) }
    stop() { this.readyState = 'ended' }
  }
  class Peer {
    connectionState = 'connected'; signalingState = 'stable'; receivers = []
    getReceivers() { return this.receivers }
    setRemoteDescription() { return Promise.resolve() }
  }
  define('RTCPeerConnection', unsupported ? undefined : Peer)
  define('MediaStreamTrack', Track)
  const timers = new Map()
  t.mock.method(globalThis, 'setInterval', (fn, ms) => { const id = {}; timers.set(id, { fn, ms }); return id })
  t.mock.method(globalThis, 'clearInterval', id => timers.delete(id))
  let now = 10000
  t.mock.method(Date, 'now', () => now)
  const stream = (...tracks) => ({ id: 'same-stream-id', getAudioTracks: () => tracks.filter(t => t.kind === 'audio'), getVideoTracks: () => tracks.filter(t => t.kind === 'video'), getTracks: () => tracks })
  const remoteTrack = new Track('same-id'), localTrack = new Track('same-id'), video = new Track('video', 'video')
  define('navigator', { mediaDevices: Object.create({ getDisplayMedia: async () => stream(video, localTrack) }) })
  const elements = []
  const model = new Model()
  const root = {
    isConnected: true,
    getAttribute: name => name === 'data-participant-id' ? 'remote-id' : null,
    __jsmodel: { A0Tiaf: { pending: { value: { wy: model } } } },
    querySelectorAll: selector => selector.includes('jscontroller') ? [{ getAttribute: () => 'ring', __jscontroller: { pending: { value: new Ring(model) } } }] : []
  }
  define('document', { documentElement: {}, querySelectorAll: selector => selector === 'audio' ? elements : selector === '[data-participant-id]' ? [root] : [], addEventListener() {}, removeEventListener() {} })
  define('MutationObserver', class { observe() {} disconnect() {} })
  const nodes = [], samples = []
  const context = {
    currentTime: 0, destination: {},
    createMediaStreamSource(s) { const node = { stream: s, connect() {}, disconnect() { this.disconnected = true } }; nodes.push(node); return node },
    createGain: () => ({ gain: { value: 1, setValueAtTime(value) { this.value = value } }, connect() {}, disconnect() {} }),
    createAnalyser: () => ({ disconnect() {}, getFloatTimeDomainData(buffer) { samples.push(1); buffer.fill(0.2) } }),
    resume: () => Promise.resolve()
  }
  const state = createState({ getItem: () => null })
  state.google.mode = 'media'
  const controller = createGoogleMeetController({ state, context, setStatus() {}, renderSoon() {}, updateLiveUi() {} })
  t.after(() => {
    controller.stop()
    for (const [name, desc] of descriptors) { if (desc) Object.defineProperty(globalThis, name, desc); else delete globalThis[name] }
  })
  controller.start()
  const participant = { key: 'remote', participantId: 'remote-id', platform: 'google-meet', name: 'Remote', element: root, present: true, lastSeenAt: now, value: 2.5 }
  state.participants.set(participant.key, participant)
  const audio = s => { const el = { srcObject: s, isConnected: true, muted: false, volume: 0.7 }; elements.push(el); return el }
  const peer = new Peer(); peer.receivers = [{ track: remoteTrack }]; peer.setRemoteDescription()
  const scan = () => { for (const { fn, ms } of timers.values()) if (ms === 500) fn() }
  return { controller, state, participant, remoteTrack, localTrack, video, peer, Track, Peer, stream, audio, scan, context, nodes, samples, timers,
    step(ms = 30) { now += ms; controller.route() } }
}

for (const gain of [0, 2.5]) test(`presenter retains remote media gain ${gain}, excluding local capture and mixed/unknown streams`, async t => {
  const f = fixture(t)
  const remote = f.audio(f.stream(f.remoteTrack))
  const local = f.audio(f.stream(f.localTrack.clone()))
  const mixed = f.audio(f.stream(f.remoteTrack, f.localTrack))
  f.scan()
  assert.equal(f.controller.pipelines.length, 1, 'only affirmative receiver provenance is eligible')
  const pipeline = f.controller.pipelines[0]
  for (let i = 0; i < 20; i++) f.step()
  assert.equal(f.state.google.appliedParticipantKey, f.participant.key)
  await navigator.mediaDevices.getDisplayMedia()
  f.scan(); f.step()
  assert.equal(f.state.google.localPresentationActive, true)
  assert.equal(f.participant.speaking, true)
  assert.equal(f.state.google.speakerSource, 'meet-activity')
  assert.equal(f.state.google.appliedParticipantKey, f.participant.key)
  f.participant.value = gain; f.controller.applyParticipantGain(f.participant)
  assert.equal(pipeline.gain.gain.value, gain, 'actual production graph target, not UI-only state')
  assert.equal(remote.muted, true)
  for (const el of [local, mixed]) { assert.equal(el.muted, false); assert.equal(el.volume, 0.7) }
  assert.equal(f.nodes.length, 1, 'excluded audio never gets a graph')
  for (let i = 0; i < 20; i++) f.step()
  assert.ok(f.controller.levelFor(f.participant.key).frames > 0, 'verified remote levels continue during sharing')
  f.video.stop()
  for (const { fn, ms } of [...f.timers.values()]) if (ms !== 30) fn()
  f.step()
  assert.equal(f.state.google.localPresentationActive, false)
  assert.equal(f.state.google.appliedParticipantKey, f.participant.key)
  f.controller.stop()
  assert.equal(remote.muted, false); assert.equal(remote.volume, 0.7)
  assert.equal(f.remoteTrack.readyState, 'live')
  assert.equal(f.timers.size, 0)
})

test('share START does not deactivate a previously confirmed remote output', async t => {
  const f = fixture(t)
  const remote = f.audio(f.stream(f.remoteTrack))
  f.scan()
  for (let i = 0; i < 20; i++) f.step()
  const pipeline = f.controller.pipelines[0]
  assert.equal(f.state.google.appliedParticipantKey, f.participant.key)
  assert.equal(pipeline.gain.gain.value, 2.5)
  await navigator.mediaDevices.getDisplayMedia()
  f.step()
  assert.equal(f.state.google.localPresentationActive, true)
  assert.equal(pipeline.connected, true, 'START must not disconnect verified remote playback')
  assert.equal(remote.muted, true)
  assert.equal(pipeline.gain.gain.value, 2.5)
  assert.equal(f.state.google.appliedParticipantKey, f.participant.key)
})

test('newly attached remote output is discovered during an already active presentation', async t => {
  const f = fixture(t)
  await navigator.mediaDevices.getDisplayMedia()
  const remote = f.audio(f.stream(f.remoteTrack.clone()))
  f.audio(f.stream(new f.Track('unknown')))
  f.scan()
  assert.equal(f.controller.pipelines.length, 1)
  for (let i = 0; i < 20; i++) f.step()
  assert.equal(f.state.google.appliedParticipantKey, f.participant.key)
  assert.equal(remote.muted, true)
  assert.equal(f.controller.pipelines[0].gain.gain.value, 2.5)
})

test('duplicate retention, source swaps and detach/reinsert remain safe between scans', t => {
  const f = fixture(t)
  const s = f.stream(f.remoteTrack)
  const audio = f.audio(s), duplicate = f.audio(s)
  f.scan()
  const pipeline = f.controller.pipelines[0]
  pipeline.set(0, true)
  audio.srcObject = f.stream(f.localTrack)
  pipeline.set(2.5, true)
  assert.equal(audio.muted, false); assert.equal(audio.volume, 0.7)
  assert.equal(duplicate.muted, true)
  audio.srcObject = s; f.scan()
  assert.equal(pipeline.elements.has(audio), true)
  assert.equal(audio.muted, true)
  audio.isConnected = false; f.step()
  assert.equal(audio.muted, false)
  audio.isConnected = true; f.scan()
  assert.equal(pipeline.elements.has(audio), true)
  assert.equal(audio.muted, true)
})

test('mixed track insertion revokes a connected graph without waiting for a scan', t => {
  const f = fixture(t)
  const tracks = [f.remoteTrack]
  const audio = f.audio({ getAudioTracks: () => tracks })
  f.scan(); const pipeline = f.controller.pipelines[0]; pipeline.set(0, true)
  tracks.push(f.localTrack)
  f.controller.setOutputs(4, true)
  assert.equal(f.controller.pipelines.length, 0)
  assert.equal(pipeline.connected, false); assert.equal(audio.muted, false); assert.equal(audio.volume, 0.7)
})

test('unsupported discovery preserves native playback while presenting and native participant activity', async t => {
  const f = fixture(t, { unsupported: true })
  f.state.google.mode = 'detecting'
  f.state.google.modeStartedAt = performance.now() - 2000
  const remote = f.audio(f.stream(f.remoteTrack))
  await navigator.mediaDevices.getDisplayMedia(); f.scan(); f.step()
  assert.equal(f.controller.pipelines.length, 0)
  assert.equal(f.state.google.mode, 'media', 'native fallback must not claim an absent worklet is applying participant gain')
  assert.equal(remote.muted, false); assert.equal(remote.volume, 0.7)
  assert.equal(f.nodes.length, 0)
  assert.equal(f.participant.speaking, true)
  assert.equal(f.state.google.appliedParticipantKey, null)
})

test('clone replacement, peer closure and rejoin revoke stale pipelines before route/sample/activation', t => {
  const f = fixture(t)
  const remote = f.audio(f.stream(f.remoteTrack.clone().clone()))
  f.scan()
  const stale = f.controller.pipelines[0]
  assert.ok(stale, 'first clone acquisition')
  stale.set(2.5, true)
  f.peer.receivers = [{ track: new f.Track('same-id') }]
  const samples = f.samples.length
  f.step()
  assert.equal(f.controller.pipelines.length, 0)
  stale.set(4, true); stale.sample(); stale.activate()
  assert.equal(f.samples.length, samples, 'revoked graph is never sampled')
  assert.equal(stale.connected, false); assert.equal(remote.muted, false)
  remote.srcObject = f.stream(f.peer.receivers[0].track)
  f.scan(); assert.equal(f.controller.pipelines.length, 1)
  f.peer.connectionState = 'closed'; f.step()
  assert.equal(f.controller.pipelines.length, 0); assert.equal(remote.muted, false)
  const peer = new f.Peer(); peer.receivers = [{ track: new f.Track('same-id') }]; peer.setRemoteDescription()
  remote.srcObject = f.stream(peer.receivers[0].track.clone())
  f.scan(); assert.equal(f.controller.pipelines.length, 1)
  f.controller.stop(); assert.equal(remote.muted, false); assert.equal(remote.volume, 0.7)
})

test('acceptance revocation handles in-place track mutation and identical ids without reviving stale graph', t => {
  const f = fixture(t)
  let tracks = [f.remoteTrack]
  const stream = { id: 'same', getAudioTracks: () => tracks }
  const audio = f.audio(stream)
  const manager = createMediaPipelineManager(f.context, { accepts: s => s.getAudioTracks().every(track => track === f.remoteTrack) })
  t.after(() => manager.destroy())
  manager.scan(); const stale = manager.pipelines[0]; stale.set(0, true)
  tracks = [f.localTrack]
  const samples = f.samples.length
  stale.sample(); stale.set(4, true); stale.activate()
  assert.equal(f.samples.length, samples)
  assert.equal(stale.connected, false); assert.equal(audio.muted, false); assert.equal(audio.volume, 0.7)
  manager.scan(); assert.equal(manager.pipelines.length, 0)
  tracks = [f.remoteTrack]; manager.scan(); assert.equal(manager.pipelines.length, 1)
  assert.notEqual(manager.pipelines[0], stale)
  stale.set(4, true); assert.equal(stale.connected, false)
})

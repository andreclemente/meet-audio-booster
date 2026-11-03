import test from 'node:test'
import assert from 'node:assert/strict'
import { installLocalPresentationCaptureHook } from '../src/platforms/google-meet/presentation.js'
import { createGoogleMeetController } from '../src/platforms/google-meet/index.js'
import { createState } from '../src/state.js'

// MediaStreamTrack.stop() changes readyState without dispatching 'ended'.
class Track extends EventTarget {
  readyState = 'live'
  stop() { this.readyState = 'ended' }
  endExternally() { this.stop(); this.dispatchEvent(new Event('ended')) }
}
const streamOf = (video, audio = []) => ({ getVideoTracks: () => video, getTracks: () => [...video, ...audio] })

function clock(t) {
  const intervals = new Map()
  let id = 0
  t.mock.method(globalThis, 'setInterval', callback => { intervals.set(++id, callback); return id })
  t.mock.method(globalThis, 'clearInterval', timer => intervals.delete(timer))
  return { intervals, tick() { for (const callback of [...intervals.values()]) callback() } }
}
function hookFixture(t, streams) {
  const timer = clock(t)
  const events = []
  const original = async () => streams.shift()
  const prototype = { getDisplayMedia: original }
  const mediaDevices = Object.create(prototype)
  const restore = installLocalPresentationCaptureHook(active => events.push(active), mediaDevices)
  t.after(restore)
  return { ...timer, events, restore, prototype, original, mediaDevices }
}

test('programmatic display stop clears bypass without an ended event', async t => {
  const video = new Track(), audio = new Track()
  const f = hookFixture(t, [streamOf([video], [audio])])
  assert.equal(f.intervals.size, 0)
  await f.mediaDevices.getDisplayMedia()
  assert.deepEqual(f.events, [true])
  f.tick()
  assert.deepEqual(f.events, [true], 'live display must remain protected')
  video.stop()
  assert.deepEqual(f.events, [true], 'stop itself did not emit ended')
  f.tick()
  assert.deepEqual(f.events, [true, false])
  assert.equal(audio.readyState, 'live', 'display video governs the capture lifecycle')
  assert.equal(f.intervals.size, 0, 'no idle polling after capture ends')
})

test('silent stops retain bypass for other live tracks and overlapping captures', async t => {
  const a = new Track(), b = new Track(), c = new Track()
  const f = hookFixture(t, [streamOf([a, b]), streamOf([c])])
  await f.mediaDevices.getDisplayMedia()
  await f.mediaDevices.getDisplayMedia()
  a.stop(); f.tick()
  assert.deepEqual(f.events, [true])
  b.stop(); f.tick()
  assert.deepEqual(f.events, [true])
  c.stop(); f.tick()
  assert.deepEqual(f.events, [true, false])
  assert.equal(f.intervals.size, 0)
})

test('natural ended events clear immediately and cleanup supports another capture', async t => {
  const a = new Track(), b = new Track()
  const f = hookFixture(t, [streamOf([a]), streamOf([b])])
  await f.mediaDevices.getDisplayMedia()
  a.endExternally()
  assert.deepEqual(f.events, [true, false])
  assert.equal(f.intervals.size, 0)
  await f.mediaDevices.getDisplayMedia()
  assert.deepEqual(f.events, [true, false, true])
  b.stop(); f.tick()
  assert.deepEqual(f.events, [true, false, true, false])
  assert.equal(f.intervals.size, 0)
})

test('disposing an active hook removes polling/listeners and restores capture function', async t => {
  const video = new Track()
  const f = hookFixture(t, [streamOf([video])])
  await f.mediaDevices.getDisplayMedia()
  f.restore(); f.restore()
  assert.equal(f.intervals.size, 0)
  assert.equal(f.prototype.getDisplayMedia, f.original)
  video.endExternally(); f.tick()
  assert.deepEqual(f.events, [true], 'no callback after disposal')
})

test('media controller retains speaker activity during sharing and clears silent stop despite a stale share tile', async t => {
  const timer = clock(t)
  const video = new Track()
  const prototype = { getDisplayMedia: async () => streamOf([video]) }
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: Object.create(prototype) } })
  t.after(() => { if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor); else delete globalThis.navigator })
  const originals = { document: globalThis.document, MutationObserver: globalThis.MutationObserver }
  const share = {
    getAttribute: name => name === 'data-participant-id' ? 'share-id' : null,
    querySelectorAll: selector => selector.includes('google-symbols') ? [{ textContent: 'stylus_laser_pointer' }] : []
  }
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
  const model = new Model()
  const remote = {
    isConnected: true,
    getAttribute: name => name === 'data-participant-id' ? 'remote-id' : null,
    __jsmodel: { A0Tiaf: { pending: { value: { wy: model } } } },
    querySelectorAll: selector => selector.includes('jscontroller')
      ? [{ getAttribute: () => 'ring', __jscontroller: { pending: { value: new Ring(model) } } }] : []
  }
  globalThis.document = {
    documentElement: {}, querySelectorAll: selector => selector === '[data-participant-id]' ? [share, remote] : [],
    addEventListener() {}, removeEventListener() {}
  }
  globalThis.MutationObserver = class { observe() {} disconnect() {} }
  let controller
  t.after(() => { controller?.stop(); Object.assign(globalThis, originals) })
  const state = createState({ getItem: () => null })
  state.google.mode = 'media'
  controller = createGoogleMeetController({ state, context: {}, setStatus() {}, renderSoon() {}, updateLiveUi() {} })
  controller.start()
  const participant = {
    key: 'remote', participantId: 'remote-id', platform: 'google-meet', name: 'Remote',
    element: remote, present: true, lastSeenAt: Date.now(), value: 2
  }
  state.participants.set(participant.key, participant)
  await navigator.mediaDevices.getDisplayMedia()
  controller.route()
  assert.notEqual(state.google.routingState, 'local-presentation-bypass')
  assert.equal(participant.speaking, true)
  assert.equal(state.google.localPresentationActive, true)
  timer.tick()
  assert.notEqual(state.google.routingState, 'local-presentation-bypass', 'remote routing continues during the live share')
  video.stop()
  // Multiple scheduler turns also exercise reconcile running before capture polling.
  timer.tick(); timer.tick()
  controller.route()
  assert.equal(state.google.localPresentationActive, false)
  assert.notEqual(state.google.routingState, 'local-presentation-bypass', 'routing runs again without a Meet reload')
  assert.equal(state.google.speakerSource, 'meet-activity')
  assert.equal(participant.speaking, true, 'native speaker detection resumes')
  controller.stop()
  assert.equal(timer.intervals.size, 0)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { createAudibleMeter } from '../src/platforms/google-meet/audible-meter.js'
import { createGoogleMeetController } from '../src/platforms/google-meet/index.js'
import { createPanelController } from '../src/ui/panel.js'

// Synthetic DOM/activity, PCM, AudioNodes and immediately settled slots. Actual
// meter -> controller estimator -> panel Auto -> gain callback -> UI are exercised.
class Element {
  constructor(tagName, document) { Object.assign(this, { tagName, document, children: [], style: {}, dataset: {}, attributes: {} }) }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child) } }
  replaceChildren() { this.children = [] }
  get isConnected() { return this === this.document.documentElement || !!this.parentElement?.isConnected }
  setAttribute(k, v) { this.attributes[k] = String(v) }
  getAttribute(k) { return this.attributes[k] ?? null }
  addEventListener() {}
  matches(s) { const role = s.match(/^\[data-role="(.+)"\]$/); return role ? this.dataset.role === role[1] : s === '[data-participant-key]' ? this.dataset.participantKey !== undefined : s.split(', ').includes(this.tagName) }
  querySelectorAll(s) { return this.children.flatMap(c => [...(c.matches(s) ? [c] : []), ...c.querySelectorAll(s)]) }
  querySelector(s) { return this.querySelectorAll(s)[0] ?? null }
  getBoundingClientRect() { return { left: 12, top: 72, width: 300, height: 200 } }
}
// Intentionally minified: production verifies Meet's delegating getter grammar.
class Model {constructor(id,level){this.Xa={Yc:()=>id,Yec:()=>level.value}}isDisposed(){return false}Yc(){return this.Xa.Yc()}oa(){return this.Xa.Yec()}}
class Ring {constructor(holder){this.di=holder;this.element={}}Cbc(){var a=Math.round(this.di.Aa.oa()*5);this.element.Ga=a>0}}
function root(id) {
  const level = { value: 0 }, model = new Model(id, level), ring = { getAttribute: () => 'ring', __jscontroller: { pending: { value: new Ring({ Aa: model }) } } }
  return { level, root: { isConnected: true, getAttribute: n => n === 'data-participant-id' ? id : null, __jsmodel: { A0Tiaf: { pending: { value: { wy: model } } } }, querySelectorAll: () => [ring], querySelector: () => null, matches: () => false } }
}
function scenario(change, { initialSingle = false, gaps = false, manual = false, durationMs = 120000, observe = null } = {}) {
  const keys = ['document', 'addEventListener', 'GainNode', 'AudioWorkletNode', 'BaseAudioContext', 'AudioContext', 'OfflineAudioContext', 'AudioParam']
  const saved = new Map(keys.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)])), oldNow = Date.now
  let now = 0, sourcePower = 10 ** (-30 / 10), meter, controller, native, slot, panel
  const a = root('source-a'), b = root('source-b'), roots = initialSingle ? [a.root] : [a.root, b.root], writes = [], resets = []
  let external = [], qualifiedFrames = 0, confidenceLosses = 0, missingPower = 0
  const document = { activeElement: null, createElement: tag => new Element(tag, document) }
  document.documentElement = new Element('html', document)
  document.getElementById = id => [document.documentElement, ...document.documentElement.querySelectorAll('div')].find(e => e.id === id)
  document.querySelectorAll = s => s === '[data-participant-id]' ? roots : s === 'audio,video' ? external : []
  try {
    class AudioParam { constructor() { this.value = 1 } setValueAtTime(v) { this.value = v } }
    class GainNode { constructor(context) { Object.assign(this, { context, gain: new AudioParam(), channelCount: 2, channelCountMode: 'max', channelInterpretation: 'speakers' }) } }
    class AudioWorkletNode { constructor(context) { Object.assign(this, { context, channelCount: 2, channelCountMode: 'max', channelInterpretation: 'speakers' }) } }
    class BaseAudioContext {
      constructor() { this.currentTime = 0; this.destination = { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' } }
      createGain() { return new globalThis.GainNode(this) }
      createChannelSplitter() { return {} }
      createAnalyser() { return { getFloatTimeDomainData(buf) { buf.fill(Math.sqrt(sourcePower / 2) * native.gain.value * slot.actualValue) } } }
    }
    Object.assign(globalThis, { document, addEventListener() {}, GainNode, AudioWorkletNode, BaseAudioContext, AudioContext: undefined, OfflineAudioContext: undefined, AudioParam })
    Date.now = () => now
    const mappings = []
    meter = createAudibleMeter({ mappings: () => mappings, connect() {}, disconnect() {} })
    const context = new BaseAudioContext(), source = new globalThis.AudioWorkletNode(context)
    native = context.createGain()
    mappings.push({ source, destination: native, booster: context.createGain(), output: 0, input: 0 })
    meter.connected(source, [native]); meter.connected(native, [context.destination])
    slot = { gain: {}, tap: null, audibleMeter: meter, actualValue: 1, targetValue: 1, appliedMultiplier: 1, set(v) { this.actualValue = this.targetValue = this.appliedMultiplier = v }, release() { this.set(1) } }
    const people = new Map(roots.map((r, i) => { const key = i ? 'B' : 'A'; return [key, { key, participantId: i ? 'source-b' : 'source-a', element: r, name: key, platform: 'google-meet', present: true, value: 1, muted: false }] }))
    const state = { participants: people, settings: {}, closed: false, google: { slots: [slot], mediaPipelines: [], mode: 'worklet', activeParticipantKey: null, appliedParticipantKey: null, routingState: 'idle', transitionGuard: {}, routing: {}, rosterSignature: '', localPresentationActive: false } }
    const readMeter = meter.read
    meter.read = slots => { const power = readMeter(slots); if (!Number.isFinite(power)) missingPower++; return power }
    panel = createPanelController(state, { participants: () => [...people.values()], levels: k => controller.levelFor(k), onGain(p, v) {
      const write = { now, key: p.key, from: p.value, to: v, level: controller.levelFor(p.key), qualifiedFrames }
      writes.push(write); p.value = v; controller.applyParticipantGain(p)
      write.actualValue = slot.actualValue
    }, onSave() {} })
    controller = createGoogleMeetController({ state, context: {}, setStatus() {}, renderSoon() {}, updateLiveUi: panel.updateLiveUi, onLevelSample(t, key) {
      if (key === 'A') {
        if (Number.isFinite(controller.levelFor(key).autoDb)) qualifiedFrames++
        else { if (qualifiedFrames) confidenceLosses++; qualifiedFrames = 0 }
      }
      panel.autoTick(t, key)
    }, onLevelReset(t, metadata) { qualifiedFrames = 0; resets.push({ now: t, metadata }); panel.invalidateAuto(t, metadata) } })
    panel.render()
    const balance = state.panel.querySelectorAll('button').find(e => e.textContent === 'Auto Balance')
    balance.onclick()
    function tick(key) { a.level.value = key === 'A' ? .6 : 0; b.level.value = key === 'B' ? .6 : 0; context.currentTime = now / 1000; controller.route(); now += 30 }
    for (let i = 0; i < 4000; i++) tick(initialSingle ? 'A' : Math.floor(i / 400) % 2 ? 'B' : 'A')
    assert.equal(state.autoBalanceReady, !initialSingle, 'initial comparative target policy')
    const start = now
    missingPower = 0; confidenceLosses = 0
    const api = { meter, context, source, native, mappings, slot, state, read: () => meter.read(state.google.slots), external: value => { external = value } }
    change(api)
    if (manual) {
      const slider = state.panel.querySelector('[data-role="slider"]')
      slider.value = '1'; slider.oninput()
    }
    for (let i = 0; i * 30 < durationMs; i++) {
      tick(gaps && i % 100 >= 67 ? null : 'A')
      if (observe) observe({ elapsedMs: now - start, value: people.get('A').value, actualValue: slot.actualValue, slider: Number(state.panel.querySelector('[data-role="slider"]').value), level: controller.levelFor('A'), writes: writes.filter(w => w.now >= start).length, missingPower, confidenceLosses })
    }
    const dropWrites = writes.filter(w => w.now >= start)
    const slider = state.panel.querySelector('[data-role="slider"]')
    return { start, writes: dropWrites, firstMs: dropWrites[0]?.now - start, value: people.get('A').value, slider: Number(slider.value), ready: state.autoBalanceReady, enabled: state.autoBalanceEnabled, level: controller.levelFor('A'), resets: resets.filter(r => r.now >= start) }
  } finally {
    meter?.dispose(); Date.now = oldNow
    for (const [k, d] of saved) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k] }
  }
}
const attenuate = ({ native }) => { native.gain.value = 10 ** (-12 / 20) }
for (const gaps of [false, true]) test(`compatible static native attenuation recovers with only A, gaps=${gaps}`, t => {
  const trace = []
  // Confidence is deliberately re-earned after gain-settling fragments the
  // speaking portions. Intermittent speech need not finish at exactly 120 s,
  // but must make bounded progress and then reach and hold the SAME deadband.
  const r = scenario(attenuate, { gaps, durationMs: gaps ? 360000 : 120000, observe(s) {
    if (s.elapsedMs % 30000 === 0) trace.push(s)
  } })
  const gainDb = value => 20 * Math.log10(value)
  // The injected source is exactly -42 dB after native attenuation. Progress
  // remains measurable even at a checkpoint where Auto correctly abstains.
  const errorDb = s => 12 - gainDb(s.value)
  const at120 = trace.find(s => s.elapsedMs === 120000)
  const lastWriteMs = r.writes.at(-1)?.now - r.start
  t.diagnostic(JSON.stringify({ gaps, firstWriteMs: r.firstMs, lastWriteMs,
    writes: r.writes.length, value: r.value, slider: r.slider, trace }))
  assert.ok(r.writes.length > 0, 'fresh quiet speech must correct without a second reference returning')
  assert.ok(r.firstMs >= 4000, 'fresh estimator and sustained-error qualification must still warm up')
  assert.ok(r.firstMs <= 30000, 'first correction must not stall past 30 s')
  assert.ok(gainDb(at120.value) >= 6, 'at least 6 dB of the 12 dB error must be removed by 120 s')
  for (let i = 0; i < trace.length; i++) {
    const s = trace[i]
    assert.equal(s.slider, s.value)
    assert.equal(s.actualValue, s.value, 'panel and settled applied gain must agree')
    assert.ok(s.level.sampledAt >= r.start + s.elapsedMs - 3000)
    if (i && errorDb(trace[i - 1]) > 3) {
      assert.ok(s.value > trace[i - 1].value, 'no 30 s plateau outside the deadband')
    }
  }
  for (const w of r.writes) {
    assert.equal(w.key, 'A')
    assert.ok(Math.abs(gainDb(w.to / w.from) - 0.05) < 1e-10, 'only monotonic 0.05 dB earned steps')
    assert.equal(w.actualValue, w.to, 'gain callback must reach the real slot')
    assert.equal(w.level.sampledAt, w.now, 'no writes on stale evidence')
    assert.ok(w.level.autoSince >= r.start, 'no pre-reset evidence')
    assert.ok(w.level.autoSupportMs >= 6000)
    assert.ok(w.level.autoInlierFrames >= 24)
    assert.ok(w.level.autoInlierPortions >= 3)
    assert.ok(w.qualifiedFrames >= 30, 'fresh confidence loss must rearm sustained qualification')
    assert.ok(-30 - (w.level.autoDb + gainDb(w.from)) > 3 - 1e-6, 'no writes inside the deadband')
  }
  assert.ok(lastWriteMs <= 180000, 'deadband convergence has an explicit 180 s budget')
  assert.ok(Math.abs(-30 - (r.level.autoDb + gainDb(r.value))) <= 3, 'same established 3 dB deadband')
  if (gaps) {
    assert.ok(trace.some(s => s.confidenceLosses > 0), 'exercise confidence loss and rearming')
    assert.ok(trace.some(s => s.missingPower > 0), 'exercise native-meter settling abstentions')
    const settled = trace.find(s => s.elapsedMs === 180000)
    for (const s of trace.filter(s => s.elapsedMs >= 180000)) {
      assert.equal(s.writes, settled.writes, 'no chasing after convergence through 240/360 s')
      assert.equal(s.value, settled.value)
    }
  }
  assert.equal(r.slider, r.value)
  assert.equal(r.enabled, true); assert.equal(r.ready, true)
  assert.ok(r.resets.some(r => r.metadata?.reason === 'compatible-native-gain'))
})
const unsafe = {
  'arbitrary generation': a => { a.meter.changed(); attenuate(a); a.read() },
  'disconnect/reconnect before gain change': a => { a.meter.disconnected(a.native, [a.context.destination]); a.meter.connected(a.native, [a.context.destination]); attenuate(a) },
  'slot replacement': a => { a.state.google.slots = [{ ...a.slot }]; attenuate(a) },
  'meter replacement': a => { a.slot.audibleMeter = { generation: 0, read: () => 10 ** (-42 / 10) }; attenuate(a) },
  'tap replacement': a => { a.slot.tap = {}; attenuate(a) },
  'context replacement': a => { a.mappings[0].booster = { context: { ...a.context } }; attenuate(a) },
  'source ownership replacement': a => { a.mappings[0].source = {}; attenuate(a) },
  'supported booster ownership replacement then gain change': a => { a.mappings[0].booster = a.context.createGain(); attenuate(a); a.read() },
  'supported channel layout replacement then gain change': a => { a.context.destination.channelCount = 1; attenuate(a); a.read() },
  'unsupported sink then gain change': a => { a.context.destination.channelCount = 9; a.read(); a.context.destination.channelCount = 1; attenuate(a); a.read() },
  'unsupported media then compatible gain': a => { a.external([{}]); a.read(); a.external([]); a.read(); attenuate(a); a.read() },
  'unreadable graph then compatible gain': a => {
    Object.defineProperty(a.source, 'context', { configurable: true, get() { throw new Error('lost graph') } })
    try { a.read() } catch {} // The baseline propagates this; the candidate invalidates.
    Object.defineProperty(a.source, 'context', { configurable: true, value: a.context })
    attenuate(a); a.read()
  },
  'automation': a => { a.native.gain.setValueAtTime(10 ** (-12 / 20), 0) },
  'zero gain then compatible gain': a => { a.native.gain.value = 0; a.read(); attenuate(a); a.read() }
}
// Observe a channel change before a later scalar change: the last reason may
// become compatible, but the original coordinate-system epoch must be gone.
for (const node of ['native', 'source', 'sink']) {
  for (const [field, value] of [['channelCount', 1], ['channelCountMode', 'clamped-max'], ['channelInterpretation', 'discrete']]) {
    unsafe[`${node} ${field} observed before static gain`] = a => {
      const target = node === 'sink' ? a.context.destination : a[node]
      const epoch = a.meter.continuity.token
      target[field] = value
      a.read()
      assert.notEqual(a.meter.continuity.token, epoch, 'first channel observation must revoke the epoch')
      attenuate(a); a.read()
      assert.notEqual(a.meter.continuity.token, epoch, 'later scalar gain cannot restore the epoch')
    }
  }
  for (const [field, invalid] of [['channelCount', 0], ['channelCount', 1.5], ['channelCount', NaN], ['channelCountMode', 'unknown'], ['channelInterpretation', undefined]]) {
    unsafe[`${node} invalid ${field}=${String(invalid)}`] = a => {
      const target = node === 'sink' ? a.context.destination : a[node], prior = target[field]
      const epoch = a.meter.continuity.token
      target[field] = invalid
      assert.ok(Number.isNaN(a.read()))
      assert.notEqual(a.meter.continuity.token, epoch)
      target[field] = prior; a.read(); attenuate(a); a.read()
    }
  }
  for (const field of ['channelCount', 'channelCountMode', 'channelInterpretation']) {
    unsafe[`${node} throwing ${field}`] = a => {
      const target = node === 'sink' ? a.context.destination : a[node], prior = target[field]
      const epoch = a.meter.continuity.token
      Object.defineProperty(target, field, { configurable: true, get() { throw new Error('channel read') } })
      assert.ok(Number.isNaN(a.read()))
      assert.notEqual(a.meter.continuity.token, epoch)
      Object.defineProperty(target, field, { configurable: true, writable: true, value: prior })
      a.read(); attenuate(a); a.read()
    }
  }
}
unsafe['native stereo max/2 to explicit/1 before static gain'] = a => {
  const epoch = a.meter.continuity.token
  a.native.channelCountMode = 'explicit'; a.native.channelCount = 1
  a.read()
  assert.notEqual(a.meter.continuity.token, epoch)
  a.native.gain.value = .25; a.read()
}
for (const [name, change] of Object.entries(unsafe)) test(`unsafe ${name} never reuses the established target`, () => {
  const r = scenario(change)
  assert.equal(r.writes.length, 0)
  assert.equal(r.ready, false)
  assert.equal(r.enabled, true)
})
test('compatible change never creates an initial single-speaker target', () => {
  const r = scenario(attenuate, { initialSingle: true })
  assert.equal(r.writes.length, 0); assert.equal(r.ready, false)
})
test('manual slider still cancels Auto across compatible invalidation', () => {
  const r = scenario(attenuate, { manual: true })
  assert.equal(r.enabled, false); assert.equal(r.ready, false)
  assert.equal(r.writes.length, 1)
})

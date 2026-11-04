import test from 'node:test'
import assert from 'node:assert/strict'
import { createAudibleMeter } from '../src/platforms/google-meet/audible-meter.js'

function fixture(run) {
  const keys = ['GainNode', 'AudioWorkletNode', 'BaseAudioContext', 'AudioContext', 'OfflineAudioContext', 'AudioParam', 'MediaStream', 'document']
  const saved = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  class GainNode { constructor(context) { this.context = context; this.gain = { value: 1 } } }
  class AudioWorkletNode { constructor(context) { this.context = context } }
  class BaseAudioContext {
    constructor() { this.currentTime = 0; this.destination = { channelCount: 1 } }
    createGain() { return new globalThis.GainNode(this) }
    createChannelSplitter() { return { context: this } }
    createAnalyser() { return { getFloatTimeDomainData(buffer) { buffer.fill(0.25) } } }
  }
  class MediaStream {
    constructor(kinds = []) { this.kinds = kinds }
    getAudioTracks() { return this.kinds.filter(kind => kind === 'audio') }
  }
  let elements = [], meter
  try {
    Object.assign(globalThis, { GainNode, AudioWorkletNode, BaseAudioContext, AudioContext: undefined, OfflineAudioContext: undefined, AudioParam: undefined, MediaStream, document: { querySelectorAll: () => elements } })
    const mappings = [], calls = []
    meter = createAudibleMeter({ mappings: () => mappings, connect: function (...args) { calls.push({ source: this, args }) }, disconnect() {} })
    const context = new BaseAudioContext(), source = new globalThis.AudioWorkletNode(context), native = context.createGain(), booster = context.createGain()
    mappings.push({ source, destination: native, booster, output: 0, input: 0 })
    meter.connected(source, [native]); meter.connected(native, [context.destination])
    const slots = [{ actualValue: 1, targetValue: 1 }]
    const read = time => { context.currentTime = time; return meter.read(slots) }
    const element = srcObject => ({ srcObject, currentSrc: '', getAttribute: () => null })
    run({ meter, read, context, source, calls, setElements: value => { elements = value }, element, MediaStream })
  } finally {
    meter?.dispose()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
}

test('video-only streams and empty media do not disable verified hardware metering', () => fixture(({ read, setElements, element, MediaStream, calls, context }) => {
  setElements([element(new MediaStream(['video'])), element(null)])
  assert.ok(Number.isNaN(read(0)))
  assert.ok(Number.isNaN(read(0.12)))
  assert.equal(read(0.24), 0.0625)
  assert.ok(calls.every(call => call.args[0] !== context.destination), 'private probe must add no audible route')
}))

test('new audio-bearing media invalidates confidence; removal requires fresh measurement settling', () => fixture(({ meter, read, setElements, element, MediaStream }) => {
  const stream = new MediaStream(['video'])
  setElements([element(stream)])
  read(0); read(0.12)
  assert.equal(read(0.24), 0.0625)
  const validGeneration = meter.generation
  stream.kinds.push('audio')
  assert.ok(Number.isNaN(read(0.36)))
  assert.ok(meter.generation > validGeneration)
  const invalidGeneration = meter.generation
  assert.ok(Number.isNaN(read(0.48)))
  assert.equal(meter.generation, invalidGeneration, 'unsupported state must not churn revisions forever')
  stream.kinds.pop()
  assert.ok(Number.isNaN(read(0.60)))
  assert.ok(meter.generation > invalidGeneration)
  assert.ok(Number.isNaN(read(0.72)))
  assert.equal(read(0.84), 0.0625)
}))

test('an unmapped output from a mapped worklet cannot bypass the measurement', () => fixture(({ meter, read, source, context }) => {
  read(0); read(0.12)
  assert.equal(read(0.24), 0.0625)
  const generation = meter.generation
  meter.connected(source, [context.destination, 1, 0])
  assert.ok(Number.isNaN(read(0.36)))
  assert.ok(meter.generation > generation)
}))

test('file-backed or unrecognised media remain unsupported', () => fixture(({ read, setElements, element }) => {
  const file = element(null); file.currentSrc = 'data:audio/wav;base64,'
  setElements([file]); assert.ok(Number.isNaN(read(0)))
  setElements([{}]); assert.ok(Number.isNaN(read(0.12)))
}))

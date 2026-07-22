import test from 'node:test'
import assert from 'node:assert/strict'
import { createMediaElementPipeline, createMediaPipelineManager } from '../src/platforms/google-meet/media-elements.js'

function fixture({ failDestination = false } = {}) {
  const destination = {}
  const source = { connect() {}, disconnect() {} }
  const gain = {
    gain: { value: 1, context: { currentTime: 0 }, setValueAtTime(value) { this.value = value } },
    connect(target) { if (failDestination && target === destination) throw new Error('blocked'); this.connected = true },
    disconnect() { this.connected = false }
  }
  const analyser = {
    fftSize: 0, connect() {}, disconnect() {},
    getFloatTimeDomainData(buffer) { buffer.fill(0) }
  }
  const context = {
    destination,
    createMediaStreamSource: () => source,
    createGain: () => gain,
    createAnalyser: () => analyser,
    resume: () => Promise.resolve()
  }
  const track = { id: 'track-1', readyState: 'live' }
  const stream = { id: 'stream-1', getAudioTracks: () => [track] }
  const audio = { srcObject: stream, muted: false, volume: 0.7 }
  return { context, audio, gain }
}

test('media fallback never suppresses native playback before replacement connection succeeds', () => {
  const { context, audio } = fixture({ failDestination: true })
  const pipeline = createMediaElementPipeline(context, audio, 'media-1')
  assert.equal(pipeline.activate(), false)
  assert.equal(audio.muted, false)
  assert.equal(audio.volume, 0.7)
})

test('media fallback restores exact native element state on teardown', () => {
  const { context, audio } = fixture()
  const pipeline = createMediaElementPipeline(context, audio, 'media-1')
  assert.equal(pipeline.activate(), true)
  assert.equal(audio.muted, true)
  assert.equal(audio.volume, 0)
  pipeline.set(2.5)
  assert.equal(pipeline.gain.gain.value, 2.5)
  pipeline.destroy()
  assert.equal(audio.muted, false)
  assert.equal(audio.volume, 0.7)
})

test('pipeline analyser reuses one sampling buffer', () => {
  const { context, audio } = fixture()
  const pipeline = createMediaElementPipeline(context, audio, 'media-1')
  const buffer = pipeline.analyser.buffer
  pipeline.sample()
  pipeline.sample()
  assert.equal(pipeline.analyser.buffer, buffer)
  pipeline.destroy()
})

test('moving an owned element restores it before the new pipeline records original state', () => {
  const context = {
    destination: {},
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    createGain: () => ({
      gain: { value: 1, context: { currentTime: 0 }, setValueAtTime(value) { this.value = value } },
      connect() {}, disconnect() {}
    }),
    createAnalyser: () => ({ fftSize: 0, connect() {}, disconnect() {}, getFloatTimeDomainData(buffer) { buffer.fill(0) } }),
    resume: () => Promise.resolve()
  }
  const trackA = { id: 'a', readyState: 'live' }
  const trackB = { id: 'b', readyState: 'live' }
  const streamA = { id: 'stream-a', getAudioTracks: () => [trackA] }
  const streamB = { id: 'stream-b', getAudioTracks: () => [trackB] }
  const moving = { srcObject: streamA, muted: false, volume: 0.7, isConnected: true }
  const staying = { srcObject: streamA, muted: false, volume: 0.6, isConnected: true }
  const root = { querySelectorAll: () => [moving, staying] }
  const manager = createMediaPipelineManager(context)
  manager.scan(root)
  const oldPipeline = manager.pipelines[0]
  oldPipeline.activate()
  moving.srcObject = streamB
  manager.scan(root)
  const newPipeline = manager.pipelines.find(item => item.streamKey.startsWith('stream-b'))
  assert.equal(oldPipeline.elements.has(staying), true)
  assert.equal(oldPipeline.connected, true)
  assert.equal(moving.muted, false)
  assert.equal(moving.volume, 0.7)
  newPipeline.activate()
  newPipeline.destroy()
  assert.equal(moving.muted, false)
  assert.equal(moving.volume, 0.7)
  manager.destroy()
})

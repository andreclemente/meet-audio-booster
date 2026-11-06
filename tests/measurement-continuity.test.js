import test from 'node:test'
import assert from 'node:assert/strict'
import { createMeasurementContinuity } from '../src/platforms/google-meet/measurement-continuity.js'

const pipeline = () => ({ stream: {}, tracks: [{}] })
const slot = meter => ({ tap: {}, audibleMeter: meter })

test('media: someone joining or leaving keeps evidence; a replaced stream still resets', () => {
  const observe = createMeasurementContinuity()
  const a = pipeline(), b = pipeline(), g = { mode: 'media' }
  assert.equal(observe(g, [a]).reason, 'measurement-graph', 'first stream starts a measurement graph')
  assert.equal(observe(g, [a]), null)
  assert.equal(observe(g, [a, b]), null, 'joiner adds a silent stream: no reset')
  assert.equal(observe(g, [b]), null, 'leaver removes a stream: no reset')
  assert.equal(observe(g, [a, b]), null, 'rejoin as a new stream: no reset')
  b.tracks = [{}]
  assert.equal(observe(g, [a, b]).reason, 'measurement-graph', 'replaced track of a kept stream resets')
  assert.equal(observe(g, [pipeline()]).reason, 'measurement-graph', 'no stream kept: resets')
  assert.equal(observe(g, []).reason, 'measurement-graph', 'all streams gone: resets')
})

test('media: a replaced pipeline object with others kept is treated like leave plus join (pre-gain power is unchanged)', () => {
  const observe = createMeasurementContinuity()
  const a = pipeline(), b = pipeline(), g = { mode: 'media' }
  observe(g, [a, b])
  assert.equal(observe(g, [a, pipeline()]), null)
})

test('worklet: a slot joining or leaving with the real audible meter still discards evidence (meter re-verifies the graph)', () => {
  const observe = createMeasurementContinuity()
  let generation = 1
  const meter = { get generation() { return generation }, continuity: null }
  const s0 = slot(meter), s1 = slot(meter), g = { mode: 'worklet', slots: [s0] }
  assert.equal(observe(g, []).reason, 'measurement-graph')
  assert.equal(observe(g, []), null, 'steady graph: nothing to invalidate')
  generation++; g.slots = [s0, s1]
  assert.equal(observe(g, []).reason, 'measurement-graph', 'connect bumps the meter generation: resets')
  generation++; g.slots = [s0]
  assert.equal(observe(g, []).reason, 'measurement-graph', 'disconnect bumps the meter generation: resets')
  g.slots = [s0, s1]
  assert.equal(observe(g, []).reason, 'measurement-graph', 'even without a generation bump, worklet slot changes reset')
  g.mode = 'media'; assert.equal(observe(g, [pipeline()]).reason, 'measurement-graph', 'mode change resets')
})

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

test('worklet: an added or removed slot keeps evidence only while the scaling slot and meter are unchanged', () => {
  const observe = createMeasurementContinuity()
  const meter = { generation: 1, continuity: null }
  const s0 = slot(meter), s1 = slot(meter), g = { mode: 'worklet', slots: [s0] }
  assert.equal(observe(g, []).reason, 'measurement-graph')
  g.slots = [s0, s1]; assert.equal(observe(g, []), null, 'added slot: no reset')
  g.slots = [s0]; assert.equal(observe(g, []), null, 'removed slot: no reset')
  g.slots = [s1, s0]; assert.equal(observe(g, []).reason, 'measurement-graph', 'scaling slot changed: resets')
  g.slots = [s1, slot({ generation: 1 })]; assert.equal(observe(g, []).reason, 'measurement-graph', 'different meter: resets')
  const m2 = { generation: 1, continuity: null }, t0 = slot(m2)
  g.slots = [t0]; observe(g, [])
  m2.generation = 2; g.slots = [t0, slot(m2)]
  assert.equal(observe(g, []).reason, 'measurement-graph', 'meter generation change during a join still resets')
  g.mode = 'media'; assert.equal(observe(g, [pipeline()]).reason, 'measurement-graph', 'mode change resets')
})

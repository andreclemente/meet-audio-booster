import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateRms, createRmsDetector } from '../src/platforms/google-meet/active-speaker.js'
import { createAssociationLearner } from '../src/platforms/google-meet/association.js'

test('RMS calculation and hysteresis reject one-frame noise', () => {
  assert.ok(Math.abs(calculateRms(new Float32Array([1, -1])) - 1) < 0.0001)
  const detector = createRmsDetector({ attackFrames: 2, releaseFrames: 2 })
  assert.equal(detector.update(0.02), false)
  assert.equal(detector.update(0.02), true)
  assert.equal(detector.update(0), true)
  assert.equal(detector.update(0), false)
})

test('association requires repeated exclusive alignment and never uses order', () => {
  const learner = createAssociationLearner(3)
  learner.observe('stream-x', 'A', { exclusiveUi: true, exclusiveEnergy: true })
  learner.observe('stream-x', 'A', { exclusiveUi: false, exclusiveEnergy: true })
  assert.equal(learner.get('stream-x').associationReliable, false)
  learner.observe('stream-x', 'A', { exclusiveUi: true, exclusiveEnergy: true })
  assert.equal(learner.get('stream-x').associationReliable, false)
  const result = learner.observe('stream-x', 'A', { exclusiveUi: true, exclusiveEnergy: true })
  assert.deepEqual(result, { participantKey: 'A', associationReliable: true })
})

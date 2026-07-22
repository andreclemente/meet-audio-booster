import test from 'node:test'
import assert from 'node:assert/strict'
import { collectCurrentUiSpeakers } from '../src/platforms/google-meet/index.js'

test('previous UI speaker is not held after the speaking marker clears', () => {
  const participants = [
    { key: 'A', speaking: true, lastSpeakingAt: 900 },
    { key: 'B', speaking: false, lastSpeakingAt: 0 }
  ]
  const speakingRoots = new Set(['B'])
  const result = collectCurrentUiSpeakers(participants, participant => speakingRoots.has(participant.key))
  assert.deepEqual(result.map(participant => participant.key), ['B'])
  assert.equal(participants[0].speaking, false)
  assert.equal(participants[1].speaking, true)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { dbToScale, postVolumeDb, planBalance, roundVolume, isBalanceEligible } from '../src/ui/balance.js'

const person = (key, value) => ({ key, name: key, value })
const levelsFrom = table => key => table[key] ?? null

test('display scale maps -60..0 dBFS linearly to 0..1 and clamps', () => {
  assert.equal(dbToScale(-60), 0)
  assert.equal(dbToScale(0), 1)
  assert.equal(dbToScale(-30), 0.5)
  assert.equal(dbToScale(-90), 0)
  assert.equal(dbToScale(12), 1)
  assert.equal(dbToScale(null), 0)
  assert.equal(dbToScale(NaN), 0)
})

test('post-volume level adds 20*log10(volume); muted or unknown has no level', () => {
  assert.equal(postVolumeDb(-30, 1), -30)
  assert.ok(Math.abs(postVolumeDb(-30, 2) - (-30 + 20 * Math.log10(2))) < 1e-12)
  assert.equal(postVolumeDb(-30, 0), null)
  assert.equal(postVolumeDb(null, 1), null)
  assert.equal(postVolumeDb(-Infinity, 1), null)
  assert.equal(postVolumeDb(-30, NaN), null)
})

test('volume rounding snaps to the 0.05 slider step inside 0.05..6', () => {
  assert.equal(roundVolume(1.234), 1.25)
  assert.equal(roundVolume(1.22), 1.2)
  assert.equal(roundVolume(0.01), 0.05)
  assert.equal(roundVolume(9), 6)
  assert.equal(roundVolume(0.35000000001), 0.35)
})

test('balance targets the median post-volume typical level of eligible voices', () => {
  // post levels: A -40, B -30, C -20 => median -30
  const people = [person('A', 1), person('B', 1), person('C', 1)]
  const plan = planBalance(people, levelsFrom({ A: { typicalDb: -40 }, B: { typicalDb: -30 }, C: { typicalDb: -20 } }))
  assert.equal(plan.target, -30)
  assert.deepEqual(plan.changes.map(change => [change.participant.key, change.from, change.to]), [
    ['A', 1, roundVolume(10 ** 0.5)], ['B', 1, 1], ['C', 1, roundVolume(10 ** -0.5)]
  ])
  assert.equal(plan.changes[0].to, 3.15)
  assert.equal(plan.changes[2].to, 0.3)
})

test('balance uses current volumes (post-volume typical) and an even-count median', () => {
  // A pre -30 at 2x (post -23.98), B pre -30 at 1x (post -30) => target -26.99
  const plan = planBalance([person('A', 2), person('B', 1)], levelsFrom({ A: { typicalDb: -30 }, B: { typicalDb: -30 } }))
  const target = ((-30 + 20 * Math.log10(2)) + -30) / 2
  assert.ok(Math.abs(plan.target - target) < 1e-12)
  assert.equal(plan.changes[0].to, roundVolume(2 * 10 ** ((target - (-30 + 20 * Math.log10(2))) / 20)))
  assert.equal(plan.changes[0].to, 1.4)
  assert.equal(plan.changes[1].to, 1.4)
})

test('balance clamps extreme corrections to 0.05..6', () => {
  const plan = planBalance([person('A', 1), person('B', 1), person('C', 1)],
    levelsFrom({ A: { typicalDb: -59 }, B: { typicalDb: -20 }, C: { typicalDb: -20 } }))
  assert.equal(plan.changes.find(change => change.participant.key === 'A').to, 6)
  const loud = planBalance([person('A', 1), person('B', 1), person('C', 1)],
    levelsFrom({ A: { typicalDb: -1 }, B: { typicalDb: -50 }, C: { typicalDb: -50 } }))
  assert.equal(loud.changes.find(change => change.participant.key === 'A').to, 0.05)
})

test('balance skips muted and not-yet-heard participants; fewer than 2 eligible is a no-op', () => {
  const people = [person('A', 1), person('Muted', 0), person('New', 1), person('B', 1)]
  const levels = levelsFrom({ A: { typicalDb: -40 }, Muted: { typicalDb: -20 }, New: { typicalDb: null, liveDb: -10 }, B: { typicalDb: -20 } })
  assert.equal(isBalanceEligible(people[1], levels), false)
  assert.equal(isBalanceEligible(people[2], levels), false)
  const plan = planBalance(people, levels)
  assert.deepEqual(plan.eligible.map(item => item.key), ['A', 'B'])
  assert.deepEqual(plan.changes.map(change => change.participant.key), ['A', 'B'])
  const none = planBalance([person('A', 1), person('Muted', 0)], levels)
  assert.equal(none.eligible.length, 1)
  assert.deepEqual(none.changes, [])
  assert.equal(none.target, null)
})

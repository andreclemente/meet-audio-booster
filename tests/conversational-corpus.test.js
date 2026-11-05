import test from 'node:test'
import assert from 'node:assert/strict'
import { createParticipantLevelMeter } from '../src/platforms/google-meet/levels.js'
import { createAutoBalance } from '../src/ui/auto-balance.js'
import { runCorpus } from './fixtures/conversational-corpus.js'

const corpus = runCorpus({ createParticipantLevelMeter, createAutoBalance })
// Every write is a 0.05 dB step; total movement equal to the step count means
// no person's gain ever reversed direction.
function assertMonotonic(r, maxDb) {
  const moved = r.finalGainDb.reduce((sum, db) => sum + Math.abs(db), 0)
  assert.ok(Math.abs(moved - 0.05 * r.writes) < 1e-9, JSON.stringify(r))
  for (const db of r.finalGainDb) assert.ok(Math.abs(db) <= maxDb, JSON.stringify(r))
}

test('known-envelope corpus: adequately sampled long turns acquire without gain chasing', () => {
  const required = corpus.acquisition.filter(r => r.cadence <= 200 && r.turnMs >= 3000)
  assert.equal(required.length, 18)
  for (const r of required) assert.ok(r.readyAt !== null, JSON.stringify(r))
  assert.ok(corpus.acquisition.filter(r => r.turnMs >= 3000 && r.readyAt !== null).length >= 22,
    'improve adequate-turn coverage beyond unchanged baseline18/24')
  for (const r of required) assert.equal(r.writes, 0, JSON.stringify(r))
  // Short/slowly sampled fragments may legitimately lack independent support or
  // sample only one phonetic phase. Do not force confidence by rephasing them.
  // Against a fixed target such a phase-biased estimate can earn a small
  // correction, but it must be monotonic (never chasing) and stay small.
  for (const r of corpus.acquisition) assertMonotonic(r, 1)
})

test('known-envelope corpus: short fluctuations and balanced periodic passages never write', () => {
  const controls = corpus.dynamics.filter(r => ['cough', 'dip', 'reversal', 'periodic'].includes(r.kind))
  assert.equal(controls.length, 16)
  for (const r of controls) assert.equal(r.newWrites, 0, JSON.stringify(r))
})

test('known-envelope corpus: persistent steps respond slowly, with unchanged deadband/slew', () => {
  const steps = corpus.dynamics.filter(r => r.kind.endsWith('-step'))
  assert.equal(steps.length, 8)
  for (const r of steps) {
    // Bounded by memory turnover: 120 accepted samples at the read cadence.
    assert.ok(r.firstWriteDelayMs >= 3000 && r.firstWriteDelayMs <= Math.max(30000, 120 * r.cadence), JSON.stringify(r))
    assert.ok(r.maxStepDb <= 0.0500001, JSON.stringify(r))
    assert.ok(r.kind === 'quiet-step' ? r.finalGainDb[1] > 0 : r.finalGainDb[1] < 0, JSON.stringify(r))
  }
  for (const r of corpus.dynamics.filter(r => r.kind === 'slow-drift' && r.cadence <= 120)) {
    assert.ok(r.newWrites > 0 && r.finalGainDb[1] > 0, JSON.stringify(r))
  }
  // Faster drift can exceed the 4 dB stationarity band over the supported
  // observation window. Coverage is measured, not forced by relaxing safety.
})

test('known-envelope corpus: one voice at the fixed level is kept; floor noise, silence and unknown meter abstain', () => {
  // A single confident voice now establishes the fixed target, but one already
  // at -20 dB is inside the deadband and is never adjusted.
  const single = corpus.negatives.find(r => r.kind === 'one-voice')
  assert.ok(single.readyAt !== null, JSON.stringify(single))
  assert.equal(single.writes, 0, JSON.stringify(single))
  for (const r of corpus.negatives.filter(r => !['unstable-noise', 'one-voice'].includes(r.kind))) {
    assert.equal(r.readyAt, null, JSON.stringify(r))
    assert.equal(r.writes, 0, JSON.stringify(r))
  }
  // Above-floor stationary noise falsely declared by an upstream source to be
  // sole speech is indistinguishable here from speech of that scalar envelope.
  // Keep this adverse challenge visible rather than asserting impossible VAD.
  // Its median sits 5 dB under the fixed target, so it is treated like a quiet
  // voice: a monotonic boost that stops at the deadband edge, never chasing.
  const ambiguous = corpus.negatives.find(r => r.kind === 'unstable-noise')
  assertMonotonic(ambiguous, 2.5)
})

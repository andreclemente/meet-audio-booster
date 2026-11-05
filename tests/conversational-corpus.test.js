import test from 'node:test'
import assert from 'node:assert/strict'
import { createParticipantLevelMeter } from '../src/platforms/google-meet/levels.js'
import { createAutoBalance } from '../src/ui/auto-balance.js'
import { runCorpus } from './fixtures/conversational-corpus.js'

const corpus = runCorpus({ createParticipantLevelMeter, createAutoBalance })

test('known-envelope corpus: adequately sampled long turns acquire without gain chasing', () => {
  const required = corpus.acquisition.filter(r => r.cadence <= 200 && r.turnMs >= 3000)
  assert.equal(required.length, 18)
  for (const r of required) assert.ok(r.readyAt !== null, JSON.stringify(r))
  assert.ok(corpus.acquisition.filter(r => r.turnMs >= 3000 && r.readyAt !== null).length >= 22,
    'improve adequate-turn coverage beyond unchanged baseline18/24')
  for (const r of corpus.acquisition) assert.equal(r.writes, 0, JSON.stringify(r))
  // Short/slowly sampled fragments may legitimately lack independent support or
  // sample only one phonetic phase. Do not force confidence by rephasing them.
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

test('known-envelope corpus: missing references, floor noise, silence and unknown meter abstain', () => {
  for (const r of corpus.negatives.filter(r => r.kind !== 'unstable-noise')) {
    assert.equal(r.readyAt, null, JSON.stringify(r))
    assert.equal(r.writes, 0, JSON.stringify(r))
  }
  // Above-floor stationary noise falsely declared by an upstream source to be
  // sole speech is indistinguishable here from speech of that scalar envelope.
  // Keep this adverse challenge visible rather than asserting impossible VAD.
  const ambiguous = corpus.negatives.find(r => r.kind === 'unstable-noise')
  assert.equal(ambiguous.writes, 0)
})

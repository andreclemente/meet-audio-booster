import test from 'node:test'
import assert from 'node:assert/strict'
import { createParticipantLevelMeter } from '../src/platforms/google-meet/levels.js'
import { createAutoBalance, AUTO_STEP_DB } from '../src/ui/auto-balance.js'
import { runCorpus } from './fixtures/conversational-corpus.js'

const corpus = runCorpus({ createParticipantLevelMeter, createAutoBalance })
// Every write is one fixed-size step; total movement equal to the step count means
// no person's gain ever reversed direction.
function assertMonotonic(r, maxDb) {
  const moved = r.finalGainDb.reduce((sum, db) => sum + Math.abs(db), 0)
  assert.ok(Math.abs(moved - AUTO_STEP_DB * r.writes) < 1e-9, JSON.stringify(r))
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
  // Against the reference such a phase-biased estimate can earn a small
  // correction, but it must be monotonic (never chasing) and stay small. The
  // one 300 ms/3 s phase-biased case now moves 0.4 dB (2.1 dB against the
  // fixed -20 dB target of 2.6.0, since B's biased level now also sets the
  // reference); the tightened bound keeps any regression beyond that visible.
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
    assert.ok(r.maxStepDb <= AUTO_STEP_DB + 1e-7, JSON.stringify(r))
    assert.ok(r.kind === 'quiet-step' ? r.finalGainDb[1] > 0 : r.finalGainDb[1] < 0, JSON.stringify(r))
    // Two voices: the reference is their midpoint (-26 / -14 dB), so B's
    // 12 dB step is corrected to the 1 dB deadband around it, i.e. ~5 dB
    // (measured 5.0 / -5.1 dB at 100-200 ms; 0.4 dB in the 36 s at 300 ms).
    if (r.cadence <= 200) assert.ok(Math.abs(r.finalGainDb[1]) >= 5 - 1e-6 && Math.abs(r.finalGainDb[1]) <= 5.1 + 1e-6 && r.finalGainDb[0] === 0, JSON.stringify(r))
  }
  for (const r of corpus.dynamics.filter(r => r.kind === 'slow-drift' && r.cadence <= 120)) {
    assert.ok(r.newWrites > 0 && r.finalGainDb[1] > 0, JSON.stringify(r))
  }
  // Faster drift can exceed the 4 dB stationarity band over the supported
  // observation window. Coverage is measured, not forced by relaxing safety.
})

test('known-envelope corpus: one voice at the default level is kept; floor noise, silence and unknown meter abstain', () => {
  // A single confident voice establishes the -20 dB default reference; one
  // already at -20 dB is inside even the 1 dB deadband and is never adjusted.
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
  // Both "voices" share a median ~5 dB under -20 dB. While A is the only
  // measured voice it is treated like a clearly quiet lone voice and boosted
  // to the 4 dB lone-voice edge (measured +1.1 dB, 11 steps). Once B is also
  // measured, the call reference is their shared level (~-24.9 dB), so A is
  // now ~1.1 dB loud and takes exactly ONE 0.1 dB step back, then holds:
  // measured 12 writes, final A +1.0 dB, B untouched. This one-time,
  // single-step return at the lone-voice -> call transition is inherent to
  // the 2.7.0 relative reference; anything more (a second reversal, more
  // back-steps, or a larger excursion) is chasing and fails here.
  const ambiguous = corpus.negatives.find(r => r.kind === 'unstable-noise')
  assert.ok(ambiguous.maxStepDb <= AUTO_STEP_DB + 1e-7, JSON.stringify(ambiguous))
  assert.ok(ambiguous.reverseSteps.every(n => n <= 1), JSON.stringify(ambiguous))
  assert.ok(ambiguous.directionChanges.every(n => n <= 1), 'at most one change of direction, never back again: ' + JSON.stringify(ambiguous))
  for (const db of ambiguous.finalGainDb) assert.ok(Math.abs(db) <= 4.5, JSON.stringify(ambiguous))
  const gross = ambiguous.finalGainDb.reduce((sum, db) => sum + Math.abs(db), 0) + 2 * AUTO_STEP_DB * ambiguous.reverseSteps.reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(gross - AUTO_STEP_DB * ambiguous.writes) < 1e-9, 'every write is accounted for by net movement plus the single return step: ' + JSON.stringify(ambiguous))
  assert.ok(ambiguous.writes <= 12, JSON.stringify(ambiguous))
})
test('known-envelope corpus: no voice ever reverses outside the lone-voice -> call transition', () => {
  for (const r of [...corpus.acquisition, ...corpus.dynamics, ...corpus.negatives.filter(r => r.kind !== 'unstable-noise')]) {
    assert.ok(r.reverseSteps.every(n => n === 0) && r.directionChanges.every(n => n === 0), JSON.stringify(r))
  }
})

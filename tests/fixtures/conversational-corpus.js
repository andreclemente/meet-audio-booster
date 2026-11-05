// Deterministic scalar envelopes: no recorded audio, identities or live input.
// Import accepts alternate production modules for unchanged-baseline comparison.
export function runCorpus({ createParticipantLevelMeter, createAutoBalance }, cadences = [100, 120, 200, 300]) {
  function session(step = 100, single = false) {
    const people = (single ? ['A'] : ['A', 'B']).map(key => ({ key, value: 1 }))
    const meter = createParticipantLevelMeter({ settleMs: 0 }), writes = []
    let now = 0, readyAt = null, qualified = 0, acceptedFrames = 0, callback = 0
    const auto = createAutoBalance({ participants: () => people, levels: key => meter.levelFor(key),
      onGain(p, value) { writes.push({ at: now, key: p.key, deltaDb: 20 * Math.log10(value / p.value) }); p.value = value } })
    auto.start(0)
    function run(key, ms, db) {
      for (let t = 0; t < ms;) {
        const delta = step === 'irregular' ? [100,120,200,300][callback++ % 4] : step
        now += delta
        const value = typeof db === 'function' ? db(t) : db
        const accepted = meter.tick({ now, participantKeys: people.map(p => p.key), attributedKey: key,
          readPower: () => value === 'unknown' ? NaN : 10 ** (value / 10) })
        if (accepted) {
          acceptedFrames++
          if (Number.isFinite(meter.levelFor(key).autoDb)) qualified++
        }
        auto.tick(now, accepted ? key : null)
        if (readyAt === null && auto.targetDb !== null) readyAt = now
        t += delta
      }
    }
    return { run, writes, people, meter, get now() { return now }, result() {
      return { readyAt, writes: writes.length, qualified, acceptedFrames,
        maxStepDb: Math.max(0, ...writes.map(w => Math.abs(w.deltaDb))),
        finalGainDb: people.map(p => 20 * Math.log10(p.value)) }
    } }
  }
  const acquisition = []
  // Cadence, articulation period/phase and turn length are varied independently.
  for (const cadence of cadences) {
    for (const rhythm of [7, 11, 17]) {
      for (const turnMs of [800, 3000, 14000]) {
        const f = session(cadence)
        const envelope = phase => t => -30 + 8 * Math.sin((t / (cadence === 'irregular' ? 180 : cadence) + phase) * 2 * Math.PI / rhythm)
        for (let i = 0; i < Math.ceil(84000 / (2 * (turnMs + 400))); i++) {
          f.run('A', turnMs, envelope(i + 2)); f.run(null, 400, -70)
          f.run('B', turnMs, envelope(i + 5)); f.run(null, 400, -70)
        }
        acquisition.push({ cadence, rhythm, turnMs, ...f.result() })
      }
    }
  }
  const dynamics = []
  for (const cadence of cadences) {
    for (const kind of ['cough', 'dip', 'reversal', 'periodic', 'quiet-step', 'loud-step', 'drift', 'slow-drift']) {
      const f = session(cadence)
      // Long enough even at 300 ms, but each reference remains <30 s old.
      f.run('A', 24000, -30); f.run('B', 24000, -30)
      const beganAt = f.now, initialWrites = f.writes.length
      if (kind === 'cough' || kind === 'dip') {
        f.run('B', 600, kind === 'cough' ? -5 : -50); f.run('B', 24000, -30)
      } else if (kind === 'reversal') {
        f.run('B', 1800, -44); f.run('B', 1800, -16); f.run('B', 24000, -30)
      } else if (kind === 'periodic') {
        f.run('B', 36000, t => Math.floor(t / 2000) % 2 ? -40 : -20)
      } else if (kind === 'drift' || kind === 'slow-drift') {
        f.run('B', 36000, t => -30 - t * (kind === 'slow-drift' ? 0.00015 : 1 / 3000))
      } else {
        f.run('B', 36000, kind === 'quiet-step' ? -42 : -18)
      }
      const first = f.writes.slice(initialWrites)[0]
      dynamics.push({ cadence, kind, ...f.result(), newWrites: f.writes.length - initialWrites,
        firstWriteDelayMs: first ? first.at - beganAt : null })
    }
  }
  const negatives = []
  for (const kind of ['one-voice', 'noise', 'silence', 'unknown-meter', 'isolated-reads', 'too-short-turns', 'unstable-noise']) {
    const f = session(kind === 'isolated-reads' ? 400 : 100, kind === 'one-voice')
    for (let i = 0; i < 5; i++) {
      for (const key of kind === 'one-voice' ? ['A'] : ['A', 'B']) {
        const value = kind === 'unknown-meter' ? 'unknown' : kind === 'silence' ? -Infinity : kind === 'noise' ? -65
          : kind === 'unstable-noise' ? t => -35 + 14 * Math.sin(t * .017) + 7 * Math.sin(t * .073) : -30
        f.run(key, kind === 'too-short-turns' ? 400 : 12000, value)
        f.run(null, 600, -70)
      }
    }
    negatives.push({ kind, ...f.result() })
  }
  return { acquisition, dynamics, negatives }
}

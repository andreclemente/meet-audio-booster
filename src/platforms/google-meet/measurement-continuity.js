// Controller-side classification; the meter alone verifies the native graph.
// This never licenses reuse of samples or qualification, only a session target.
export function createMeasurementContinuity() {
  let previousMode = null, previousUnits = [], previous = null
  const same = (a, b) => a.length === b.length && a.every((value, i) => value === b[i])
  // One unit per remote stream (media) or audio slot (worklet), with the
  // meter generation it was observed at.
  const unitsOf = (g, pipelines) => g.mode === 'media'
    ? pipelines.map(p => ({ key: p, parts: [p, p.stream, ...(p.tracks || [])], generation: undefined }))
    : g.slots.map(s => ({ key: s, parts: [s, s.tap, s.audibleMeter], generation: s.audibleMeter?.generation }))
  return function observe(g, pipelines) {
    const units = unitsOf(g, pipelines)
    const before = new Map(previousUnits.map(u => [u.key, u]))
    const kept = units.filter(u => before.has(u.key))
    const keptUnchanged = kept.every(u => { const o = before.get(u.key); return same(u.parts, o.parts) && u.generation === o.generation })
    const unchanged = g.mode === previousMode && units.length === previousUnits.length && kept.length === units.length && keptUnchanged
      && units.every((u, i) => u.key === previousUnits[i].key)
    if (unchanged) return null
    const meter = g.mode === 'worklet' && g.slots[0]?.audibleMeter
    // Someone joining or leaving only adds or removes other people's streams.
    // Levels are summed over all streams, so a silent added stream does not
    // change the measured speaker; keep evidence. Any replaced or re-wired
    // stream, the worklet scaling slot (slots[0]) or meter changing, or a
    // first/last stream is still a new measurement graph.
    const membershipOnly = g.mode === previousMode && previousUnits.length > 0 && units.length > 0 && keptUnchanged
      && kept.length > 0 && (g.mode !== 'worklet' || (g.slots[0] === previousUnits[0].key
        && g.slots.every(s => s.audibleMeter === meter) && (!previous || previous.meter === meter)))
    const next = meter?.continuity
    const sameOwners = g.mode === previousMode && units.length === previousUnits.length && units.every((u, i) => u.key === previousUnits[i].key && same(u.parts, previousUnits[i].parts))
    const compatible = sameOwners && previous?.meter === meter
      && g.slots.every(s => s.audibleMeter === meter)
      && next?.token && next.token === previous.token
      && next.reason === 'static-native-gain' && next.generation === meter.generation
      && next.generation > previous.generation
    previousMode = g.mode; previousUnits = units
    if (membershipOnly) return null
    previous = next ? { meter, ...next } : null
    return { reason: compatible ? 'compatible-native-gain' : 'measurement-graph' }
  }
}

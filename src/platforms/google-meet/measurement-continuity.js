// Controller-side classification; the meter alone verifies the native graph.
// This never licenses reuse of samples or qualification, only a session target.
export function createMeasurementContinuity() {
  let previousGraph = [], previousGenerations = [], previous = null
  const same = (a, b) => a.length === b.length && a.every((value, i) => value === b[i])
  return function observe(g, pipelines) {
    const graph = [g.mode, ...(g.mode === 'media'
      ? pipelines.flatMap(p => [p, p.stream, ...(p.tracks || [])])
      : g.slots.flatMap(s => [s, s.tap, s.audibleMeter]))]
    const generations = g.mode === 'media' ? [] : g.slots.map(s => s.audibleMeter?.generation)
    const sameOwners = same(graph, previousGraph)
    if (sameOwners && same(generations, previousGenerations)) return null
    const meter = g.mode === 'worklet' && g.slots[0]?.audibleMeter
    const next = meter?.continuity
    const compatible = sameOwners && previous?.meter === meter
      && g.slots.every(s => s.audibleMeter === meter)
      && next?.token && next.token === previous.token
      && next.reason === 'static-native-gain' && next.generation === meter.generation
      && next.generation > previous.generation
    previousGraph = graph; previousGenerations = generations
    previous = next ? { meter, ...next } : null
    return { reason: compatible ? 'compatible-native-gain' : 'measurement-graph' }
  }
}

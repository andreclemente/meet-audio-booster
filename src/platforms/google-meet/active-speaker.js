export function createRmsDetector({ onThreshold = 0.018, offThreshold = 0.009, attackFrames = 2, releaseFrames = 5 } = {}) {
  let active = false
  let above = 0
  let below = 0
  return {
    update(rms) {
      const value = Number.isFinite(rms) ? rms : 0
      if (active) {
        below = value < offThreshold ? below + 1 : 0
        if (below >= releaseFrames) {
          active = false
          above = 0
        }
      } else {
        above = value >= onThreshold ? above + 1 : 0
        if (above >= attackFrames) {
          active = true
          below = 0
        }
      }
      return active
    },
    get active() { return active },
    reset() { active = false; above = 0; below = 0 }
  }
}

export function calculateRms(buffer) {
  if (!buffer?.length) return 0
  let sum = 0
  for (let index = 0; index < buffer.length; index += 1) sum += buffer[index] * buffer[index]
  return Math.sqrt(sum / buffer.length)
}

export function attachPipelineAnalyser(context, node, options = {}) {
  const analyser = context.createAnalyser()
  analyser.fftSize = options.fftSize || 256
  const buffer = new Float32Array(analyser.fftSize)
  const detector = createRmsDetector(options)
  node.connect(analyser)
  return {
    analyser,
    buffer,
    detector,
    sample() {
      analyser.getFloatTimeDomainData(buffer)
      const rms = calculateRms(buffer)
      return { rms, activeByEnergy: detector.update(rms) }
    },
    disconnect() { try { analyser.disconnect() } catch {} }
  }
}

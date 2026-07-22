export function readAudioParam(param, fallback = 1) {
  const value = Number(param?.value)
  return Number.isFinite(value) ? value : fallback
}

export function writeAudioParam(param, value) {
  if (!param) return false
  const safe = Number.isFinite(value) ? Math.max(0, value) : 1
  try { param.setValueAtTime(safe, param.context?.currentTime || 0) } catch {}
  try { param.value = safe } catch { return false }
  return true
}

export function createAudioContext() {
  const Context = globalThis.AudioContext || globalThis.webkitAudioContext
  if (!Context) return null
  try { return new Context() } catch { return null }
}
